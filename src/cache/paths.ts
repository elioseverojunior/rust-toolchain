// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { isAbsolute, relative, resolve, sep } from "node:path";

/** One `<manifest-dir> -> <target-dir>` mapping, both resolved absolutely. */
export interface Workspace {
  manifestDir: string;
  targetDir: string;
}

/**
 * Resolves one side of a mapping, refusing anything outside the checkout.
 *
 * Cache paths come from workflow input, and a path escaping `GITHUB_WORKSPACE`
 * would let a cache entry read or overwrite files outside the checkout. An
 * absolute input is not rejected out of hand — it is normalised and then held
 * to the same containment check as a relative one, so `/workspace/target`
 * under a `/workspace` root is accepted while `/etc` is not.
 */
function resolveInside(root: string, part: string): string {
  const resolved = isAbsolute(part) ? resolve(part) : resolve(root, part);
  // `relative` is the separator-correct containment test: it returns `""`
  // for the root itself, a bare relative path for anything inside it, and
  // something starting with `..` — or, on Windows, an absolute path when
  // `resolved` is on a different drive — for anything outside. Comparing
  // string prefixes instead needs the platform separator baked in, and
  // hardcoding `/` silently rejects every path on a Windows runner, where
  // `GITHUB_WORKSPACE` and `resolve()` are both backslash-joined.
  //
  // `..` is compared as a whole path segment, not as a string prefix: a
  // directory named `..cargo-target` sits inside the root and must be
  // accepted, and `startsWith("..")` alone would refuse it.
  const offset = relative(root, resolved);
  const escapes = offset === ".." || offset.startsWith(`..${sep}`);
  if (offset !== "" && (escapes || isAbsolute(offset))) {
    throw new Error(
      `\`cache-workspaces\` entry "${part}" resolves to "${resolved}", which ` +
        `is outside the workspace "${root}". Cache paths come from workflow ` +
        "input, so one escaping the checkout is refused rather than trusted.",
    );
  }
  return resolved;
}

/**
 * Reads `cache-workspaces` into resolved mappings.
 *
 * The `<manifest-dir> -> <target-dir>` syntax matches `Swatinem/rust-cache`, so
 * an existing workflow value transfers unchanged.
 */
export function parseWorkspaces(value: string, root: string): Workspace[] {
  const workspaces = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("->").map((part) => part.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          "`cache-workspaces` entries look like `<manifest-dir> -> <target-dir>`, " +
            `one per line; got ${JSON.stringify(line)}.`,
        );
      }
      return {
        manifestDir: resolveInside(root, parts[0]),
        targetDir: resolveInside(root, parts[1]),
      };
    });

  if (workspaces.length === 0) {
    throw new Error(
      "`cache-workspaces` must name at least one `<manifest-dir> -> <target-dir>` mapping.",
    );
  }
  return workspaces;
}

/**
 * The registry layer's paths.
 *
 * `registry/src` holds extracted sources, regenerable from the `.crate` files
 * in `registry/cache`, so it is simply never listed. Naming what to keep beats
 * excluding what to drop: there is nothing here to keep in sync.
 *
 * These are bare directories, unlike `buildPaths` below, and the asymmetry is
 * load-bearing rather than an oversight. This layer carries no exclusions, so
 * tar's recursion into a listed directory is exactly what archives it — one
 * manifest line per layer instead of one per file, and directory entries,
 * permissions and empty directories all preserved. `buildPaths` gives that up
 * only because it has something to exclude.
 */
export function registryPaths(cargoHome: string): string[] {
  return [
    `${cargoHome}/registry/index`,
    `${cargoHome}/registry/cache`,
    `${cargoHome}/git/db`,
  ];
}

/**
 * The build layer's paths, with the regenerable subtrees excluded.
 *
 * Profile directories cannot be enumerated up front — `debug`, `release`,
 * `<triple>/debug` — so these are negation globs. `**` rather than `*`
 * because the depth is not fixed either: this action's own `targets` input
 * produces `<target>/<triple>/debug/incremental`, which a single-level
 * pattern cannot reach.
 *
 * The last pattern below — the globstar with a trailing slash — is the one
 * that makes the whole set work, and removing it silently disables everything
 * above. (It cannot be written literally in this comment: the sequence that
 * ends it also ends a block comment.) `@actions/cache` resolves these
 * patterns with `implicitDescendants: false`, writes the matches to a
 * manifest, then runs `tar --files-from <manifest>` — with no
 * `--no-recursion`. Any directory left in that manifest is therefore expanded
 * wholesale by tar, re-including every path the negations just removed, and
 * duplicating each file once per listed ancestor. A trailing `/` matches
 * directories only, so that one pattern strips every directory and leaves a
 * files-only manifest — the only shape in which a negation survives to the
 * archive. (This is also why the pre-fix `[<target>, !…]` form excluded
 * nothing: `implicitDescendants: false` made `<target>` match one entry — the
 * directory — and tar then archived the whole tree from it.)
 *
 * The other directory negation, `!${targetDir}/`, is belt-and-braces and is
 * measurably redundant: dropping it changes the resolved set not at all,
 * because the globstar one already matches the root directory through its own
 * trailing slash. Dropping the globstar one instead puts `<target>/debug`
 * straight back into the manifest and the bug returns. Keep both — the
 * explicit root exclusion costs one line and does not lean on that globstar
 * behaviour holding — but do not read the pair as two independent guards.
 *
 * The cost is that the archive carries no directory entries, so empty
 * directories and directory permissions and mtimes are not preserved.
 * Acceptable for a cargo target directory specifically: cargo decides
 * freshness from file mtimes, recreates any directory it needs, and an empty
 * directory in `target/` holds no build state. `registryPaths` keeps naming
 * bare directories precisely because it has nothing to exclude and so pays
 * none of this.
 *
 * Excluding rather than deleting keeps the working tree intact, so a failed
 * save leaves nothing damaged.
 *
 * These stay forward-slash-joined on every platform, deliberately not
 * `path.join`: `@actions/glob` normalises separators for matching, but a
 * backslash in a glob pattern is an escape character on POSIX, so a
 * backslash-joined pattern would itself need escaping. A mixed-separator
 * path string is fine for globbing; a backslash-escaped glob is not.
 */
export function buildPaths(workspaces: Workspace[]): string[] {
  return workspaces.flatMap(({ targetDir }) => [
    `${targetDir}/**`,
    `!${targetDir}/**/incremental/**`,
    `!${targetDir}/**/examples/**`,
    `!${targetDir}/`,
    `!${targetDir}/**/`,
  ]);
}

/**
 * The binaries rustup owns, which must never enter the `bin` layer.
 *
 * `$CARGO_HOME/bin` holds both rustup's shims and cargo-installed tools. The
 * shims belong to the toolchain, and excluding them is precisely what allows
 * the toolchain to leave the `bin` cache key — so bumping stable no longer
 * forces a reinstall of every tool. It also avoids `Swatinem/rust-cache`'s
 * destructive alternative, which deletes any binary present before the action
 * ran and is why that action warns against self-hosted runners.
 *
 * A fixed, known set, unlike the ownership inference Phase D replaces for the
 * `build` layer: there is nothing to guess here.
 */
export const RUSTUP_SHIMS = [
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
] as const;

/**
 * The bin layer's paths, with rustup's shims excluded.
 *
 * The same files-only glob shape `buildPaths` uses, and for the same reason:
 * `@actions/cache` resolves these patterns with `implicitDescendants: false`,
 * writes the matches to a manifest, then runs `tar --files-from <manifest>`
 * with no `--no-recursion`. Any directory left in that manifest is expanded
 * wholesale by tar, re-including every shim the negations just removed. The
 * trailing-slash patterns are what strip directories and leave a files-only
 * manifest, so they are load-bearing rather than decoration — delete them and
 * every exclusion above silently stops working, with no unit test of the glob
 * layer alone noticing. `E2E Warm Cache` is what actually proves it.
 *
 * Both the bare and the `.exe` spelling are negated unconditionally rather
 * than behind a platform check. A negation for a file that does not exist
 * matches nothing, and the E2E matrix runs `windows-latest`, where every shim
 * carries the suffix.
 *
 * Nothing on disk is touched, so a failed save leaves the working tree intact.
 * Forward-slash joined on every platform, deliberately not `path.join`: a
 * backslash is an escape character in a glob on POSIX.
 *
 * The last two entries are cargo's install ledger, and they are the difference
 * between a warm `bin` cache being usable and being a trap. They sit at
 * `$CARGO_HOME/`, one level ABOVE `bin/`, so the glob above cannot reach them.
 * Cargo records there which package installed which binary, from which source
 * and revision; restore the binaries without it and cargo finds files it has no
 * record of. Measured against cargo 1.97.1, the two cases differ completely:
 *
 *   with the ledger:    Ignored package `x` is already installed  -> exit 0
 *   without the ledger: error: binary `x` already exists in destination -> 101
 *
 * So a consumer's own `cargo install` step — for anything `cargo-tools` cannot
 * express, such as a `--git --rev` build — succeeds as a no-op on a cache hit
 * with the ledger, and hard-fails on every run after the first without it. The
 * usual workaround, `--force`, rebuilds from source every run and thereby
 * discards the exact saving this layer exists to provide.
 */
export function binPaths(cargoHome: string): string[] {
  const bin = `${cargoHome}/bin`;
  return [
    `${bin}/**`,
    // Grouped with the include above, not appended at the end: the two
    // directory negations must remain the LAST entries, because they are what
    // strips directories from tar's manifest and makes every negation before
    // them take effect. These two are plain file paths outside `bin/`, so no
    // negation here can match them either way.
    `${cargoHome}/.crates.toml`,
    `${cargoHome}/.crates2.json`,
    ...RUSTUP_SHIMS.flatMap((shim) => [
      `!${bin}/${shim}`,
      `!${bin}/${shim}.exe`,
    ]),
    `!${bin}/`,
    `!${bin}/**/`,
  ];
}
