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
 * Splits one `<name>[@<version>]` entry.
 *
 * Split on the FIRST `@`, so a second one stays in the version where the
 * identifier check rejects it. Splitting on the last would read
 * `cargo-deny@0.16.1@2.0` as the plausible-looking name `cargo-deny@0.16.1`.
 */
function toSpec(entry: string): ToolSpec {
  const at = entry.indexOf("@");
  const name = at === -1 ? entry : entry.slice(0, at);
  const version = at === -1 ? LATEST : entry.slice(at + 1);

  assertIdentifier("name", name, entry);
  assertIdentifier("version", version, entry);

  return { name, version };
}

function assertIdentifier(
  kind: "name" | "version",
  value: string,
  entry: string,
): void {
  if (isRustupIdentifier(value)) return;
  throw new Error(
    `"${value}" is not a valid cargo tool ${kind}, in \`cargo-tools\` entry ` +
      `"${entry}". Entries look like \`<name>\` or \`<name>@<version>\`, ` +
      "where both halves are letters, digits, dots, underscores and dashes.",
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
  // A pinned version is already concrete. Returning before touching the client
  // is what makes a registry outage unable to affect a pinned tool at all.
  if (spec.version !== LATEST) {
    return { tool: { name: spec.name, version: spec.version } };
  }

  let reason = "";
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    try {
      const version = await deps.client.latestVersion(spec.name);
      return { tool: { name: spec.name, version } };
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
    tool: { name: spec.name, version: UNRESOLVED_VERSION },
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
