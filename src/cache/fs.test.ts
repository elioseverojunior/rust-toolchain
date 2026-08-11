// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { nodeStageFs, nodeStatFs, walkFiles } from "@/cache/fs";

/**
 * These run against a real directory on purpose.
 *
 * Every other test in this repo injects a filesystem fake, which is what
 * makes the suite fast and deterministic — and is also what let a real bug
 * through: the fake for `walk` returned an empty list for a missing directory
 * while `readdirSync` throws, and nothing could detect the disagreement
 * because the same hand wrote both sides. A fake cannot verify a contract
 * about `node:fs`. Only `node:fs` can.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rust-toolchain-fs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An mtime far enough in the past that "unchanged" cannot pass by accident. */
const OLD = new Date("2020-01-02T03:04:05.000Z");

function writeFile(relative: string, contents = "x"): string {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

describe("walkFiles", () => {
  // THE regression test. `$CARGO_HOME/git/db` does not exist until a workspace
  // takes a git dependency; walking it threw ENOENT, the throw escaped the
  // staging loop, and every pruned layer lost its save.
  it("returns nothing for a directory that is not there", () => {
    expect(walkFiles(join(root, "absent"))).toEqual([]);
  });

  it("returns nothing for a directory that is there and empty", () => {
    mkdirSync(join(root, "empty"));
    expect(walkFiles(join(root, "empty"))).toEqual([]);
  });

  it("lists every file beneath the directory, recursively", () => {
    writeFile("a.txt");
    writeFile("deep/b.txt");
    writeFile("deep/deeper/c.txt");

    expect(walkFiles(root).sort()).toEqual(
      [
        join(root, "a.txt"),
        join(root, "deep/b.txt"),
        join(root, "deep/deeper/c.txt"),
      ].sort(),
    );
  });

  it("lists files only, never the directories holding them", () => {
    writeFile("deep/b.txt");
    for (const entry of walkFiles(root)) {
      expect(statSync(entry).isDirectory()).toBe(false);
    }
  });
});

describe("nodeStatFs", () => {
  it("reports a file's size and that it is not a directory", () => {
    const file = writeFile("sized.txt", "0123456789");
    const entry = nodeStatFs.stat(file);

    expect(entry.size).toBe(10);
    expect(entry.isDirectory()).toBe(false);
  });

  it("recognises a directory", () => {
    mkdirSync(join(root, "dir"));
    expect(nodeStatFs.stat(join(root, "dir")).isDirectory()).toBe(true);
  });

  it("lists a directory's immediate entries", () => {
    writeFile("one.txt");
    writeFile("nested/two.txt");
    expect(nodeStatFs.readdir(root).sort()).toEqual(["nested", "one.txt"]);
  });

  // Unguarded on purpose, unlike walkFiles. `measurePaths` draws the
  // missing-versus-unreadable distinction itself and reports the second, so an
  // adapter that swallowed either would erase the distinction.
  it("throws for a missing path rather than hiding it", () => {
    expect(() => nodeStatFs.stat(join(root, "absent"))).toThrow();
    expect(() => nodeStatFs.readdir(join(root, "absent"))).toThrow();
  });
});

describe("nodeStageFs", () => {
  it("creates a nested directory and every missing parent", () => {
    nodeStageFs.mkdirp(join(root, "a/b/c"));
    expect(statSync(join(root, "a/b/c")).isDirectory()).toBe(true);
  });

  it("tolerates creating a directory that already exists", () => {
    nodeStageFs.mkdirp(join(root, "twice"));
    expect(() => nodeStageFs.mkdirp(join(root, "twice"))).not.toThrow();
  });

  // The two properties `stageFiles` depends on, asserted rather than assumed.
  // A copy would satisfy neither, and cargo would rebuild everything the
  // restore had just handed it.
  it("hard-links rather than copying: same inode, shared mtime", () => {
    const source = writeFile("src.bin", "payload");
    utimesSync(source, OLD, OLD);
    const before = statSync(source);

    nodeStageFs.mkdirp(join(root, "stage"));
    nodeStageFs.link(source, join(root, "stage/src.bin"));
    const linked = statSync(join(root, "stage/src.bin"));

    expect(linked.ino).toBe(before.ino);
    expect(linked.mtimeMs).toBe(before.mtimeMs);
    // Two names for one inode is what makes a stage cost references, not bytes.
    expect(linked.nlink).toBe(2);
  });

  it("refuses to link over an existing destination", () => {
    const source = writeFile("a.bin");
    writeFile("b.bin");
    expect(() => nodeStageFs.link(source, join(root, "b.bin"))).toThrow();
  });

  it("moves a file and preserves the mtime tar restored", () => {
    const source = writeFile("staged.bin", "payload");
    utimesSync(source, OLD, OLD);
    const before = statSync(source).mtimeMs;

    nodeStageFs.mkdirp(join(root, "out"));
    nodeStageFs.move(source, join(root, "out/staged.bin"));

    expect(statSync(join(root, "out/staged.bin")).mtimeMs).toBe(before);
    expect(walkFiles(root)).toEqual([join(root, "out/staged.bin")]);
  });

  it("removes a directory tree entirely", () => {
    writeFile("stage/deep/file.bin");
    nodeStageFs.remove(join(root, "stage"));
    expect(walkFiles(join(root, "stage"))).toEqual([]);
  });

  // Clearing a stage that was never created is the ordinary path on a cache
  // miss, not an error.
  it("tolerates removing a directory that is not there", () => {
    expect(() => nodeStageFs.remove(join(root, "never"))).not.toThrow();
  });

  // Removing a link must never touch the file it points at — this is what
  // makes clearing a stage unable to lose work however wrong the keep-set was.
  it("removing a stage leaves the files it linked to untouched", () => {
    const source = writeFile("keep.bin", "payload");
    nodeStageFs.mkdirp(join(root, "stage"));
    nodeStageFs.link(source, join(root, "stage/keep.bin"));

    nodeStageFs.remove(join(root, "stage"));

    expect(statSync(source).size).toBe("payload".length);
    expect(statSync(source).nlink).toBe(1);
  });

  it("walks with the same absent-is-empty contract as walkFiles", () => {
    expect(nodeStageFs.walk(join(root, "absent"))).toEqual([]);
    writeFile("stage/one.bin");
    expect(nodeStageFs.walk(join(root, "stage"))).toEqual([
      join(root, "stage/one.bin"),
    ]);
  });
});
