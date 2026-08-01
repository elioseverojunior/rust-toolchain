// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { describeError } from "@/errors";

describe("describeError", () => {
  it("uses an Error's message rather than its stringification", () => {
    expect(describeError(new Error("reserve failed"))).toBe("reserve failed");
  });

  it("keeps a subclass's message", () => {
    class CacheError extends Error {
      constructor(message: string) {
        super(message);
      }
    }
    expect(describeError(new CacheError("cache service unavailable"))).toBe(
      "cache service unavailable",
    );
  });

  // Everything this action catches crosses a boundary it does not own, and a
  // rejected promise can carry any value at all.
  it.each([
    ["a string", "boom", "boom"],
    ["a number", 42, "42"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
  ])("stringifies %s", (_name, thrown, expected) => {
    expect(describeError(thrown)).toBe(expected);
  });
});
