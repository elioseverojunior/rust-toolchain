// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  compareVersions,
  describeVerdict,
  effectiveMsrv,
  evaluateMsrv,
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

  // The single-crate-workspace layout: [package] and [workspace] in one file.
  // Cargo does NOT inherit here — the member never opted in — so neither do
  // we. Reporting 1.75 would claim an MSRV the crate does not declare, and
  // under `msrv-fallback: true` would install it.
  it("does not inherit into a package that did not opt in", () => {
    const toml = [
      "[workspace.package]",
      'rust-version = "1.75"',
      "",
      "[package]",
      'name = "root-crate"',
    ].join("\n");
    expect(parseCargoManifest(toml)).toEqual({ source: "none" });
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

// The measured case that motivates walking the graph at all: cargo-binstall
// declares 1.79 while its locked graph needs 1.95.
const BINSTALL_GRAPH = [
  { name: "cargo-binstall", version: "1.21.1", rustVersion: "1.79" },
  { name: "fs-lock", version: "0.1.16", rustVersion: "1.89.0" },
  { name: "cargo-platform", version: "0.3.3", rustVersion: "1.91" },
  { name: "vergen", version: "10.0.1", rustVersion: "1.95.0" },
];

describe("effectiveMsrv", () => {
  it("returns the highest requirement and who demands it", () => {
    expect(effectiveMsrv(BINSTALL_GRAPH)).toEqual({
      version: "1.95.0",
      package: "vergen 10.0.1",
    });
  });

  it("returns undefined when nothing declares a version", () => {
    expect(effectiveMsrv([])).toBeUndefined();
  });

  // Every other fixture in this file happens to list its highest requirement
  // last, which lets a broken comparison (e.g. "keep whatever is seen last")
  // pass unnoticed. Put the maximum first and a lower value after it, so only
  // a real maximum-tracking comparison returns the right package.
  it("keeps the maximum when a later entry declares a lower requirement", () => {
    expect(
      effectiveMsrv([
        { name: "a", version: "1.0.0", rustVersion: "1.90" },
        { name: "b", version: "2.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({ version: "1.90", package: "a 1.0.0" });
  });

  it("ignores versions it cannot parse", () => {
    expect(
      effectiveMsrv([
        { name: "a", version: "1.0.0", rustVersion: "not-a-version" },
        { name: "b", version: "2.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({ version: "1.70", package: "b 2.0.0" });
  });

  it("returns undefined when no version is parseable", () => {
    expect(
      effectiveMsrv([{ name: "a", version: "1.0.0", rustVersion: "???" }]),
    ).toBeUndefined();
  });
});

describe("evaluateMsrv", () => {
  it("reports a violation naming the crate that demands it", () => {
    expect(evaluateMsrv("1.88.0", BINSTALL_GRAPH)).toEqual({
      kind: "violation",
      installed: "1.88.0",
      required: { version: "1.95.0", package: "vergen 10.0.1" },
    });
  });

  // `ok` carries the requirement it cleared, so the caller can publish
  // `msrv-effective` without recomputing the maximum.
  it("is ok when the installed toolchain meets the requirement", () => {
    expect(evaluateMsrv("1.97.1", BINSTALL_GRAPH)).toEqual({
      kind: "ok",
      required: { version: "1.95.0", package: "vergen 10.0.1" },
    });
  });

  it("is ok when the installed toolchain matches exactly", () => {
    expect(
      evaluateMsrv("1.70.0", [
        { name: "a", version: "1.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({
      kind: "ok",
      required: { version: "1.70", package: "a 1.0.0" },
    });
  });

  it("skips when no package declares a requirement", () => {
    expect(evaluateMsrv("1.88.0", [])).toEqual({
      kind: "skipped",
      reason: "no package in the graph declares a rust-version",
    });
  });

  it("skips when the installed version cannot be read", () => {
    expect(evaluateMsrv("", BINSTALL_GRAPH)).toEqual({
      kind: "skipped",
      reason: "the installed rustc version could not be read",
    });
  });
});

describe("describeVerdict", () => {
  it("names the crate, its requirement and what is installed", () => {
    expect(describeVerdict(evaluateMsrv("1.88.0", BINSTALL_GRAPH))).toBe(
      "vergen 10.0.1 requires rustc 1.95.0, but 1.88.0 is installed.",
    );
  });

  it("explains a skip", () => {
    expect(describeVerdict(evaluateMsrv("1.88.0", []))).toBe(
      "MSRV check skipped: no package in the graph declares a rust-version.",
    );
  });

  it("says nothing interesting when the check passed", () => {
    expect(
      describeVerdict({
        kind: "ok",
        required: { version: "1.95.0", package: "vergen 10.0.1" },
      }),
    ).toBe("The installed toolchain satisfies every declared rust-version.");
  });
});
