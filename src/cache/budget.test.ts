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

/** A `stat`/`readdir` failure that is not a missing path. */
const denied = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EACCES: permission denied, ${path}`), {
    code: "EACCES",
  });

const missing = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), {
    code: "ENOENT",
  });

const fakeFs = (
  tree: Record<string, number | string[]>,
  unreadable: string[] = [],
): StatFs => ({
  readdir: (dir): string[] => {
    if (unreadable.includes(dir)) throw denied(dir);
    const entry = tree[dir];
    return Array.isArray(entry) ? entry : [];
  },
  stat: (path): { size: number; isDirectory: () => boolean } => {
    if (unreadable.includes(path) && tree[path] === undefined) {
      throw denied(path);
    }
    const entry = tree[path];
    if (entry === undefined) throw missing(path);
    return {
      size: Array.isArray(entry) ? 0 : entry,
      isDirectory: () => Array.isArray(entry),
    };
  },
});

describe("measurePaths", () => {
  it("sums a flat directory", () => {
    const fs = fakeFs({ "/t": ["a", "b"], "/t/a": 100, "/t/b": 200 });
    expect(measurePaths(["/t"], fs)).toEqual({ bytes: 300, unmeasured: [] });
  });

  it("recurses into subdirectories", () => {
    const fs = fakeFs({
      "/t": ["deep"],
      "/t/deep": ["f"],
      "/t/deep/f": 42,
    });
    expect(measurePaths(["/t"], fs).bytes).toBe(42);
  });

  // A path that does not exist is normal: a workspace may never have been
  // built, and a missing target dir is not an error.
  it("treats a missing path as zero and does not report it", () => {
    expect(measurePaths(["/nope"], fakeFs({}))).toEqual({
      bytes: 0,
      unmeasured: [],
    });
  });

  // Negation entries describe what to exclude from the archive; they are not
  // paths to walk, and treating them as such would throw ENOENT on "!...".
  it("skips negation globs", () => {
    const fs = fakeFs({ "/t": ["a"], "/t/a": 10 });
    expect(measurePaths(["/t", "!/t/**/incremental/**"], fs).bytes).toBe(10);
  });

  // `buildPaths` emits `<target>/**`, which no `stat` can resolve. Walking
  // the literal prefix measures the same tree.
  it("walks the literal root of a glob pattern", () => {
    const fs = fakeFs({ "/t": ["a", "b"], "/t/a": 100, "/t/b": 200 });
    expect(measurePaths(["/t/**"], fs).bytes).toBe(300);
  });

  // The bug this guards: swallowing every stat error, not only ENOENT, lets a
  // permission failure under-report a layer — and an under-reported layer
  // passes a budget check it should have failed.
  it("reports a file it could not stat rather than under-counting", () => {
    const fs = fakeFs({ "/t": ["a", "b"], "/t/a": 100 }, ["/t/b"]);
    expect(measurePaths(["/t"], fs)).toEqual({
      bytes: 100,
      unmeasured: ["/t/b"],
    });
  });

  it("reports a directory it could not list", () => {
    const fs = fakeFs({ "/t": ["sub"], "/t/sub": ["f"], "/t/sub/f": 5 }, [
      "/t/sub",
    ]);
    expect(measurePaths(["/t"], fs)).toEqual({
      bytes: 0,
      unmeasured: ["/t/sub"],
    });
  });
});

describe("measurePaths honours negations", () => {
  // The bin layer's shape, which is what exposed this: the negations exclude
  // ~100% of what the glob root walks. Ignoring them reported 291 MB for a
  // 233-byte archive — and `cache-budget` is checked against that number.
  it("excludes files matching an exact negation", () => {
    const fs = fakeFs({
      "/c/bin": ["cargo", "rustc", "act-fake-tool"],
      "/c/bin/cargo": 20_000_000,
      "/c/bin/rustc": 20_000_000,
      "/c/bin/act-fake-tool": 50,
    });
    expect(
      measurePaths(["/c/bin/**", "!/c/bin/cargo", "!/c/bin/rustc"], fs).bytes,
    ).toBe(50);
  });

  // `**` spans any number of segments, including zero — the depth mistake
  // Phase B's first `buildPaths` made with a single-level `*`.
  it.each([
    ["at depth", "/t/debug/incremental/x"],
    ["at the root", "/t/incremental/x"],
  ])("excludes files under a ** negation %s", (_label, victim) => {
    const fs = fakeFs({
      "/t": ["debug", "incremental"],
      "/t/debug": ["incremental"],
      "/t/debug/incremental": ["x"],
      "/t/debug/incremental/x": 500,
      "/t/incremental": ["x"],
      "/t/incremental/x": 500,
      "/t/keep": 7,
    });
    const measured = measurePaths(["/t/**", "!/t/**/incremental/**"], fs);
    expect(measured.bytes).toBe(0);
    expect(victim).toContain("incremental");
  });

  // THE subtlety. A trailing slash negates DIRECTORY ENTRIES so the tar
  // manifest stays files-only; it does not exclude the files inside. Treating
  // it as a subtree exclusion would measure every layer as zero — the opposite
  // error, and one that would silently disable the budget entirely.
  it("does not let a directory-only negation exclude the files inside", () => {
    const fs = fakeFs({
      "/t": ["debug"],
      "/t/debug": ["app"],
      "/t/debug/app": 1_234,
    });
    expect(measurePaths(["/t/**", "!/t/", "!/t/**/"], fs).bytes).toBe(1_234);
  });

  // No path builder emits a single `*` today, so this pins the grammar rather
  // than a caller: a lone star stays within one segment, and without the
  // branch a future `*` pattern would be matched as a literal and silently
  // exclude nothing.
  it("matches a single star within one segment only", () => {
    const fs = fakeFs({
      "/t": ["a.tmp", "keep.rs", "sub"],
      "/t/a.tmp": 10,
      "/t/keep.rs": 20,
      "/t/sub": ["b.tmp"],
      "/t/sub/b.tmp": 40,
    });
    // `/t/*.tmp` takes a.tmp and leaves sub/b.tmp, which is a segment deeper.
    expect(measurePaths(["/t/**", "!/t/*.tmp"], fs).bytes).toBe(60);
  });

  it("still counts what no negation matches", () => {
    const fs = fakeFs({
      "/t": ["a", "b"],
      "/t/a": 100,
      "/t/b": 200,
    });
    expect(measurePaths(["/t/**", "!/t/nope"], fs).bytes).toBe(300);
  });
});
