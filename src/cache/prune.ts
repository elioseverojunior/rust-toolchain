// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { PackageSet } from "@rust-toolchain/cache/metadata";

/**
 * Decides which of a `target/` directory's files are worth archiving.
 *
 * Nothing here deletes. The keep-set is a save-time filter on the tar manifest,
 * for the reason `AGENTS.md` gives about the negation globs it replaces: a post
 * step that deletes from `target/` is destructive at the worst possible moment,
 * a bad keep-set would surface as a build that succeeded and a checkout now
 * missing artifacts, and on a self-hosted runner that damage outlives the job.
 * Both of this module's inputs — `cargo metadata` and cargo's fingerprint
 * format — are outside our control, and the design already concedes the second
 * has no stability guarantee. A filter that misreads them produces a
 * wrong-sized archive; a deleter that misreads them destroys work.
 */

/** What to do with an artifact no package claims. */
export type PrunePolicy = "off" | "safe" | "aggressive";

/**
 * Every policy, as a lookup rather than a `switch`.
 *
 * A `Record<PrunePolicy, …>` fails to compile when the union grows a member,
 * which is the exhaustiveness a `switch` would have given — and it sidesteps
 * the Bun 1.3.14 coverage quirk where a `switch` whose cases return loses
 * coverage on the last closing brace.
 */
const POLICIES: Record<PrunePolicy, true> = {
  off: true,
  safe: true,
  aggressive: true,
};

const DEFAULT_POLICY: PrunePolicy = "safe";

/**
 * Reads the `cache-prune` input.
 *
 * Unset resolves to `safe`, because trading cache size for never dropping
 * something a build needed is the right side to err on.
 */
export function parsePrunePolicy(value: string): PrunePolicy {
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return DEFAULT_POLICY;
  if (Object.hasOwn(POLICIES, normalised)) return normalised as PrunePolicy;
  throw new Error(
    `\`cache-prune\` is \`${value.trim()}\`, which is not a prune policy. ` +
      `Valid values are off, safe, aggressive.`,
  );
}

/** Maps an artifact hash to the package name that produced it. */
export type Fingerprints = Map<string, string>;

/** The directory listing `readFingerprints` needs, a subset of `StatFs`. */
export interface DirReader {
  readdir(dir: string): string[];
}

/**
 * Recovers the hash-to-package mapping cargo already recorded.
 *
 * Cargo names a fingerprint directory `<name>-<hash>` and names the artifacts
 * that build produced `…-<hash>.…` with the SAME hash, so the directory is an
 * authoritative statement of ownership. This is the entire difference from
 * `Swatinem/rust-cache`, which strips a trailing `-$hash` off an artifact
 * filename and string-compares the remainder against a package name — a guess
 * that a crate whose own name ends in something hash-shaped defeats.
 *
 * An absent directory is the ordinary state of a `target/` nothing has built
 * yet, so it attributes nothing rather than throwing.
 */
export function readFingerprints(
  fingerprintDir: string,
  fs: DirReader,
): Fingerprints {
  const map: Fingerprints = new Map();
  let entries: string[];
  try {
    entries = fs.readdir(fingerprintDir);
  } catch {
    return map;
  }

  for (const entry of entries) {
    // The LAST hyphen, not the first: `cfg-if-43f8…` has to yield `cfg-if`,
    // and plenty of crate names carry hyphens of their own.
    const split = entry.lastIndexOf("-");
    if (split <= 0) continue;
    const name = entry.slice(0, split);
    const hash = entry.slice(split + 1);
    if (name !== "" && hash !== "") map.set(hash, name);
  }
  return map;
}

export interface KeepSetRequest {
  /** Every file under the workspace's target directory. */
  files: string[];
  fingerprints: Fingerprints;
  packageSet: PackageSet;
  policy: PrunePolicy;
}

export interface KeepSet {
  /** The files the archive should carry. Empty whenever `usable` is false. */
  keep: string[];
  /** Files no package claimed, whatever was then done with them. */
  unattributable: string[];
  /**
   * Whether the caller may use this keep-set at all.
   *
   * False for `off`, and false when the package set resolved to nothing.
   * **Saving an empty keep-set is not a small cache, it is a poisoned one** —
   * an entry that exists, hits its key, restores nothing, and leaves every
   * later job rebuilding from scratch while believing it was warm. The caller
   * falls back to the Phase B glob set instead.
   */
  usable: boolean;
}

/** Subtrees that are never worth archiving, whatever owns them. */
const ALWAYS_DROP = ["/incremental/", "/examples/"];

const UNUSABLE: KeepSet = { keep: [], unattributable: [], usable: false };

/** `serde@1.0.219` -> `serde`. The format is ours, so this is exact. */
const packageName = (id: string): string => id.slice(0, id.lastIndexOf("@"));

/**
 * Pulls the `-<hash>` out of an artifact path, if it carries one.
 *
 * Matches the SHAPE — cargo's metadata hash is sixteen hex characters — rather
 * than looking for hashes already known from the fingerprints. That distinction
 * is the whole unattributable case: a file bearing a hash no fingerprint claims
 * has to be told apart from a file bearing no hash at all. Searching for known
 * hashes collapses the two, and `cache-prune` then has nothing to govern.
 *
 * Anchored on a separator so a sixteen-character run inside a longer hex string
 * cannot masquerade as one.
 */
const HASH = /-([0-9a-f]{16})(?:[./]|$)/;

function artifactHash(file: string): string | undefined {
  return HASH.exec(file)?.[1];
}

/**
 * Decides which files under `target/` the archive carries.
 *
 * Attribution is by package NAME rather than name-and-version, and the cost is
 * worth stating: a fingerprint directory records `<name>-<hash>` with no
 * version, so a downgraded dependency keeps both versions' artifacts. That is a
 * fatter cache, not a wrong one. Recovering the version would mean parsing the
 * source paths out of cargo's `.d` files — a second undocumented format to
 * depend on, to save bytes in a case that resolves itself on the next lockfile
 * change.
 */
export function computeKeepSet(request: KeepSetRequest): KeepSet {
  const { files, fingerprints, packageSet, policy } = request;

  // `off` is deliberately NOT "the Phase B behaviour". It means compute no
  // keep-set and let the caller fall back — which is what keeps the fallback
  // path exercised by an ordinary supported configuration rather than only by
  // a rare failure.
  if (policy === "off") return UNUSABLE;
  if (packageSet.packages.size === 0) return UNUSABLE;

  const wanted = new Set<string>();
  for (const id of packageSet.packages) wanted.add(packageName(id));
  const members = new Set<string>();
  for (const id of packageSet.workspaceMembers) members.add(packageName(id));

  const keep: string[] = [];
  const unattributable: string[] = [];

  for (const file of files) {
    if (ALWAYS_DROP.some((fragment) => file.includes(fragment))) continue;

    const hash = artifactHash(file);
    if (hash === undefined) {
      // No hash at all: metadata like CACHEDIR.TAG or .rustc_info.json, which
      // is small, cheap and required for cargo to trust the directory.
      keep.push(file);
      continue;
    }

    const owner = fingerprints.get(hash);
    if (owner === undefined) {
      unattributable.push(file);
      if (policy === "safe") keep.push(file);
      continue;
    }
    // A workspace member's source is already in the checkout, so its artifacts
    // buy a rebuild cargo performs regardless.
    if (members.has(owner)) continue;
    if (wanted.has(owner)) keep.push(file);
  }

  return { keep, unattributable, usable: true };
}
