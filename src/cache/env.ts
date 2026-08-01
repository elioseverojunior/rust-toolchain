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
 * Matches a prefix but must not reach the digest.
 *
 * Two groups, for two different reasons.
 *
 * The first describes where or how rather than what gets built. `CARGO_HOME`
 * and `RUSTUP_HOME` are absolute paths that differ per machine on self-hosted
 * runners, so hashing them would churn the key without changing an artifact.
 * `CARGO_TERM_COLOR` is presentation. `RUSTUP_TOOLCHAIN` is already inside
 * `cachekey-full`, and hashing it twice buys nothing.
 *
 * The second is this action's own output read back as its input, and it must
 * stay in sync with `applyCargoDefaults` in `src/action.ts` — every variable
 * that function exports belongs here. `core.exportVariable` writes to
 * `GITHUB_ENV`, so a second invocation of the action in the same job sees
 * everything the first one set. Hashing those would make the `build` key
 * depend on how many times the action had already run in the job: measured at
 * `e3b0c442` on a first invocation and `dd704211` on a second, which is a
 * guaranteed miss on a key nothing will ever restore. The E2E job invokes the
 * action twice on purpose, so this is a configuration that exists rather than
 * one that might.
 *
 * Adding a `setIfUnset` call in `applyCargoDefaults` without adding its name
 * here silently reintroduces that drift, and no test of `applyCargoDefaults`
 * alone would notice.
 */
const EXCLUDED = new Set([
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_TERM_COLOR",
  "RUSTUP_TOOLCHAIN",
  // Keep in sync with applyCargoDefaults (src/action.ts).
  "CARGO_INCREMENTAL",
  "CARGO_REGISTRIES_CRATES_IO_PROTOCOL",
  "CARGO_HTTP_MULTIPLEXING",
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
