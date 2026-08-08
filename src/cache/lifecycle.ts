// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { MeasuredPaths } from "@rust-toolchain/cache/budget";
import type { CacheClient } from "@rust-toolchain/cache/client";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";
import { describeError } from "@rust-toolchain/errors";

/** Everything needed to restore or save one layer. */
export interface LayerPlan {
  layer: CacheLayerId;
  key: string;
  restoreKeys: string[];
  paths: string[];
  /** Bytes the keep-set excluded, when `paths` came from one. */
  prunedBytes?: number;
}

/** `exact` means the key matched; `partial` means a restore-key prefix did. */
export type LayerResult = "exact" | "partial" | "miss";

export interface RestoredLayer {
  layer: CacheLayerId;
  result: LayerResult;
  restoredKey?: string;
}

export interface SavedLayer {
  layer: CacheLayerId;
  saved: boolean;
  reason?: string;
  bytes: number;
  /**
   * Bytes the keep-set excluded from the archive, when one was used.
   *
   * Absent rather than `0` when no keep-set applied, because "pruned nothing"
   * and "did not prune" are different states and a reader deciding whether
   * `cache-prune` is doing anything has to tell them apart.
   *
   * Excluded, never deleted — see `cache/prune.ts`. This is the size of what
   * the manifest left out, measured on a working tree that still holds it.
   */
  prunedBytes?: number;
}

/** The logging surface, narrowed so tests need no `@actions/core`. */
export interface LifecycleLog {
  info: (message: string) => void;
  warning: (message: string) => void;
}

export interface SaveArgs {
  client: CacheClient;
  plans: LayerPlan[];
  /**
   * The `restoreLayers` outcome for these same `plans`, correlated by
   * `layer`. Callers must derive this from the identical `plans` array —
   * passing a filtered or otherwise mismatched subset leaves a layer with no
   * matching entry, which falls through to measure-and-save as a fail-safe
   * default rather than being rejected.
   */
  restored: RestoredLayer[];
  budget: number;
  measure: (paths: string[]) => MeasuredPaths;
  log: LifecycleLog;
}

/**
 * Everything the main phase hands to the post phase, as one named shape.
 *
 * The two phases are separate process invocations that share nothing but a
 * JSON string in `STATE_cache`, so the write side and the read side used to
 * name `plans`, `restored` and `budget` independently. That made a rename a
 * silent production break with both sides' tests still green: each half agreed
 * with itself. Naming the contract once is what makes the compiler notice.
 */
export interface CachePhaseState {
  plans: LayerPlan[];
  restored: RestoredLayer[];
  budget: number;
}

/**
 * Restores every layer, concurrently, downgrading any failure to a miss.
 *
 * `@actions/cache` throws on service outages and reserved-key races. A job that
 * would otherwise succeed must not fail because a cache was unavailable, so
 * every failure becomes a warning and an ordinary miss.
 */
export async function restoreLayers(
  client: CacheClient,
  plans: LayerPlan[],
  log: LifecycleLog,
): Promise<RestoredLayer[]> {
  return Promise.all(
    plans.map(async (plan): Promise<RestoredLayer> => {
      try {
        const restoredKey = await client.restore(
          plan.paths,
          plan.key,
          plan.restoreKeys,
        );
        if (restoredKey === undefined) {
          log.info(`${plan.layer}: no cache entry matched ${plan.key}`);
          return { layer: plan.layer, result: "miss" };
        }
        const result: LayerResult =
          restoredKey === plan.key ? "exact" : "partial";
        log.info(`${plan.layer}: ${result} match on ${restoredKey}`);
        return { layer: plan.layer, result, restoredKey };
      } catch (error) {
        log.warning(
          `${plan.layer}: restore failed, continuing without it — ` +
            describeError(error),
        );
        return { layer: plan.layer, result: "miss" };
      }
    }),
  );
}

/** A layer that was not written, and why. */
function skipped(
  layer: CacheLayerId,
  reason: string,
  bytes: number,
  prunedBytes?: number,
): SavedLayer {
  return { layer, saved: false, reason, bytes, prunedBytes };
}

/** Either a size, or the reason there is not one. */
type Measurement =
  { measured: true; bytes: number } | { measured: false; message: string };

/**
 * Measures a layer, saying so when the number is only a lower bound.
 *
 * `measurePaths` reports paths it could not read rather than silently counting
 * them as zero, and that distinction only means something if it reaches the
 * job log: a budget checked against a floor is one that merely appears to have
 * been applied.
 */
function measureForSave(
  plan: LayerPlan,
  { measure, log }: SaveArgs,
): Measurement {
  try {
    const { bytes, unmeasured } = measure(plan.paths);
    if (unmeasured.length > 0) {
      log.warning(
        `${plan.layer}: could not read ${unmeasured.length} path(s), so ` +
          `${bytes} bytes is a lower bound on its real size and the ` +
          "`cache-budget` check may pass an entry that should have failed " +
          `it: ${unmeasured.join(", ")}`,
      );
    }
    return { measured: true, bytes };
  } catch (error) {
    return { measured: false, message: describeError(error) };
  }
}

/**
 * Decides whether one layer is worth saving, and saves it if so.
 *
 * Three reasons to skip. An exact hit means the entry already exists under
 * that key, so writing it again is pure budget burn — the optimisation the
 * layer split makes safe, because a per-layer key covers everything that
 * could have changed its contents. A measurement failure means the size of
 * what would be saved is unknown, and writing an entry of unknown size into a
 * shared budget is the unsafe direction — refusing to save is the fail-safe
 * one. Over budget means saving would evict other workflows' caches, which is
 * a cost paid by someone who did nothing wrong.
 */
async function saveLayer(
  plan: LayerPlan,
  previous: RestoredLayer | undefined,
  args: SaveArgs,
): Promise<SavedLayer> {
  const { client, budget, log } = args;
  const { layer } = plan;

  if (previous?.result === "exact") {
    log.info(`${layer}: unchanged since an exact hit, not saving`);
    return skipped(layer, "unchanged since an exact hit", 0, plan.prunedBytes);
  }

  const measurement = measureForSave(plan, args);
  if (!measurement.measured) {
    const { message } = measurement;
    log.warning(
      `${layer}: could not measure its size, not saving — ${message}`,
    );
    return skipped(
      layer,
      `could not measure its size — ${message}`,
      0,
      plan.prunedBytes,
    );
  }

  const { bytes } = measurement;
  if (budget > 0 && bytes > budget) {
    log.warning(
      `${layer}: ${bytes} bytes exceeds the ${budget}-byte \`cache-budget\`, ` +
        "so it was not saved. An oversized entry evicts other workflows' " +
        "caches. Raise `cache-budget` to keep it.",
    );
    return skipped(
      layer,
      `over the ${budget}-byte budget`,
      bytes,
      plan.prunedBytes,
    );
  }

  try {
    await client.save(plan.paths, plan.key);
    log.info(`${layer}: saved ${bytes} bytes as ${plan.key}`);
    return { layer, saved: true, bytes, prunedBytes: plan.prunedBytes };
  } catch (error) {
    const message = describeError(error);
    log.warning(`${layer}: save failed, continuing — ${message}`);
    return skipped(layer, message, bytes, plan.prunedBytes);
  }
}

/**
 * Saves every layer worth saving, concurrently.
 *
 * Each layer's decision is independent (see `saveLayer`), and each is caught
 * at its own boundary, so one layer's measurement or save failure never loses
 * the results of the others in the same `Promise.all` batch.
 */
export async function saveLayers(args: SaveArgs): Promise<SavedLayer[]> {
  const { plans, restored } = args;

  return Promise.all(
    plans.map((plan) => {
      const previous = restored.find((entry) => entry.layer === plan.layer);
      return saveLayer(plan, previous, args);
    }),
  );
}
