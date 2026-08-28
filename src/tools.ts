// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";

import { isRustupIdentifier, parseCommaList } from "@rust-toolchain/config";
import { describeError } from "@rust-toolchain/errors";

/**
 * One entry of the `cargo-tools` input, before any version resolution.
 *
 * `version` is `"latest"` for a bare name, which is a request rather than a
 * value: it does not become concrete until the registry has answered. Anything
 * else is what the caller pinned, and a pinned version never needs the network
 * at all — which is what keeps a registry outage from touching it.
 */
export interface ToolSpec {
  name: string;
  version: string;
  /**
   * The binary to probe, when it is not named after the crate.
   *
   * `ensureTools` asks `<name> --version` whether a tool is already installed,
   * and a spawn error is the only evidence it accepts that the tool is absent.
   * That reading is wrong for a crate whose binaries carry other names —
   * `ignorefile-cli` ships `ign` and `ignorefile` — so the probe spawn-errors,
   * the tool reads as absent, and it is rebuilt from source on every run on top
   * of an exact `bin` cache hit that had already restored it.
   *
   * Optional because the crate name is the right default for almost every
   * crate, and deliberately absent rather than defaulted to the name: an unset
   * field says "nothing was declared", which is what keeps the fallback in one
   * place at the probe rather than smeared across the parser and resolver too.
   */
  bin?: string;
}

/** What a bare name resolves to, and the only non-version `version` value. */
const LATEST = "latest";

/**
 * Reads the `cargo-tools` input into one spec per tool.
 *
 * Accepts the same comma, whitespace and newline separators as `targets` and
 * `components`, through the same `parseCommaList`, so the separator grammar
 * keeps one definition rather than three that agree by intention.
 *
 * Both halves of an entry are validated, not just the name. They reach
 * `cargo install` as argv and commands run without a shell, so this is a
 * second line of defence rather than the only one — but a value that cannot
 * name a crate or a version is a configuration error worth reporting before
 * cargo fails obscurely on it.
 */
export function parseToolSpecs(value: string): ToolSpec[] {
  const specs = parseCommaList(value).map(toSpec);

  // Exact-name matching. crates.io treats `foo-bar` and `foo_bar` as one
  // crate, so that pair slips through here; encoding the registry's
  // normalisation is a bigger claim than this function should make, and the
  // failure mode is a duplicate install rather than a wrong one.
  const seen = new Set<string>();
  for (const { name } of specs) {
    if (seen.has(name)) {
      throw new Error(
        `\`cargo-tools\` lists ${name} more than once. Two versions of one ` +
          "tool cannot both be installed, so pick the one you want rather " +
          "than leaving the choice to the order they were written in.",
      );
    }
    seen.add(name);
  }

  return specs;
}

/**
 * Splits one `<name>[@<version>][:<binary>]` entry.
 *
 * Split on the FIRST `@`, so a second one stays in the version where the
 * identifier check rejects it. Splitting on the last would read
 * `cargo-deny@0.16.1@2.0` as the plausible-looking name `cargo-deny@0.16.1`.
 * The `:` split follows the same rule for the same reason, and runs first so
 * the `@` search never sees the suffix — which is what makes
 * `ignorefile-cli:ign@0.1.0` fail naming the binary, rather than silently
 * parsing as a crate called `ignorefile-cli` with no version.
 */
function toSpec(entry: string): ToolSpec {
  const colon = entry.indexOf(":");
  const crate = colon === -1 ? entry : entry.slice(0, colon);
  const bin = colon === -1 ? undefined : entry.slice(colon + 1);

  const at = crate.indexOf("@");
  const name = at === -1 ? crate : crate.slice(0, at);
  const version = at === -1 ? LATEST : crate.slice(at + 1);

  assertIdentifier("name", name, entry);
  assertIdentifier("version", version, entry);

  // Returned without the key rather than with an undefined one, so "no binary
  // was declared" is the absence of a field everywhere downstream.
  if (bin === undefined) return { name, version };

  assertIdentifier("binary", bin, entry);
  return { name, version, bin };
}

function assertIdentifier(
  kind: "name" | "version" | "binary",
  value: string,
  entry: string,
): void {
  if (isRustupIdentifier(value)) return;
  throw new Error(
    `"${value}" is not a valid cargo tool ${kind}, in \`cargo-tools\` entry ` +
      `"${entry}". Entries look like \`<name>\`, \`<name>@<version>\` or ` +
      "`<name>@<version>:<binary>`, where every part is letters, digits, " +
      "dots, underscores and dashes.",
  );
}

/**
 * The crates.io lookup resolution needs, as a port.
 *
 * The only real implementation lives in `src/index.ts`, which nothing imports
 * and the coverage gate does not measure — the same placement, for the same
 * reason, as the `@actions/cache` adapter behind `CacheClient`.
 */
export interface RegistryClient {
  latestVersion(name: string): Promise<string>;
}

/** A tool with a concrete version, ready to be keyed on and installed. */
export interface ResolvedTool {
  name: string;
  version: string;
  /** The declared probe target, carried through from `ToolSpec.bin`. */
  bin?: string;
}

/** A tool the registry could not answer for, and why. */
export interface UnresolvedTool {
  name: string;
  reason: string;
}

/**
 * Every tool, plus the subset the registry could not answer for.
 *
 * The same shape `measurePaths` returns, and for the same reason: a caller
 * that needs the whole list reads `tools`, and a caller that has to warn about
 * what is missing reads `unresolved` rather than re-deriving it by scanning
 * for a sentinel. `unresolved` is the authoritative signal — a caller must
 * branch on it, never on `version === UNRESOLVED_VERSION`, since nothing stops
 * someone pinning `@unknown` and there is no reason to punish them for it.
 */
export interface ToolResolution {
  tools: ResolvedTool[];
  unresolved: UnresolvedTool[];
}

/** What `resolveToolVersions` needs from the outside. */
export interface ResolveDeps {
  client: RegistryClient;
  /** Total attempts per tool, including the first. */
  attempts: number;
  /** Base of the exponential pause between attempts. */
  backoffMs: number;
  /**
   * Promise-based on purpose, unlike `ActionDeps.sleep`.
   *
   * That one blocks the thread through `Atomics.wait`, which would serialise
   * the concurrent resolution below into one lookup at a time — and its own
   * comment already records that being synchronous is a leftover rather than a
   * requirement.
   */
  delay: (ms: number) => Promise<void>;
}

/**
 * The version reported for a tool the registry could not answer for.
 *
 * Carried so the `cargo-tools` output says something honest rather than
 * omitting the tool, which would read as "not requested".
 */
export const UNRESOLVED_VERSION = "unknown";

/** One tool's outcome, before the two lists are separated. */
interface Outcome {
  tool: ResolvedTool;
  failure?: UnresolvedTool;
}

/**
 * Turns each spec into a concrete version, reporting rather than throwing.
 *
 * Deciding what an outage *means* is the caller's job: a pinned tool never
 * needed the registry, and an unresolved one may still be satisfied by a
 * restored binary. Throwing here would take the whole job down over a lookup
 * whose answer might not have been needed.
 *
 * Runs concurrently, each tool caught at its own boundary, so one unreachable
 * lookup cannot lose the answers the others already produced — the shape
 * `saveLayers` uses for the same reason.
 */
export async function resolveToolVersions(
  specs: ToolSpec[],
  deps: ResolveDeps,
): Promise<ToolResolution> {
  const outcomes = await Promise.all(
    specs.map((spec) => resolveOne(spec, deps)),
  );

  return {
    tools: outcomes.map((outcome) => outcome.tool),
    unresolved: outcomes.flatMap((outcome) =>
      outcome.failure ? [outcome.failure] : [],
    ),
  };
}

async function resolveOne(spec: ToolSpec, deps: ResolveDeps): Promise<Outcome> {
  // Spread rather than rebuilt field by field: a resolved tool IS the spec with
  // a concrete version, and every path out of here has to carry `bin` through.
  // Naming the fields instead would make dropping it on one of the three a
  // one-line omission that no type error catches, since `bin` is optional.
  //
  // A pinned version is already concrete. Returning before touching the client
  // is what makes a registry outage unable to affect a pinned tool at all.
  if (spec.version !== LATEST) {
    return { tool: { ...spec } };
  }

  let reason = "";
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    try {
      const version = await deps.client.latestVersion(spec.name);
      return { tool: { ...spec, version } };
    } catch (error) {
      // The last failure is the one reported: an intermittent first error is
      // less use than whatever the registry said when it finally gave up.
      reason = describeError(error);
      if (attempt < deps.attempts) {
        await deps.delay(deps.backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  return {
    tool: { ...spec, version: UNRESOLVED_VERSION },
    failure: { name: spec.name, reason },
  };
}

/**
 * Digests the resolved tool set into the `bin` key's segment.
 *
 * Lives here rather than in `cache/keys.ts` for the reason `hashBuildEnv`
 * lives in `cache/env.ts` and `generateSpecCacheKey` in `core.ts`: a digest
 * belongs with the thing it digests, and `keys.ts` assembles segments rather
 * than computing them.
 *
 * Sorted before hashing, so declaring the same tools in a different order is
 * the same cache entry. Joined on a newline, which is unambiguous because
 * `parseToolSpecs` has already refused any name or version that could contain
 * one. Truncated to 8 hex characters, the width the other two digests use, so
 * every segment of a derived key reads uniformly.
 *
 * An empty set digests to a real value rather than the empty string.
 * `joinKeySegments` drops an empty segment, so a tools-less job's key would
 * collapse to `bin-<os>-<arch>` while its widest restore rung stayed
 * `bin-<os>-<arch>-` — which matches a tooled job's entry, and the tools-less
 * job would restore binaries it never asked for.
 */
export function hashToolSet(tools: ResolvedTool[]): string {
  const canonical = tools
    .map(({ name, version }) => `${name}@${version}`)
    .sort()
    .join("\n");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** Outcome of one process invocation, as this module needs it. */
export interface ToolExecResult {
  status: number | null;
  stdout?: string;
  error?: Error;
}

export interface ToolExecOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  capture?: boolean;
}

/**
 * Everything `ensureTools` touches outside itself.
 *
 * The exec signature is structurally identical to `ActionDeps`'s and is
 * redeclared rather than imported on purpose: `src/action.ts` imports this
 * module, so taking its type would be a cycle. Same reasoning as `InputReader`
 * in `src/inputs.ts`, and the same reason `ResolveDeps` takes its retry policy
 * as values rather than reading `action.ts`'s constants.
 *
 * `sleep` is synchronous here where `ResolveDeps.delay` is not, and the
 * difference is not an oversight: installs run through `spawnSync`, one at a
 * time, so there is no concurrency for a blocking pause to serialise.
 */
export interface EnsureDeps {
  exec: (file: string, args: string[], opts: ToolExecOptions) => ToolExecResult;
  env: Record<string, string | undefined>;
  /** Total attempts per install, including the first. */
  attempts: number;
  backoffMs: number;
  sleep: (ms: number) => void;
  /** `cargo install` compiles from source, so this is generous by design. */
  timeoutMs: number;
  log: { info: (message: string) => void; warning: (message: string) => void };
  /**
   * Whether the `bin` layer restored on an *exact* key match.
   *
   * The `bin` key is a digest of the resolved tool set, so an exact match
   * means the archive was written by a job that resolved to these same names
   * at these same versions — proof enough to keep a binary that will not
   * report its own version. A prefix match carries no such guarantee: the
   * ladder deliberately falls back, so a partial restore may hold an older
   * tool set entirely, and a pinned version would then be silently wrong.
   */
  binRestoredExactly: boolean;
}

/** What happened to one requested tool. */
export interface ToolOutcome {
  name: string;
  version: string;
  /**
   * `kept` — already present at the resolved version, so nothing ran.
   * `installed` — absent or at the wrong version, so `cargo install` ran.
   * `unverified` — the registry could not be reached and a binary of that name
   * was already present, so it is used without knowing its version (D1).
   */
  action: "kept" | "installed" | "unverified";
}

/** The first semver-shaped token in a `--version` banner, if there is one. */
export function parseToolVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(output)?.[1];
}

/**
 * What probing an installed tool established.
 *
 * `present` and `version` are deliberately separate. Collapsing them into one
 * `string | undefined` conflates "the binary is not there" with "the binary is
 * there and will not tell me", and the two demand opposite responses: the
 * first has to install, the second usually must not. `cargo-binstall` is the
 * case that forces the distinction — its clap parser defines
 * `--version <VERSION>` as the crate version to install, shadowing the
 * conventional flag entirely, so `cargo-binstall --version` exits non-zero
 * with `a value is required for '--version <VERSION>'`. Read as "absent", that
 * rebuilds it from source on every job, discarding the `bin` layer that had
 * just restored it.
 */
type ToolProbe = { present: false } | { present: true; version?: string };

/** Asks an installed tool its version, distinguishing absent from mute. */
function probeTool(name: string, deps: EnsureDeps): ToolProbe {
  const result = deps.exec(name, ["--version"], {
    env: deps.env,
    timeoutMs: deps.timeoutMs,
    capture: true,
  });
  // A spawn error is the only evidence that the binary is not there at all.
  // Anything that ran — whatever it exited with — is installed.
  if (result.error) return { present: false };
  if (result.status !== 0) return { present: true };
  return { present: true, version: parseToolVersion(result.stdout ?? "") };
}

/**
 * Installs one tool, retrying the way every network-bound command here does.
 *
 * `--locked` so the crate's own lockfile decides its dependencies rather than
 * whatever resolves today, and `--force` because `cargo install` refuses to
 * replace an existing binary without it — which is exactly the case that
 * brought us here.
 */
function installTool(tool: ResolvedTool, deps: EnsureDeps): void {
  const args = [
    "install",
    tool.name,
    "--version",
    tool.version,
    "--locked",
    "--force",
  ];

  let last: ToolExecResult = { status: null };
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    last = deps.exec("cargo", args, {
      env: deps.env,
      timeoutMs: deps.timeoutMs,
    });
    if (last.status === 0) return;
    if (attempt < deps.attempts) {
      deps.sleep(deps.backoffMs * 2 ** (attempt - 1));
    }
  }

  const detail = last.error
    ? `could not run: ${last.error.message}`
    : `failed with exit code ${last.status}`;
  throw new Error(`cargo ${args.join(" ")} ${detail}`);
}

/**
 * Brings every requested tool to its resolved version, installing what is not
 * already there.
 *
 * Called *after* the cache restore, never before: a restored `bin` layer is
 * what makes most of these a no-op, and checking first would install tools the
 * cache was about to supply. It is also why this lives here rather than in
 * `cache/lifecycle.ts` — verification needs `exec`, which that module
 * deliberately does not have, so it stays testable against plain values.
 *
 * D1 lands here. A tool whose version the registry could not supply is
 * accepted if a binary of that name is present — that binary may well have come
 * from the widest `bin` rung — and the step warns rather than guessing at a
 * version. With nothing present there is nothing to fall back to, so it fails:
 * a missing tool breaks the job either way, and failing here says why.
 */
export function ensureTools(
  resolution: ToolResolution,
  deps: EnsureDeps,
): ToolOutcome[] {
  const unresolved = new Set(resolution.unresolved.map((tool) => tool.name));

  return resolution.tools.map((tool) => {
    // The declared binary if there is one, the crate name otherwise. This
    // fallback is the ONLY place the default lives: `cargo install` still takes
    // `tool.name`, and the outputs and the `bin` cache key still read
    // `name@version`, so a declared binary redirects the probe and nothing else.
    const probe = probeTool(tool.bin ?? tool.name, deps);
    // Narrowed once: `version` is only meaningful when the binary is present,
    // and reading it through the union at each use would not type-check.
    const version = probe.present ? probe.version : undefined;

    if (unresolved.has(tool.name)) {
      if (!probe.present) {
        throw new Error(
          `${tool.name} could not be resolved against the registry and is not ` +
            "installed, so there is nothing to fall back to. Pin a version " +
            `(\`${tool.name}@<version>\`) to skip the registry entirely.`,
        );
      }
      deps.log.warning(
        `${tool.name}: the registry could not be reached, so the installed ` +
          `binary (reporting ${version ?? "no version"}) is used as-is ` +
          `and its version is published as ${UNRESOLVED_VERSION}. Pin a ` +
          "version to avoid this.",
      );
      return { name: tool.name, version: tool.version, action: "unverified" };
    }

    if (version === tool.version) {
      deps.log.info(`${tool.name}: already at ${tool.version}`);
      return { name: tool.name, version: tool.version, action: "kept" };
    }

    // Present, ran, and reported nothing a version could be read from. An
    // exact `bin` restore already proves it is the binary this tool set
    // resolved to, so reinstalling would spend minutes rebuilding what the
    // cache just supplied — which is exactly what `cargo-binstall` did.
    if (probe.present && version === undefined && deps.binRestoredExactly) {
      deps.log.info(
        `${tool.name}: restored from an exact bin cache hit and does not ` +
          "report a version, so it is kept as-is",
      );
      return { name: tool.name, version: tool.version, action: "kept" };
    }

    deps.log.info(
      `${tool.name}: installing ${tool.version}` +
        (version === undefined ? "" : `, replacing ${version}`),
    );
    installTool(tool, deps);
    return { name: tool.name, version: tool.version, action: "installed" };
  });
}
