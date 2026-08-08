// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { PackageSet } from "@/cache/metadata";
import {
  computeKeepSet,
  parsePrunePolicy,
  readFingerprints,
  type DirReader,
  type Fingerprints,
} from "@/cache/prune";

const packageSet = (
  packages: string[],
  workspaceMembers: string[] = [],
): PackageSet => ({
  packages: new Set(packages),
  workspaceMembers: new Set(workspaceMembers),
});

/** A directory reader over a literal `path -> entries` map. */
const reader = (tree: Record<string, string[]>): DirReader => ({
  readdir: (dir: string): string[] => {
    const entries = tree[dir];
    if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
    return entries;
  },
});

describe("parsePrunePolicy", () => {
  it("reads each of the three policies", () => {
    expect(parsePrunePolicy("off")).toBe("off");
    expect(parsePrunePolicy("safe")).toBe("safe");
    expect(parsePrunePolicy("aggressive")).toBe("aggressive");
  });

  it("defaults an unset input to safe", () => {
    expect(parsePrunePolicy("")).toBe("safe");
    expect(parsePrunePolicy("   ")).toBe("safe");
  });

  it("tolerates surrounding whitespace and case", () => {
    expect(parsePrunePolicy("  Aggressive \n")).toBe("aggressive");
  });

  // Naming both the value and the alternatives, because the failure is a typo
  // often enough that "invalid value" would waste the reader's time.
  it("rejects an unknown policy by name", () => {
    expect(() => parsePrunePolicy("all")).toThrow(/all/);
    expect(() => parsePrunePolicy("all")).toThrow(/off, safe, aggressive/);
  });
});

describe("readFingerprints", () => {
  // THE mechanism the phase exists for. Cargo names the fingerprint directory
  // `<name>-<hash>` and names the artifacts it produced `…-<hash>.…` with the
  // SAME hash, so the directory is an authoritative record of which package
  // owns which hash. `rust-cache` instead strips a trailing `-$hash` off a
  // filename and string-compares the remainder, which is a guess.
  it("maps each artifact hash to the package that produced it", () => {
    const fp = readFingerprints(
      "/w/target/debug/.fingerprint",
      reader({
        "/w/target/debug/.fingerprint": [
          "cfg-if-43f8c950438ad461",
          "serde-9c949089a80a9283",
        ],
      }),
    );
    expect(fp.get("43f8c950438ad461")).toBe("cfg-if");
    expect(fp.get("9c949089a80a9283")).toBe("serde");
  });

  // A crate whose own name contains a hyphen is the case a naive split breaks
  // on: `cfg-if-43f8…` must yield `cfg-if`, not `cfg`. Splitting on the LAST
  // hyphen is what makes that work, and it is why this is a test rather than
  // an assumption.
  it("keeps hyphens in the package name", () => {
    const fp = readFingerprints(
      "/fp",
      reader({ "/fp": ["some-long-crate-name-abc123def4567890"] }),
    );
    expect(fp.get("abc123def4567890")).toBe("some-long-crate-name");
  });

  it("ignores a directory name carrying no hash", () => {
    const fp = readFingerprints("/fp", reader({ "/fp": ["nohyphenhere"] }));
    expect(fp.size).toBe(0);
  });

  // An absent `.fingerprint/` is the ordinary state of a target directory
  // nothing has built yet. It is not an error, it simply attributes nothing.
  it("returns an empty map when the directory does not exist", () => {
    expect(readFingerprints("/missing", reader({})).size).toBe(0);
  });
});

describe("computeKeepSet", () => {
  const fingerprints: Fingerprints = new Map([
    ["aaaaaaaaaaaaaaaa", "serde"],
    ["bbbbbbbbbbbbbbbb", "gone-crate"],
    ["cccccccccccccccc", "e2e-probe"],
  ]);

  const files = [
    "/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib",
    "/w/target/debug/deps/libgone_crate-bbbbbbbbbbbbbbbb.rlib",
    "/w/target/debug/deps/e2e_probe-cccccccccccccccc",
    "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
    "/w/target/debug/.fingerprint/serde-aaaaaaaaaaaaaaaa/lib-serde.json",
    "/w/target/debug/incremental/foo/bar.bin",
    "/w/target/debug/examples/hello",
    "/w/target/CACHEDIR.TAG",
  ];

  const resolved = packageSet(
    ["serde@1.0.219", "e2e-probe@0.1.0"],
    ["e2e-probe@0.1.0"],
  );

  it("keeps an artifact whose package is still resolved", () => {
    const { keep } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "safe",
    });
    expect(keep).toContain(
      "/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib",
    );
    expect(keep).toContain(
      "/w/target/debug/.fingerprint/serde-aaaaaaaaaaaaaaaa/lib-serde.json",
    );
  });

  // The headline win: a dependency dropped from Cargo.toml stops being cached
  // the run after it is removed, rather than riding along until the lock hash
  // happens to change.
  it("drops an artifact whose package is no longer resolved", () => {
    const { keep } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "safe",
    });
    expect(keep).not.toContain(
      "/w/target/debug/deps/libgone_crate-bbbbbbbbbbbbbbbb.rlib",
    );
  });

  // Step 5 of the design. A workspace member's source is in the checkout, so
  // caching its artifacts pays transfer for a rebuild cargo does regardless.
  it("never keeps a workspace member's own artifacts", () => {
    const { keep } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "safe",
    });
    expect(keep).not.toContain(
      "/w/target/debug/deps/e2e_probe-cccccccccccccccc",
    );
  });

  it("always drops incremental and examples, whatever the policy", () => {
    for (const policy of ["safe", "aggressive"] as const) {
      const { keep } = computeKeepSet({
        files,
        fingerprints,
        packageSet: resolved,
        policy,
      });
      expect(keep.some((f) => f.includes("/incremental/"))).toBe(false);
      expect(keep.some((f) => f.includes("/examples/"))).toBe(false);
    }
  });

  // D2. An artifact whose hash matches no fingerprint is unattributable, and
  // the two policies differ only here. The design's risk table is explicit
  // that the safe side of the trade is a fatter cache, never a broken one.
  it("keeps an unattributable artifact under safe, and reports it", () => {
    const { keep, unattributable } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "safe",
    });
    expect(keep).toContain(
      "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
    );
    expect(unattributable).toContain(
      "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
    );
  });

  it("drops an unattributable artifact under aggressive, and reports it", () => {
    const { keep, unattributable } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "aggressive",
    });
    expect(keep).not.toContain(
      "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
    );
    expect(unattributable).toContain(
      "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
    );
  });

  // Version-insensitive on purpose, and the cost is stated rather than hidden:
  // the fingerprint directory records `<name>-<hash>` with no version, so a
  // downgraded dependency keeps both versions' artifacts. That is a fatter
  // cache, not a wrong one, and recovering the version would mean parsing the
  // `.d` files' source paths — a second undocumented format to depend on.
  it("matches on package name, so a version change keeps both", () => {
    const { keep } = computeKeepSet({
      files: ["/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib"],
      fingerprints,
      packageSet: packageSet(["serde@1.0.200"]),
      policy: "safe",
    });
    expect(keep).toHaveLength(1);
  });

  // The invariant most likely to be got wrong: every failure mode converges on
  // an empty keep-set, and saving that is a poisoned entry — it hits its key,
  // restores nothing, and makes every later job rebuild believing it was warm.
  it("reports an empty package set as unusable rather than keeping nothing", () => {
    const { keep, usable } = computeKeepSet({
      files,
      fingerprints,
      packageSet: packageSet([]),
      policy: "safe",
    });
    expect(usable).toBe(false);
    expect(keep).toEqual([]);
  });

  it("reports a usable keep-set as usable", () => {
    expect(
      computeKeepSet({
        files,
        fingerprints,
        packageSet: resolved,
        policy: "safe",
      }).usable,
    ).toBe(true);
  });

  // `off` is not "Phase B behaviour" — it means compute no keep-set at all and
  // let the caller fall back, which is what makes the fallback path exercised
  // by an ordinary supported configuration rather than only by a rare failure.
  it("computes nothing under off", () => {
    const { keep, usable } = computeKeepSet({
      files,
      fingerprints,
      packageSet: resolved,
      policy: "off",
    });
    expect(usable).toBe(false);
    expect(keep).toEqual([]);
  });
});
