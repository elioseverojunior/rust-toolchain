// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { parse } from "smol-toml";

import { describeError } from "@rust-toolchain/errors";

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

/** Where a resolved `rust-version` came from. */
export type MsrvSource = "cargo-toml" | "workspace-inherit" | "none";

/** A manifest's declared MSRV, with its provenance. */
export interface ManifestMsrv {
  rustVersion?: string;
  source: MsrvSource;
}

const NONE: ManifestMsrv = { source: "none" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The string at `<table>.rust-version`, or undefined when absent or typed wrong. */
function declaredVersion(table: unknown): string | undefined {
  if (!isRecord(table)) return undefined;
  const value = table["rust-version"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** True for `rust-version.workspace = true`, cargo's inheritance marker. */
function inherits(table: unknown): boolean {
  if (!isRecord(table)) return false;
  const value = table["rust-version"];
  return isRecord(value) && value.workspace === true;
}

/**
 * Reads a `Cargo.toml`'s MSRV, resolving workspace inheritance.
 *
 * Three shapes matter. `[package] rust-version` is the plain case. A virtual
 * manifest has no `[package]` and declares `[workspace.package] rust-version`.
 * A member writes `rust-version.workspace = true`, which parses to the OBJECT
 * `{ workspace: true }` — read naively that is not a version at all, and it is
 * the one trap in this function.
 *
 * Throws on malformed TOML rather than guessing, matching
 * `parseRustToolchainToml`: a syntax error hides the author's intent, and
 * falling back would install a toolchain nobody asked for.
 */
export function parseCargoManifest(contents: string): ManifestMsrv {
  if (!contents.trim()) return NONE;

  let document: unknown;
  try {
    document = parse(contents);
  } catch (error) {
    throw new Error(`Cargo.toml is not valid TOML: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(document)) return NONE;

  const workspacePackage = isRecord(document.workspace)
    ? document.workspace.package
    : undefined;
  const workspaceVersion = declaredVersion(workspacePackage);

  const own = declaredVersion(document.package);
  if (own !== undefined) return { rustVersion: own, source: "cargo-toml" };

  // Inheritance is opt-in, and that is the whole subtlety. Cargo hands a
  // member the workspace value ONLY when it writes
  // `rust-version.workspace = true`; a `[package]` that simply omits the key
  // has no MSRV, even with `[workspace.package]` sitting in the same file.
  // A virtual manifest is the other case — no `[package]` at all, so the
  // workspace table IS the declaration rather than something inherited.
  //
  // Falling back to the workspace value unconditionally would report an MSRV
  // the crate does not have, and under `msrv-fallback: true` would install a
  // toolchain cargo never asked for.
  const inheritable = !isRecord(document.package) || inherits(document.package);
  if (inheritable && workspaceVersion !== undefined) {
    return { rustVersion: workspaceVersion, source: "workspace-inherit" };
  }
  return NONE;
}
