// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { CacheLayerId } from "@rust-toolchain/cache/layers";

/**
 * Joins the populated segments of a cache key with `-`.
 *
 * Empty segments collapse rather than leaving an empty slot: an unset suffix
 * yields `registry-Linux-X64-<hash>`, never `registry-Linux-X64--<hash>`. This
 * is one line here and genuinely awkward in a workflow expression, where there
 * is no filter and the usual workaround is a ternary per segment.
 */
export function joinKeySegments(...segments: (string | undefined)[]): string {
  return segments
    .map((segment) => segment?.trim() ?? "")
    .filter(Boolean)
    .join("-");
}

/** Everything a layer key is derived from. */
export interface CacheKeyContext {
  /** `RUNNER_OS` — cache entries are not portable across operating systems. */
  os: string;
  /** `RUNNER_ARCH` — nor across architectures. */
  arch: string;
  /** Optional caller-supplied discriminator, e.g. a job name. */
  suffix?: string;
  /**
   * The workflow's own `hashFiles` digest over its lockfiles.
   *
   * Supplied rather than computed: `hashFiles` is a workflow-expression
   * function that a Node action cannot call. Do not write the glob pattern
   * into this comment — a lockfile glob contains the characters that close a
   * block comment.
   */
  lockHash?: string;
  /**
   * `generateSpecCacheKey` output: the rustc build plus a digest of the
   * channel, targets, components and profile.
   */
  specCacheKey: string;
  /**
   * Digest of the build-affecting environment, from `hashBuildEnv`.
   *
   * Required rather than optional even though only the build layer uses it: an
   * optional field is one a caller can forget, and forgetting it here means
   * two jobs with different `RUSTFLAGS` silently sharing a key.
   */
  envHash: string;
  /**
   * Digest of the resolved cargo-tool set, from `hashToolSet`.
   *
   * Required for the same reason `envHash` is: only the `bin` layer reads it,
   * and forgetting it would mean two jobs with different tools sharing an
   * entry. `hashToolSet([])` is the honest value when no tools were requested,
   * never the empty string — see that function for why the segment must not
   * collapse.
   */
  toolSetHash: string;
}

/** A layer's exact key and the prefixes GitHub falls back through. */
export interface CacheLayerKey {
  key: string;
  restoreKeys: string[];
}

/**
 * Restore keys are prefix matches, so each rung keeps its trailing `-`.
 *
 * The trailing dash buys the separator, not a boundary. Without it a `ci` rung
 * would also match `...-cinightly-<hash>`, an unrelated job whose suffix merely
 * begins with the same letters. It does not — and cannot — stop `...-ci-`
 * matching `...-ci-nightly-<hash>`: a prefix match has no way to tell where a
 * suffix ends.
 *
 * That residual overlap is deliberate. A job with `cache-key-suffix: ci` will
 * restore the `registry` entry of a job using `ci-nightly`, through the widest
 * rung if not the narrower one. It is harmless: crate sources are
 * toolchain-independent, so a cross-job restore costs nothing and usually
 * helps. The `build` layer is immune for a different reason — its only rung
 * ends in the spec digest, which an entry from another toolchain cannot share.
 */
function ladder(...prefixes: string[]): string[] {
  return [...new Set(prefixes.map((prefix) => `${prefix}-`))];
}

/**
 * How each layer turns a validated context into its key and ladder.
 *
 * A `Record` keyed on `CacheLayerId` rather than a chain of `if`s: adding a
 * layer to `CACHE_LAYER_IDS` then fails to compile here until it is given a
 * deriver, where an `if` would have silently handed the new layer whichever
 * shape the fall-through branch happened to produce. It is not a `switch`
 * because Bun's coverage instrumenter never marks a final `case`'s closing
 * brace as covered — see `AGENTS.md` → Coverage gate gotchas.
 *
 * The two entries differ in exactly one way, and it is the point of the split:
 * `registry` holds downloaded source archives, which any rustc can compile, so
 * its key omits the toolchain entirely. `build` holds compiled artifacts, so
 * its key carries the resolved spec and its ladder never falls back past one —
 * artifacts from another toolchain are discarded on sight, and restoring them
 * costs download time only to re-save them under a new key.
 */
const DERIVERS: Record<
  CacheLayerId,
  (context: CacheKeyContext, root: string) => CacheLayerKey
> = {
  registry: (context, root) => {
    const scoped = joinKeySegments(root, context.suffix);
    return {
      key: joinKeySegments(scoped, context.lockHash),
      restoreKeys: ladder(scoped, root),
    };
  },
  build: (context, root) => {
    const scoped = joinKeySegments(
      root,
      context.suffix,
      context.specCacheKey,
      context.envHash,
    );
    return {
      key: joinKeySegments(scoped, context.lockHash),
      restoreKeys: ladder(scoped),
    };
  },
  // The odd one out twice over, both deliberate.
  //
  // It carries no `suffix`: two jobs resolving the same tool set need
  // byte-identical binaries, so fragmenting by a caller's discriminator would
  // cost sharing and buy nothing. It carries no toolchain, lockfile or
  // environment segment either — excluding rustup's shims (see `binPaths`) is
  // what lets the toolchain leave this key, so bumping stable stops
  // reinstalling every cargo tool.
  //
  // And its ladder DOES fall back, where `build`'s stops one rung short. A
  // partial `bin` restore is useful — three of four tools present means
  // installing one — whereas partial build artifacts are what cargo discards on
  // sight. A restore that turns out to carry none of the requested tools is
  // harmless: the version check reinstalls what is missing.
  bin: (context, root) => ({
    key: joinKeySegments(root, context.toolSetHash),
    restoreKeys: ladder(root),
  }),
};

/** Derives one layer's key and restore ladder. */
export function buildLayerKey(
  layer: CacheLayerId,
  context: CacheKeyContext,
): CacheLayerKey {
  const root = joinKeySegments(layer, context.os, context.arch);
  return DERIVERS[layer](context, root);
}
