// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { join } from "node:path";

import {
  ToolchainSpecBuilder,
  type ToolchainSpec,
} from "@rust-toolchain/builder";
import type { MeasuredPaths } from "@rust-toolchain/cache/budget";
import type { CacheClient } from "@rust-toolchain/cache/client";
import {
  buildCacheOutputs,
  readCacheRequest,
  type CacheRequest,
} from "@rust-toolchain/cache/inputs";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";
import {
  restoreLayers,
  saveLayers,
  type CachePhaseState,
  type LayerPlan,
  type RestoredLayer,
  type SavedLayer,
} from "@rust-toolchain/cache/lifecycle";
import {
  parsePackageSet,
  type MetadataReader,
  type PackageSet,
} from "@rust-toolchain/cache/metadata";
import {
  binPaths,
  buildPaths,
  registryPaths,
} from "@rust-toolchain/cache/paths";
import {
  computeKeepSet,
  parsePrunePolicy,
  readFingerprints,
  type PrunePolicy,
} from "@rust-toolchain/cache/prune";
import { renderSummary } from "@rust-toolchain/cache/summary";
import {
  assertProfileAvailable,
  mergeConfig,
  resolveRustupEnv,
  type ToolchainInputs,
} from "@rust-toolchain/config";
import {
  generateSpecCacheKey,
  parseRustToolchainToml,
  parseRustcVersion,
  resolveChannel,
  type RustcVersionInfo,
  type ToolchainTomlConfig,
} from "@rust-toolchain/core";
import { describeError } from "@rust-toolchain/errors";
import { readBooleanInput } from "@rust-toolchain/inputs";
import {
  buildActionOutputs,
  toOutputEntries,
  type CacheOutputs,
} from "@rust-toolchain/outputs";
import {
  ensureTools,
  hashToolSet,
  parseToolSpecs,
  resolveToolVersions,
  type RegistryClient,
  type ToolResolution,
} from "@rust-toolchain/tools";

/** Outcome of one process invocation. */
export interface ExecResult {
  /** Exit code, or `null` when the process never started. */
  status: number | null;
  stdout?: string;
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  error?: Error;
}

export interface ExecOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  /** Capture stdout instead of streaming it to the job log. */
  capture?: boolean;
}

/**
 * Everything `run` touches outside itself.
 *
 * Injected rather than imported so the orchestration — retries, failure
 * reporting, output wiring — is exercised by tests instead of only by CI.
 */
export interface ActionDeps {
  exec: (file: string, args: string[], opts: ExecOptions) => ExecResult;
  readFile: (path: string) => string;
  core: {
    getInput: (name: string) => string;
    setOutput: (name: string, value: string) => void;
    setFailed: (message: string) => void;
    exportVariable: (name: string, value: string) => void;
    addPath: (path: string) => void;
    info: (message: string) => void;
    /** Crosses the main/post boundary — `action.yml`'s `post:` is a second,
     * unrelated process invocation that shares nothing but this. */
    saveState: (name: string, value: string) => void;
    getState: (name: string) => string;
    warning: (message: string) => void;
    summary: { addRaw: (text: string) => { write: () => Promise<unknown> } };
  };
  env: Record<string, string | undefined>;
  /** `process.platform` — decides the rustup installer and path layout. */
  platform: string;
  sleep: (ms: number) => void;
  /**
   * Promise-based pause, for the concurrent registry lookups.
   *
   * Separate from `sleep` because that one blocks the thread through
   * `Atomics.wait`, which would serialise `resolveToolVersions` into one
   * lookup at a time. `sleep` stays for the synchronous `spawnSync` retries.
   */
  delay: (ms: number) => Promise<void>;
  /** The only real implementation wraps `@actions/cache`, in `src/index.ts`. */
  cache: CacheClient;
  /** The only real implementation calls crates.io, also in `src/index.ts`. */
  registry: RegistryClient;
}

/** Toolchain downloads are network-bound; a stalled one must not hang the job. */
const RUSTUP_TIMEOUT_MS = 600_000;
const RUSTC_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
/** `cargo install` compiles from source, so it needs far longer than rustup. */
const CARGO_INSTALL_TIMEOUT_MS = 900_000;

function describeFailure(args: string[], result: ExecResult): string {
  const command = ["rustup", ...args].join(" ");
  if (result.error) return `${command} could not run: ${result.error.message}`;
  return `${command} failed with exit code ${result.status}`;
}

/**
 * Runs one rustup command, retrying transient failures with growing backoff.
 *
 * Every rustup verb used here downloads from static.rust-lang.org, so a single
 * dropped connection should not fail the job. Throws once the attempts are
 * exhausted — the caller turns that into a single `setFailed`.
 */
function rustupOrThrow(
  deps: ActionDeps,
  args: string[],
  env: Record<string, string | undefined>,
): void {
  let last: ExecResult = { status: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = deps.exec("rustup", args, { env, timeoutMs: RUSTUP_TIMEOUT_MS });
    if (last.status === 0) return;
    if (attempt < MAX_ATTEMPTS) {
      deps.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }

  throw new Error(describeFailure(args, last));
}

/**
 * Reads the cache key from the toolchain that was just installed.
 *
 * Resolved through `RUSTUP_TOOLCHAIN`, so the key describes the toolchain that
 * was requested rather than whatever a workspace `rust-toolchain.toml` selects.
 * A failure here is fatal: an empty key would collapse every consumer's cache
 * to a single entry without any signal that it had happened.
 */
function readRustcVersion(
  deps: ActionDeps,
  env: Record<string, string | undefined>,
): { info: RustcVersionInfo; banner: string } {
  const result = deps.exec("rustc", ["--version", "--verbose"], {
    env,
    timeoutMs: RUSTC_TIMEOUT_MS,
    capture: true,
  });

  if (result.error) {
    throw new Error(`rustc could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`rustc --version failed with exit code ${result.status}`);
  }

  const banner = result.stdout ?? "";
  return { info: parseRustcVersion(banner), banner };
}

function readTomlConfig(deps: ActionDeps): ToolchainTomlConfig {
  const workspace = deps.env.GITHUB_WORKSPACE ?? ".";
  let contents: string;
  try {
    contents = deps.readFile(join(workspace, "rust-toolchain.toml"));
  } catch {
    // No rust-toolchain.toml in the workspace — inputs and defaults only.
    return {};
  }
  // A malformed file is *not* swallowed: parseRustToolchainToml throws.
  return parseRustToolchainToml(contents);
}

function readInputs(deps: ActionDeps): ToolchainInputs {
  return {
    toolchain: deps.core.getInput("toolchain") || undefined,
    targets: deps.core.getInput("targets") || undefined,
    target: deps.core.getInput("target") || undefined,
    components: deps.core.getInput("components") || undefined,
    profile: deps.core.getInput("profile") || undefined,
  };
}

/**
 * The installable spec, kept together with the two sources it was merged from.
 *
 * The sources are carried rather than discarded because the outputs report
 * them: a merged list alone cannot say whether a target came from the workflow
 * or from the workspace's `rust-toolchain.toml`.
 */
interface ResolvedConfiguration {
  spec: ToolchainSpec;
  inputs: ToolchainInputs;
  toml: ToolchainTomlConfig;
}

function resolveConfiguration(deps: ActionDeps): ResolvedConfiguration {
  const inputs = readInputs(deps);
  const toml = readTomlConfig(deps);
  const resolved = mergeConfig(toml, inputs);
  const channel = resolveChannel(resolved.channel);
  // Checked against the resolved channel: `stable 2 releases ago` is a release,
  // whatever the input said.
  assertProfileAvailable(channel, resolved.profile);
  const builder = new ToolchainSpecBuilder()
    .withChannel(channel)
    .withTargets(...resolved.targets)
    .withComponents(...resolved.components);
  // mergeConfig always resolves one; the guard keeps the type honest.
  if (resolved.profile) builder.withProfile(resolved.profile);
  return { spec: builder.build(), inputs, toml };
}

/** True when a working `rustup` is already on PATH. */
function hasRustup(
  deps: ActionDeps,
  env: Record<string, string | undefined>,
): boolean {
  const probe = deps.exec("rustup", ["--version"], {
    env,
    timeoutMs: RUSTC_TIMEOUT_MS,
    capture: true,
  });
  return !probe.error && probe.status === 0;
}

/**
 * Installs rustup itself when the runner does not already have it.
 *
 * Self-hosted runners and slim containers frequently ship without rustup;
 * without this the action would fail on the very first command. Downloaded to a
 * file and executed directly rather than piped through a shell.
 */
function bootstrapRustup(
  deps: ActionDeps,
  env: Record<string, string | undefined>,
  cargoHome: string,
): void {
  const temp = deps.env.RUNNER_TEMP ?? "/tmp";
  const windows = deps.platform === "win32";
  const arch = deps.env.RUNNER_ARCH === "ARM64" ? "aarch64" : "x86_64";

  const url = windows
    ? `https://win.rustup.rs/${arch}`
    : "https://sh.rustup.rs";
  const installer = windows
    ? `${temp}\\rustup-init.exe`
    : `${temp}/rustup-init.sh`;

  const download = deps.exec(
    "curl",
    [
      "--proto",
      "=https",
      "--tlsv1.2",
      "--retry",
      "10",
      "--retry-connrefused",
      "--location",
      "--silent",
      "--show-error",
      "--fail",
      url,
      "--output",
      installer,
    ],
    { env, timeoutMs: RUSTUP_TIMEOUT_MS },
  );
  if (download.error || download.status !== 0) {
    throw new Error(describeFailure(["curl", url], download));
  }

  const init = windows
    ? deps.exec(
        installer,
        ["--default-toolchain", "none", "--no-modify-path", "-y"],
        { env, timeoutMs: RUSTUP_TIMEOUT_MS },
      )
    : deps.exec("sh", [installer, "--default-toolchain", "none", "-y"], {
        env,
        timeoutMs: RUSTUP_TIMEOUT_MS,
      });
  if (init.error || init.status !== 0) {
    throw new Error(describeFailure(["rustup-init"], init));
  }

  deps.core.addPath(windows ? `${cargoHome}\\bin` : `${cargoHome}/bin`);
}

/**
 * Applies the cargo defaults dtolnay/rust-toolchain sets, plus the workarounds
 * for toolchains whose bundled cargo has known network bugs.
 *
 * Every one is skipped when the workflow already set the variable itself.
 *
 * Every name exported here must also appear in `EXCLUDED` in
 * `src/cache/env.ts` — as must every name exported anywhere else in this file,
 * `run`'s `RUST_TOOLCHAIN_CACHE_ON_FAILURE` and `RUSTUP_TOOLCHAIN` included.
 * The rule is about `core.exportVariable`, not about this function:
 * `RUST_TOOLCHAIN_CACHE_ON_FAILURE` leaked into the digest precisely because
 * an earlier version of this comment scoped it here.
 *
 * `core.exportVariable` writes to `GITHUB_ENV`, so a second invocation of this
 * action in the same job reads these back as if the caller had set them — and
 * a `build` key that moves between the first and second invocation is a key
 * nothing will ever restore.
 */
function applyCargoDefaults(deps: ActionDeps, release: string): void {
  const setIfUnset = (name: string, value: string): void => {
    if (deps.env[name] === undefined) deps.core.exportVariable(name, value);
  };

  // Incremental artifacts never survive to the next CI run, so producing them
  // only costs time and cache space.
  setIfUnset("CARGO_INCREMENTAL", "0");
  setIfUnset("CARGO_TERM_COLOR", "always");

  // Sparse registry: implemented in 1.66, stabilized in 1.68, default in 1.70.
  if (/^1\.6[89]\./.test(release)) {
    setIfUnset("CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "sparse");
  } else if (/^1\.6[67]\./.test(release)) {
    setIfUnset("CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "git");
  }

  // curl 8.0 shipped in these toolchains and produced spurious network errors
  // with HTTP multiplexing enabled.
  if (/^1\.7[01]\./.test(release)) {
    setIfUnset("CARGO_HTTP_MULTIPLEXING", "false");
  }
}

/**
 * The filesystem paths each cache layer covers.
 *
 * A `Record` rather than an `if`/`switch` for the same reason `keys.ts`'s
 * `DERIVERS` is one: adding a layer to `CACHE_LAYER_IDS` then fails to
 * compile here until it is given a path list, instead of silently falling
 * through to whichever branch an `if` chain happened to end on.
 */
function layerPathsByLayer(
  request: CacheRequest,
  cargoHome: string,
): Record<CacheLayerId, string[]> {
  return {
    registry: registryPaths(cargoHome),
    build: buildPaths(request.workspaces),
    bin: binPaths(cargoHome),
  };
}

/**
 * Turns the validated cache request and its derived keys into one
 * restore/save plan per enabled layer.
 *
 * `cache.layers` is built from this same `request.layers` list by
 * `buildCacheOutputs`, so every layer named here is guaranteed an entry —
 * the non-null assertion documents that invariant rather than working around
 * a real possibility of `undefined`.
 */
function buildLayerPlans(
  request: CacheRequest,
  cache: CacheOutputs,
  cargoHome: string,
): LayerPlan[] {
  const pathsByLayer = layerPathsByLayer(request, cargoHome);
  return request.layers.map((layer) => {
    const derived = cache.layers[layer]!;
    return {
      layer,
      key: derived.key,
      restoreKeys: derived.restoreKeys,
      paths: pathsByLayer[layer],
    };
  });
}

/**
 * Folds each layer's restore outcome into the `cache` output.
 *
 * `result` is absent until a layer has actually been restored — Phase A
 * emitted keys with no lifecycle behind them — so this is the only place that
 * field is ever populated.
 */
function foldRestoredResults(
  cache: CacheOutputs,
  restored: RestoredLayer[],
): CacheOutputs {
  const layers: CacheOutputs["layers"] = {};
  for (const layer of Object.keys(cache.layers) as CacheLayerId[]) {
    const output = cache.layers[layer];
    if (!output) continue;
    const match = restored.find((entry) => entry.layer === layer);
    layers[layer] = match ? { ...output, result: match.result } : output;
  }
  return { ...cache, layers };
}

/**
 * Restores every enabled cache layer and hands the outcome to the post phase
 * through `saveState("cache", ...)`.
 *
 * Returns `cacheHit: false` without touching `deps.cache` or `saveState` when
 * caching is disabled — `cacheRequest` is `undefined` in that case — so the
 * post phase, driven by `getState("cache")`, correctly does nothing. Does
 * *not* set `saveState("isPost", ...)` itself: `run` sets that unconditionally
 * regardless of whether caching is enabled, so this function skipping entirely
 * cannot leave the post phase unable to tell it is the post phase.
 */
async function resolveCacheLifecycle(
  deps: ActionDeps,
  cacheRequest: CacheRequest | undefined,
  specCacheKey: string,
  cargoHome: string,
  toolSetHash: string,
  prune: PrunePolicy,
): Promise<{ cache: CacheOutputs; cacheHit: boolean }> {
  const cache = buildCacheOutputs(cacheRequest, specCacheKey, toolSetHash);
  if (!cacheRequest) return { cache, cacheHit: false };

  const plans = buildLayerPlans(cacheRequest, cache, cargoHome);
  const restored = await restoreLayers(deps.cache, plans, {
    info: deps.core.info,
    warning: deps.core.warning,
  });

  // Typed as `CachePhaseState` rather than left to inference: `runPost` casts
  // the parsed JSON to the same interface, so the two halves of the handoff
  // are checked against one declaration instead of agreeing by coincidence.
  const state: CachePhaseState = {
    plans,
    restored,
    budget: cacheRequest.budget,
    prune,
    workspaces: cacheRequest.workspaces,
    cargoHome,
  };
  deps.core.saveState("cache", JSON.stringify(state));

  return {
    cache: foldRestoredResults(cache, restored),
    // `[].every(...)` is vacuously true, so the length guard is what stops an
    // empty restore set from reporting a hit that never happened.
    cacheHit:
      restored.length > 0 &&
      restored.every((entry) => entry.result === "exact"),
  };
}

/** Installs the requested toolchain and publishes the action's outputs. */
export async function run(deps: ActionDeps): Promise<void> {
  try {
    // The first statement in the try, before anything that can throw, and the
    // ordering is the whole point rather than a detail.
    //
    // action.yml's `post:` runs on every successful job whether caching is
    // enabled or not, and GitHub only sets STATE_isPost once this line runs.
    // src/index.ts's dispatch reads exactly that variable to decide it is the
    // post phase; without it, the post invocation falls into the `else` branch
    // and re-runs the entire main phase. It is tempting to argue that a throw
    // below makes `success()` false so `post-if` never fires — but
    // `continue-on-error: true` on the action's step keeps the job status
    // successful, and then a bad `cache-budget` would install the toolchain a
    // second time as the post step. Making the invariant structural is the
    // only defence available: the dispatch itself lives in coverage-excluded
    // src/index.ts, so no unit test can cover it.
    //
    // "isPost set, no cache payload" is already the proven caching-disabled
    // no-op — see runPost's early return and its test.
    deps.core.saveState("isPost", "true");

    // Validation first among the things that can throw. Every cache input is
    // checked against nothing but itself, so a typo here must fail before the
    // rustup bootstrap and the toolchain install it would otherwise throw away.
    //
    // Narrowed to what that module actually needs, rather than handed the whole
    // of `deps`: taking `ActionDeps` there would make it import this file for
    // the type while this file imports it back.
    const cacheRequest = readCacheRequest({
      getInput: deps.core.getInput,
      env: deps.env,
    });

    // Parsed alongside the cache inputs, and for the same reason: it is
    // checked against nothing but itself, so a malformed tool name must fail
    // before the rustup bootstrap it would otherwise throw away. Resolution is
    // network-bound and waits until further down.
    // Validated here, with the other cache inputs, so a typo fails the job
    // before a toolchain is downloaded rather than after a ten-minute build.
    const prunePolicy = parsePrunePolicy(deps.core.getInput("cache-prune"));
    const toolSpecs = parseToolSpecs(deps.core.getInput("cargo-tools"));

    // Exported as early as possible: `post-if` reads this even when the job
    // fails at a later, unrelated step, long after this action returned.
    const cacheOnFailure = readBooleanInput(
      deps.core,
      "cache-on-failure",
      false,
    );
    deps.core.exportVariable(
      "RUST_TOOLCHAIN_CACHE_ON_FAILURE",
      String(cacheOnFailure.value),
    );

    const config = resolveConfiguration(deps);
    const spec = config.spec;
    const rustupEnv = resolveRustupEnv(deps.env, deps.platform);
    const env: Record<string, string | undefined> = {
      ...deps.env,
      ...rustupEnv,
      // rustup renames a component's directory into $RUSTUP_HOME/tmp before
      // replacing it, which overlayfs rejects across image layers. This permits
      // a copy instead.
      RUSTUP_PERMIT_COPY_RENAME: "1",
    };

    if (!hasRustup(deps, env)) {
      bootstrapRustup(deps, env, rustupEnv.CARGO_HOME);
    }

    rustupOrThrow(deps, spec.toRustupInstallArgs(), env);

    const targetArgs = spec.toRustupTargetAddArgs();
    if (targetArgs) rustupOrThrow(deps, targetArgs, env);

    const componentArgs = spec.toRustupComponentAddArgs();
    if (componentArgs) rustupOrThrow(deps, componentArgs, env);

    // rustup honours --profile only when it installs a toolchain for the first
    // time, so on a runner that already has one the profile would otherwise do
    // nothing. Adding its components by name makes it take effect either way.
    // Best-effort on purpose: these were implied, not requested, and a channel
    // that does not publish one of them must not fail the job.
    const profileComponentArgs = spec.toRustupProfileComponentAddArgs();
    if (profileComponentArgs) {
      try {
        rustupOrThrow(deps, profileComponentArgs, env);
      } catch (error) {
        deps.core.info(
          `Could not add every component implied by the "${spec.profile}" ` +
            `profile, continuing: ${describeError(error)}`,
        );
      }
    }

    // dtolnay/rust-toolchain#127: `rustup default` fails for some toolchains
    // that installed correctly. `RUSTUP_TOOLCHAIN` below is what actually
    // selects the toolchain, so a failure here is not worth failing the job.
    try {
      rustupOrThrow(deps, spec.toRustupDefaultArgs(), env);
    } catch (error) {
      deps.core.info(
        `rustup default did not succeed, continuing: ${describeError(error)}`,
      );
    }

    // `RUSTUP_TOOLCHAIN` outranks a `rust-toolchain.toml` in rustup's override
    // chain, so this is what makes "inputs override the toml" hold at *use*
    // time and not merely at install time. Exported after the install so it
    // never names a missing toolchain.
    //
    // Because it outranks *every* toolchain file in the tree, a monorepo that
    // pins a different toolchain per crate can opt out and let each nested
    // rust-toolchain.toml keep winning. The pin is still applied to this
    // action's own environment, so the outputs below describe the toolchain it
    // installed either way.
    const setRustupToolchain = readBooleanInput(
      deps.core,
      "set-rustup-toolchain",
      true,
    );
    if (setRustupToolchain.value) {
      deps.core.exportVariable("RUSTUP_TOOLCHAIN", spec.channel);
    }
    env.RUSTUP_TOOLCHAIN = spec.channel;

    const rustc = readRustcVersion(deps, env);
    deps.core.info(rustc.banner);
    applyCargoDefaults(deps, rustc.info.version);

    const specCacheKey = generateSpecCacheKey(rustc.info.cacheKey, spec);

    // BEFORE the keys are derived, unavoidably: `toolSetHash` is a segment of
    // the `bin` key, so resolving afterwards would key every tooled job on the
    // empty-set digest and collapse them onto one entry. A pinned version never
    // reaches the client, so this is a no-op for a fully pinned `cargo-tools`.
    const toolResolution: ToolResolution = await resolveToolVersions(
      toolSpecs,
      {
        client: deps.registry,
        attempts: MAX_ATTEMPTS,
        backoffMs: BACKOFF_BASE_MS,
        delay: deps.delay,
      },
    );
    // Lands here, after the toolchain install, unavoidably: the `build` key
    // carries `specCacheKey`, which does not exist until rustc has run. These
    // are cargo caches for later `cargo` steps, not rustup itself, so the
    // ordering costs nothing.
    const { cache, cacheHit } = await resolveCacheLifecycle(
      deps,
      cacheRequest,
      specCacheKey,
      rustupEnv.CARGO_HOME,
      hashToolSet(toolResolution.tools),
      prunePolicy,
    );

    // AFTER the restore, and that ordering is the point (D2 of the Phase C
    // plan). A restored `bin` layer is what makes most of these a no-op, so
    // verifying first would install exactly what the cache was about to
    // supply. It lives outside `cache/lifecycle.ts` because it needs `exec`,
    // which that module deliberately does without so it stays testable against
    // plain values.
    ensureTools(toolResolution, {
      exec: deps.exec,
      env,
      attempts: MAX_ATTEMPTS,
      backoffMs: BACKOFF_BASE_MS,
      sleep: deps.sleep,
      timeoutMs: CARGO_INSTALL_TIMEOUT_MS,
      log: { info: deps.core.info, warning: deps.core.warning },
    });

    const outputs = buildActionOutputs({
      spec,
      inputs: config.inputs,
      toml: config.toml,
      setRustupToolchain,
      cacheKey: rustc.info.cacheKey,
      specCacheKey,
      cache,
      cacheHit,
      // The same list `hashToolSet` keyed the bin layer from above, not
      // `ensureTools`' outcomes: a consumer reading both `cargo-tools` and the
      // bin key needs them to describe one resolution.
      tools: toolResolution.tools,
    });
    for (const [name, value] of toOutputEntries(outputs)) {
      deps.core.setOutput(name, value);
    }
  } catch (error) {
    deps.core.setFailed(describeError(error));
  }
}

/** The post phase's dependencies — a subset of the main phase's. */
export interface PostDeps {
  cache: CacheClient;
  core: Pick<ActionDeps["core"], "getState" | "info" | "warning" | "summary">;
  measure: (paths: string[]) => MeasuredPaths;
  /** Runs `cargo metadata`; the real one is in `src/index.ts`. */
  metadata: MetadataReader;
  /** Every file under a directory, recursively. */
  walk: (dir: string) => string[];
  /** One directory's entries, for reading `.fingerprint/`. */
  readdir: (dir: string) => string[];
}

/**
 * Below this share of the bytes, pruning is not worth its own resolution cost.
 *
 * Task 4 measured both ends of the trade on real cargo trees. A churned
 * workspace dropped 46% of a 220 MB archive for 495 ms of `@actions/glob`
 * resolution — clearly worth it. An unchurned one spent 904 ms to drop 0.2%,
 * which is pure loss: resolution runs about 1.5 ms per kept entry, so the
 * explicit manifest costs more the *less* there is to prune.
 */
const PRUNE_WORTH_IT = 0.05;

/**
 * Narrows the plans to a keep-set, when one can be computed and is worth using.
 *
 * Every failure here falls back to the plans the main phase already built,
 * which are the Phase B glob set. That is the invariant the whole phase turns
 * on: **an empty or unusable keep-set must never be saved.** Saving one is not
 * a small cache but a poisoned one — an entry that exists, hits its key,
 * restores nothing, and leaves every later job rebuilding while believing it
 * was warm. `cargo metadata` missing, a workspace with no manifest, a lockfile
 * `--locked` rejects, and a fingerprint layout cargo has restructured all
 * converge on that same empty result, so the fallback is the common path and
 * not the rare one.
 */
async function prunePlans(
  plans: LayerPlan[],
  state: CachePhaseState,
  deps: PostDeps,
): Promise<LayerPlan[]> {
  // The state is a cross-version contract: `action.yml` invokes `dist/index.js`
  // twice as two unrelated processes, and during an upgrade the payload can
  // have been written by a main phase that predates these fields. Absent is
  // therefore an ordinary case meaning "no pruning was planned", not a fault —
  // warning about it would fire on every mid-upgrade job for something nobody
  // can act on.
  if (state.prune === undefined || state.workspaces === undefined) return plans;
  if (state.prune === "off") return plans;

  const packages = new Set<string>();
  const members = new Set<string>();
  const keep: string[] = [];
  let allFiles: string[] = [];

  for (const workspace of state.workspaces) {
    const set: PackageSet = parsePackageSet(
      await deps.metadata.read(workspace.manifestDir),
    );
    for (const id of set.packages) packages.add(id);
    for (const id of set.workspaceMembers) members.add(id);

    const files = deps.walk(workspace.targetDir);
    allFiles = allFiles.concat(files);
    const result = computeKeepSet({
      files,
      fingerprints: readFingerprints(
        `${workspace.targetDir}/debug/.fingerprint`,
        {
          readdir: deps.readdir,
        },
      ),
      packageSet: set,
      policy: state.prune,
    });
    if (!result.usable) return plans;
    keep.push(...result.keep);
    if (result.unattributable.length > 0) {
      deps.core.info(
        `prune: ${result.unattributable.length} artifact(s) under ` +
          `${workspace.targetDir} matched no package and were ` +
          `${state.prune === "safe" ? "kept" : "dropped"}`,
      );
    }
  }

  if (keep.length === 0 || packages.size === 0) return plans;

  // The guard Task 4's measurement forced. Both measurements are needed for
  // `prunedBytes` regardless, so deciding on them is nearly free.
  const total = deps.measure(allFiles).bytes;
  const kept = deps.measure(keep).bytes;
  const dropped = total - kept;
  if (total === 0 || dropped / total < PRUNE_WORTH_IT) {
    deps.core.info(
      `prune: would drop ${dropped} of ${total} bytes, below the ` +
        `${PRUNE_WORTH_IT * 100}% threshold, so the unpruned paths are kept`,
    );
    return plans;
  }

  return plans.map((plan) => {
    if (plan.layer === "build") {
      return {
        ...plan,
        paths: buildPaths(state.workspaces, keep),
        prunedBytes: dropped,
      };
    }
    if (plan.layer === "registry") {
      return { ...plan, paths: registryPaths(state.cargoHome, packages) };
    }
    return plan;
  });
}

/**
 * Writes the job summary, warning rather than throwing when it fails.
 *
 * Its own guard, separate from `runPost`'s: a summary failure — typically
 * `GITHUB_STEP_SUMMARY` unset on a slim runner or under `act` — must not
 * discard the saves `runPost` already computed by being reported as though
 * the whole post step failed.
 */
async function writeSummarySafely(
  core: PostDeps["core"],
  restored: RestoredLayer[],
  saved: SavedLayer[],
): Promise<void> {
  try {
    await core.summary.addRaw(renderSummary(restored, saved)).write();
  } catch (error) {
    core.warning(
      `could not write the job summary, continuing: ${describeError(error)}`,
    );
  }
}

/**
 * Saves the layers the main phase restored.
 *
 * Runs from `action.yml`'s `post:`, so it sees none of the main phase's
 * locals — everything it needs crossed the boundary through `saveState` as a
 * JSON-encoded environment variable, which is what makes the outer guard
 * below necessary: design invariant 8 ("a cache failure never fails the
 * build") holds inside `restoreLayers`/`saveLayers` themselves, but a
 * truncated or malformed payload throws before either ever runs.
 */
export async function runPost(deps: PostDeps): Promise<void> {
  try {
    const raw = deps.core.getState("cache");
    if (!raw) return;

    // Cast to the same interface the main phase serialised, so a rename on
    // either side is a compile error rather than a silent `undefined`.
    const state = JSON.parse(raw) as CachePhaseState;
    const { restored, budget } = state;

    // Pruning happens here, not in the main phase: it describes what to save,
    // and the main phase has not built anything yet — computing it there would
    // read a `target/` that does not exist.
    let plans = state.plans;
    try {
      plans = await prunePlans(plans, state, deps);
    } catch (error) {
      deps.core.warning(
        `prune: could not narrow the cache to the resolved package set, ` +
          `saving everything instead — ${describeError(error)}`,
      );
    }

    const saved = await saveLayers({
      client: deps.cache,
      plans,
      restored,
      budget,
      measure: deps.measure,
      log: { info: deps.core.info, warning: deps.core.warning },
    });

    await writeSummarySafely(deps.core, restored, saved);
  } catch (error) {
    deps.core.warning(
      `cache post-processing failed, continuing: ${describeError(error)}`,
    );
  }
}
