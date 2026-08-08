// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import * as lib from "@rust-toolchain";

import { resolveChannel } from "@/core";

describe("library barrel", () => {
  // Pins the public surface: removing or renaming an export is a breaking
  // change for consumers and should fail here rather than in their build.
  it("exposes every value export of the eighteen library modules", () => {
    expect(Object.keys(lib).sort()).toEqual(
      [
        // action.ts
        "run",
        "runPost",
        // builder.ts
        "ToolchainSpec",
        "ToolchainSpecBuilder",
        // cache/budget.ts
        "parseSize",
        "measurePaths",
        // cache/env.ts
        "hashBuildEnv",
        // cache/inputs.ts
        "readCacheRequest",
        "buildCacheOutputs",
        // cache/keys.ts
        "joinKeySegments",
        "buildLayerKey",
        // cache/layers.ts
        "CACHE_LAYER_IDS",
        "parseCacheLayers",
        // cache/metadata.ts
        "parsePackageSet",
        // cache/lifecycle.ts
        "restoreLayers",
        "saveLayers",
        // cache/paths.ts
        "parseWorkspaces",
        "registryPaths",
        "buildPaths",
        "binPaths",
        "RUSTUP_SHIMS",
        // cache/summary.ts
        "renderSummary",
        // config.ts
        "RUSTUP_PROFILES",
        "DEFAULT_PROFILE",
        "PROFILE_COMPONENTS",
        "resolveRustupEnv",
        "assertProfileAvailable",
        "mergeConfig",
        "parseCommaList",
        "isRustupIdentifier",
        // core.ts
        "resolveChannel",
        "parseRustToolchainToml",
        "generateCacheKey",
        "generateSpecCacheKey",
        "parseRustcVersion",
        // errors.ts
        "describeError",
        // inputs.ts
        "readBooleanInput",
        // outputs.ts
        "buildActionOutputs",
        "toOutputEntries",
        // tools.ts
        "ensureTools",
        "hashToolSet",
        "parseToolSpecs",
        "parseToolVersion",
        "resolveToolVersions",
        "UNRESOLVED_VERSION",
      ].sort(),
    );
  });

  // The whole reason this barrel exists as a separate file from index.ts.
  // Re-exporting the entry point would make `import "@rust-toolchain"` call
  // run() and shell out to rustup, so guard it in source rather than trusting
  // a comment to survive.
  it("does not re-export the action entry point", () => {
    const source = readFileSync(new URL("./lib.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/export \* from "@rust-toolchain\/action"/);
    expect(source).not.toMatch(/\/index"/);
  });

  it("resolves the @rust-toolchain alias to working implementations", () => {
    const spec = new lib.ToolchainSpecBuilder()
      .withChannel("stable")
      .withTargets("wasm32-unknown-unknown")
      .build();
    const outputs = lib.buildActionOutputs({
      spec,
      inputs: {},
      toml: {},
      setRustupToolchain: { raw: "", value: true },
      cacheKey: "20250915abcd",
      specCacheKey: "20250915abcd-1f2e3d4c",
      cache: { enabled: false, layers: {} },
      cacheHit: false,
      tools: [],
    });
    expect(outputs.target).toBe("wasm32-unknown-unknown");
  });

  it("resolves the @/ alias to a single module", () => {
    expect(resolveChannel("nightly-2025-01-01")).toBe("nightly-2025-01-01");
  });
});
