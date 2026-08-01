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
      "| registry | exact | unchanged since an exact hit |",
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
