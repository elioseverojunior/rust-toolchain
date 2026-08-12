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
  type Workspace,
} from "@rust-toolchain/cache/paths";
import {
  computeKeepSet,
  parsePrunePolicy,
  readFingerprints,
  type PrunePolicy,
} from "@rust-toolchain/cache/prune";
import {
  buildStageRoots,
  registryStageRoot,
  stageFiles,
  stagePaths,
  unstageFiles,
  type StageFs,
  type StageRoot,
} from "@rust-toolchain/cache/stage";
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
  /**
   * Moves a staged layer's files back into the tree after a restore.
   *
   * Needed in the main phase as well as the post phase: a staged archive
   * unpacks into a directory nothing reads from, so the restore is only half
   * done until this has run.
   */
  stageFs: StageFs;
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

/**
 * True when a working `rustup` is already on PATH.
 *
 * `--help`, not `--version`, and the difference is not cosmetic. `rustup
 * --version` also prints the *active* rustc version, which makes rustup walk
 * the override chain — and this probe runs in the workspace before
 * `RUSTUP_TOOLCHAIN` is exported, so a `rust-toolchain.toml` wins there at
 * precedence 4. rustup then DOWNLOADS that toolchain, six components of it,
 * only to print one line; the action installs the caller's channel immediately
 * afterwards and uses that instead. The waste lands on exactly the workflows
 * this action exists for — a toml overridden by an input — and is invisible,
 * because the resolved toolchain is still correct.
 *
 * `--help` answers the one question asked here (does rustup run?) and resolves
 * nothing. Verified outside the action: beside a toml naming an uninstalled
 * channel, `rustup --version` emits "syncing channel updates" and `rustup
 * --help` does not.
 */
function hasRustup(
  deps: ActionDeps,
  env: Record<string, string | undefined>,
): boolean {
  const probe = deps.exec("rustup", ["--help"], {
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
 *
 * **The paths array is part of the cache entry's identity**, not just a
 * description of what to archive: `@actions/cache` matches on
 * `(key, sha256(paths | …))`. Both phases therefore have to derive the same
 * array, and `prune` is the only thing that changes its shape — which is why
 * the switch is on the *input* and never on whether a keep-set was ultimately
 * worth using. The keep-set is not computed until the post phase, so deciding
 * on it here would be deciding on something the restore cannot know, and the
 * entry it wrote would be unreadable for the rest of its life.
 */
function layerPathsByLayer(
  request: CacheRequest,
  cargoHome: string,
  prune: PrunePolicy,
): Record<CacheLayerId, string[]> {
  const staged = prune !== "off";
  return {
    registry: staged
      ? stagePaths([registryStageRoot(cargoHome)])
      : registryPaths(cargoHome),
    build: staged
      ? stagePaths(buildStageRoots(request.workspaces))
      : buildPaths(request.workspaces),
    // Never staged: the `bin` layer has nothing to prune, so it keeps the
    // cheaper form where tar recurses the directory itself.
    bin: binPaths(cargoHome),
  };
}

/** The stage roots a layer archives from, or none when it is not staged. */
function stageRootsFor(
  layer: CacheLayerId,
  workspaces: Workspace[],
  cargoHome: string,
): StageRoot[] {
  if (layer === "build") return buildStageRoots(workspaces);
  if (layer === "registry") return [registryStageRoot(cargoHome)];
  return [];
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
  prune: PrunePolicy,
): LayerPlan[] {
  const pathsByLayer = layerPathsByLayer(request, cargoHome, prune);
  return request.layers.map((layer) => {
    const derived = cache.layers[layer]!;
    const stageRoots =
      prune === "off"
        ? []
        : stageRootsFor(layer, request.workspaces, cargoHome);
    return {
      layer,
      key: derived.key,
      restoreKeys: derived.restoreKeys,
      paths: pathsByLayer[layer],
      ...(stageRoots.length > 0 ? { stageRoots } : {}),
    };
  });
}

/**
 * Moves a staged layer's files back into the tree they belong to.
 *
 * A staged archive unpacks into `<tree>/.rust-toolchain-stage/…`, which is
 * where nothing looks for it — cargo reads `target/debug`, not
 * `target/.rust-toolchain-stage/debug`. This is the step that makes a restore
 * mean anything, and it is deliberately the last thing the restore does.
 *
 * Caught per layer and reduced to a warning, like every other cache failure:
 * a stage that could not be unpacked leaves the tree exactly as the job found
 * it, which is a cold build and not a broken one.
 */
function unstageRestored(
  deps: ActionDeps,
  restored: RestoredLayer[],
  plans: LayerPlan[],
): void {
  for (const plan of plans) {
    if (!plan.stageRoots) continue;
    const outcome = restored.find((entry) => entry.layer === plan.layer);
    if (!outcome || outcome.result === "miss") continue;

    for (const root of plan.stageRoots) {
      try {
        const { staged, failed } = unstageFiles(root, deps.stageFs);
        deps.core.info(
          `${plan.layer}: restored ${staged} file(s) into ${root.sourceDir}` +
            (failed > 0 ? `, ${failed} could not be moved` : ""),
        );
      } catch (error) {
        deps.core.warning(
          `${plan.layer}: could not unpack ${root.stageDir}, continuing ` +
            `without it — ${describeError(error)}`,
        );
      }
    }
  }
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

  const plans = buildLayerPlans(cacheRequest, cache, cargoHome, prune);
  const restored = await restoreLayers(deps.cache, plans, {
    info: deps.core.info,
    warning: deps.core.warning,
  });
  unstageRestored(deps, restored, plans);

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
      // An exact `bin` restore is a digest match on the resolved tool set, so
      // a tool that will not report its own version is provably the right one
      // and must not be rebuilt from source.
      binRestoredExactly: cache.layers.bin?.result === "exact",
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
  /**
   * Every file under a directory, recursively; empty when it is absent.
   *
   * The absence half is part of the contract, not a convenience: several of
   * the paths this walks are legitimately optional, and an adapter that throws
   * on them takes a layer's save down with it.
   */
  walk: (dir: string) => string[];
  /** One directory's entries, for reading `.fingerprint/`. */
  readdir: (dir: string) => string[];
  /** Links the keep-set into each staged layer's stage directory. */
  stageFs: StageFs;
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

/** The keep-set, resolved once and shared by every staged layer. */
interface ResolvedKeepSet {
  /**
   * Whether the keep-set may be used at all.
   *
   * `false` is the fallback signal, and every failure mode converges on it:
   * `cargo metadata` missing, a workspace with no manifest, a lockfile
   * `--locked` rejects, a fingerprint layout cargo has restructured, and a
   * tree with too little to drop to be worth resolving.
   */
  usable: boolean;
  /** Files to keep under the workspaces' target directories. */
  build: string[];
  /** The resolved package set, for selecting `.crate` archives. */
  packages: ReadonlySet<string>;
  /** Bytes the keep-set excludes, for the job summary. */
  droppedBytes: number;
}

const UNUSABLE_KEEP_SET: ResolvedKeepSet = {
  usable: false,
  build: [],
  packages: new Set(),
  droppedBytes: 0,
};

/** Regenerable subtrees, excluded from the build layer whether pruned or not. */
const BUILD_EXCLUDED = /\/(incremental|examples)\//;

/**
 * Resolves the keep-set, or reports that the whole tree should be staged.
 *
 * Returns `usable: false` rather than throwing on every failure path. The
 * caller turns that into "stage everything", which is the invariant this phase
 * turns on: **an empty or unusable keep-set must never be saved.** Saving one
 * is not a small cache but a poisoned one — an entry that exists, hits its
 * key, restores nothing, and leaves every later job rebuilding while believing
 * it was warm.
 */
async function resolveKeepSet(
  state: CachePhaseState,
  deps: PostDeps,
): Promise<ResolvedKeepSet> {
  const packages = new Set<string>();
  const keep: string[] = [];
  let allFiles: string[] = [];

  for (const workspace of state.workspaces) {
    const set: PackageSet = parsePackageSet(
      await deps.metadata.read(workspace.manifestDir),
    );
    for (const id of set.packages) packages.add(id);

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
    if (!result.usable) return UNUSABLE_KEEP_SET;
    keep.push(...result.keep);
    if (result.unattributable.length > 0) {
      deps.core.info(
        `prune: ${result.unattributable.length} artifact(s) under ` +
          `${workspace.targetDir} matched no package and were ` +
          `${state.prune === "safe" ? "kept" : "dropped"}`,
      );
    }
  }

  if (keep.length === 0 || packages.size === 0) return UNUSABLE_KEEP_SET;

  // The guard Task 4's measurement forced. Both measurements are needed for
  // `prunedBytes` regardless, so deciding on them is nearly free.
  const total = deps.measure(allFiles).bytes;
  const kept = deps.measure(keep).bytes;
  const dropped = total - kept;
  if (total === 0 || dropped / total < PRUNE_WORTH_IT) {
    deps.core.info(
      `prune: would drop ${dropped} of ${total} bytes, below the ` +
        `${PRUNE_WORTH_IT * 100}% threshold, so the whole tree is staged`,
    );
    return UNUSABLE_KEEP_SET;
  }

  return { usable: true, build: keep, packages, droppedBytes: dropped };
}

/**
 * Whether an error means "that path is not there" rather than "I could not
 * read it".
 *
 * A deliberate twin of the predicate in `cache/budget.ts`, which draws the
 * same distinction for the same reason: a missing directory contributes a
 * true zero, while an unreadable one contributes an unknown, and treating the
 * second as the first silently ships a smaller archive than the caller asked
 * for. Kept local rather than exported, because widening the library's public
 * surface for one five-line predicate costs more than the duplication does.
 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Every file under a directory, treating an absent one as empty.
 *
 * Each of the registry's three roots is genuinely optional: `git/db` does not
 * exist until a workspace takes a git dependency, and none of them exist
 * before the first fetch. An absent root is nothing to archive, not a fault —
 * but the adapter is `readdirSync`, which throws ENOENT rather than returning
 * nothing, and that throw once cost every pruned layer its save.
 *
 * Only a missing directory is swallowed. An unreadable one still throws, so
 * the caller drops the layer with a warning rather than quietly saving an
 * archive with a hole in it.
 */
function walkOptional(dir: string, deps: PostDeps): string[] {
  try {
    return deps.walk(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Every file the registry layer archives when nothing is pruned. */
function registryAllFiles(cargoHome: string, deps: PostDeps): string[] {
  // `registry/src` holds extracted sources, regenerable from the `.crate`
  // files in `registry/cache`, so it is simply never listed.
  return [
    `${cargoHome}/registry/index`,
    `${cargoHome}/registry/cache`,
    `${cargoHome}/git/db`,
  ].flatMap((dir) => walkOptional(dir, deps));
}

/**
 * The registry layer's keep-set.
 *
 * Version-exact, unlike the build layer. A crate archive is named
 * `<name>-<version>.crate`, so the version is in the filename — where the
 * build layer's fingerprint directories record only `<name>-<hash>` and force
 * attribution by name alone. Pruning here is therefore precise: a crate that
 * left the lockfile is dropped even when another version of it stayed.
 */
function registryKeepFiles(
  cargoHome: string,
  packages: ReadonlySet<string>,
  deps: PostDeps,
): string[] {
  const wanted = new Set(
    [...packages].map((id) => {
      const at = id.lastIndexOf("@");
      return `${id.slice(0, at)}-${id.slice(at + 1)}.crate`;
    }),
  );
  const crates = walkOptional(`${cargoHome}/registry/cache`, deps).filter(
    (file) => wanted.has(file.slice(file.lastIndexOf("/") + 1)),
  );

  // The index is never pruned: it is what makes a `.crate` resolvable at all,
  // it is shared across every package rather than owned by one, and it is
  // regenerated by a network round-trip rather than from anything on disk.
  return [
    ...walkOptional(`${cargoHome}/registry/index`, deps),
    ...crates,
    ...walkOptional(`${cargoHome}/git/db`, deps),
  ];
}

/** Which files one stage root should be filled with. */
function filesToStage(
  layer: CacheLayerId,
  root: StageRoot,
  keep: ResolvedKeepSet,
  deps: PostDeps,
): string[] {
  if (layer === "registry") {
    return keep.usable
      ? registryKeepFiles(root.sourceDir, keep.packages, deps)
      : registryAllFiles(root.sourceDir, deps);
  }
  return keep.usable
    ? keep.build.filter((file) => file.startsWith(`${root.sourceDir}/`))
    : deps.walk(root.sourceDir).filter((file) => !BUILD_EXCLUDED.test(file));
}

/**
 * Fills each staged layer's stage directory, ready for `saveLayers` to archive.
 *
 * This replaces narrowing each plan's `paths` array to the keep-set, which was
 * unreadable by construction. `@actions/cache` matches an entry on
 * `(key, sha256(paths | …))`, so an entry saved under a content-derived paths
 * array can never be found again: the restore that would need it does not yet
 * know the content, asks under the coarse array, and misses forever while
 * still paying the upload on every run. `stagePaths` carries the full
 * reasoning.
 *
 * The keep-set now decides what is *linked into* the stage, and the stage
 * directory is what gets archived — so pruning changes an archive's contents
 * without touching its identity. Nothing is removed from the working tree,
 * exactly as before: a link is an addition, and a save failure still cannot
 * damage the checkout.
 */
async function stageLayers(
  plans: LayerPlan[],
  state: CachePhaseState,
  deps: PostDeps,
): Promise<LayerPlan[]> {
  // The state is a cross-version contract: `action.yml` invokes `dist/index.js`
  // twice as two unrelated processes, and during an upgrade the payload can
  // have been written by a main phase that predates these fields. Absent is
  // therefore an ordinary case meaning "no staging was planned", not a fault —
  // warning about it would fire on every mid-upgrade job for something nobody
  // can act on.
  if (state.prune === undefined || state.workspaces === undefined) return plans;
  if (state.prune === "off") return plans;

  let keep: ResolvedKeepSet;
  try {
    keep = await resolveKeepSet(state, deps);
  } catch (error) {
    // Caught *here* rather than left to `runPost`'s outer guard, and the
    // difference is the whole invariant. Under the old design a throw left the
    // unpruned paths in place, which still archived everything. Under staging
    // it would leave every stage empty and save exactly the poisoned entry the
    // fallback exists to prevent — one that hits its key, restores nothing,
    // and leaves every later job rebuilding while believing it was warm.
    deps.core.warning(
      `prune: could not narrow the cache to the resolved package set, ` +
        `saving everything instead — ${describeError(error)}`,
    );
    keep = UNUSABLE_KEEP_SET;
  }

  const filled: LayerPlan[] = [];
  for (const plan of plans) {
    if (!plan.stageRoots) {
      filled.push(plan);
      continue;
    }

    // Scoped to one layer, because the blast radius of not scoping it is the
    // whole phase. `$CARGO_HOME/git/db` does not exist in a workspace with no
    // git dependencies; the registry file list walked it, the adapter threw
    // ENOENT, and that one absent directory escaped this loop and left every
    // pruned layer unstaged and therefore unsaved. A layer that cannot be
    // staged is a layer this job does not cache — never a reason to drop the
    // ones that could.
    let staged = 0;
    try {
      for (const root of plan.stageRoots) {
        const outcome = stageFiles(
          root,
          filesToStage(plan.layer, root, keep, deps),
          deps.stageFs,
        );
        staged += outcome.staged;
        deps.core.info(
          `${plan.layer}: staged ${outcome.staged} file(s) from ` +
            `${root.sourceDir}` +
            (outcome.failed > 0
              ? `, ${outcome.failed} could not be linked`
              : ""),
        );
      }
    } catch (error) {
      deps.core.warning(
        `${plan.layer}: could not be staged, so it is not saved — ` +
          describeError(error),
      );
      continue;
    }

    // The last guard, and the only one that sees what actually reached the
    // stage rather than what was meant to. Dropping the plan is what stops an
    // empty archive being saved at all.
    if (staged === 0) {
      deps.core.warning(
        `${plan.layer}: nothing was staged, so the layer is not saved — ` +
          `an empty entry would hit its key and restore nothing`,
      );
      continue;
    }

    filled.push(
      keep.usable && plan.layer === "build"
        ? { ...plan, prunedBytes: keep.droppedBytes }
        : plan,
    );
  }
  return filled;
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
 * Removes every stage once its archive has been written.
 *
 * A stage is a hard-linked mirror of the tree it came from, so leaving it
 * behind costs no disk blocks — but it does leave `target/` and `$CARGO_HOME`
 * each carrying a duplicate of themselves, which is confusing to anything that
 * walks the tree and, on a self-hosted runner, outlives the job. Removing a
 * link never touches the file it points at, so this cannot lose work no matter
 * how wrong the keep-set was.
 *
 * Driven from the state's plans rather than the staged ones, so a layer that
 * was dropped for staging nothing still has whatever it managed to create
 * cleaned up.
 *
 * After the save, never before: the archive is written from these very
 * directories.
 */
function clearStages(plans: LayerPlan[], deps: PostDeps): void {
  for (const plan of plans) {
    for (const root of plan.stageRoots ?? []) {
      try {
        deps.stageFs.remove(root.stageDir);
      } catch (error) {
        // The archive is already written, so a stage that will not go away
        // costs a confusing directory and nothing else.
        deps.core.warning(
          `${plan.layer}: could not clear ${root.stageDir} — ` +
            describeError(error),
        );
      }
    }
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
    // No guard of its own, deliberately. `stageLayers` contains every failure
    // it can have -- a keep-set it cannot resolve, and a layer it cannot stage
    // -- because under staging those two are not equivalent to the old
    // "keep the unpruned paths" fallback and cannot share one catch. A guard
    // here could only repeat that badly: the message it used to carry said
    // "saving everything instead", which was true when a failure left the
    // coarse globs in place and is the exact opposite of what an unfilled
    // stage saves. `runPost`'s outer guard remains the backstop.
    const plans = await stageLayers(state.plans, state, deps);

    const savedLayers = await saveLayers({
      client: deps.cache,
      plans,
      restored,
      budget,
      measure: deps.measure,
      log: { info: deps.core.info, warning: deps.core.warning },
    });

    clearStages(state.plans, deps);

    await writeSummarySafely(deps.core, restored, savedLayers);
  } catch (error) {
    deps.core.warning(
      `cache post-processing failed, continuing: ${describeError(error)}`,
    );
  }
}
