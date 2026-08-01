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
import { buildPaths, registryPaths } from "@rust-toolchain/cache/paths";
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
  /** The only real implementation wraps `@actions/cache`, in `src/index.ts`. */
  cache: CacheClient;
}

/** Toolchain downloads are network-bound; a stalled one must not hang the job. */
const RUSTUP_TIMEOUT_MS = 600_000;
const RUSTC_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;

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
): Promise<{ cache: CacheOutputs; cacheHit: boolean }> {
  const cache = buildCacheOutputs(cacheRequest, specCacheKey);
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
    // Lands here, after the toolchain install, unavoidably: the `build` key
    // carries `specCacheKey`, which does not exist until rustc has run. These
    // are cargo caches for later `cargo` steps, not rustup itself, so the
    // ordering costs nothing.
    const { cache, cacheHit } = await resolveCacheLifecycle(
      deps,
      cacheRequest,
      specCacheKey,
      rustupEnv.CARGO_HOME,
    );

    const outputs = buildActionOutputs({
      spec,
      inputs: config.inputs,
      toml: config.toml,
      setRustupToolchain,
      cacheKey: rustc.info.cacheKey,
      specCacheKey,
      cache,
      cacheHit,
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
    const { plans, restored, budget } = JSON.parse(raw) as CachePhaseState;

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
