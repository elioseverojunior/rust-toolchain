// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

import * as cache from "@actions/cache";
import {
  addPath,
  exportVariable,
  getInput,
  getState,
  info,
  saveState,
  setFailed,
  setOutput,
  summary,
  warning,
} from "@actions/core";

import { run, runPost } from "@rust-toolchain/action";
import { measurePaths } from "@rust-toolchain/cache/budget";

/**
 * GitHub Action entry point.
 *
 * Wiring only — every decision lives in `./action`, where it is tested. Keep
 * this file free of logic: nothing imports it, so it is invisible to the
 * coverage gate. That is also why the `@actions/cache` adapter is built only
 * here: it is 1.39 MB of Azure storage SDK and unmockable network code, and a
 * library module importing it would pull it into every test process.
 */
const client = {
  restore: (
    paths: string[],
    key: string,
    restoreKeys: string[],
  ): Promise<string | undefined> =>
    cache.restoreCache(paths.slice(), key, restoreKeys.slice()),
  save: async (paths: string[], key: string): Promise<void> => {
    await cache.saveCache(paths.slice(), key);
  },
};

/**
 * Every file beneath a directory.
 *
 * Here rather than in a library module for the same reason the other adapters
 * are: it is unmockable filesystem recursion, and `src/index.ts` is invisible
 * to the coverage gate. `computeKeepSet` takes the resulting list as data.
 */
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

/**
 * The staging half of the wiring.
 *
 * Hard links rather than copies, for the reason `stageFiles` gives: they cost
 * an inode reference instead of the bytes, and they share the source file's
 * mtime, which is what cargo's freshness check reads. `walk` tolerates a
 * missing directory here because a stage that was never written is the normal
 * case on a cache miss.
 */
const stageFs = {
  mkdirp: (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  },
  link: (from: string, to: string): void => linkSync(from, to),
  walk: (dir: string): string[] => (existsSync(dir) ? walk(dir) : []),
  move: (from: string, to: string): void => renameSync(from, to),
  remove: (dir: string): void => {
    rmSync(dir, { recursive: true, force: true });
  },
};

/**
 * The `cargo metadata` half of the wiring.
 *
 * `--locked` on purpose: resolving against a lockfile that would have to be
 * updated is exactly the case where the package set is untrustworthy, and a
 * non-zero exit here is caught upstream and downgraded to "save everything".
 * A wrong package set would prune artifacts a later build needs.
 */
const metadata = {
  read: async (manifestDir: string): Promise<string> =>
    spawnSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
      cwd: manifestDir,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }).stdout ?? "",
};

const fs = {
  readdir: (dir: string): string[] => readdirSync(dir),
  stat: (path: string): { size: number; isDirectory: () => boolean } =>
    statSync(path),
};

/**
 * The crates.io half of the wiring, here for the same reason the cache adapter
 * is: this file is never imported, so the coverage gate cannot see it and the
 * network code stays out of every test process.
 *
 * `max_stable_version` rather than `newest_version`: the latter includes
 * pre-releases, and resolving a bare `cargo-nextest` to an alpha is not what
 * anyone means by "latest".
 *
 * The User-Agent is not optional — crates.io rejects requests without one, and
 * their policy asks that it identify the caller.
 */
const registry = {
  latestVersion: async (name: string): Promise<string> => {
    const response = await fetch(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      {
        headers: {
          "user-agent":
            "elioseverojunior/rust-toolchain (https://github.com/elioseverojunior/rust-toolchain)",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`crates.io answered ${response.status} for ${name}`);
    }
    const body = (await response.json()) as {
      crate?: { max_stable_version?: string };
    };
    const version = body.crate?.max_stable_version;
    if (!version) {
      throw new Error(`crates.io published no stable version for ${name}`);
    }
    return version;
  },
};

// GitHub sets STATE_isPost once the main phase has called saveState("isPost").
if (process.env.STATE_isPost === "true") {
  await runPost({
    cache: client,
    core: { getState, info, warning, summary },
    measure: (paths) => measurePaths(paths, fs),
    metadata,
    walk,
    readdir: (dir) => readdirSync(dir),
    stageFs,
  });
} else {
  await run({
    exec: (file, args, opts) => {
      const result = spawnSync(file, args, {
        env: opts.env,
        timeout: opts.timeoutMs,
        stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
        encoding: "utf-8",
      });
      return {
        status: result.status,
        stdout: result.stdout ?? undefined,
        error: result.error,
      };
    },
    readFile: (path) => readFileSync(path, "utf-8"),
    core: {
      getInput,
      setOutput,
      setFailed,
      exportVariable,
      addPath,
      info,
      saveState,
      getState,
      warning,
      summary,
    },
    env: process.env,
    platform: process.platform,
    // Blocks the thread without a timer. `run` is async now, but `exec` is
    // still `spawnSync`, so nothing here actually needs to run during a retry
    // pause — synchronous is a leftover choice, not a requirement, now that
    // the surrounding call is awaited rather than fire-and-forget.
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    // Promise-based, unlike `sleep` above: registry lookups run concurrently,
    // and a blocking pause would serialise them into one at a time.
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cache: client,
    registry,
    stageFs,
  });
}
