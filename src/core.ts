import { parse } from "smol-toml";

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

const RUST_EPOCH_MS = 1430956800000; // 2015-05-15T00:00:00Z — Rust 1.0.0 release
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const RELEASE_CYCLE_WEEKS = 6;

function stableMinorAtDate(date: Date): number {
  const diff = date.getTime() - RUST_EPOCH_MS;
  const weeks = diff / MS_PER_WEEK;
  return Math.floor(weeks / RELEASE_CYCLE_WEEKS);
}

function currentStableMinor(): number {
  const now = new Date();
  // Account for timezone offset to get UTC
  const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60 * 1000);
  return stableMinorAtDate(utc);
}

export function resolveChannel(channel: string): string {
  const stableAgo = /^stable\s+(\d+)\s+(year|month|week|day)s?\s+ago$/i;
  const stableMinus = /^stable\s+minus\s+(\d+)\s+releases?$/i;
  const agoMatch = channel.match(stableAgo);
  if (agoMatch) {
    const count = Number.parseInt(agoMatch[1]!, 10);
    const unit = agoMatch[2]!.toLowerCase();

    const now = new Date();
    const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60 * 1000);
    const target = new Date(utc);

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
    const minor = currentStableMinor() - count;
    return `1.${minor}`;
  }

  // Everything else is already a valid rustup toolchain spec — a named channel,
  // a <major.minor> or <major.minor.patch> version, or any of those with a
  // -<date>/-<host> suffix. Pass it through untouched: rewriting <major.minor>
  // to <major.minor>.0 would pin an older patch than rustup would select.
  return channel;
}

export function parseRustToolchainToml(toml: string): ToolchainTomlConfig {
  if (!toml.trim()) {
    return {};
  }
  try {
    const parsed = parse(toml) as { toolchain?: ToolchainTomlConfig };
    return parsed.toolchain ?? {};
  } catch {
    return {};
  }
}

export function generateCacheKey(
  version: string,
  date: string,
  hash: string,
): string {
  return `${date}${hash}`.slice(0, 12);
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
  const cacheKey = generateCacheKey(version, datePart, commitHash);

  return { version, commitHash, commitDate, cacheKey };
}
