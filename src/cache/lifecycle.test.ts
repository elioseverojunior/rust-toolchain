// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { CacheClient } from "@/cache/client";
import type { LayerPlan, LifecycleLog } from "@/cache/lifecycle";
import { restoreLayers, saveLayers } from "@/cache/lifecycle";

const plans: LayerPlan[] = [
  {
    layer: "registry",
    key: "registry-Linux-X64-a1",
    restoreKeys: ["registry-Linux-X64-"],
    paths: ["/c/registry/index"],
  },
  {
    layer: "build",
    key: "build-Linux-X64-d1-e1-a1",
    restoreKeys: ["build-Linux-X64-d1-e1-"],
    paths: ["/w/target", "!/w/target/*/incremental"],
  },
];

const log = (): LifecycleLog & { messages: string[] } => {
  const messages: string[] = [];
  return {
    messages,
    info: (m) => messages.push(`info: ${m}`),
    warning: (m) => messages.push(`warning: ${m}`),
  };
};

const client = (
  restore: CacheClient["restore"],
  save: CacheClient["save"] = async () => {},
): CacheClient => ({ restore, save });

describe("restoreLayers", () => {
  it("classifies an exact match, a prefix match and a miss", async () => {
    const results = await restoreLayers(
      client(async (_p, key) =>
        key === "registry-Linux-X64-a1" ? key : "build-Linux-X64-d1-e1-old",
      ),
      plans,
      log(),
    );
    expect(results).toEqual([
      {
        layer: "registry",
        result: "exact",
        restoredKey: "registry-Linux-X64-a1",
      },
      {
        layer: "build",
        result: "partial",
        restoredKey: "build-Linux-X64-d1-e1-old",
      },
    ]);
  });

  it("reports a miss when nothing matched", async () => {
    const results = await restoreLayers(
      client(async () => undefined),
      plans,
      log(),
    );
    expect(results.map((r) => r.result)).toEqual(["miss", "miss"]);
  });

  // A cache outage is not a build failure. @actions/cache throws on service
  // errors, and a job that would otherwise succeed must still succeed.
  it("treats a restore failure as a miss and warns", async () => {
    const l = log();
    const results = await restoreLayers(
      client(async () => {
        throw new Error("cache service unavailable");
      }),
      plans,
      l,
    );
    expect(results.map((r) => r.result)).toEqual(["miss", "miss"]);
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(true);
  });
});

const saveArgs = (
  overrides: Partial<Parameters<typeof saveLayers>[0]> = {},
): Parameters<typeof saveLayers>[0] => ({
  client: client(async () => undefined),
  plans,
  restored: [
    { layer: "registry", result: "miss" },
    { layer: "build", result: "miss" },
  ],
  budget: 0,
  measure: () => 10,
  log: log(),
  ...overrides,
});

describe("saveLayers", () => {
  it("saves every layer that did not hit exactly", async () => {
    const saved: string[] = [];
    const results = await saveLayers(
      saveArgs({
        client: client(
          async () => undefined,
          async (_p, key) => {
            saved.push(key);
          },
        ),
      }),
    );
    expect(saved).toEqual([
      "registry-Linux-X64-a1",
      "build-Linux-X64-d1-e1-a1",
    ]);
    expect(results.every((r) => r.saved)).toBe(true);
  });

  // The entry already exists under that exact key, so writing it again is
  // pure budget burn. This is the optimisation the layer split makes safe.
  it("skips a layer that hit exactly", async () => {
    const saved: string[] = [];
    const results = await saveLayers(
      saveArgs({
        restored: [
          {
            layer: "registry",
            result: "exact",
            restoredKey: "registry-Linux-X64-a1",
          },
          { layer: "build", result: "miss" },
        ],
        client: client(
          async () => undefined,
          async (_p, key) => {
            saved.push(key);
          },
        ),
      }),
    );
    expect(saved).toEqual(["build-Linux-X64-d1-e1-a1"]);
    expect(results[0]?.saved).toBe(false);
    expect(results[0]?.reason).toContain("unchanged");
  });

  // An oversized entry does not degrade its own hit rate — it evicts other
  // workflows' caches, so the failure surfaces somewhere else entirely.
  it("skips a layer over budget and warns with the size", async () => {
    const l = log();
    const results = await saveLayers(
      saveArgs({ budget: 5, measure: () => 4096, log: l }),
    );
    expect(results.every((r) => !r.saved)).toBe(true);
    expect(l.messages.join("\n")).toContain("4096");
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(true);
  });

  it("ignores the budget when it is zero", async () => {
    const results = await saveLayers(
      saveArgs({ budget: 0, measure: () => 10 ** 9 }),
    );
    expect(results.every((r) => r.saved)).toBe(true);
  });

  it("treats a save failure as a warning, not a build failure", async () => {
    const l = log();
    const results = await saveLayers(
      saveArgs({
        client: client(
          async () => undefined,
          async () => {
            throw new Error("reserve failed");
          },
        ),
        log: l,
      }),
    );
    expect(results.every((r) => !r.saved)).toBe(true);
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(true);
  });
});
