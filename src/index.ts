// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  addPath,
  exportVariable,
  getInput,
  info,
  setFailed,
  setOutput,
} from "@actions/core";

import { run } from "@rust-toolchain/action";

/**
 * GitHub Action entry point.
 *
 * Wiring only — every decision lives in `./action`, where it is tested. Keep
 * this file free of logic: nothing imports it, so it is invisible to the
 * coverage gate.
 */
run({
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
  core: { getInput, setOutput, setFailed, exportVariable, addPath, info },
  env: process.env,
  platform: process.platform,
  // Blocks the thread without a timer: `run` is synchronous, so a retry pause
  // must not hand control back to the event loop mid-install.
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
});
