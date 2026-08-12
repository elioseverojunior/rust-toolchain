// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/** A Rust version as three numbers, with the pre-release suffix discarded. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** `1.88`, `1.88.1`, or either with a `-nightly`-style suffix. */
const VERSION = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/;

/**
 * Reads a Rust version, or `undefined` when the value is not one.
 *
 * `undefined` rather than a throw: `rust_version` reaches this from crates
 * nobody here controls, and one unreadable value must not fail a job. The
 * caller skips what it cannot read.
 *
 * The pre-release suffix is dropped because `rustc --version` reports
 * `1.99.0-nightly` on nightly, and the channel is not part of the ordering.
 */
export function parseVersion(value: string): Version | undefined {
  const match = value.trim().match(VERSION);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/**
 * Orders two versions numerically: negative when `a` precedes `b`.
 *
 * Never compare these as strings — `"1.9"` sorts *above* `"1.10"`
 * lexically and below it numerically, which is the whole reason this exists.
 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** What `msrv-check` does when the installed toolchain is too old. */
export type MsrvPolicy = "off" | "warn" | "error";

const POLICIES: Record<MsrvPolicy, true> = {
  off: true,
  warn: true,
  error: true,
};

const DEFAULT_POLICY: MsrvPolicy = "warn";

/**
 * Reads the `msrv-check` input.
 *
 * `warn` by default: the effective MSRV depends on the dependency graph, so a
 * `cargo update` can raise it without the repository changing. Failing by
 * default would turn an unrelated bump into a red build.
 */
export function parseMsrvPolicy(value: string): MsrvPolicy {
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return DEFAULT_POLICY;
  if (Object.hasOwn(POLICIES, normalised)) return normalised as MsrvPolicy;
  throw new Error(
    `\`msrv-check\` is \`${value.trim()}\`, which is not a policy. ` +
      `Valid values are off, warn, error.`,
  );
}
