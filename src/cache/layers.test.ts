// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { CACHE_LAYER_IDS, parseCacheLayers } from "@/cache/layers";

describe("CACHE_LAYER_IDS", () => {
  // Phase A ships two layers. `bin` arrives with cargo-tool installation,
  // because its key hashes resolved tool versions that nothing resolves yet.
  it("names the layers in canonical order", () => {
    expect(CACHE_LAYER_IDS).toEqual(["registry", "build"]);
  });
});

describe("parseCacheLayers", () => {
  it("parses a comma-separated list", () => {
    expect(parseCacheLayers("registry,build")).toEqual(["registry", "build"]);
  });

  it("parses whitespace- and newline-separated lists", () => {
    expect(parseCacheLayers("registry\n  build")).toEqual([
      "registry",
      "build",
    ]);
  });

  it("dedupes repeated layers", () => {
    expect(parseCacheLayers("build,build,registry")).toEqual([
      "registry",
      "build",
    ]);
  });

  // Canonical order, not input order: the order decides nothing at runtime, and
  // a stable order keeps the `cache` output diffable between runs.
  it("returns canonical order regardless of input order", () => {
    expect(parseCacheLayers("build,registry")).toEqual(["registry", "build"]);
  });

  it("rejects an unknown layer and names the valid ones", () => {
    expect(() => parseCacheLayers("registry,bin")).toThrow(
      '"bin" is not a cache layer. Valid layers are: registry, build.',
    );
  });

  it("rejects a list that names no layer", () => {
    expect(() => parseCacheLayers(" , ")).toThrow(
      "`cache-layers` must name at least one of: registry, build.",
    );
  });
});
