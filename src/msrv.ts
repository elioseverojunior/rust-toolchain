// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { parse } from "smol-toml";

import type { PackageMsrv } from "@rust-toolchain/cache/metadata";
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

/** The highest declared requirement, and the package that declares it. */
export interface MsrvRequirement {
  version: string;
  package: string;
}

/** The highest requirement, keeping the parsed form for comparison. */
interface BestRequirement {
  parsed: Version;
  requirement: MsrvRequirement;
}

/**
 * The maximum `rust-version` across the graph, parsed form included.
 *
 * Private, and the parsed value is why: `evaluateMsrv` needs it to compare
 * without parsing the same string twice, while callers outside this module
 * only ever want the requirement.
 */
function bestRequirement(packages: PackageMsrv[]): BestRequirement | undefined {
  let best: BestRequirement | undefined;

  for (const entry of packages) {
    const parsed = parseVersion(entry.rustVersion);
    if (!parsed) continue;
    if (best && compareVersions(parsed, best.parsed) <= 0) continue;
    best = {
      parsed,
      requirement: {
        version: entry.rustVersion,
        package: `${entry.name} ${entry.version}`,
      },
    };
  }

  return best;
}

/**
 * The maximum `rust-version` across the resolved graph.
 *
 * A crate's own declaration is not the answer: cargo-binstall 1.21.1 declares
 * 1.79 while pinning vergen 10.0.1, which needs 1.95. Under `--locked` the
 * graph binds, so the floor is sixteen minor versions above what the crate
 * advertises. Unparseable values are skipped rather than fatal — see
 * `parseVersion`.
 */
export function effectiveMsrv(
  packages: PackageMsrv[],
): MsrvRequirement | undefined {
  return bestRequirement(packages)?.requirement;
}

/**
 * The outcome of comparing the installed toolchain against the graph.
 *
 * `ok` carries the requirement it cleared so the caller can publish
 * `msrv-effective` from the verdict alone. Without it every caller would run
 * the maximum a second time, and the two results could drift apart under a
 * later edit.
 */
export type MsrvVerdict =
  | { kind: "ok"; required: MsrvRequirement }
  | { kind: "skipped"; reason: string }
  | { kind: "violation"; installed: string; required: MsrvRequirement };

/**
 * Compares the installed rustc against the graph's effective MSRV.
 *
 * `skipped` is a distinct outcome from `ok` on purpose: a check that could not
 * run is not a check that passed, and the caller reports the two differently.
 * Inability to verify never fails a build, even under `msrv-check: error`.
 */
export function evaluateMsrv(
  installed: string,
  packages: PackageMsrv[],
): MsrvVerdict {
  const current = parseVersion(installed);
  if (!current) {
    return {
      kind: "skipped",
      reason: "the installed rustc version could not be read",
    };
  }

  const best = bestRequirement(packages);
  if (!best) {
    return {
      kind: "skipped",
      reason: "no package in the graph declares a rust-version",
    };
  }

  // `best.parsed` rather than re-parsing `best.requirement.version`: the same
  // string, already read once, and re-reading it would add a branch for a
  // failure that cannot happen here.
  if (compareVersions(current, best.parsed) < 0) {
    return { kind: "violation", installed, required: best.requirement };
  }
  return { kind: "ok", required: best.requirement };
}

/** Renders a verdict as the line a human reads in the log. */
export function describeVerdict(verdict: MsrvVerdict): string {
  if (verdict.kind === "violation") {
    return (
      `${verdict.required.package} requires rustc ${verdict.required.version}, ` +
      `but ${verdict.installed} is installed.`
    );
  }
  if (verdict.kind === "skipped") {
    return `MSRV check skipped: ${verdict.reason}.`;
  }
  return "The installed toolchain satisfies every declared rust-version.";
}
