// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

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

const fs = {
  readdir: (dir: string): string[] => readdirSync(dir),
  stat: (path: string): { size: number; isDirectory: () => boolean } =>
    statSync(path),
};

// GitHub sets STATE_isPost once the main phase has called saveState("isPost").
if (process.env.STATE_isPost === "true") {
  await runPost({
    cache: client,
    core: { getState, info, warning, summary },
    measure: (paths) => measurePaths(paths, fs),
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
    cache: client,
  });
}
