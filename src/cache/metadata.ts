// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describeError } from "@rust-toolchain/errors";

/**
 * Reads `cargo metadata` output, the authoritative answer to which packages a
 * workspace still depends on.
 *
 * This is the input to pruning: an artifact under `target/` whose package is
 * absent from this set is one no later build can use, so archiving it pays
 * transfer for nothing. Deriving the set from cargo rather than from filenames
 * is the whole difference from `Swatinem/rust-cache`, which infers ownership by
 * stripping a trailing `-$hash` and string-comparing the remainder.
 */

/** A package identified the way cargo's own package-id spec spells it. */
export type PackageId = string;

/**
 * The packages a workspace resolves to, with its own crates called out.
 *
 * `workspaceMembers` is a subset of `packages`, not a disjoint set — a member
 * is still a package, it is simply one whose artifacts are never worth caching
 * because its source is already in the checkout and cargo rebuilds it anyway.
 */
export interface PackageSet {
  packages: Set<PackageId>;
  workspaceMembers: Set<PackageId>;
}

/**
 * Runs `cargo metadata` and returns its stdout.
 *
 * A port for the same reason `CacheClient` and `RegistryClient` are: the real
 * implementation spawns a process, and it lives in `src/index.ts` where the
 * coverage gate cannot see it. Tests inject a string.
 */
export interface MetadataReader {
  /** Resolves to `cargo metadata --format-version 1 --locked` stdout. */
  read(manifestDir: string): Promise<string>;
}

interface RawPackage {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  rust_version?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Formats a package the way the fingerprint mapping and the logs both spell it. */
const identify = (name: string, version: string): PackageId =>
  `${name}@${version}`;

function readPackage(
  entry: unknown,
  index: number,
): {
  id: string;
  packageId: PackageId;
} {
  if (!isRecord(entry)) {
    throw new Error(
      `\`cargo metadata\` listed a package at index ${index} that is not an object.`,
    );
  }
  const { id, name, version } = entry as RawPackage;
  // `name` is read before `version` so the error for a half-formed entry can
  // name the package it is complaining about. Reversing them would produce
  // "a package is missing its name" for an entry that has one.
  if (typeof name !== "string" || name === "") {
    throw new Error(
      `\`cargo metadata\` listed a package at index ${index} with no name.`,
    );
  }
  if (typeof version !== "string" || version === "") {
    throw new Error(
      `\`cargo metadata\` listed ${name} with no version, so its artifacts cannot be identified.`,
    );
  }
  if (typeof id !== "string" || id === "") {
    throw new Error(
      `\`cargo metadata\` listed ${name} with no id, so it cannot be matched against workspace_members.`,
    );
  }
  return { id, packageId: identify(name, version) };
}

/**
 * Parses `cargo metadata --format-version 1` output into its package set.
 *
 * Throws rather than degrading, and every message names what was wrong. The
 * caller turns a throw into a warning and the Phase B fallback — deciding
 * policy is its job, not this function's — but a caller that cannot say
 * *why* it fell back leaves nobody able to tell a cargo upgrade from a broken
 * workspace.
 */
export function parsePackageSet(json: string): PackageSet {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `\`cargo metadata\` did not emit valid JSON: ${describeError(error)}`,
      { cause: error },
    );
  }

  const raw = isRecord(document) ? document.packages : undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      "`cargo metadata` emitted no `packages` array, so no package set could be resolved.",
    );
  }

  const packages = new Set<PackageId>();
  const byId = new Map<string, PackageId>();
  raw.forEach((entry, index) => {
    const { id, packageId } = readPackage(entry, index);
    packages.add(packageId);
    byId.set(id, packageId);
  });

  // Matched on the id verbatim rather than by parsing it. Cargo spells ids at
  // least three ways — `path+file:///x/foo#1.0.0` when the directory is named
  // after the crate, `path+file:///x/bar#foo@1.0.0` when it is not, and
  // `registry+https://…#foo@1.0.0` — so a parser here would be a standing bet
  // on a format cargo has already changed once. An id naming no known package
  // is skipped rather than rejected: it costs a member being treated as a
  // dependency, which is a fatter cache, not a wrong one.
  const members = isRecord(document) ? document.workspace_members : undefined;
  const workspaceMembers = new Set<PackageId>();
  if (Array.isArray(members)) {
    for (const member of members) {
      const packageId =
        typeof member === "string" ? byId.get(member) : undefined;
      if (packageId !== undefined) workspaceMembers.add(packageId);
    }
  }

  return { packages, workspaceMembers };
}

/** A package's declared MSRV, named so a message can say who demands it. */
export interface PackageMsrv {
  name: string;
  version: string;
  rustVersion: string;
}

/**
 * Collects every declared `rust_version` in the resolved graph.
 *
 * Deliberately lenient where `parsePackageSet` is strict: that function's
 * output decides which files a cache archives, so a half-formed entry is a
 * real problem. This one only advises, so a malformed package costs its own
 * contribution rather than the whole check. The JSON itself must still parse —
 * unreadable output means the check could not run, which the caller reports
 * differently from a violation.
 */
export function parsePackageMsrv(json: string): PackageMsrv[] {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `\`cargo metadata\` did not emit valid JSON: ${describeError(error)}`,
      { cause: error },
    );
  }

  const raw = isRecord(document) ? document.packages : undefined;
  if (!Array.isArray(raw)) return [];

  const found: PackageMsrv[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { name, version, rust_version: rustVersion } = entry as RawPackage;
    if (typeof name !== "string" || name === "") continue;
    if (typeof version !== "string" || version === "") continue;
    if (typeof rustVersion !== "string" || rustVersion === "") continue;
    found.push({ name, version, rustVersion });
  }
  return found;
}
