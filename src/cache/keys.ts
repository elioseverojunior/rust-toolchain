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
  /** `generateSpecCacheKey` output: rustc build plus channel, targets, components, profile. */
  specCacheKey: string;
}

/** A layer's exact key and the prefixes GitHub falls back through. */
export interface CacheLayerKey {
  key: string;
  restoreKeys: string[];
}

/**
 * Restore keys are prefix matches, so each rung keeps its trailing `-`.
 *
 * Without it, a `ci` suffix rung would also match a `ci-nightly` entry and
 * restore a cache built for a different job.
 */
function ladder(...prefixes: string[]): string[] {
  return [...new Set(prefixes.map((prefix) => `${prefix}-`))];
}

/**
 * Derives one layer's key and restore ladder.
 *
 * The two layers differ in exactly one way, and it is the point of the split:
 * `registry` holds downloaded source archives, which any rustc can compile, so
 * its key omits the toolchain entirely. `build` holds compiled artifacts, so
 * its key carries the resolved spec and its ladder never falls back past one —
 * artifacts from another toolchain are discarded on sight, and restoring them
 * costs download time only to re-save them under a new key.
 *
 * Written as an early return rather than a `switch`: `CacheLayerId` has
 * exactly two members, so TypeScript narrows `layer` to `"build"` below
 * without an `else` or a trailing `default`, and Bun's coverage instrumenter
 * does not double-count a final `switch` case's closing brace as a phantom
 * uncovered line the way it does here.
 */
export function buildLayerKey(
  layer: CacheLayerId,
  context: CacheKeyContext,
): CacheLayerKey {
  const root = joinKeySegments(layer, context.os, context.arch);

  if (layer === "registry") {
    const scoped = joinKeySegments(root, context.suffix);
    return {
      key: joinKeySegments(scoped, context.lockHash),
      restoreKeys: ladder(scoped, root),
    };
  }

  const scoped = joinKeySegments(root, context.suffix, context.specCacheKey);
  return {
    key: joinKeySegments(scoped, context.lockHash),
    restoreKeys: ladder(scoped),
  };
}
