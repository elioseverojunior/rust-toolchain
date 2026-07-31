// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

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

describe("readCacheRequest", () => {
  // Nothing else is examined when caching is off: those inputs describe a key
  // nobody asked for, so validating them would fail runs that never cache.
  it("returns undefined when cache is unset, ignoring every other input", () => {
    expect(readCacheRequest(source({ "cache-key-suffix": "has spaces" }))).toBe(
      undefined,
    );
  });

  it("defaults to every layer and carries the validated context", () => {
    const request = readCacheRequest(enabled({ "cache-key-suffix": "ci" }));
    expect(request?.layers).toEqual(["registry", "build"]);
    expect(request?.context).toEqual({
      os: "Linux",
      arch: "X64",
      suffix: "ci",
      lockHash: "a1b2c3",
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
});

describe("buildCacheOutputs", () => {
  it("reports a disabled cache when there is no request", () => {
    expect(buildCacheOutputs(undefined, "20250915abcd-1f2e3d4c")).toEqual({
      enabled: false,
      layers: {},
    });
  });

  it("completes the request with the spec digest", () => {
    const request = readCacheRequest(enabled({ "cache-key-suffix": "ci" }));
    const outputs = buildCacheOutputs(request, "20250915abcd-1f2e3d4c");

    expect(outputs.enabled).toBe(true);
    expect(outputs.layers.registry?.key).toBe("registry-Linux-X64-ci-a1b2c3");
    expect(outputs.layers.build?.key).toBe(
      "build-Linux-X64-ci-20250915abcd-1f2e3d4c-a1b2c3",
    );
  });

  // The two layer invariants the whole design rests on, asserted as properties
  // rather than as golden strings someone could "fix" by updating.
  it("keeps the toolchain digest out of the registry key and inside the build key", () => {
    const digest = "20250915abcd-1f2e3d4c";
    const outputs = buildCacheOutputs(readCacheRequest(enabled()), digest);

    expect(outputs.layers.registry?.key).not.toContain(digest);
    expect(outputs.layers.build?.key).toContain(digest);
  });
});
