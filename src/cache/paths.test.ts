// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  binPaths,
  buildPaths,
  parseWorkspaces,
  registryPaths,
  RUSTUP_SHIMS,
} from "@/cache/paths";

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

  // The mirror of the sibling-prefix case below, on the other side: `..` is a
  // path segment, not a string prefix, so a directory whose *name* starts
  // with two dots is inside the checkout and must be accepted.
  it("accepts a directory whose name merely begins with two dots", () => {
    expect(parseWorkspaces(". -> ..cargo-target", ROOT)).toEqual([
      { manifestDir: "/workspace", targetDir: "/workspace/..cargo-target" },
    ]);
  });

  it("normalises an absolute mapping that stays inside the workspace", () => {
    expect(
      parseWorkspaces("/workspace/./a -> /workspace/b/../t", ROOT),
    ).toEqual([{ manifestDir: "/workspace/a", targetDir: "/workspace/t" }]);
  });

  // A naive `startsWith(root)` admits this: it is a prefix of the root
  // without being inside it.
  it("rejects a sibling directory that merely shares the root's prefix", () => {
    expect(() => parseWorkspaces(". -> target", "/workspace")).not.toThrow();
    expect(() =>
      parseWorkspaces("/workspace-evil -> target", "/workspace"),
    ).toThrow("outside the workspace");
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
  // The directory negations are what make the other two take effect:
  // `@actions/cache` runs `tar --files-from` with no `--no-recursion`, so a
  // directory left in the manifest is expanded wholesale and re-includes
  // everything the negations removed.
  it("matches files only, so the exclusions survive tar", () => {
    expect(buildPaths([{ manifestDir: "/w", targetDir: "/w/target" }])).toEqual(
      [
        "/w/target/**",
        "!/w/target/**/incremental/**",
        "!/w/target/**/examples/**",
        "!/w/target/",
        "!/w/target/**/",
      ],
    );
  });

  // `*/incremental` is single-level and cannot reach
  // `<target>/<triple>/debug/incremental`, which is exactly the layout this
  // action's own `targets` input produces.
  it("reaches a target-triple profile directory, not only a top-level one", () => {
    const paths = buildPaths([{ manifestDir: "/w", targetDir: "/w/target" }]);
    expect(paths).toContain("!/w/target/**/incremental/**");
    expect(paths).not.toContain("!/w/target/*/incremental");
  });

  it("handles multiple workspaces", () => {
    const paths = buildPaths([
      { manifestDir: "/w/a", targetDir: "/w/ta" },
      { manifestDir: "/w/b", targetDir: "/w/tb" },
    ]);
    expect(paths).toContain("/w/ta/**");
    expect(paths).toContain("/w/tb/**");
    expect(paths.filter((p) => p.startsWith("!"))).toHaveLength(8);
  });
});

describe("registryPaths", () => {
  // registry/src is extracted from the .crate files beside it, so excluding it
  // costs a decompression on restore and nothing else. It has never been
  // archived — this pins that, because "it was already excluded" is exactly the
  // kind of fact a later refactor re-adds by accident.
  it("never archives registry/src or git/checkouts", () => {
    const paths = registryPaths("/home/runner/.cargo");
    expect(paths.some((p) => p.includes("/registry/src"))).toBe(false);
    expect(paths.some((p) => p.includes("/git/checkouts"))).toBe(false);
  });

  // Bare directories, so tar's own recursion archives them — one manifest line
  // per layer instead of one per file. Pruning no longer narrows this list:
  // the paths array is a cache entry's identity, so narrowing it here is what
  // made every pruned entry unreadable. The keep-set now selects what is
  // linked into the stage instead — see `cache/stage.ts`.
  it("names the three bare directories", () => {
    expect(registryPaths("/c")).toEqual([
      "/c/registry/index",
      "/c/registry/cache",
      "/c/git/db",
    ]);
  });
});

describe("buildPaths", () => {
  const workspaces = [{ manifestDir: "/w", targetDir: "/w/target" }];

  // The unpruned form, which `cache-prune: off` uses. Both directory negations
  // are load-bearing: `@actions/cache` runs `tar --files-from` with no
  // `--no-recursion`, so any directory left in the manifest re-expands and
  // re-includes everything the exclusions above it removed.
  it("emits the glob set with both directory negations", () => {
    expect(buildPaths(workspaces)).toEqual([
      "/w/target/**",
      "!/w/target/**/incremental/**",
      "!/w/target/**/examples/**",
      "!/w/target/",
      "!/w/target/**/",
    ]);
  });
});

describe("binPaths", () => {
  const BIN = "/home/runner/.cargo/bin";

  // Pinned as a literal array rather than rebuilt from RUSTUP_SHIMS, which
  // would only restate the implementation. This is the highest-risk glob set in
  // the action: the two directory negations at the end are what make every
  // negation above them reach the archive at all, because `@actions/cache` runs
  // `tar --files-from` with no `--no-recursion` and any directory left in the
  // manifest is expanded wholesale.
  it("matches files only, so the shim exclusions survive tar", () => {
    expect(binPaths("/home/runner/.cargo")).toEqual([
      `${BIN}/**`,
      `!${BIN}/cargo`,
      `!${BIN}/cargo.exe`,
      `!${BIN}/cargo-clippy`,
      `!${BIN}/cargo-clippy.exe`,
      `!${BIN}/cargo-fmt`,
      `!${BIN}/cargo-fmt.exe`,
      `!${BIN}/cargo-miri`,
      `!${BIN}/cargo-miri.exe`,
      `!${BIN}/clippy-driver`,
      `!${BIN}/clippy-driver.exe`,
      `!${BIN}/rls`,
      `!${BIN}/rls.exe`,
      `!${BIN}/rust-analyzer`,
      `!${BIN}/rust-analyzer.exe`,
      `!${BIN}/rust-gdb`,
      `!${BIN}/rust-gdb.exe`,
      `!${BIN}/rust-gdbgui`,
      `!${BIN}/rust-gdbgui.exe`,
      `!${BIN}/rust-lldb`,
      `!${BIN}/rust-lldb.exe`,
      `!${BIN}/rustc`,
      `!${BIN}/rustc.exe`,
      `!${BIN}/rustdoc`,
      `!${BIN}/rustdoc.exe`,
      `!${BIN}/rustfmt`,
      `!${BIN}/rustfmt.exe`,
      `!${BIN}/rustup`,
      `!${BIN}/rustup.exe`,
      `!${BIN}/`,
      `!${BIN}/**/`,
    ]);
  });

  // Emitted unconditionally rather than behind a platform check: a negation for
  // a file that does not exist matches nothing, and the CI E2E matrix runs
  // windows-latest, where every shim carries the suffix.
  it("negates both the bare and the .exe spelling of every shim", () => {
    const paths = binPaths("/c");
    for (const shim of RUSTUP_SHIMS) {
      expect(paths).toContain(`!/c/bin/${shim}`);
      expect(paths).toContain(`!/c/bin/${shim}.exe`);
    }
  });

  // The set rustup owns. Adding a shim here without adding it to the fixture
  // above fails that test, which is the point.
  it("names the fourteen rustup shims", () => {
    expect(RUSTUP_SHIMS).toEqual([
      "cargo",
      "cargo-clippy",
      "cargo-fmt",
      "cargo-miri",
      "clippy-driver",
      "rls",
      "rust-analyzer",
      "rust-gdb",
      "rust-gdbgui",
      "rust-lldb",
      "rustc",
      "rustdoc",
      "rustfmt",
      "rustup",
    ]);
  });

  it("keeps the directory negations last", () => {
    const paths = binPaths("/c");
    expect(paths.slice(-2)).toEqual(["!/c/bin/", "!/c/bin/**/"]);
  });
});
