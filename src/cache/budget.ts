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

/**
 * Compiles one exclusion glob into a matcher over file paths.
 *
 * Only the three constructs the path builders actually emit are supported:
 * `**` across separators, `*` within a segment, and literals. `**` followed by
 * a separator spans *zero* or more segments, so `<t>/**\/incremental/**` catches
 * both `<t>/incremental/x` and `<t>/debug/incremental/x` — the depth mistake
 * Phase B's first `buildPaths` made by reaching for a single-level `*`.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] as string;
    if (char !== "*") {
      source += char.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
      continue;
    }
    if (pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }
    source += "[^/]*";
  }
  return new RegExp(`^${source}$`);
}

/**
 * The negations that exclude *files*, compiled once per measurement.
 *
 * A pattern ending in `/` is deliberately dropped rather than compiled. Those
 * exist to keep directory entries out of the tar manifest — see `buildPaths` —
 * and the files inside them are still archived. Treating one as a subtree
 * exclusion would measure every layer as zero, which is the opposite error and
 * would silently disable `cache-budget` altogether.
 */
function fileExclusions(paths: string[]): RegExp[] {
  return paths
    .filter((path) => path.startsWith("!") && !path.endsWith("/"))
    .map((path) => globToRegExp(path.slice(1)));
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
 * Sums the bytes the archive would actually carry.
 *
 * A missing path is normal rather than exceptional — a workspace that has never
 * been built has no target directory. Negation entries are not directories to
 * descend into; they are subtracted from what the walk finds.
 *
 * Honouring them is not cosmetic. The walk starts from `globRoot`, which strips
 * a pattern at its first wildcard, so `<bin>/**` walks the whole of
 * `$CARGO_HOME/bin` — every rustup shim included. Ignoring the negations
 * reported 291 MB for an archive measured at 233 bytes, and `cache-budget` is
 * checked against this number, so an entry carrying almost nothing could be
 * refused a save for size it does not use. The over-report was tolerable while
 * `build` was the only excluding layer, where the excluded subtrees are a
 * fraction of `target/`; `bin` excludes very nearly everything it walks.
 */
export function measurePaths(paths: string[], fs: StatFs): MeasuredPaths {
  let bytes = 0;
  const unmeasured: string[] = [];
  const excluded = fileExclusions(paths);
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
      if (!excluded.some((pattern) => pattern.test(current))) {
        bytes += entry.size;
      }
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
