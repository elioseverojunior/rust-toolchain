// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";

/**
 * Environment variables that change what cargo produces.
 *
 * The same prefix set `Swatinem/rust-cache` defaults to. Matching by prefix
 * rather than by name is what makes it cover `RUSTFLAGS`, `RUSTDOCFLAGS`,
 * `CARGO_BUILD_JOBS` and the rest without enumerating a list that goes stale.
 */
const BUILD_ENV_PREFIXES = [
  "CARGO_",
  "CC",
  "CFLAGS",
  "CXX",
  "CMAKE",
  "RUST",
] as const;

/**
 * Matches a prefix but describes where or how, not what gets built.
 *
 * `CARGO_HOME` and `RUSTUP_HOME` are absolute paths that differ per machine on
 * self-hosted runners, so hashing them would churn the key without changing an
 * artifact. `CARGO_TERM_COLOR` is presentation. `RUSTUP_TOOLCHAIN` is already
 * inside `cachekey-full`, and hashing it twice buys nothing.
 */
const EXCLUDED = new Set([
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_TERM_COLOR",
  "RUSTUP_TOOLCHAIN",
]);

/**
 * Digests the build-affecting environment into a key segment.
 *
 * Sorted before hashing, so the digest describes the environment as a set
 * rather than as whatever order the caller happened to build the object in.
 * Truncated to 8 hex characters, the same width `generateSpecCacheKey` uses,
 * so every key segment stays uniform.
 */
export function hashBuildEnv(env: Record<string, string | undefined>): string {
  const canonical = Object.entries(env)
    .filter(([name, value]) => {
      if (value === undefined) return false;
      if (EXCLUDED.has(name)) return false;
      return BUILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    })
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join("\n");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}
