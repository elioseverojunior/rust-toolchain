// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { Workspace } from "@/cache/paths";
import {
  buildStageRoots,
  registryStageRoot,
  STAGE_DIR_NAME,
  stagedLocation,
  stageFiles,
  stagePaths,
  unstagedLocation,
  unstageFiles,
  type StageFs,
  type StageRoot,
} from "@/cache/stage";

const WORKSPACES: Workspace[] = [
  { manifestDir: "/w", targetDir: "/w/target" },
  { manifestDir: "/w/crates/b", targetDir: "/w/out" },
];

const BUILD_ROOT: StageRoot = {
  stageDir: `/w/target/${STAGE_DIR_NAME}`,
  sourceDir: "/w/target",
};

/**
 * A `StageFs` over a plain map, so the pure staging logic is testable without
 * touching a disk. `fail` names paths whose operation throws, which is how the
 * "one file vanished mid-job" case is reached.
 */
function fakeFs(
  seed: string[] = [],
  fail: ReadonlySet<string> = new Set(),
): StageFs & { files: Set<string>; dirs: Set<string> } {
  const files = new Set(seed);
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    mkdirp: (dir): void => {
      dirs.add(dir);
    },
    link: (from, to): void => {
      if (fail.has(from)) throw new Error(`ENOENT: ${from}`);
      files.add(to);
    },
    walk: (dir) =>
      [...files].filter((file) => file.startsWith(`${dir}/`)).sort(),
    move: (from, to): void => {
      if (fail.has(from)) throw new Error(`EXDEV: ${from}`);
      files.delete(from);
      files.add(to);
    },
    remove: (dir): void => {
      for (const file of [...files]) {
        if (file === dir || file.startsWith(`${dir}/`)) files.delete(file);
      }
    },
  };
}

describe("stage roots", () => {
  it("puts the build stage inside the target dir it mirrors", () => {
    expect(buildStageRoots(WORKSPACES)).toEqual([
      { stageDir: `/w/target/${STAGE_DIR_NAME}`, sourceDir: "/w/target" },
      { stageDir: `/w/out/${STAGE_DIR_NAME}`, sourceDir: "/w/out" },
    ]);
  });

  it("puts the registry stage inside cargo home", () => {
    expect(registryStageRoot("/home/u/.cargo")).toEqual({
      stageDir: `/home/u/.cargo/${STAGE_DIR_NAME}`,
      sourceDir: "/home/u/.cargo",
    });
  });

  // The whole point of the module: `@actions/cache` folds the paths array into
  // the cache entry's identity, so a paths array that varies with the keep-set
  // makes every entry it writes unreadable. These paths derive from the
  // workspace layout alone.
  it("names only the stage directories, so the paths array is content-free", () => {
    expect(stagePaths(buildStageRoots(WORKSPACES))).toEqual([
      `/w/target/${STAGE_DIR_NAME}`,
      `/w/out/${STAGE_DIR_NAME}`,
    ]);
  });

  it("derives the same paths array from a different keep-set", () => {
    const first = stagePaths(buildStageRoots(WORKSPACES));
    const second = stagePaths(buildStageRoots([...WORKSPACES]));
    expect(first).toEqual(second);
  });
});

describe("stagedLocation", () => {
  it("mirrors a source file's relative path under the stage", () => {
    expect(stagedLocation(BUILD_ROOT, "/w/target/debug/libfoo.rlib")).toBe(
      `/w/target/${STAGE_DIR_NAME}/debug/libfoo.rlib`,
    );
  });

  it("rejects a file outside the source tree", () => {
    expect(stagedLocation(BUILD_ROOT, "/elsewhere/x")).toBeUndefined();
  });

  // Without this the fallback path ("stage everything") would walk the stage
  // it is currently filling and recurse until the disk gave out.
  it("rejects a file already inside the stage", () => {
    expect(
      stagedLocation(BUILD_ROOT, `/w/target/${STAGE_DIR_NAME}/debug/x`),
    ).toBeUndefined();
  });

  it("rejects the source directory itself", () => {
    expect(stagedLocation(BUILD_ROOT, "/w/target")).toBeUndefined();
  });

  it("rejects a sibling whose name merely starts with the source dir", () => {
    expect(stagedLocation(BUILD_ROOT, "/w/target-old/x")).toBeUndefined();
  });
});

describe("unstagedLocation", () => {
  it("maps a staged file back to its place in the source tree", () => {
    expect(
      unstagedLocation(BUILD_ROOT, `/w/target/${STAGE_DIR_NAME}/debug/x`),
    ).toBe("/w/target/debug/x");
  });

  it("rejects a path outside the stage", () => {
    expect(unstagedLocation(BUILD_ROOT, "/w/target/debug/x")).toBeUndefined();
  });
});

describe("stageFiles", () => {
  it("links every kept file into the stage, creating parents", () => {
    const fs = fakeFs(["/w/target/debug/a.rlib", "/w/target/debug/b.rlib"]);
    const outcome = stageFiles(
      BUILD_ROOT,
      ["/w/target/debug/a.rlib", "/w/target/debug/b.rlib"],
      fs,
    );

    expect(outcome).toEqual({ staged: 2, failed: 0 });
    expect(fs.files.has(`/w/target/${STAGE_DIR_NAME}/debug/a.rlib`)).toBe(true);
    expect(fs.files.has(`/w/target/${STAGE_DIR_NAME}/debug/b.rlib`)).toBe(true);
    expect(fs.dirs.has(`/w/target/${STAGE_DIR_NAME}/debug`)).toBe(true);
  });

  it("skips a file that is not under this root", () => {
    const fs = fakeFs();
    expect(stageFiles(BUILD_ROOT, ["/other/x"], fs)).toEqual({
      staged: 0,
      failed: 0,
    });
  });

  // A cache failure never fails the build, and a file cargo removed between
  // the walk and the link is not a reason to lose the whole layer.
  it("counts a file that vanished rather than throwing", () => {
    const fs = fakeFs([], new Set(["/w/target/debug/gone.rlib"]));
    expect(
      stageFiles(
        BUILD_ROOT,
        ["/w/target/debug/gone.rlib", "/w/target/debug/ok.rlib"],
        fs,
      ),
    ).toEqual({ staged: 1, failed: 1 });
  });

  it("clears a stage left behind by an earlier attempt", () => {
    const fs = fakeFs([`/w/target/${STAGE_DIR_NAME}/stale`]);
    stageFiles(BUILD_ROOT, [], fs);
    expect(fs.files.has(`/w/target/${STAGE_DIR_NAME}/stale`)).toBe(false);
  });
});

describe("unstageFiles", () => {
  it("moves every staged file back and clears the stage", () => {
    const fs = fakeFs([
      `/w/target/${STAGE_DIR_NAME}/debug/a.rlib`,
      `/w/target/${STAGE_DIR_NAME}/debug/deps/b.rlib`,
    ]);
    const outcome = unstageFiles(BUILD_ROOT, fs);

    expect(outcome).toEqual({ staged: 2, failed: 0 });
    expect(fs.files.has("/w/target/debug/a.rlib")).toBe(true);
    expect(fs.files.has("/w/target/debug/deps/b.rlib")).toBe(true);
    expect([...fs.files].some((f) => f.includes(STAGE_DIR_NAME))).toBe(false);
  });

  it("reports nothing when the stage is absent", () => {
    expect(unstageFiles(BUILD_ROOT, fakeFs())).toEqual({
      staged: 0,
      failed: 0,
    });
  });

  it("counts a file it could not move rather than throwing", () => {
    const bad = `/w/target/${STAGE_DIR_NAME}/debug/a.rlib`;
    const fs = fakeFs([bad], new Set([bad]));
    expect(unstageFiles(BUILD_ROOT, fs)).toEqual({ staged: 0, failed: 1 });
  });

  // `walk` is an injected port, so "everything it returns is under the stage"
  // is an assumption about someone else's code rather than something this
  // module can prove. Counting the stray entry keeps a wrong adapter visible
  // instead of silently moving a file out of the tree it belongs to.
  //
  // The `mkdirp`/`move` assertions pin intent rather than close a hole.
  // Deleting the guard entirely is an EQUIVALENT mutation today: without it
  // `parentDir(undefined)` throws inside the try below, the catch increments
  // `failed`, and the count comes out identical. So `failed: 1` alone cannot
  // tell the two apart, and no test can. What these assertions do buy is a
  // guarantee against a future refactor — make `parentDir` total, or move the
  // `mkdirp` call above the try, and a stray path would suddenly be acted on
  // with nothing else to notice.
  it("counts a walk entry that is not under the stage, without touching it", () => {
    const touched: string[] = [];
    const inner = fakeFs();
    const fs: StageFs = {
      ...inner,
      walk: () => ["/somewhere/else/x"],
      mkdirp: (dir) => {
        touched.push(`mkdirp:${dir}`);
        inner.mkdirp(dir);
      },
      move: (from, to) => {
        touched.push(`move:${from}`);
        inner.move(from, to);
      },
    };

    expect(unstageFiles(BUILD_ROOT, fs)).toEqual({ staged: 0, failed: 1 });
    expect(touched).toEqual([]);
  });
});
