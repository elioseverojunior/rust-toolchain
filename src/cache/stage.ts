// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { Workspace } from "@rust-toolchain/cache/paths";

/**
 * The directory a staged layer is archived from.
 *
 * Placed *inside* the tree it mirrors — `target/` for the build layer,
 * `$CARGO_HOME` for the registry layer — for two reasons that both rule out
 * `$RUNNER_TEMP`. Hard links cannot cross a filesystem, and on the hosted
 * runners `$RUNNER_TEMP` and the workspace are not guaranteed to share one;
 * staging inside the source tree makes same-device a structural property
 * rather than something to detect and fall back from. And both locations are
 * already ignored by git, so nothing here can surface in a `git status` the
 * job later checks.
 */
export const STAGE_DIR_NAME = ".rust-toolchain-stage";

/** A staged layer: what the archive contains, and where it came from. */
export interface StageRoot {
  /**
   * The single directory handed to the cache client as the layer's path.
   *
   * Derived from the workspace layout and nothing else. That is the entire
   * point of this module — see `stagePaths`.
   */
  stageDir: string;
  /** The tree staged files are linked from, and restored back into. */
  sourceDir: string;
}

/** How much of a stage operation succeeded. */
export interface StageOutcome {
  staged: number;
  failed: number;
}

/**
 * Everything staging touches on disk, so the mapping logic stays testable.
 *
 * The real implementation is in `src/index.ts` alongside the other adapters,
 * for the reason given there: a module under test must not reach a real
 * filesystem, and `src/index.ts` is outside the coverage gate.
 */
export interface StageFs {
  /** Creates a directory and every missing parent. */
  mkdirp: (dir: string) => void;
  /** Hard-links `from` to `to`. */
  link: (from: string, to: string) => void;
  /** Every file beneath a directory, recursively; empty when it is absent. */
  walk: (dir: string) => string[];
  /** Moves a file. */
  move: (from: string, to: string) => void;
  /** Removes a directory tree, tolerating absence. */
  remove: (dir: string) => void;
}

/** The build layer's stage roots, one per workspace. */
export function buildStageRoots(workspaces: Workspace[]): StageRoot[] {
  return workspaces.map(({ targetDir }) => ({
    stageDir: `${targetDir}/${STAGE_DIR_NAME}`,
    sourceDir: targetDir,
  }));
}

/** The registry layer's stage root. */
export function registryStageRoot(cargoHome: string): StageRoot {
  return {
    stageDir: `${cargoHome}/${STAGE_DIR_NAME}`,
    sourceDir: cargoHome,
  };
}

/**
 * The paths array a staged layer hands the cache client.
 *
 * `@actions/cache` does not look an entry up by key alone. It matches on
 * `(key, version)`, where the version is `sha256(paths.join("|") | …)` — the
 * paths array *is* part of the entry's identity. A save that narrows the array
 * to a computed keep-set therefore writes an entry under a version no restore
 * ever asks for: the key matches, the version does not, and the layer reports
 * a miss forever while still paying the upload every run.
 *
 * These paths name stage directories and nothing else, so the array depends on
 * the workspace layout alone. Whether a keep-set applied, and which files it
 * chose, changes what is *inside* the stage and never the array — which is the
 * property that makes an entry readable by the run after it.
 */
export function stagePaths(roots: StageRoot[]): string[] {
  return roots.map((root) => root.stageDir);
}

/** The directory holding a path, which here always has a parent. */
function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * Where a source file belongs inside the stage.
 *
 * `undefined` for anything outside the source tree, and — load-bearing — for
 * anything already inside the stage. The fallback path stages every file it
 * walked, and without that guard a walk that reached the stage would link its
 * own output back into itself.
 */
export function stagedLocation(
  root: StageRoot,
  file: string,
): string | undefined {
  if (file === root.stageDir || file.startsWith(`${root.stageDir}/`)) {
    return undefined;
  }
  const prefix = `${root.sourceDir}/`;
  if (!file.startsWith(prefix)) return undefined;

  const relative = file.slice(prefix.length);
  return relative ? `${root.stageDir}/${relative}` : undefined;
}

/** Where a staged file belongs back in the source tree. */
export function unstagedLocation(
  root: StageRoot,
  staged: string,
): string | undefined {
  const prefix = `${root.stageDir}/`;
  if (!staged.startsWith(prefix)) return undefined;

  const relative = staged.slice(prefix.length);
  return relative ? `${root.sourceDir}/${relative}` : undefined;
}

/**
 * Links every kept file into the stage, ready to be archived.
 *
 * Hard links rather than copies: they cost one inode reference each instead of
 * the bytes, and they share the source file's mtime, which is what cargo's
 * freshness check reads. A copy would be both slower and subtly wrong.
 *
 * Nothing is removed from the source tree — the link is an addition, and the
 * stage is cleared again once the archive is written. That preserves the
 * property the coarse-glob form had: a save failure cannot damage the
 * checkout.
 *
 * A file that vanished between the walk and the link is counted, not thrown:
 * cargo may still be finishing, and one lost artifact is not a reason to lose
 * the layer.
 */
export function stageFiles(
  root: StageRoot,
  files: readonly string[],
  fs: StageFs,
): StageOutcome {
  // A stage left behind by an earlier attempt would otherwise be archived
  // alongside this one's, restoring files the keep-set had dropped.
  fs.remove(root.stageDir);

  let staged = 0;
  let failed = 0;
  for (const file of files) {
    const destination = stagedLocation(root, file);
    if (destination === undefined) continue;
    try {
      fs.mkdirp(parentDir(destination));
      fs.link(file, destination);
      staged += 1;
    } catch {
      failed += 1;
    }
  }
  return { staged, failed };
}

/**
 * Moves every staged file back into the source tree, then clears the stage.
 *
 * The mirror of `stageFiles`, run straight after a restore. A move rather than
 * a link because the stage is about to be removed, and `rename` preserves the
 * mtime tar restored — again, what cargo's freshness check reads.
 */
export function unstageFiles(root: StageRoot, fs: StageFs): StageOutcome {
  let staged = 0;
  let failed = 0;
  for (const file of fs.walk(root.stageDir)) {
    const destination = unstagedLocation(root, file);
    if (destination === undefined) {
      failed += 1;
      continue;
    }
    try {
      fs.mkdirp(parentDir(destination));
      fs.move(file, destination);
      staged += 1;
    } catch {
      failed += 1;
    }
  }
  fs.remove(root.stageDir);
  return { staged, failed };
}
