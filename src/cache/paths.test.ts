// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { buildPaths, parseWorkspaces, registryPaths } from "@/cache/paths";

const ROOT = "/workspace";

describe("parseWorkspaces", () => {
  it("defaults a bare directory to a target sibling", () => {
    expect(parseWorkspaces(". -> target", ROOT)).toEqual([
      { manifestDir: "/workspace", targetDir: "/workspace/target" },
    ]);
  });

  it("parses one mapping per line, ignoring blank lines", () => {
    expect(
      parseWorkspaces("crates/a -> target\n\ncrates/b -> out", ROOT),
    ).toEqual([
      { manifestDir: "/workspace/crates/a", targetDir: "/workspace/target" },
      { manifestDir: "/workspace/crates/b", targetDir: "/workspace/out" },
    ]);
  });

  it("tolerates loose spacing around the arrow", () => {
    expect(parseWorkspaces(".->target", ROOT)).toEqual([
      { manifestDir: "/workspace", targetDir: "/workspace/target" },
    ]);
  });

  it("rejects a line with no arrow", () => {
    expect(() => parseWorkspaces("crates/a", ROOT)).toThrow(
      "`cache-workspaces` entries look like `<manifest-dir> -> <target-dir>`",
    );
  });

  // Cache paths come from workflow input. A mapping escaping the checkout
  // would let a cache entry read or overwrite files outside it.
  it.each(["../etc -> target", ". -> ../outside", "/etc -> target"])(
    "rejects %s for escaping the workspace",
    (line) => {
      expect(() => parseWorkspaces(line, ROOT)).toThrow(
        "outside the workspace",
      );
    },
  );

  it("rejects an empty list", () => {
    expect(() => parseWorkspaces("   ", ROOT)).toThrow(
      "must name at least one",
    );
  });
});

describe("registryPaths", () => {
  // registry/src is extracted source, regenerable from the .crate files in
  // registry/cache. Listing what we want means it is never included, which
  // beats excluding it because there is nothing to keep in sync.
  it("names only the three directories worth keeping", () => {
    expect(registryPaths("/home/runner/.cargo")).toEqual([
      "/home/runner/.cargo/registry/index",
      "/home/runner/.cargo/registry/cache",
      "/home/runner/.cargo/git/db",
    ]);
  });

  it("never includes registry/src", () => {
    expect(registryPaths("/c").join("\n")).not.toContain("registry/src");
  });
});

describe("buildPaths", () => {
  // Profile directories cannot be enumerated up front (debug, release,
  // <triple>/debug), so the unwanted ones are excluded by negation rather
  // than by listing what to include.
  it("includes each target dir and excludes the regenerable subtrees", () => {
    expect(buildPaths([{ manifestDir: "/w", targetDir: "/w/target" }])).toEqual(
      ["/w/target", "!/w/target/*/incremental", "!/w/target/*/examples"],
    );
  });

  it("handles multiple workspaces", () => {
    const paths = buildPaths([
      { manifestDir: "/w/a", targetDir: "/w/ta" },
      { manifestDir: "/w/b", targetDir: "/w/tb" },
    ]);
    expect(paths).toContain("/w/ta");
    expect(paths).toContain("/w/tb");
    expect(paths.filter((p) => p.startsWith("!"))).toHaveLength(4);
  });
});
