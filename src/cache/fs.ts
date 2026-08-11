// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

import type { StatFs } from "@rust-toolchain/cache/budget";
import type { StageFs } from "@rust-toolchain/cache/stage";

/**
 * The real `node:fs` implementations of the cache's filesystem ports.
 *
 * These lived in `src/index.ts` alongside the `@actions/cache` client, which
 * is outside the coverage gate because it vendors an Azure SDK and unmockable
 * network code. Nothing here shares that problem — it is plain `node:fs`, no
 * network — and being swept into that exemption by proximity is what let a
 * real bug through: the only description of `walk`'s behaviour that any test
 * ever saw was a hand-written fake that returned an empty list for a missing
 * directory, while `readdirSync` throws. The fake and the code agreed because
 * the same hand wrote both, and no amount of line coverage could notice.
 *
 * So they live here, where `fs.test.ts` exercises them against a real
 * directory and the port contracts have one description that is actually
 * verified.
 */

/**
 * Every file beneath a directory, recursively; empty when it is absent.
 *
 * The absence half is the contract, not a convenience. Several of the paths
 * this walks are legitimately optional — `$CARGO_HOME/git/db` does not exist
 * until a workspace takes a git dependency — and an adapter that throws on
 * them takes a layer's save down with it, which is precisely what happened.
 *
 * Note that an absent directory and an empty one both yield `[]`. That is
 * deliberate here: for a save-time file list the two are the same statement,
 * "there is nothing to archive". The distinction that *does* matter — missing
 * versus unreadable — is drawn by the callers, which swallow only `ENOENT`.
 */
export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * The `StatFs` `measurePaths` needs.
 *
 * Deliberately unguarded, unlike `walkFiles`: `measurePaths` distinguishes a
 * missing path from an unreadable one itself and reports the second, so
 * swallowing the error here would erase a distinction it exists to draw.
 */
export const nodeStatFs: StatFs = {
  readdir: (dir: string): string[] => readdirSync(dir),
  stat: (path: string): { size: number; isDirectory: () => boolean } =>
    statSync(path),
};

/**
 * The `StageFs` staging needs.
 *
 * `link` is a hard link rather than a copy, and that is load-bearing twice
 * over: it costs one inode reference instead of the file's bytes, and it
 * shares the source's mtime, which is what cargo's freshness check reads. A
 * copy would be slower *and* would hand a restored tree new mtimes, making
 * cargo rebuild everything it had just been given.
 *
 * `remove` forces, because clearing a stage that was never created is the
 * ordinary path on a cache miss rather than an error.
 */
export const nodeStageFs: StageFs = {
  mkdirp: (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  },
  link: (from: string, to: string): void => {
    linkSync(from, to);
  },
  walk: walkFiles,
  move: (from: string, to: string): void => {
    renameSync(from, to);
  },
  remove: (dir: string): void => {
    rmSync(dir, { recursive: true, force: true });
  },
};
