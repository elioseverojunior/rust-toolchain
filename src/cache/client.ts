// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * The cache operations the lifecycle needs, as a port.
 *
 * The only real implementation wraps `@actions/cache` and lives in
 * `src/index.ts`, which nothing imports and the coverage gate does not measure.
 * That placement is the point: `@actions/cache` is 1.39 MB of Azure storage SDK
 * and unmockable network code, so a library module importing it would put it
 * into every test process and make the 100% gate unreachable for the lifecycle.
 *
 * `restore` returns the key that actually matched — which may be a restore-key
 * prefix rather than the exact key — or `undefined` on a miss. The caller
 * compares it against the exact key to decide whether saving is worth doing.
 */
export interface CacheClient {
  restore(
    paths: string[],
    key: string,
    restoreKeys: string[],
  ): Promise<string | undefined>;
  save(paths: string[], key: string): Promise<void>;
}
