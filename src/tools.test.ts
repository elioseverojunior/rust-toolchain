// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { parseToolSpecs } from "@/tools";

describe("parseToolSpecs", () => {
  // `cargo-tools` is optional, so an unset input is not an error.
  it("reads an empty input as no tools", () => {
    expect(parseToolSpecs("")).toEqual([]);
    expect(parseToolSpecs("   ")).toEqual([]);
  });

  // A bare name means "whatever is current", which only becomes a concrete
  // version once the registry has answered — see Task 2.
  it("defaults a bare name to latest", () => {
    expect(parseToolSpecs("cargo-nextest")).toEqual([
      { name: "cargo-nextest", version: "latest" },
    ]);
  });

  it("keeps an explicitly pinned version", () => {
    expect(parseToolSpecs("cargo-deny@0.16.1")).toEqual([
      { name: "cargo-deny", version: "0.16.1" },
    ]);
  });

  it("accepts an explicit latest", () => {
    expect(parseToolSpecs("cargo-nextest@latest")).toEqual([
      { name: "cargo-nextest", version: "latest" },
    ]);
  });

  // The same separator grammar as `targets` and `components`, so a workflow
  // can write the list however reads best.
  it.each([
    ["a comma", "cargo-deny,cargo-nextest"],
    ["a space", "cargo-deny cargo-nextest"],
    ["a newline", "cargo-deny\ncargo-nextest"],
    ["mixed separators", "cargo-deny, \n cargo-nextest"],
  ])("splits on %s", (_label, input) => {
    expect(parseToolSpecs(input).map((tool) => tool.name)).toEqual([
      "cargo-deny",
      "cargo-nextest",
    ]);
  });

  it("preserves the order the caller wrote", () => {
    expect(parseToolSpecs("z-tool,a-tool").map((t) => t.name)).toEqual([
      "z-tool",
      "a-tool",
    ]);
  });

  // Every name and version reaches `cargo install` as argv. Commands run
  // without a shell, so this is a second line of defence rather than the only
  // one — but a value that cannot name a crate is a configuration error worth
  // reporting before cargo fails obscurely.
  describe("rejects values that are not plain identifiers", () => {
    it("rejects a name carrying shell syntax", () => {
      expect(() => parseToolSpecs("cargo-deny; id > /tmp/pwned")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a name carrying command substitution", () => {
      expect(() => parseToolSpecs("cargo-deny$(id)")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a version carrying shell syntax", () => {
      expect(() => parseToolSpecs("cargo-deny@0.16.1`id`")).toThrow(
        /not a valid cargo tool version/,
      );
    });

    // Splitting on the first `@` leaves the rest in the version, where the
    // identifier class rejects the second one.
    it("rejects an entry with more than one @", () => {
      expect(() => parseToolSpecs("cargo-deny@0.16.1@2.0")).toThrow(
        /not a valid cargo tool version/,
      );
    });

    it("rejects a missing name", () => {
      expect(() => parseToolSpecs("@0.16.1")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a trailing @ with no version", () => {
      expect(() => parseToolSpecs("cargo-deny@")).toThrow(
        /not a valid cargo tool version/,
      );
    });
  });

  // Two pinned versions of one tool cannot both be installed, and picking one
  // would be a guess. Naming the tool in the message is what makes it fixable.
  it("rejects a duplicate tool name", () => {
    expect(() => parseToolSpecs("cargo-deny@0.16.1,cargo-deny@0.17.0")).toThrow(
      /cargo-deny/,
    );
  });

  it("rejects a duplicate even when the versions agree", () => {
    expect(() => parseToolSpecs("cargo-deny,cargo-deny")).toThrow(
      /more than once/,
    );
  });
});
