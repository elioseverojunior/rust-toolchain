// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { isAbsolute, resolve } from "node:path";

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
 * absolute input is rejected for the same reason rather than trusted.
 */
function resolveInside(root: string, part: string): string {
  const resolved = isAbsolute(part) ? part : resolve(root, part);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
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
 * `<triple>/debug` — so these are negation globs, which `@actions/cache`
 * honours through `@actions/glob`. Excluding rather than deleting keeps the
 * working tree intact, so a failed save leaves nothing damaged.
 */
export function buildPaths(workspaces: Workspace[]): string[] {
  return workspaces.flatMap(({ targetDir }) => [
    targetDir,
    `!${targetDir}/*/incremental`,
    `!${targetDir}/*/examples`,
  ]);
}
