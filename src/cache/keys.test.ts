// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { CacheKeyContext } from "@/cache/keys";
import { buildLayerKey, joinKeySegments } from "@/cache/keys";

const base: CacheKeyContext = {
  os: "Linux",
  arch: "X64",
  suffix: "ci",
  lockHash: "a1b2c3",
  specCacheKey: "20250915abcd-1f2e3d4c",
  envHash: "e1e2e3e4",
};

describe("joinKeySegments", () => {
  it("joins every populated segment with a dash", () => {
    expect(joinKeySegments("cargo", "Linux", "X64")).toBe("cargo-Linux-X64");
  });

  // The whole reason this exists. GitHub expressions have no filter, so the
  // YAML version of this leaves `cargo-Linux-X64--<hash>` when a suffix is
  // unset, and that empty slot is part of the key.
  it("drops empty and undefined segments instead of leaving a separator", () => {
    expect(joinKeySegments("cargo", "Linux", "", undefined, "a1b2")).toBe(
      "cargo-Linux-a1b2",
    );
  });

  it("drops whitespace-only segments", () => {
    expect(joinKeySegments("cargo", "   ", "a1b2")).toBe("cargo-a1b2");
  });

  it("trims surrounding whitespace from the segments it keeps", () => {
    expect(joinKeySegments(" cargo ", "Linux")).toBe("cargo-Linux");
  });
});

describe("buildLayerKey", () => {
  it("keys the registry layer on the dependency set alone", () => {
    expect(buildLayerKey("registry", base)).toEqual({
      key: "registry-Linux-X64-ci-a1b2c3",
      restoreKeys: ["registry-Linux-X64-ci-", "registry-Linux-X64-"],
    });
  });

  // The toolchain spec is absent on purpose: downloaded crates are source
  // archives, identical whichever rustc later compiles them.
  it("omits the toolchain spec from the registry key", () => {
    const key = buildLayerKey("registry", base).key;
    expect(key).not.toContain("20250915abcd");
  });

  it("keys the build layer on the dependency set and the toolchain spec", () => {
    expect(buildLayerKey("build", base)).toEqual({
      key: "build-Linux-X64-ci-20250915abcd-1f2e3d4c-e1e2e3e4-a1b2c3",
      restoreKeys: ["build-Linux-X64-ci-20250915abcd-1f2e3d4c-e1e2e3e4-"],
    });
  });

  it("keeps the environment digest out of the registry key", () => {
    expect(buildLayerKey("registry", base).key).not.toContain(base.envHash);
  });

  // Falling back across a different toolchain would restore artifacts cargo
  // discards on sight, then re-save them as a fresh entry — the exact write
  // amplification the layer split exists to remove.
  it("never lets the build ladder cross a toolchain-spec boundary", () => {
    const { restoreKeys } = buildLayerKey("build", base);
    expect(restoreKeys).toHaveLength(1);
    expect(restoreKeys[0]).toContain("20250915abcd-1f2e3d4c");
  });

  it("collapses the suffix slot in both key and ladder when unset", () => {
    const noSuffix: CacheKeyContext = { ...base, suffix: undefined };
    expect(buildLayerKey("registry", noSuffix)).toEqual({
      key: "registry-Linux-X64-a1b2c3",
      restoreKeys: ["registry-Linux-X64-"],
    });
  });

  it("dedupes the ladder when the suffix rung equals the bare rung", () => {
    const noSuffix: CacheKeyContext = { ...base, suffix: "" };
    expect(buildLayerKey("registry", noSuffix).restoreKeys).toEqual([
      "registry-Linux-X64-",
    ]);
  });
});
