// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { join } from "node:path";

import {
  ToolchainSpecBuilder,
  type ToolchainSpec,
} from "@rust-toolchain/builder";
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
import {
  buildActionOutputs,
  toOutputEntries,
  type BooleanInput,
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
  };
  env: Record<string, string | undefined>;
  /** `process.platform` — decides the rustup installer and path layout. */
  platform: string;
  sleep: (ms: number) => void;
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
 * Reads a YAML 1.2 boolean input, defaulting to `fallback` when unset.
 *
 * Matches `@actions/core`'s `getBooleanInput` grammar, and rejects anything
 * else rather than quietly reading a typo as `false`. The raw text is returned
 * alongside the value because the outputs report it: only the raw form
 * distinguishes an explicit `true` from an omitted input that defaulted to it.
 */
function readBooleanInput(
  deps: ActionDeps,
  name: string,
  fallback: boolean,
): BooleanInput {
  const raw = deps.core.getInput(name).trim();
  if (raw === "") return { raw, value: fallback };
  if (["true", "True", "TRUE"].includes(raw)) return { raw, value: true };
  if (["false", "False", "FALSE"].includes(raw)) return { raw, value: false };
  throw new Error(`Input \`${name}\` must be "true" or "false", got "${raw}".`);
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

/** Installs the requested toolchain and publishes the action's outputs. */
export function run(deps: ActionDeps): void {
  try {
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
            `profile, continuing: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
        `rustup default did not succeed, continuing: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      deps,
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

    const outputs = buildActionOutputs({
      spec,
      inputs: config.inputs,
      toml: config.toml,
      setRustupToolchain,
      cacheKey: rustc.info.cacheKey,
      specCacheKey: generateSpecCacheKey(rustc.info.cacheKey, spec),
    });
    for (const [name, value] of toOutputEntries(outputs)) {
      deps.core.setOutput(name, value);
    }
  } catch (error) {
    deps.core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
