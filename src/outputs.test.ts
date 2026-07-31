// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { ToolchainSpecBuilder, type ToolchainSpec } from "@/builder";
import type { RustupProfile, ToolchainInputs } from "@/config";
import type { ToolchainTomlConfig } from "@/core";
import {
  buildActionOutputs,
  toOutputEntries,
  type ActionOutputs,
  type ActionOutputsArgs,
  type CacheOutputs,
} from "@/outputs";

const spec = (
  overrides: {
    channel?: string;
    targets?: string[];
    components?: string[];
    profile?: RustupProfile;
  } = {},
): ToolchainSpec => {
  const builder = new ToolchainSpecBuilder()
    .withChannel(overrides.channel ?? "1.90.0")
    .withTargets(...(overrides.targets ?? []))
    .withComponents(...(overrides.components ?? []));
  if (overrides.profile) builder.withProfile(overrides.profile);
  return builder.build();
};

const args = (
  overrides: Partial<ActionOutputsArgs> = {},
): ActionOutputsArgs => ({
  spec: spec({ profile: "minimal" }),
  inputs: {},
  toml: {},
  setRustupToolchain: { raw: "", value: true },
  cacheKey: "20250915abcd",
  specCacheKey: "20250915abcd-1f2e3d4c",
  cache: { enabled: false, layers: {} },
  ...overrides,
});

describe("buildActionOutputs", () => {
  it("reports the resolved channel as both toolchain and name", () => {
    const outputs = buildActionOutputs(
      args({
        spec: spec({ channel: "nightly-2025-01-01", profile: "default" }),
      }),
    );
    expect(outputs.toolchain).toBe("nightly-2025-01-01");
    expect(outputs.name).toBe("nightly-2025-01-01");
  });

  it("carries targets and components through as arrays", () => {
    const outputs = buildActionOutputs(
      args({
        spec: spec({
          targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
          components: ["clippy", "rustfmt"],
          profile: "minimal",
        }),
      }),
    );
    expect(outputs.targets).toEqual([
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
    expect(outputs.components).toEqual(["clippy", "rustfmt"]);
  });

  // `targets` is a merged list; `target` names its first entry so the common
  // single-target job has a scalar to read. mergeConfig orders inputs first,
  // so this is the caller's own target whenever they named one.
  it("reports the first resolved target as `target`", () => {
    const outputs = buildActionOutputs(
      args({
        spec: spec({
          targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
          profile: "minimal",
        }),
      }),
    );
    expect(outputs.target).toBe("wasm32-unknown-unknown");
  });

  it("reports an empty `target` when no targets were resolved", () => {
    const outputs = buildActionOutputs(args());
    expect(outputs.target).toBe("");
    expect(outputs.targets).toEqual([]);
  });

  it("reports the resolved profile", () => {
    const outputs = buildActionOutputs(
      args({ spec: spec({ profile: "complete", channel: "nightly" }) }),
    );
    expect(outputs.profile).toBe("complete");
  });

  // mergeConfig always resolves a profile, but ToolchainSpec permits none, so
  // the mapping must not emit `undefined` into a string-typed output.
  it("reports an empty profile when the spec carries none", () => {
    const outputs = buildActionOutputs(args({ spec: spec() }));
    expect(outputs.profile).toBe("");
  });

  it("reports set-rustup-toolchain as a real boolean", () => {
    expect(
      buildActionOutputs(
        args({ setRustupToolchain: { raw: "", value: true } }),
      )["set-rustup-toolchain"],
    ).toBe(true);
    expect(
      buildActionOutputs(
        args({ setRustupToolchain: { raw: "false", value: false } }),
      )["set-rustup-toolchain"],
    ).toBe(false);
  });

  it("carries both cache keys through", () => {
    const outputs = buildActionOutputs(args());
    expect(outputs.cachekey).toBe("20250915abcd");
    expect(outputs["cachekey-full"]).toBe("20250915abcd-1f2e3d4c");
  });

  describe("inputs provenance", () => {
    it("echoes the raw action inputs verbatim", () => {
      const inputs: ToolchainInputs = {
        toolchain: "stable 2 releases ago",
        targets: "wasm32-unknown-unknown, aarch64-apple-darwin",
        target: "x86_64-pc-windows-gnu",
        components: "clippy rustfmt",
        profile: "minimal",
      };
      const outputs = buildActionOutputs(
        args({ inputs, setRustupToolchain: { raw: "false", value: false } }),
      );
      expect(outputs.inputs).toEqual({
        toolchain: "stable 2 releases ago",
        targets: "wasm32-unknown-unknown, aarch64-apple-darwin",
        target: "x86_64-pc-windows-gnu",
        components: "clippy rustfmt",
        profile: "minimal",
        "set-rustup-toolchain": "false",
      });
    });

    // The point of the provenance block is telling "the caller asked for this"
    // apart from "the toml did", so an unset input must be an empty string
    // rather than absent.
    it("reports unset inputs as empty strings", () => {
      const outputs = buildActionOutputs(args());
      expect(outputs.inputs).toEqual({
        toolchain: "",
        targets: "",
        target: "",
        components: "",
        profile: "",
        "set-rustup-toolchain": "",
      });
    });
  });

  describe("toml provenance", () => {
    it("reports the parsed rust-toolchain.toml values", () => {
      const toml: ToolchainTomlConfig = {
        channel: "stable",
        targets: ["aarch64-apple-darwin"],
        components: ["rustfmt"],
        profile: "minimal",
      };
      const outputs = buildActionOutputs(args({ toml }));
      expect(outputs.toml).toEqual({
        channel: "stable",
        targets: ["aarch64-apple-darwin"],
        components: ["rustfmt"],
        profile: "minimal",
        path: null,
      });
    });

    // Absent scalars are null rather than "" so a consumer can tell "the toml
    // did not set this" from "the toml set it to an empty value".
    it("reports absent toml values as null and empty arrays", () => {
      const outputs = buildActionOutputs(args());
      expect(outputs.toml).toEqual({
        channel: null,
        targets: [],
        components: [],
        profile: null,
        path: null,
      });
    });

    it("reports a path toolchain", () => {
      const outputs = buildActionOutputs(
        args({ toml: { path: "/opt/custom" } }),
      );
      expect(outputs.toml.path).toBe("/opt/custom");
    });
  });
});

describe("toOutputEntries", () => {
  const entries = (
    overrides: Partial<ActionOutputsArgs> = {},
  ): Record<string, string> =>
    Object.fromEntries(toOutputEntries(buildActionOutputs(args(overrides))));

  /**
   * Parses the `json` entry, throwing when it is missing.
   *
   * `noUncheckedIndexedAccess` types the lookup as possibly undefined, and a
   * silent fallback would let a dropped entry pass as a green assertion.
   */
  const jsonEntry = (flat: Record<string, string>): ActionOutputs => {
    const raw = flat.json;
    if (raw === undefined) throw new Error("no `json` entry was emitted");
    return JSON.parse(raw) as ActionOutputs;
  };

  it("serialises targets and components as JSON arrays", () => {
    const flat = entries({
      spec: spec({
        targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
        components: ["clippy", "rustfmt"],
        profile: "minimal",
      }),
    });
    expect(flat.targets).toBe(
      '["wasm32-unknown-unknown","aarch64-apple-darwin"]',
    );
    expect(flat.components).toBe('["clippy","rustfmt"]');
  });

  it("serialises empty lists as an empty JSON array", () => {
    const flat = entries();
    expect(flat.targets).toBe("[]");
    expect(flat.components).toBe("[]");
  });

  it("serialises set-rustup-toolchain as a string boolean", () => {
    expect(entries()["set-rustup-toolchain"]).toBe("true");
    expect(
      entries({ setRustupToolchain: { raw: "false", value: false } })[
        "set-rustup-toolchain"
      ],
    ).toBe("false");
  });

  it("emits scalars unchanged", () => {
    const flat = entries({
      spec: spec({ channel: "1.90.0", profile: "minimal" }),
    });
    expect(flat.toolchain).toBe("1.90.0");
    expect(flat.name).toBe("1.90.0");
    expect(flat.profile).toBe("minimal");
    expect(flat.cachekey).toBe("20250915abcd");
    expect(flat["cachekey-full"]).toBe("20250915abcd-1f2e3d4c");
  });

  // The whole point of the `json` output: one key a consumer can fromJSON()
  // instead of re-splitting the flat strings.
  it("emits the complete outputs object as `json`", () => {
    const built = buildActionOutputs(
      args({
        spec: spec({ targets: ["wasm32-unknown-unknown"], profile: "minimal" }),
        toml: { channel: "stable" },
      }),
    );
    const flat = Object.fromEntries(toOutputEntries(built));
    expect(jsonEntry(flat)).toEqual(built);
  });

  it("orders json keys deterministically, provenance last", () => {
    const flat = entries();
    expect(Object.keys(jsonEntry(flat))).toEqual([
      "toolchain",
      "targets",
      "target",
      "components",
      "profile",
      "set-rustup-toolchain",
      "name",
      "cachekey",
      "cachekey-full",
      "cache",
      "inputs",
      "toml",
    ]);
  });

  it("emits every documented output key exactly once", () => {
    const keys = toOutputEntries(buildActionOutputs(args())).map(([k]) => k);
    expect(keys).toEqual([
      "cachekey",
      "cachekey-full",
      "name",
      "toolchain",
      "targets",
      "target",
      "components",
      "profile",
      "set-rustup-toolchain",
      "cache",
      "json",
    ]);
  });
});

describe("cache outputs", () => {
  it("carries the per-layer keys through to the outputs", () => {
    const cache: CacheOutputs = {
      enabled: true,
      layers: {
        registry: {
          key: "registry-Linux-X64-ci-a1b2c3",
          restoreKeys: ["registry-Linux-X64-ci-", "registry-Linux-X64-"],
        },
      },
    };
    expect(buildActionOutputs(args({ cache })).cache).toEqual(cache);
  });

  it("reports a disabled cache with no layers", () => {
    expect(buildActionOutputs(args()).cache).toEqual({
      enabled: false,
      layers: {},
    });
  });

  // Action outputs are strings, so the object ships as JSON and a consumer
  // reads it with fromJSON() rather than parsing a delimited format.
  it("serialises the cache block as JSON in the flat entries", () => {
    const cache: CacheOutputs = {
      enabled: true,
      layers: {
        build: {
          key: "build-Linux-X64-20250915abcd-1f2e3d4c-a1b2c3",
          restoreKeys: ["build-Linux-X64-20250915abcd-1f2e3d4c-"],
        },
      },
    };
    const entries = toOutputEntries(buildActionOutputs(args({ cache })));
    const entry = entries.find(([name]) => name === "cache");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry?.[1] ?? "null")).toEqual(cache);
  });
});
