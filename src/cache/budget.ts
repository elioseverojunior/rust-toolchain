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

/**
 * Sums the bytes under each path, ignoring what cannot be walked.
 *
 * A missing path is normal rather than exceptional — a workspace that has never
 * been built has no target directory — and negation entries are exclusions for
 * the archive, not directories to descend into.
 */
export function measurePaths(paths: string[], fs: StatFs): number {
  let total = 0;
  const pending = paths.filter((path) => !path.startsWith("!"));

  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entry: { size: number; isDirectory: () => boolean };
    try {
      entry = fs.stat(current);
    } catch {
      continue;
    }
    if (!entry.isDirectory()) {
      total += entry.size;
      continue;
    }
    for (const child of fs.readdir(current)) {
      pending.push(`${current}/${child}`);
    }
  }

  return total;
}
