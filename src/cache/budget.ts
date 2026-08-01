// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/** The slice of `node:fs` measuring needs, injected so tests need no disk. */
export interface StatFs {
  readdir: (dir: string) => string[];
  stat: (path: string) => { size: number; isDirectory: () => boolean };
}

/** `2GB` and friends, binary rather than decimal. */
const SIZE = /^(\d+)\s*([KMGT])?B?$/i;

const MULTIPLIER: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/**
 * Reads `cache-budget` into a byte count, `0` meaning disabled.
 *
 * Binary suffixes because GitHub reports cache entry sizes in binary units, so
 * a decimal budget would not match the number a user is reacting to. An
 * unparseable value throws rather than defaulting to disabled: silently
 * removing the bound is how an oversized entry evicts its neighbours.
 */
export function parseSize(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "0") return 0;

  const match = trimmed.match(SIZE);
  if (!match) {
    throw new Error(
      `\`cache-budget\` must be a byte count with an optional K, M, G or T ` +
        `suffix, got ${JSON.stringify(value)}. Use "0" to disable the check.`,
    );
  }
  const amount = Number.parseInt(match[1] as string, 10);
  const suffix = match[2]?.toUpperCase();
  return suffix ? amount * (MULTIPLIER[suffix] as number) : amount;
}

/** Everything `@actions/glob` treats as a wildcard rather than as a literal. */
const GLOB_METACHARACTER = /[*?[\]]/;

/**
 * The literal directory a glob pattern is rooted at.
 *
 * `buildPaths` emits `<target>/**`, which no `stat` can resolve; walking its
 * literal prefix measures the same tree. The result over-reports by whatever
 * the negation entries exclude, which is the safe direction for a budget whose
 * purpose is to stop an oversized entry evicting other workflows' caches.
 */
function globRoot(pattern: string): string {
  const segments = pattern.split("/");
  const wildcard = segments.findIndex((segment) =>
    GLOB_METACHARACTER.test(segment),
  );
  return wildcard === -1 ? pattern : segments.slice(0, wildcard).join("/");
}

/** A path that is simply absent, which is normal rather than a failure. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** A layer's measured size, plus whatever could not be measured. */
export interface MeasuredPaths {
  bytes: number;
  /**
   * Paths whose size could not be read — a permission failure, a vanished
   * mount, an I/O error. Not a broken symlink: `statSync` reports that as
   * `ENOENT`, which `isMissing` classifies as an ordinary absent path and
   * does not report here.
   *
   * Reported rather than swallowed because the two failure modes are not
   * equivalent: a missing path contributes a true zero, while an unreadable
   * one contributes an unknown, and silently treating the second as the first
   * under-reports a layer — which is the direction that lets an oversized
   * entry pass the budget it should have failed.
   */
  unmeasured: string[];
}

/**
 * Sums the bytes under each path.
 *
 * A missing path is normal rather than exceptional — a workspace that has never
 * been built has no target directory — and negation entries are exclusions for
 * the archive, not directories to descend into.
 */
export function measurePaths(paths: string[], fs: StatFs): MeasuredPaths {
  let bytes = 0;
  const unmeasured: string[] = [];
  const pending = paths
    .filter((path) => !path.startsWith("!"))
    .map((path) => globRoot(path));

  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entry: { size: number; isDirectory: () => boolean };
    try {
      entry = fs.stat(current);
    } catch (error) {
      if (!isMissing(error)) unmeasured.push(current);
      continue;
    }
    if (!entry.isDirectory()) {
      bytes += entry.size;
      continue;
    }
    let children: string[];
    try {
      children = fs.readdir(current);
    } catch (error) {
      if (!isMissing(error)) unmeasured.push(current);
      continue;
    }
    for (const child of children) {
      pending.push(`${current}/${child}`);
    }
  }

  return { bytes, unmeasured };
}
