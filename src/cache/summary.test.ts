// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { renderSummary } from "@/cache/summary";

describe("renderSummary", () => {
  it("renders one row per layer with its result and size", () => {
    const table = renderSummary(
      [
        { layer: "registry", result: "exact", restoredKey: "registry-a1" },
        { layer: "build", result: "miss" },
      ],
      [
        {
          layer: "registry",
          saved: false,
          reason: "unchanged since an exact hit",
          bytes: 0,
        },
        { layer: "build", saved: true, bytes: 2048 },
      ],
    );

    expect(table).toContain(
      "| registry | exact | — | unchanged since an exact hit |",
    );
    expect(table).toContain("| build | miss |");
    expect(table).toContain("2048");
  });

  // A restore-only run is a normal outcome, not an absence of one, so it must
  // still report what it restored rather than rendering nothing.
  it("renders rows even when nothing was saved", () => {
    const table = renderSummary(
      [{ layer: "registry", result: "partial", restoredKey: "registry-" }],
      [],
    );
    expect(table).toContain("| registry | partial |");
  });
});

describe("pruning columns", () => {
  // D4. The number that makes pruning legible: without it a run that dropped
  // 100 MB and one that dropped nothing render identically.
  it("reports the bytes the keep-set excluded", () => {
    const table = renderSummary(
      [{ layer: "build", result: "partial" }],
      [{ layer: "build", saved: true, bytes: 118, prunedBytes: 101 }],
    );
    expect(table).toContain("| build | partial | 101 | saved 118 bytes |");
  });

  // An em dash rather than `0`, because zero-pruned and pruning-not-attempted
  // are different states and a reader deciding whether `cache-prune` is doing
  // anything needs to tell them apart.
  it("renders an unpruned layer as a dash, not as zero", () => {
    const table = renderSummary(
      [{ layer: "registry", result: "miss" }],
      [{ layer: "registry", saved: true, bytes: 10 }],
    );
    expect(table).toContain("| registry | miss | — | saved 10 bytes |");
  });

  it("names the pruned column in the header", () => {
    expect(renderSummary([], [])).toContain(
      "| Layer | Result | Pruned | Save |",
    );
  });
});
