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
 * The two trailing directory negations are the ones that make the whole set
 * work, and removing them silently disables everything above. `@actions/cache`
 * resolves these patterns with `implicitDescendants: false`, writes the matches
 * to a manifest, then runs `tar --files-from <manifest>` — with no
 * `--no-recursion`. Any directory left in that manifest is therefore expanded
 * wholesale by tar, re-including every path the negations just removed, and
 * duplicating each file once per listed ancestor. Excluding directories leaves
 * a files-only manifest, which is the only shape in which a negation survives
 * to the archive. (This is also why the pre-fix `[<target>, !…]` form excluded
 * nothing: `implicitDescendants: false` made `<target>` match one entry — the
 * directory — and tar then archived the whole tree from it.)
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
