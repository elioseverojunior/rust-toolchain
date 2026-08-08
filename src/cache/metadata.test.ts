// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { parsePackageSet } from "@/cache/metadata";

/** Builds a `cargo metadata --format-version 1` document. */
const doc = (
  packages: { id: string; name: string; version: string }[],
  workspaceMembers: string[] = [],
): string =>
  JSON.stringify({
    packages,
    workspace_members: workspaceMembers,
    resolve: null,
    version: 1,
  });

const SERDE = {
  id: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.219",
  name: "serde",
  version: "1.0.219",
};
const ANYHOW = {
  id: "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.99",
  name: "anyhow",
  version: "1.0.99",
};
const LOCAL = {
  id: "path+file:///workspace/e2e-probe#e2e-probe@0.1.0",
  name: "e2e-probe",
  version: "0.1.0",
};

describe("parsePackageSet", () => {
  it("collects every package as name@version", () => {
    const set = parsePackageSet(doc([SERDE, ANYHOW]));
    expect([...set.packages].sort()).toEqual([
      "anyhow@1.0.99",
      "serde@1.0.219",
    ]);
  });

  // Step 5 of the design always drops the workspace's own crates: their source
  // is in the checkout, so caching their artifacts pays transfer for something
  // cargo rebuilds anyway. They have to be distinguishable from dependencies,
  // and the only reliable way is `workspace_members`.
  it("separates workspace members from dependencies", () => {
    const set = parsePackageSet(doc([SERDE, LOCAL], [LOCAL.id]));
    expect([...set.packages].sort()).toEqual([
      "e2e-probe@0.1.0",
      "serde@1.0.219",
    ]);
    expect([...set.workspaceMembers]).toEqual(["e2e-probe@0.1.0"]);
  });

  // Matching is on the package id verbatim rather than by parsing it. Cargo
  // spells ids at least three ways — `path+file:///x/foo#1.0.0` when the
  // directory is named after the crate, `path+file:///x/bar#foo@1.0.0` when it
  // is not, and `registry+https://…#foo@1.0.0` — so a parser would be a
  // standing bet on a format cargo has already changed once.
  it("ignores a workspace member id that matches no package", () => {
    const set = parsePackageSet(
      doc([SERDE], ["path+file:///gone#ghost@1.0.0"]),
    );
    expect([...set.workspaceMembers]).toEqual([]);
    expect(set.packages.size).toBe(1);
  });

  it("reads a valid but empty document as an empty set", () => {
    const set = parsePackageSet(doc([]));
    expect(set.packages.size).toBe(0);
    expect(set.workspaceMembers.size).toBe(0);
  });

  it("deduplicates a package listed twice", () => {
    const set = parsePackageSet(doc([SERDE, SERDE]));
    expect([...set.packages]).toEqual(["serde@1.0.219"]);
  });

  // Every rejection below names what was wrong, because the caller downgrades
  // it to a warning and falls back to the Phase B glob set. A message of
  // "could not parse" would leave nobody able to tell a cargo upgrade from a
  // genuinely broken workspace.
  it("rejects malformed JSON", () => {
    expect(() => parsePackageSet("{not json")).toThrow(/valid JSON/i);
  });

  it("rejects a package entry that is not an object", () => {
    expect(() =>
      parsePackageSet(JSON.stringify({ packages: ["serde"] })),
    ).toThrow(/index 0 that is not an object/i);
  });

  it("rejects a document with no packages array", () => {
    expect(() => parsePackageSet(JSON.stringify({ version: 1 }))).toThrow(
      /no `packages` array/i,
    );
  });

  it("rejects a document whose packages is not an array", () => {
    expect(() =>
      parsePackageSet(JSON.stringify({ packages: { serde: "1.0" } })),
    ).toThrow(/no `packages` array/i);
  });

  it("rejects a package entry missing its version", () => {
    expect(() =>
      parsePackageSet(doc([{ id: "x", name: "serde" } as never])),
    ).toThrow(/serde/);
  });

  it("rejects a package entry missing its name", () => {
    expect(() =>
      parsePackageSet(doc([{ id: "x", version: "1.0.0" } as never])),
    ).toThrow(/name/i);
  });

  it("rejects a package entry missing its id", () => {
    expect(() =>
      parsePackageSet(doc([{ name: "serde", version: "1.0.0" } as never])),
    ).toThrow(/id/i);
  });
});
