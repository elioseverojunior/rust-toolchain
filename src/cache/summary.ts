// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type {
  RestoredLayer,
  SavedLayer,
} from "@rust-toolchain/cache/lifecycle";

/**
 * Renders the per-layer outcome as a Markdown table.
 *
 * Without this a cold run and a broken key look identical: both report a miss
 * and nothing else. Naming the result, the reason a save was skipped and the
 * bytes involved is what separates them.
 */
export function renderSummary(
  restored: RestoredLayer[],
  saved: SavedLayer[],
): string {
  const rows = restored.map((entry) => {
    const outcome = saved.find((item) => item.layer === entry.layer);
    const note = outcome?.saved
      ? `saved ${outcome.bytes} bytes`
      : (outcome?.reason ?? "not saved");
    return `| ${entry.layer} | ${entry.result} | ${note} |`;
  });

  return ["| Layer | Result | Save |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}
