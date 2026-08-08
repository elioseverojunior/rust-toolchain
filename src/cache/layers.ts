// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { parseCommaList } from "@rust-toolchain/config";

/**
 * The cache partitions, in canonical order.
 *
 * Each layer is an independent cache entry keyed on what actually invalidates
 * it: `registry` on the dependency set, `build` on the dependency set plus the
 * resolved toolchain spec, `bin` on the resolved cargo-tool set alone.
 * Splitting them is what stops a rustc bump from re-saving the downloaded
 * crates it did not touch, or reinstalling the tools it did not affect.
 */
export const CACHE_LAYER_IDS = ["registry", "build", "bin"] as const;

export type CacheLayerId = (typeof CACHE_LAYER_IDS)[number];

/**
 * Reads the `cache-layers` input into a canonical, deduped layer list.
 *
 * Accepts the same comma, whitespace and newline separators as `targets` and
 * `components`, so a workflow can write the list however reads best. Order is
 * normalised rather than preserved: it changes nothing at runtime, and a stable
 * order keeps the `cache` output diffable between runs.
 */
export function parseCacheLayers(value: string): CacheLayerId[] {
  // Shares `parseCommaList` with `targets` and `components` rather than
  // restating the separator grammar: one definition is what keeps "the same
  // separators as targets" true instead of merely intended.
  const named = parseCommaList(value);

  for (const name of named) {
    if (!(CACHE_LAYER_IDS as readonly string[]).includes(name)) {
      throw new Error(
        `"${name}" is not a cache layer. Valid layers are: ` +
          `${CACHE_LAYER_IDS.join(", ")}.`,
      );
    }
  }

  const requested = new Set(named);
  const layers = CACHE_LAYER_IDS.filter((id) => requested.has(id));

  if (layers.length === 0) {
    throw new Error(
      "`cache-layers` must name at least one of: " +
        `${CACHE_LAYER_IDS.join(", ")}.`,
    );
  }

  return layers;
}
