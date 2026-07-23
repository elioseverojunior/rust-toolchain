import { describe, expect, it } from "bun:test";

import {
  generateCacheKey,
  parseRustcVersion,
  parseRustToolchainToml,
  resolveChannel,
} from "./core";

describe("resolveChannel", () => {
  it("resolves 'stable' as-is", () => {
    expect(resolveChannel("stable")).toBe("stable");
  });

  it("resolves 'nightly' as-is", () => {
    expect(resolveChannel("nightly")).toBe("nightly");
  });

  it("resolves specific version '1.89.0' as-is", () => {
    expect(resolveChannel("1.89.0")).toBe("1.89.0");
  });

  it("resolves 'nightly-2025-01-01' as-is", () => {
    expect(resolveChannel("nightly-2025-01-01")).toBe("nightly-2025-01-01");
  });

  it("resolves 'stable 6 months ago' to a version", () => {
    const result = resolveChannel("stable 6 months ago");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  it("resolves 'stable 1 year ago' to a version", () => {
    const result = resolveChannel("stable 1 year ago");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  it("resolves 'stable 4 weeks ago' to a version", () => {
    const result = resolveChannel("stable 4 weeks ago");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  it("resolves 'stable 30 days ago' to a version", () => {
    const result = resolveChannel("stable 30 days ago");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  it("resolves 'stable minus 3 releases' to a version", () => {
    const result = resolveChannel("stable minus 3 releases");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  it("resolves 'stable minus 1 release' (singular)", () => {
    const result = resolveChannel("stable minus 1 release");
    expect(result).toMatch(/^\d+\.\d+$/);
  });

  // rustup's grammar accepts <major.minor> as a channel and resolves it to the
  // newest patch in that series. Rewriting "1.62" to "1.62.0" would pin an
  // older patch, so the value must pass through untouched.
  it("passes bare minor '1.62' through unchanged", () => {
    expect(resolveChannel("1.62")).toBe("1.62");
  });

  it("passes bare minor '1.0' through unchanged", () => {
    expect(resolveChannel("1.0")).toBe("1.0");
  });
});

describe("parseRustToolchainToml", () => {
  it("parses minimal toml with channel only", () => {
    const toml = `
[toolchain]
channel = "stable"
`;
    const config = parseRustToolchainToml(toml);
    expect(config.channel).toBe("stable");
  });

  it("parses toml with targets", () => {
    const toml = `
[toolchain]
channel = "nightly"
targets = ["wasm32-unknown-unknown", "aarch64-apple-darwin"]
`;
    const config = parseRustToolchainToml(toml);
    expect(config.channel).toBe("nightly");
    expect(config.targets).toEqual([
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
  });

  it("parses toml with components", () => {
    const toml = `
[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
`;
    const config = parseRustToolchainToml(toml);
    expect(config.components).toEqual(["clippy", "rustfmt"]);
  });

  it("parses toml with profile", () => {
    const toml = `
[toolchain]
channel = "stable"
profile = "minimal"
`;
    const config = parseRustToolchainToml(toml);
    expect(config.profile).toBe("minimal");
  });

  it("returns empty object for empty toml", () => {
    const config = parseRustToolchainToml("");
    expect(config).toEqual({});
  });

  it("returns empty object for invalid toml", () => {
    const config = parseRustToolchainToml("not = toml [[");
    expect(config).toEqual({});
  });
});

describe("generateCacheKey", () => {
  it("generates 12-char cache key from version info", () => {
    const key = generateCacheKey("1.89.0", "20250627", "a1b2c3d4e5f6");
    expect(key).toBe("20250627a1b2");
    expect(key).toHaveLength(12);
  });
});

describe("parseRustcVersion", () => {
  it("parses rustc version output", () => {
    const output = `rustc 1.89.0 (e5b2c17f0 2025-06-27)
binary: rustc
commit-hash: e5b2c17f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d
commit-date: 2025-06-27
host: x86_64-apple-darwin
release: 1.89.0
LLVM version: 19.1.7`;
    const result = parseRustcVersion(output);
    expect(result).toEqual({
      version: "1.89.0",
      commitHash: "e5b2c17f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
      commitDate: "2025-06-27",
      cacheKey: "20250627e5b2",
    });
  });
});
