// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { hashBuildEnv } from "@/cache/env";
import type { CacheInputSource } from "@/cache/inputs";
import { buildCacheOutputs, readCacheRequest } from "@/cache/inputs";

/**
 * Builds the narrow source this module takes.
 *
 * The whole point of the extraction: these tests need no exec harness, no
 * rustup and no toolchain — reading and validating cache inputs depends on
 * nothing but the inputs.
 */
const source = (
  inputs: Record<string, string> = {},
  env: Record<string, string | undefined> = {
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
  },
): CacheInputSource => ({
  getInput: (name) => inputs[name] ?? "",
  env,
});

const enabled = (extra: Record<string, string> = {}): CacheInputSource =>
  source({ cache: "true", "cache-key-hash": "a1b2c3", ...extra });

/**
 * The digest `readCacheRequest` derives from `source()`'s default env.
 *
 * Neither `RUNNER_OS` nor `RUNNER_ARCH` matches a build-env prefix, so this
 * equals `hashBuildEnv({})` — computed rather than hardcoded, so it tracks
 * `hashBuildEnv`'s own behaviour instead of a value copied from its output.
 */
const defaultEnvHash = hashBuildEnv({ RUNNER_OS: "Linux", RUNNER_ARCH: "X64" });

describe("readCacheRequest", () => {
  // Every one of these `.trim()` calls survived mutation testing: deleting any
  // of them left the whole suite green. They are belt-and-braces in production
  // — `@actions/core`'s getInput trims the ends already — but `CacheInputSource`
  // is a port any caller may implement, and the consequence of losing one is
  // silent rather than loud: whitespace reaching a key derives a DIFFERENT
  // cache entry from the same configuration, with no error to notice.
  describe("whitespace-only inputs are treated as unset", () => {
    it("falls back to every layer for a blank cache-layers", () => {
      expect(
        readCacheRequest(enabled({ "cache-layers": "   " }))?.layers,
      ).toEqual(["registry", "build", "bin"]);
    });

    it("treats a blank cache-key-hash as missing rather than as a hash", () => {
      expect(() =>
        readCacheRequest(source({ cache: "true", "cache-key-hash": "  \n " })),
      ).toThrow("cache-key-hash");
    });

    it("carries no suffix for a blank cache-key-suffix", () => {
      expect(
        readCacheRequest(enabled({ "cache-key-suffix": "   " }))?.context
          .suffix,
      ).toBe("");
    });

    // Untrimmed, `"  "` is truthy, so the default never applies and
    // `parseWorkspaces` rejects it as naming no mapping at all.
    it("falls back to the default mapping for blank cache-workspaces", () => {
      const request = readCacheRequest({
        getInput: (name) =>
          ({
            cache: "true",
            "cache-key-hash": "a1b2c3",
            "cache-workspaces": "  ",
          })[name] ?? "",
        env: {
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          GITHUB_WORKSPACE: "/workspace",
        },
      });
      expect(request?.workspaces).toEqual([
        { manifestDir: "/workspace", targetDir: "/workspace/target" },
      ]);
    });

    // Resolved against the process's own directory, not against a directory
    // literally named "  " beneath it.
    it("falls back to the cwd for a blank GITHUB_WORKSPACE", () => {
      const request = readCacheRequest({
        getInput: (name) =>
          ({ cache: "true", "cache-key-hash": "a1b2c3" })[name] ?? "",
        env: { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", GITHUB_WORKSPACE: "  " },
      });
      expect(request?.workspaces).toEqual([
        { manifestDir: process.cwd(), targetDir: `${process.cwd()}/target` },
      ]);
    });
  });

  // Nothing else is examined when caching is off: those inputs describe a key
  // nobody asked for, so validating them would fail runs that never cache.
  it("returns undefined when cache is unset, ignoring every other input", () => {
    expect(readCacheRequest(source({ "cache-key-suffix": "has spaces" }))).toBe(
      undefined,
    );
  });

  it("defaults to every layer and carries the validated context", () => {
    const request = readCacheRequest(enabled({ "cache-key-suffix": "ci" }));
    expect(request?.layers).toEqual(["registry", "build", "bin"]);
    expect(request?.context).toEqual({
      os: "Linux",
      arch: "X64",
      suffix: "ci",
      lockHash: "a1b2c3",
      envHash: defaultEnvHash,
    });
  });

  it("honours an explicit layer selection", () => {
    expect(
      readCacheRequest(enabled({ "cache-layers": "registry" }))?.layers,
    ).toEqual(["registry"]);
  });

  // Without a lock hash the keys are constant: they hit exactly on every run,
  // never re-save, and serve the same crates for the life of the repository.
  it("rejects an enabled cache with no lock hash", () => {
    expect(() => readCacheRequest(source({ cache: "true" }))).toThrow(
      "`cache-key-hash` is required",
    );
  });

  // The requirement is scoped to the layers that actually key on the
  // dependency set. `bin` keys on the resolved tool set alone, so it has no
  // lockfile component to miss and failing it would be wrong.
  describe("cache-key-hash is required only by the layers that key on it", () => {
    const withoutHash = (layers: string): CacheInputSource =>
      source({ cache: "true", "cache-layers": layers });

    it("accepts a bin-only request with no lock hash", () => {
      const request = readCacheRequest(withoutHash("bin"));
      expect(request?.layers).toEqual(["bin"]);
      expect(request?.context.lockHash).toBe("");
    });

    it.each([
      ["registry"],
      ["build"],
      ["registry,build"],
      // `bin` alongside one that needs it does not excuse the requirement.
      ["bin,build"],
      ["registry,build,bin"],
    ])("still rejects %s with no lock hash", (layers) => {
      expect(() => readCacheRequest(withoutHash(layers))).toThrow(
        "`cache-key-hash` is required",
      );
    });

    // An unused hash is not an error — a workflow that passes one everywhere
    // should not have to special-case a bin-only job.
    it("accepts a bin-only request that supplies one anyway", () => {
      expect(
        readCacheRequest(enabled({ "cache-layers": "bin" }))?.layers,
      ).toEqual(["bin"]);
    });
  });

  // getInput trims the ends and nothing else, so an embedded comma or newline
  // reaches the key intact — one splits a joined restore-keys block, the other
  // is rejected outright by actions/cache.
  it.each([
    ["a comma", "ci,nightly"],
    ["a space", "ci nightly"],
    ["a newline", "ci\nnightly"],
  ])("rejects a suffix containing %s", (_label, suffix) => {
    expect(() =>
      readCacheRequest(enabled({ "cache-key-suffix": suffix })),
    ).toThrow("must not contain a comma or whitespace");
  });

  // joinKeySegments drops empty segments, which is right for an unset suffix
  // and catastrophic here: the key would collide across operating systems.
  it.each([
    ["RUNNER_OS", { RUNNER_OS: "", RUNNER_ARCH: "X64" }],
    ["RUNNER_ARCH", { RUNNER_OS: "Linux", RUNNER_ARCH: "  " }],
    ["a missing RUNNER_OS", { RUNNER_ARCH: "X64" }],
  ])("refuses to derive a key with %s empty", (_label, env) => {
    const s: CacheInputSource = {
      getInput: (name) =>
        ({ cache: "true", "cache-key-hash": "a1b2c3" })[name] ?? "",
      env,
    };
    expect(() => readCacheRequest(s)).toThrow("is empty");
  });

  it("rejects a derived key longer than actions/cache accepts", () => {
    expect(() =>
      readCacheRequest(enabled({ "cache-key-suffix": "x".repeat(600) })),
    ).toThrow(/actions\/cache rejects any key over 512/);
  });

  // The boundary itself, not just a value well past it. 512 is the longest key
  // actions/cache accepts, so a key of exactly 512 must be allowed through —
  // `key.length <= MAX` rather than `<`. Mutation testing found that swapping
  // those two left every other test here green, because none of them sat on
  // the boundary; rejecting a legal key would look like a mysterious failure
  // on a configuration the service would in fact have accepted.
  //
  // 458 is the suffix length that makes the longest (build) key exactly 512:
  // one more reports "is 513 characters" in the rejection message above.
  it("accepts a derived key of exactly the maximum length", () => {
    expect(() =>
      readCacheRequest(enabled({ "cache-key-suffix": "x".repeat(458) })),
    ).not.toThrow();
    expect(() =>
      readCacheRequest(enabled({ "cache-key-suffix": "x".repeat(459) })),
    ).toThrow("is 513 characters");
  });

  // The build key is the longer of the two, so the bound must be measured
  // against it rather than against whichever layer happens to be first.
  it("measures the bound against the longest layer key", () => {
    expect(() =>
      readCacheRequest(
        enabled({
          "cache-key-suffix": "x".repeat(490),
          "cache-layers": "build",
        }),
      ),
    ).toThrow(/`build` cache key/);
  });

  describe("cache-workspaces and cache-budget", () => {
    it("defaults to the whole workspace root mapped to target, and a 0 budget", () => {
      const request = readCacheRequest(enabled());
      expect(request?.workspaces).toEqual([
        { manifestDir: process.cwd(), targetDir: `${process.cwd()}/target` },
      ]);
    });

    it("defaults cache-budget to disabled when unset", () => {
      const request = readCacheRequest(enabled());
      expect(request?.budget).toBe(0);
    });

    it("resolves cache-workspaces against GITHUB_WORKSPACE", () => {
      const s: CacheInputSource = {
        getInput: (name) =>
          ({ cache: "true", "cache-key-hash": "a1b2c3" })[name] ?? "",
        env: {
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          GITHUB_WORKSPACE: "/home/runner/work/repo/repo",
        },
      };
      const request = readCacheRequest(s);
      expect(request?.workspaces).toEqual([
        {
          manifestDir: "/home/runner/work/repo/repo",
          targetDir: "/home/runner/work/repo/repo/target",
        },
      ]);
    });

    it("honours an explicit multi-workspace cache-workspaces value", () => {
      const request = readCacheRequest(
        enabled({
          "cache-workspaces":
            "crates/a -> crates/a/target\ncrates/b -> crates/b/target",
        }),
      );
      expect(request?.workspaces).toEqual([
        {
          manifestDir: `${process.cwd()}/crates/a`,
          targetDir: `${process.cwd()}/crates/a/target`,
        },
        {
          manifestDir: `${process.cwd()}/crates/b`,
          targetDir: `${process.cwd()}/crates/b/target`,
        },
      ]);
    });

    it("parses an explicit cache-budget into bytes", () => {
      const request = readCacheRequest(enabled({ "cache-budget": "2GB" }));
      expect(request?.budget).toBe(2 * 1024 ** 3);
    });

    // An unparseable size must fail loudly rather than silently disabling the
    // budget check, which is how an oversized entry evicts its neighbours.
    it("throws when cache-budget does not parse", () => {
      expect(() =>
        readCacheRequest(enabled({ "cache-budget": "not-a-size" })),
      ).toThrow("`cache-budget` must be a byte count");
    });
  });
});

describe("buildCacheOutputs", () => {
  const TOOLS = "7a7b7c7d";

  it("reports a disabled cache when there is no request", () => {
    expect(
      buildCacheOutputs(undefined, "20250915abcd-1f2e3d4c", TOOLS),
    ).toEqual({
      enabled: false,
      layers: {},
    });
  });

  it("completes the request with both digests", () => {
    const request = readCacheRequest(enabled({ "cache-key-suffix": "ci" }));
    const outputs = buildCacheOutputs(request, "20250915abcd-1f2e3d4c", TOOLS);

    expect(outputs.enabled).toBe(true);
    expect(outputs.layers.registry?.key).toBe("registry-Linux-X64-ci-a1b2c3");
    expect(outputs.layers.build?.key).toBe(
      `build-Linux-X64-ci-20250915abcd-1f2e3d4c-${defaultEnvHash}-a1b2c3`,
    );
    expect(outputs.layers.bin?.key).toBe(`bin-Linux-X64-${TOOLS}`);
  });

  // The layer invariants the whole design rests on, asserted as properties
  // rather than as golden strings someone could "fix" by updating.
  it("keeps the toolchain digest out of the registry key and inside the build key", () => {
    const digest = "20250915abcd-1f2e3d4c";
    const outputs = buildCacheOutputs(
      readCacheRequest(enabled()),
      digest,
      TOOLS,
    );

    expect(outputs.layers.registry?.key).not.toContain(digest);
    expect(outputs.layers.build?.key).toContain(digest);
  });

  // Excluding rustup's shims is what lets the toolchain leave this key, so a
  // stable bump stops reinstalling every cargo tool. The suffix is absent for a
  // different reason: the same tool set needs byte-identical binaries whoever
  // asked for them.
  it("keys bin on the tool set alone, with no toolchain, lockfile or suffix", () => {
    const outputs = buildCacheOutputs(
      readCacheRequest(enabled({ "cache-key-suffix": "ci" })),
      "20250915abcd-1f2e3d4c",
      TOOLS,
    );

    expect(outputs.layers.bin?.key).toBe(`bin-Linux-X64-${TOOLS}`);
    for (const absent of ["20250915abcd", "a1b2c3", "-ci-", defaultEnvHash]) {
      expect(outputs.layers.bin?.key).not.toContain(absent);
    }
  });
});
