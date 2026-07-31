// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { InputReader } from "@/inputs";
import { readBooleanInput } from "@/inputs";

const reader = (value: string): InputReader => ({
  getInput: (): string => value,
});

describe("readBooleanInput", () => {
  it("falls back when the input is unset", () => {
    expect(readBooleanInput(reader(""), "cache", true)).toEqual({
      raw: "",
      value: true,
    });
    expect(readBooleanInput(reader(""), "cache", false)).toEqual({
      raw: "",
      value: false,
    });
  });

  // The raw text is what distinguishes an explicit `true` from an omission
  // that defaulted to it, and the outputs report that distinction.
  it("keeps the raw text alongside the parsed value", () => {
    expect(readBooleanInput(reader("true"), "cache", false)).toEqual({
      raw: "true",
      value: true,
    });
  });

  it("accepts every casing @actions/core accepts", () => {
    for (const raw of ["true", "True", "TRUE"]) {
      expect(readBooleanInput(reader(raw), "cache", false).value).toBe(true);
    }
    for (const raw of ["false", "False", "FALSE"]) {
      expect(readBooleanInput(reader(raw), "cache", true).value).toBe(false);
    }
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(readBooleanInput(reader("  true  "), "cache", false).value).toBe(
      true,
    );
  });

  // Reading a typo as `false` would silently disable a feature the workflow
  // asked for, with nothing in the log to say so.
  it("rejects anything else rather than reading it as false", () => {
    expect(() => readBooleanInput(reader("yes"), "cache", false)).toThrow(
      'Input `cache` must be "true" or "false", got "yes".',
    );
  });
});
