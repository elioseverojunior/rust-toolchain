// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";

import { parse } from "smol-toml";

import { describeError } from "@rust-toolchain/errors";

export interface ToolchainTomlConfig {
  channel?: string;
  targets?: string[];
  profile?: string;
  components?: string[];
  /**
   * A local custom toolchain directory. rustup treats `path` as mutually
   * exclusive with `channel`; there is nothing for rustup to install.
   */
  path?: string;
}

export interface RustcVersionInfo {
  version: string;
  commitHash: string;
  commitDate: string;
  cacheKey: string;
}

/** Channels, versions, dates and host triples — letters, digits, `.`, `_`, `-`. */
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A `1.NN` version with no patch component, e.g. `1.9` or `1.62`. */
const BARE_MINOR = /^1\.(\d+)$/;

/**
 * 2015-05-14T00:00:00Z — day 16569, the anchor dtolnay/rust-toolchain uses.
 *
 * Pinned to that exact day so both actions resolve `stable N ago` and
 * `stable minus N releases` to the same version. Shifting it even a week makes
 * the cycle flip before the release exists, and `rustup toolchain install`
 * fails on a version that has not shipped.
 */
const RUST_EPOCH_MS = 1431561600000;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const RELEASE_CYCLE_WEEKS = 6;

/**
 * Which stable minor was current at `date`.
 *
 * `Date.getTime()` is already an absolute epoch offset and every field accessor
 * used here is a `setUTC*`/`getUTC*` variant, so no timezone correction is
 * needed — adding `getTimezoneOffset()` would shift the *instant* and can land
 * the result on the wrong side of a six-week boundary.
 */
function stableMinorAtDate(date: Date): number {
  const diff = date.getTime() - RUST_EPOCH_MS;
  const weeks = diff / MS_PER_WEEK;
  return Math.floor(weeks / RELEASE_CYCLE_WEEKS);
}

export function resolveChannel(
  channel: string,
  now: Date = new Date(),
): string {
  const stableAgo = /^stable\s+(\d+)\s+(year|month|week|day)s?\s+ago$/i;
  const stableMinus = /^stable\s+minus\s+(\d+)\s+releases?$/i;
  const agoMatch = channel.match(stableAgo);
  if (agoMatch) {
    const count = Number.parseInt(agoMatch[1]!, 10);
    const unit = agoMatch[2]!.toLowerCase();

    const target = new Date(now);

    switch (unit) {
      case "year":
        target.setUTCFullYear(target.getUTCFullYear() - count);
        break;
      case "month":
        target.setUTCMonth(target.getUTCMonth() - count);
        break;
      case "week":
        target.setUTCDate(target.getUTCDate() - count * 7);
        break;
      case "day":
        target.setUTCDate(target.getUTCDate() - count);
        break;
    }

    const minor = stableMinorAtDate(target);
    return `1.${minor}`;
  }

  const minusMatch = channel.match(stableMinus);
  if (minusMatch) {
    const count = Number.parseInt(minusMatch[1]!, 10);
    const minor = stableMinorAtDate(now) - count;
    return `1.${minor}`;
  }

  const bareMinorMatch = channel.match(BARE_MINOR);
  if (bareMinorMatch) {
    const written = Number.parseInt(bareMinorMatch[1]!, 10);
    return `1.${scaleBareMinor(written, stableMinorAtDate(now))}`;
  }

  // Everything else is already a valid rustup toolchain spec — a named channel,
  // a <major.minor.patch> version, or any of those with a -<date>/-<host>
  // suffix. Pass it through untouched.
  return assertToolchainName(channel);
}

/**
 * Expands a truncated minor to the release the author meant.
 *
 * `1.9` is ambiguous: taken literally it is the 2015 release, but anyone
 * writing it today means 1.90. Scale by ten while the scaled value names a
 * release that already exists, so the reading can never run ahead of reality.
 * `1.62` is left alone because 620 is still in the future.
 */
function scaleBareMinor(written: number, currentMinor: number): number {
  if (written * 100 <= currentMinor) return written * 100;
  if (written * 10 <= currentMinor) return written * 10;
  return written;
}

/**
 * Rejects anything rustup could not name as a toolchain.
 *
 * The channel may originate in a `rust-toolchain.toml` from an untrusted
 * checkout. Commands are executed without a shell, so this is a second line of
 * defence rather than the only one — but a value that cannot name a toolchain
 * is a configuration error worth reporting before rustup fails obscurely.
 */
function assertToolchainName(channel: string): string {
  if (!TOOLCHAIN_NAME.test(channel)) {
    throw new Error(
      `"${channel}" is not a valid rustup toolchain name. Expected a channel ` +
        `such as "stable", "1.89.0" or "nightly-2025-01-01", optionally with a ` +
        `host triple suffix.`,
    );
  }
  return channel;
}

export function parseRustToolchainToml(toml: string): ToolchainTomlConfig {
  if (!toml.trim()) {
    return {};
  }
  let parsed: { toolchain?: ToolchainTomlConfig };
  try {
    parsed = parse(toml) as { toolchain?: ToolchainTomlConfig };
  } catch (error) {
    // Loud by design: a syntax error hides the author's intent, and installing
    // "stable" instead would run a toolchain nobody asked for.
    const detail = describeError(error);
    throw new Error(`rust-toolchain.toml is not valid TOML: ${detail}`, {
      cause: error,
    });
  }
  return parsed.toolchain ?? {};
}

export function generateCacheKey(date: string, hash: string): string {
  return `${date}${hash}`.slice(0, 12);
}

/** The parts of a resolved toolchain that change what gets built. */
export interface CacheKeySpec {
  channel: string;
  targets: string[];
  components: string[];
  profile?: string;
}

/**
 * A cache key bound to the whole toolchain spec, not just the compiler.
 *
 * `generateCacheKey` matches dtolnay/rust-toolchain byte for byte and so
 * describes the rustc build alone: two jobs on the same compiler collide even
 * when one installed `wasm32-unknown-unknown` and the other did not, and the
 * second restores artifacts produced without its target. This appends a digest
 * of the resolved channel, targets, components and profile so those caches stay
 * separate. Targets and components are sorted, so writing the same set in a
 * different order still hits the same key.
 */
export function generateSpecCacheKey(
  rustcKey: string,
  spec: CacheKeySpec,
): string {
  const canonical = [
    spec.channel,
    [...spec.targets].sort().join(","),
    [...spec.components].sort().join(","),
    spec.profile ?? "",
  ].join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${rustcKey}-${digest.slice(0, 8)}`;
}

export function parseRustcVersion(output: string): RustcVersionInfo {
  const lines = output.split("\n");

  let version = "";
  let commitHash = "";
  let commitDate = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("rustc ")) {
      version = trimmed.split(" ")[1] ?? "";
    }
    if (trimmed.startsWith("commit-hash: ")) {
      commitHash = trimmed.slice("commit-hash: ".length);
    }
    if (trimmed.startsWith("commit-date: ")) {
      commitDate = trimmed.slice("commit-date: ".length);
    }
  }

  const datePart = commitDate.replace(/-/g, "");
  const cacheKey = generateCacheKey(datePart, commitHash);

  return { version, commitHash, commitDate, cacheKey };
}
