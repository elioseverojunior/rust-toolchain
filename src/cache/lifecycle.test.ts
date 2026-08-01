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
    paths: ["/w/target/**", "!/w/target/**/incremental/**"],
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
  measure: () => ({ bytes: 10, unmeasured: [] }),
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
      saveArgs({
        budget: 5,
        measure: () => ({ bytes: 4096, unmeasured: [] }),
        log: l,
      }),
    );
    expect(results.every((r) => !r.saved)).toBe(true);
    expect(l.messages.join("\n")).toContain("4096");
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(true);
  });

  it("ignores the budget when it is zero", async () => {
    const results = await saveLayers(
      saveArgs({
        budget: 0,
        measure: () => ({ bytes: 10 ** 9, unmeasured: [] }),
      }),
    );
    expect(results.every((r) => r.saved)).toBe(true);
  });

  it("saves when the budget is enabled and the size is under it", async () => {
    const results = await saveLayers(
      saveArgs({
        budget: 1000,
        measure: () => ({ bytes: 10, unmeasured: [] }),
      }),
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

  // The bug this guards: a synchronous throw from `measure` inside a
  // `Promise.all`-mapped callback rejects the whole batch, discarding every
  // other layer's already-decided result — including ones that saved fine.
  it("treats a measurement failure as a warning and still saves other layers", async () => {
    const l = log();
    const saved: string[] = [];
    const results = await saveLayers(
      saveArgs({
        client: client(
          async () => undefined,
          async (_p, key) => {
            saved.push(key);
          },
        ),
        measure: (paths) => {
          if (paths[0] === "/c/registry/index") {
            throw new Error("permission denied");
          }
          return { bytes: 10, unmeasured: [] };
        },
        log: l,
      }),
    );
    expect(results[0]?.saved).toBe(false);
    expect(results[0]?.reason).toContain("could not measure its size");
    expect(results[1]?.saved).toBe(true);
    expect(saved).toEqual(["build-Linux-X64-d1-e1-a1"]);
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(true);
  });

  // A partial measurement is not a failure — the layer is still worth saving —
  // but it does mean the number the budget was checked against is a floor
  // rather than the size. Saying so is the difference between a budget that
  // was applied and one that only appeared to be.
  it("saves a partially measured layer but names what it could not read", async () => {
    const l = log();
    const results = await saveLayers(
      saveArgs({
        measure: () => ({ bytes: 10, unmeasured: ["/w/target/debug/locked"] }),
        log: l,
      }),
    );
    expect(results.every((r) => r.saved)).toBe(true);
    const warnings = l.messages.filter((m) => m.startsWith("warning:"));
    expect(warnings.join("\n")).toContain("/w/target/debug/locked");
  });

  it("stays quiet when everything was measured", async () => {
    const l = log();
    await saveLayers(saveArgs({ log: l }));
    expect(l.messages.some((m) => m.startsWith("warning:"))).toBe(false);
  });
});
