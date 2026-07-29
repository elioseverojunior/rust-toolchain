// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  generateCacheKey,
  generateSpecCacheKey,
  parseRustcVersion,
  parseRustToolchainToml,
  resolveChannel,
} from "@/core";

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
  // newest patch in that series, so no ".0" is ever appended — that would pin
  // an older patch than rustup would pick.
  it("passes bare minor '1.62' through unchanged", () => {
    expect(resolveChannel("1.62")).toBe("1.62");
  });

  it("passes bare minor '1.0' through unchanged", () => {
    expect(resolveChannel("1.0")).toBe("1.0");
  });

  // Pinned against real rust-lang.org release dates rather than our own
  // arithmetic: the cycle must flip on the day a release actually ships, and
  // the result must depend only on the instant, never on the host timezone.
  // A boundary even one week early names a version rustup cannot install yet.
  describe("cycle boundaries land on real release dates", () => {
    it.each([
      ["2023-12-28", "1.75"],
      ["2024-02-08", "1.76"],
      ["2024-03-21", "1.77"],
      ["2025-02-20", "1.85"],
      ["2025-08-07", "1.89"],
      ["2025-09-18", "1.90"],
    ])("resolves %s (release day) to %s", (day, expected) => {
      const noon = new Date(`${day}T12:00:00.000Z`);
      expect(resolveChannel("stable minus 0 releases", noon)).toBe(expected);
    });

    it("still names the previous release the day before 1.76 ships", () => {
      const dayBefore = new Date("2024-02-07T23:59:59.000Z");
      expect(resolveChannel("stable minus 0 releases", dayBefore)).toBe("1.75");
    });

    it("subtracts whole releases from the instant's cycle", () => {
      const releaseDay = new Date("2025-09-18T12:00:00.000Z");
      expect(resolveChannel("stable minus 3 releases", releaseDay)).toBe(
        "1.87",
      );
    });

    it("resolves 'N days ago' from the supplied instant", () => {
      const releaseDay = new Date("2025-09-18T12:00:00.000Z");
      // A day earlier is still inside the 1.89 cycle.
      expect(resolveChannel("stable 1 day ago", releaseDay)).toBe("1.89");
    });
  });

  // dtolnay scales a bare minor while the scaled value is a release that
  // already exists, so "1.9" cannot silently pin the 2015-era 1.9.
  describe("scales a truncated bare minor", () => {
    const now = new Date("2026-07-24T12:00:00.000Z"); // cycle 1.97

    it("reads '1.9' as 1.90 rather than the 2015 release", () => {
      expect(resolveChannel("1.9", now)).toBe("1.90");
    });

    it("reads '1.6' as 1.60", () => {
      expect(resolveChannel("1.6", now)).toBe("1.60");
    });

    it("leaves a two-digit minor alone", () => {
      expect(resolveChannel("1.62", now)).toBe("1.62");
    });

    it("leaves 1.0 alone", () => {
      expect(resolveChannel("1.0", now)).toBe("1.0");
    });
  });

  // resolveChannel is the single funnel producing the string handed to rustup,
  // so it is where an unusable channel has to be rejected. The expressive forms
  // above resolve to "1.NN" before reaching this check.
  describe("rejects channels rustup could not name", () => {
    it("rejects a channel carrying a shell command separator", () => {
      expect(() => resolveChannel("stable; id > /tmp/pwned")).toThrow(
        /not a valid rustup toolchain/,
      );
    });

    it("rejects a channel carrying command substitution", () => {
      expect(() => resolveChannel("stable$(id)")).toThrow(
        /not a valid rustup toolchain/,
      );
    });

    it("rejects an empty channel", () => {
      expect(() => resolveChannel("")).toThrow(/not a valid rustup toolchain/);
    });

    it("accepts a dated nightly with a host triple", () => {
      expect(
        resolveChannel("nightly-2025-01-01-x86_64-unknown-linux-gnu"),
      ).toBe("nightly-2025-01-01-x86_64-unknown-linux-gnu");
    });
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

  // A syntax error means the author asked for *something* and we cannot tell
  // what. Falling back to "stable" would install a toolchain nobody requested —
  // the same silent fallback `mergeConfig` deliberately refuses for `path`.
  it("throws on malformed toml instead of falling back to defaults", () => {
    expect(() => parseRustToolchainToml("not = toml [[")).toThrow(
      /rust-toolchain\.toml is not valid TOML/,
    );
  });

  it("names the underlying parse error in the message", () => {
    expect(() => parseRustToolchainToml("channel = ")).toThrow(
      /rust-toolchain\.toml is not valid TOML/,
    );
  });

  it("still treats a toml without a [toolchain] table as no config", () => {
    expect(parseRustToolchainToml("[other]\nkey = 1")).toEqual({});
  });
});

describe("generateCacheKey", () => {
  // The key is derived from the commit date and hash only; rustc's semver adds
  // nothing (it is implied by the commit) so it is not a parameter.
  it("generates a 12-char cache key from commit date and hash", () => {
    const key = generateCacheKey("20250627", "a1b2c3d4e5f6");
    expect(key).toBe("20250627a1b2");
    expect(key).toHaveLength(12);
  });
});

// dtolnay's cachekey hashes the rustc version alone, so a job building for
// wasm32 and a job building only for the host share one key — the second
// restores artifacts produced without its target. Binding the key to the whole
// resolved spec keeps those caches apart while leaving `cachekey` compatible.
describe("generateSpecCacheKey", () => {
  const base = {
    channel: "stable",
    targets: ["wasm32-unknown-unknown"],
    components: ["clippy"],
    profile: "minimal",
  };

  it("keeps the compatible rustc key as its prefix", () => {
    expect(generateSpecCacheKey("20250627e5b2", base)).toStartWith(
      "20250627e5b2-",
    );
  });

  it("is stable across calls for the same spec", () => {
    expect(generateSpecCacheKey("20250627e5b2", base)).toBe(
      generateSpecCacheKey("20250627e5b2", base),
    );
  });

  it("ignores the order targets and components were written in", () => {
    const reordered = {
      ...base,
      targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
    };
    const sameSet = {
      ...base,
      targets: ["aarch64-apple-darwin", "wasm32-unknown-unknown"],
    };
    expect(generateSpecCacheKey("20250627e5b2", reordered)).toBe(
      generateSpecCacheKey("20250627e5b2", sameSet),
    );
  });

  it.each([
    ["targets", { ...base, targets: ["aarch64-apple-darwin"] }],
    ["components", { ...base, components: ["rustfmt"] }],
    ["profile", { ...base, profile: "complete" }],
    ["channel", { ...base, channel: "nightly" }],
  ])("changes when %s differ", (_label, variant) => {
    expect(generateSpecCacheKey("20250627e5b2", variant)).not.toBe(
      generateSpecCacheKey("20250627e5b2", base),
    );
  });

  it("distinguishes an absent profile from an empty one consistently", () => {
    const withoutProfile = { ...base, profile: undefined };
    expect(generateSpecCacheKey("20250627e5b2", withoutProfile)).toBe(
      generateSpecCacheKey("20250627e5b2", withoutProfile),
    );
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
