// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { CacheClient } from "@rust-toolchain/cache/client";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";

/** Everything needed to restore or save one layer. */
export interface LayerPlan {
  layer: CacheLayerId;
  key: string;
  restoreKeys: string[];
  paths: string[];
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
}

/** The logging surface, narrowed so tests need no `@actions/core`. */
export interface LifecycleLog {
  info: (message: string) => void;
  warning: (message: string) => void;
}

export interface SaveArgs {
  client: CacheClient;
  plans: LayerPlan[];
  restored: RestoredLayer[];
  budget: number;
  measure: (paths: string[]) => number;
  log: LifecycleLog;
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
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return { layer: plan.layer, result: "miss" };
      }
    }),
  );
}

/**
 * Saves the layers worth saving.
 *
 * Two reasons to skip. An exact hit means the entry already exists under that
 * key, so writing it again is pure budget burn — the optimisation the layer
 * split makes safe, because a per-layer key covers everything that could have
 * changed its contents. Over budget means saving would evict other workflows'
 * caches, which is a cost paid by someone who did nothing wrong.
 */
export async function saveLayers(args: SaveArgs): Promise<SavedLayer[]> {
  const { client, plans, restored, budget, measure, log } = args;

  return Promise.all(
    plans.map(async (plan): Promise<SavedLayer> => {
      const previous = restored.find((entry) => entry.layer === plan.layer);
      if (previous?.result === "exact") {
        log.info(`${plan.layer}: unchanged since an exact hit, not saving`);
        return {
          layer: plan.layer,
          saved: false,
          reason: "unchanged since an exact hit",
          bytes: 0,
        };
      }

      const bytes = measure(plan.paths);
      if (budget > 0 && bytes > budget) {
        log.warning(
          `${plan.layer}: ${bytes} bytes exceeds the ${budget}-byte ` +
            "`cache-budget`, so it was not saved. An oversized entry evicts " +
            "other workflows' caches. Raise `cache-budget` to keep it.",
        );
        return {
          layer: plan.layer,
          saved: false,
          reason: `over the ${budget}-byte budget`,
          bytes,
        };
      }

      try {
        await client.save(plan.paths, plan.key);
        log.info(`${plan.layer}: saved ${bytes} bytes as ${plan.key}`);
        return { layer: plan.layer, saved: true, bytes };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warning(`${plan.layer}: save failed, continuing — ${message}`);
        return { layer: plan.layer, saved: false, reason: message, bytes };
      }
    }),
  );
}
