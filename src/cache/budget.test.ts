// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { StatFs } from "@/cache/budget";
import { measurePaths, parseSize } from "@/cache/budget";

describe("parseSize", () => {
  it("treats zero as disabled", () => {
    expect(parseSize("0")).toBe(0);
    expect(parseSize("")).toBe(0);
  });

  it("reads a bare byte count", () => {
    expect(parseSize("1024")).toBe(1024);
  });

  // Binary, not decimal: GitHub reports cache entry sizes in binary units, so
  // a budget expressed in decimal would not match what the user sees.
  it.each([
    ["1K", 1024],
    ["1KB", 1024],
    ["2M", 2 * 1024 ** 2],
    ["2GB", 2 * 1024 ** 3],
    ["1T", 1024 ** 4],
  ])("parses %s as binary", (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it("is case-insensitive and tolerates spacing", () => {
    expect(parseSize(" 2gb ")).toBe(2 * 1024 ** 3);
  });

  // Silently disabling the budget on a typo would let an oversized entry
  // evict other workflows' caches, which is the harm the budget prevents.
  it.each(["2 gigabytes", "-1", "MB", "1.5G"])("rejects %s", (input) => {
    expect(() => parseSize(input)).toThrow("`cache-budget`");
  });
});

const fakeFs = (tree: Record<string, number | string[]>): StatFs => ({
  readdir: (dir): string[] => {
    const entry = tree[dir];
    return Array.isArray(entry) ? entry : [];
  },
  stat: (path): { size: number; isDirectory: () => boolean } => {
    const entry = tree[path];
    if (entry === undefined) throw new Error(`ENOENT: ${path}`);
    return {
      size: Array.isArray(entry) ? 0 : entry,
      isDirectory: () => Array.isArray(entry),
    };
  },
});

describe("measurePaths", () => {
  it("sums a flat directory", () => {
    const fs = fakeFs({ "/t": ["a", "b"], "/t/a": 100, "/t/b": 200 });
    expect(measurePaths(["/t"], fs)).toBe(300);
  });

  it("recurses into subdirectories", () => {
    const fs = fakeFs({
      "/t": ["deep"],
      "/t/deep": ["f"],
      "/t/deep/f": 42,
    });
    expect(measurePaths(["/t"], fs)).toBe(42);
  });

  // A path that does not exist is normal: a workspace may never have been
  // built, and a missing target dir is not an error.
  it("treats a missing path as zero", () => {
    expect(measurePaths(["/nope"], fakeFs({}))).toBe(0);
  });

  // Negation entries describe what to exclude from the archive; they are not
  // paths to walk, and treating them as such would throw ENOENT on "!...".
  it("skips negation globs", () => {
    const fs = fakeFs({ "/t": ["a"], "/t/a": 10 });
    expect(measurePaths(["/t", "!/t/*/incremental"], fs)).toBe(10);
  });
});
