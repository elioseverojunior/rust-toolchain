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
  it("exposes every value export of the eleven library modules", () => {
    expect(Object.keys(lib).sort()).toEqual(
      [
        // action.ts
        "run",
        // builder.ts
        "ToolchainSpec",
        "ToolchainSpecBuilder",
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
        // cache/paths.ts
        "parseWorkspaces",
        "registryPaths",
        "buildPaths",
        // config.ts
        "RUSTUP_PROFILES",
        "DEFAULT_PROFILE",
        "PROFILE_COMPONENTS",
        "resolveRustupEnv",
        "assertProfileAvailable",
        "mergeConfig",
        "parseCommaList",
        // core.ts
        "resolveChannel",
        "parseRustToolchainToml",
        "generateCacheKey",
        "generateSpecCacheKey",
        "parseRustcVersion",
        // inputs.ts
        "readBooleanInput",
        // outputs.ts
        "buildActionOutputs",
        "toOutputEntries",
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
    });
    expect(outputs.target).toBe("wasm32-unknown-unknown");
  });

  it("resolves the @/ alias to a single module", () => {
    expect(resolveChannel("nightly-2025-01-01")).toBe("nightly-2025-01-01");
  });
});
