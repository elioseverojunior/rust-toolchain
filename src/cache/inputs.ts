// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { parseSize } from "@rust-toolchain/cache/budget";
import { hashBuildEnv } from "@rust-toolchain/cache/env";
import {
  buildLayerKey,
  type CacheKeyContext,
  type CacheLayerKey,
} from "@rust-toolchain/cache/keys";
import {
  CACHE_LAYER_IDS,
  parseCacheLayers,
  type CacheLayerId,
} from "@rust-toolchain/cache/layers";
import { parseWorkspaces, type Workspace } from "@rust-toolchain/cache/paths";
import { generateSpecCacheKey } from "@rust-toolchain/core";
import { readBooleanInput } from "@rust-toolchain/inputs";
import type { CacheOutputs } from "@rust-toolchain/outputs";

/**
 * Everything this module reads from the action's environment.
 *
 * `ActionDeps` would satisfy it many times over, which is the point: taking the
 * whole surface would mean importing `src/action.ts` for the type while
 * `action.ts` imports this module back. `{ getInput: deps.core.getInput, env:
 * deps.env }` is the adapter at the one call site.
 */
export interface CacheInputSource {
  getInput: (name: string) => string;
  env: Record<string, string | undefined>;
}

/**
 * Every Phase A layer keys on the dependency set, so an absent hash makes the
 * key constant: it hits exactly forever, never re-saves, and serves stale
 * crates for the life of the repository. That is worse than failing here.
 */
const MISSING_LOCK_HASH_MESSAGE =
  "`cache-key-hash` is required when `cache` is true. This action cannot " +
  "compute it — `hashFiles()` is a workflow-expression function — so " +
  "pass the workflow's own value:\n" +
  "  cache-key-hash: ${{ hashFiles('**/Cargo.lock') }}\n" +
  "Without it the cache keys never change: they hit exactly on every " +
  "run and serve the same crates for the life of the repository.";

/** `actions/cache` rejects any key longer than this. */
const MAX_CACHE_KEY_LENGTH = 512;

/**
 * A spec digest standing in for the one this run has yet to produce.
 *
 * The real digest is not known until rustc has run, and the length check
 * deliberately happens before the install rather than after it. Built through
 * `generateSpecCacheKey` itself, from the widest rustc key `generateCacheKey`
 * can return, so the stand-in is never narrower than the real value and the
 * two stay in step without pinning a width here as a literal that could drift.
 */
const SPEC_CACHE_KEY_STAND_IN = generateSpecCacheKey("0".repeat(12), {
  channel: "",
  targets: [],
  components: [],
});

/** Anything that would make a key ambiguous once it reaches a workflow. */
const INVALID_SUFFIX_CHARACTER = /[,\s]/;

/**
 * Reads a runner-provided environment value that a key cannot do without.
 *
 * `joinKeySegments` drops empty segments, which is right for an unset suffix
 * and wrong here: a blank `RUNNER_OS` would yield `registry-X64-<hash>`, a
 * plausible-looking key that collides across operating systems and whose widest
 * restore rung matches every entry in the repository. Cache entries are not
 * portable between operating systems or architectures, so a missing one is a
 * broken environment, not a defaultable value.
 */
function requireRunnerEnv(source: CacheInputSource, name: string): string {
  const value = (source.env[name] ?? "").trim();
  if (value) return value;
  throw new Error(
    `\`${name}\` is empty, so the derived cache keys would silently drop that ` +
      `segment and collide with keys from other runners. Cache entries are ` +
      `not portable across operating systems or architectures. GitHub sets ` +
      `\`${name}\` on every hosted runner; set it explicitly on a self-hosted ` +
      "one, or leave `cache` unset.",
  );
}

/** Everything a layer key needs except the digest of the installed spec. */
type PendingCacheKeyContext = Omit<CacheKeyContext, "specCacheKey">;

/** The validated cache inputs, ready to be completed with the spec digest. */
export interface CacheRequest {
  layers: CacheLayerId[];
  context: PendingCacheKeyContext;
  workspaces: Workspace[];
  budget: number;
}

/**
 * Fails when a derived key would break a rule `actions/cache` enforces.
 *
 * This action owns key derivation, so it owns the constraints on the result:
 * `actions/cache` rejects a key over 512 characters, and the README's
 * `restore-keys` recipe joins the ladder on a newline, so a key carrying one
 * would arrive at the cache step as two.
 */
function assertKeyIsUsable(
  layer: CacheLayerId,
  key: string,
  suffix: string,
  lockHash: string,
): void {
  if (key.length <= MAX_CACHE_KEY_LENGTH) return;
  throw new Error(
    `The derived \`${layer}\` cache key is ${key.length} characters, but ` +
      `actions/cache rejects any key over ${MAX_CACHE_KEY_LENGTH}. Shorten ` +
      `\`cache-key-suffix\` (${suffix.length} characters) or ` +
      `\`cache-key-hash\` (${lockHash.length} characters).`,
  );
}

/**
 * Reads `cache-key-suffix`, rejecting anything a key cannot carry.
 *
 * `getInput` trims the ends and nothing else, so an embedded newline or a
 * comma reaches the key intact.
 */
function readCacheKeySuffix(source: CacheInputSource): string {
  const suffix = source.getInput("cache-key-suffix").trim();
  if (!INVALID_SUFFIX_CHARACTER.test(suffix)) return suffix;
  throw new Error(
    "`cache-key-suffix` must not contain a comma or whitespace, got " +
      `${JSON.stringify(suffix)}. actions/cache rejects a key containing a ` +
      "comma, and a joined `restore-keys` block splits on a newline, so an " +
      "embedded one would arrive as two keys.",
  );
}

/**
 * Reads and validates every cache input, before anything is installed.
 *
 * Returns `undefined` when caching is off, which is also why none of the other
 * inputs are examined in that case: they describe a key nobody asked for.
 *
 * Separate from the derivation below because the two run at opposite ends of
 * `run`. Validation needs no toolchain, and a typo here has to fail on line one
 * telling the caller what to paste — not ten minutes later, after a rustup
 * bootstrap and a toolchain install it then throws away.
 */
export function readCacheRequest(
  source: CacheInputSource,
): CacheRequest | undefined {
  if (!readBooleanInput(source, "cache", false).value) return undefined;

  const layers = parseCacheLayers(
    source.getInput("cache-layers").trim() || CACHE_LAYER_IDS.join(","),
  );

  const lockHash = source.getInput("cache-key-hash").trim();
  if (!lockHash) throw new Error(MISSING_LOCK_HASH_MESSAGE);

  const suffix = readCacheKeySuffix(source);
  const context: PendingCacheKeyContext = {
    os: requireRunnerEnv(source, "RUNNER_OS"),
    arch: requireRunnerEnv(source, "RUNNER_ARCH"),
    suffix,
    lockHash,
    envHash: hashBuildEnv(source.env),
  };

  const workspaces = parseWorkspaces(
    source.getInput("cache-workspaces").trim() || ". -> target",
    (source.env.GITHUB_WORKSPACE ?? "").trim() || ".",
  );
  const budget = parseSize(source.getInput("cache-budget"));

  // Checked against a same-width stand-in for the digest, so the build layer —
  // the longer of the two — is measured as it will actually be derived.
  for (const layer of layers) {
    const { key } = buildLayerKey(layer, {
      ...context,
      specCacheKey: SPEC_CACHE_KEY_STAND_IN,
    });
    assertKeyIsUsable(layer, key, suffix, lockHash);
  }

  return { layers, context, workspaces, budget };
}

/**
 * Completes the validated request into the per-layer keys.
 *
 * Deriving only: `action.ts` hands the result to `restoreLayers` and, through
 * `saveState`, to the post phase's `saveLayers`, and publishes it as the
 * `cache` output for a workflow that would rather drive its own
 * `actions/cache` steps. The lock hash arrives as an input because
 * `hashFiles()` is a workflow-expression function that a Node action cannot
 * call, and taking GitHub's own value keeps the keys interoperable with caches
 * the workflow already has.
 */
export function buildCacheOutputs(
  request: CacheRequest | undefined,
  specCacheKey: string,
): CacheOutputs {
  if (!request) return { enabled: false, layers: {} };

  const context: CacheKeyContext = { ...request.context, specCacheKey };
  const built: Partial<Record<CacheLayerId, CacheLayerKey>> = {};
  for (const layer of request.layers) {
    built[layer] = buildLayerKey(layer, context);
  }
  return { enabled: true, layers: built };
}
