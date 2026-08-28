// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
import { nodeStageFs, nodeStatFs, walkFiles } from "@rust-toolchain/cache/fs";

/**
 * GitHub Action entry point.
 *
 * Wiring only — every decision lives in `./action`, where it is tested. Keep
 * this file free of logic: nothing imports it, so it is invisible to the
 * coverage gate.
 *
 * What remains here earns the exemption individually, rather than by living
 * in this file. The `@actions/cache` client vendors 1.39 MB of Azure storage
 * SDK and unmockable network code, so a library module importing it would pull
 * that into every test process. `metadata` shells out to `cargo`, and
 * `registry` calls crates.io.
 *
 * `metadata` is handed to **both** `run` and `runPost` — the main phase reads
 * it for the MSRV check, the post phase reads it again to compute a pruned
 * layer's keep-set. It is not post-phase-only, whatever an older version of
 * this comment said.
 *
 * The `node:fs` adapters used to be here too, and that was a mistake: they
 * have no network and no vendored SDK, so they were exempt by proximity
 * rather than for a reason. Their only description was a hand-written test
 * fake that disagreed with `readdirSync` about a missing directory, and the
 * disagreement cost every pruned cache layer its save. They now live in
 * `cache/fs.ts`, where `cache/fs.test.ts` holds them to a real filesystem.
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
 * The `cargo metadata` half of the wiring.
 *
 * `--locked` on purpose: resolving against a lockfile that would have to be
 * updated is exactly the case where the package set is untrustworthy, and a
 * non-zero exit here is caught upstream and downgraded to "save everything".
 * A wrong package set would prune artifacts a later build needs.
 */
const metadata = {
  read: async (manifestDir: string): Promise<string> => {
    const result = spawnSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked"],
      { cwd: manifestDir, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );

    // A failure is REPORTED rather than returned as "". The previous form was
    // `.stdout ?? ""`, which collapsed every distinct failure -- cargo missing
    // from PATH, a manifest that does not parse, a lockfile cargo refuses to
    // update -- into an empty string, and the empty string then surfaced as
    // "`cargo metadata` did not emit valid JSON: Unexpected end of JSON
    // input". That message is true and useless: it describes the symptom of
    // the reader's own fallback, not the cause, and it names JSON when nothing
    // ever tried to produce any.
    //
    // It cost a real diagnosis. The E2E fixture dropped a dependency from
    // Cargo.toml without rebuilding, so `--locked` exited 101 with "cannot
    // update the lock file", every layer silently staged its whole tree, and
    // the only evidence was a complaint about JSON.
    //
    // The policy above this does not change: the caller still catches, warns,
    // and stages everything. Only the sentence it can print gets better.
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      const detail =
        stderr === "" ? "no stderr" : (stderr.split("\n")[0] ?? "");
      throw new Error(
        `\`cargo metadata --locked\` exited ${result.status} in ${manifestDir}: ${detail}`,
      );
    }
    return result.stdout ?? "";
  },
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
    measure: (paths) => measurePaths(paths, nodeStatFs),
    metadata,
    walk: walkFiles,
    readdir: nodeStatFs.readdir,
    stageFs: nodeStageFs,
  });
} else {
  await run({
    exec: (file, args, opts) => {
      const result = spawnSync(file, args, {
        env: opts.env,
        timeout: opts.timeoutMs,
        // Both streams, not just stdout. `capture` marks a question the action
        // asks and then interprets, and inheriting stderr published the
        // child's complaint about a question it did not like straight into the
        // job log, unattributed and looking like a failure —
        // `cargo-binstall --version` exits 2 with
        // `error: a value is required for '--version <VERSION>'`, which read
        // as an error in a run that succeeded. The text is carried back in
        // `stderr` instead, for the caller to surface if it matters.
        stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: "utf-8",
      });
      return {
        status: result.status,
        stdout: result.stdout ?? undefined,
        stderr: result.stderr ?? undefined,
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
    metadata,
    stageFs: nodeStageFs,
  });
}
