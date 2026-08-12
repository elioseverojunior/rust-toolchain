// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  compareVersions,
  parseCargoManifest,
  parseMsrvPolicy,
  parseVersion,
} from "@/msrv";

describe("parseVersion", () => {
  it("reads a two-component version, defaulting the patch", () => {
    expect(parseVersion("1.88")).toEqual({ major: 1, minor: 88, patch: 0 });
  });

  it("reads a three-component version", () => {
    expect(parseVersion("1.88.1")).toEqual({ major: 1, minor: 88, patch: 1 });
  });

  // rustc on nightly reports "1.99.0-nightly"; the suffix is not part of the
  // number and must not make the whole value unreadable.
  it("ignores a pre-release suffix", () => {
    expect(parseVersion("1.99.0-nightly")).toEqual({
      major: 1,
      minor: 99,
      patch: 0,
    });
  });

  it("returns undefined for a value that is not a version", () => {
    expect(parseVersion("stable")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("1")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  // The whole reason this is not a string comparison: "1.9" > "1.10"
  // lexically, and the opposite numerically.
  it("orders 1.9 below 1.10", () => {
    const a = parseVersion("1.9");
    const b = parseVersion("1.10");
    expect(a && b && compareVersions(a, b)).toBeLessThan(0);
  });

  it("returns zero for equal versions", () => {
    const a = parseVersion("1.88.0");
    const b = parseVersion("1.88");
    expect(a && b && compareVersions(a, b)).toBe(0);
  });

  it("orders by patch when major and minor match", () => {
    const a = parseVersion("1.88.2");
    const b = parseVersion("1.88.1");
    expect(a && b && compareVersions(a, b)).toBeGreaterThan(0);
  });

  it("orders by major first", () => {
    const a = parseVersion("2.0.0");
    const b = parseVersion("1.99.99");
    expect(a && b && compareVersions(a, b)).toBeGreaterThan(0);
  });
});

describe("parseMsrvPolicy", () => {
  it("defaults an empty input to warn", () => {
    expect(parseMsrvPolicy("")).toBe("warn");
  });

  it("accepts each policy, case-insensitively and trimmed", () => {
    expect(parseMsrvPolicy("off")).toBe("off");
    expect(parseMsrvPolicy(" WARN ")).toBe("warn");
    expect(parseMsrvPolicy("Error")).toBe("error");
  });

  it("rejects anything else by name", () => {
    expect(() => parseMsrvPolicy("strict")).toThrow(
      "`msrv-check` is `strict`, which is not a policy. Valid values are off, warn, error.",
    );
  });
});

describe("parseCargoManifest", () => {
  it("reads rust-version from [package]", () => {
    expect(
      parseCargoManifest('[package]\nname = "x"\nrust-version = "1.88"\n'),
    ).toEqual({ rustVersion: "1.88", source: "cargo-toml" });
  });

  // A virtual manifest has no [package]; the value lives under
  // [workspace.package] and is inherited by members.
  it("reads rust-version from [workspace.package]", () => {
    expect(
      parseCargoManifest('[workspace.package]\nrust-version = "1.75"\n'),
    ).toEqual({ rustVersion: "1.75", source: "workspace-inherit" });
  });

  // THE trap: a member writes `rust-version.workspace = true`, and a naive
  // read returns the object { workspace: true } instead of a version.
  it("resolves an inheriting member against the workspace table", () => {
    const toml = [
      "[workspace.package]",
      'rust-version = "1.75"',
      "",
      "[package]",
      'name = "x"',
      "rust-version.workspace = true",
    ].join("\n");
    expect(parseCargoManifest(toml)).toEqual({
      rustVersion: "1.75",
      source: "workspace-inherit",
    });
  });

  it("reports none when the member inherits but no workspace value exists", () => {
    const toml = '[package]\nname = "x"\nrust-version.workspace = true\n';
    expect(parseCargoManifest(toml)).toEqual({ source: "none" });
  });

  it("reports none when nothing declares a rust-version", () => {
    expect(parseCargoManifest('[package]\nname = "x"\n')).toEqual({
      source: "none",
    });
  });

  it("reports none for an empty manifest", () => {
    expect(parseCargoManifest("")).toEqual({ source: "none" });
  });

  // Loud, matching parseRustToolchainToml: a syntax error hides the author's
  // intent, and guessing would install a toolchain nobody asked for.
  it("throws on invalid TOML", () => {
    expect(() => parseCargoManifest("[package")).toThrow(
      "Cargo.toml is not valid TOML",
    );
  });

  it("ignores a rust-version that is not a string", () => {
    expect(parseCargoManifest("[package]\nrust-version = 188\n")).toEqual({
      source: "none",
    });
  });
});
