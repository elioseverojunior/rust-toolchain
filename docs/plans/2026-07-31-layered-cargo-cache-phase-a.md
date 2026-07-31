<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit correct, tested cache keys for the `registry` and `build` layers as action outputs, so a downstream
composite can delete its hand-written `bash` key-computation step.

**Architecture:** Two new pure modules under `src/cache/` — `layers.ts` (layer identifiers and input parsing) and
`keys.ts` (segment joining and per-layer key plus restore-ladder derivation). `src/outputs.ts` grows a `cache` block,
`src/action.ts` reads the new inputs and wires them, and `action.yml` declares them. Nothing is restored or saved in
this phase; no new runtime dependency is added.

**Tech Stack:** TypeScript 6 (strict), Bun test runner, `node:crypto`, `@actions/core`.

## Global Constraints

Every task's requirements implicitly include this section.

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then write the minimal implementation.
- **Coverage gate is 100%** for lines, functions and statements across `src/`, enforced by `bunfig.toml`. Unreachable
  or unused code fails the build. This is why Phase A ships two layers, not three — see "Why only two layers".
- **A class with field declarations needs an explicit `constructor()`**, even an empty one, or Bun reports a phantom
  uncovered function. No classes are introduced in this phase, but the rule applies to any added.
- **Library source imports siblings as `@rust-toolchain/<module>`**, never `./<module>` and never `@/<module>`.
  Test files use `@/<module>`. An internal-only alias type-checks here and fails in every consumer with `TS2307`.
- **`src/lib.ts` is the barrel** and must never re-export `src/index.ts`. `src/lib.test.ts` asserts the complete export
  list; adding a library module means updating both.
- **Every file starts with the SPDX header**, matching the existing `src/*.ts` files exactly:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0
```

- **Before every commit**, in this order: `bun run fix:all`, `bun run typecheck`, `bun run test`.
- **Commits are GPG-signed** (`git commit -S`) and follow Conventional Commits. **Never** add a `Co-Authored-By`
  trailer.
- **`dist/` is committed.** Only Task 5 rebuilds it, so intermediate commits leave it stale on purpose; CI is not run
  against intermediate commits.

## Why only two layers

The spec defines three layers: `registry`, `build` and `bin`. Phase A ships the first two.

The `bin` layer's key is a hash of **resolved** cargo-tool versions, and resolution is Phase C. Shipping the `bin`
branch now would mean `hashToolSet`, the `bin` case of `buildLayerKey`, and the `RUSTUP_SHIMS` list all exist with no
caller — which the 100% coverage gate rejects outright.

It would also be a released behaviour change. Every push to `main` publishes a release, so a `cargo-tools` input that
only feeds a hash in Phase A and starts _installing software_ in Phase C would silently change meaning for anyone who
adopted it in between.

So `CACHE_LAYER_IDS` is `["registry", "build"]` here, and `parseCacheLayers` rejects `bin` with a message naming the
valid layers. Phase C adds the third identifier, the `bin` branch, `hashToolSet`, `RUSTUP_SHIMS` and the `cargo-tools`
input together, in one coherent change.

## File Structure

| File                                                          | Responsibility                                                         | Task    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------- |
| `src/cache/layers.ts`                                         | Layer identifiers and `cache-layers` input parsing                     | 1       |
| `src/cache/layers.test.ts`                                    | Tests for the above                                                    | 1       |
| `commitlint.config.cjs`                                       | Add `cache` to `scope-enum`                                            | 1       |
| `src/cache/keys.ts`                                           | Segment joining, per-layer key and restore-ladder derivation           | 2       |
| `src/cache/keys.test.ts`                                      | Tests for the above                                                    | 2       |
| `src/outputs.ts`                                              | `CacheOutputs` types, `cache` in `ActionOutputs` and `toOutputEntries` | 3       |
| `src/outputs.test.ts`                                         | Tests for the above                                                    | 3       |
| `src/config.ts`                                               | Export the existing `parseCommaList` for reuse                         | 4       |
| `src/action.ts`                                               | Read and validate the cache inputs, build the keys, pass to outputs    | 4       |
| `src/action.test.ts`                                          | Tests for the above                                                    | 4       |
| `src/lib.ts`, `src/lib.test.ts`                               | Barrel exports and the pinned export list                              | 1, 2, 4 |
| `action.yml`                                                  | Declare the new inputs and the `cache` output                          | 4       |
| `README.md`, `docs/ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md` | Documentation                                                          | 5       |
| `dist/index.js`                                               | Rebuilt bundle                                                         | 5       |

---

### Task 1: Layer identifiers and `cache-layers` parsing

**Files:**

- Create: `src/cache/layers.ts`
- Create: `src/cache/layers.test.ts`
- Modify: `src/lib.ts` — add the new barrel re-export
- Modify: `src/lib.test.ts:17-41` — add `CACHE_LAYER_IDS` and `parseCacheLayers` to the pinned export list
- Modify: `commitlint.config.cjs:26-44` — add `cache` to `scope-enum`

**Interfaces:**

- Consumes: nothing.
- Produces: `CACHE_LAYER_IDS: readonly ["registry", "build"]`, `type CacheLayerId = "registry" | "build"`,
  `parseCacheLayers(value: string): CacheLayerId[]`.

**Steps:**

- [ ] **Step 1: Add `cache` to the commitlint scope enum**

`commitlint.config.cjs` lists allowed scopes at severity 1. `cache` is absent, so every commit in this workstream warns.
Insert it alphabetically between `aws` and `cli`:

```js
        "api",
        "aws",
        "cache",
        "cli",
        "config",
```

- [ ] **Step 2: Write the failing test**

Create `src/cache/layers.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { CACHE_LAYER_IDS, parseCacheLayers } from "@/cache/layers";

describe("CACHE_LAYER_IDS", () => {
  // Phase A ships two layers. `bin` arrives with cargo-tool installation,
  // because its key hashes resolved tool versions that nothing resolves yet.
  it("names the layers in canonical order", () => {
    expect(CACHE_LAYER_IDS).toEqual(["registry", "build"]);
  });
});

describe("parseCacheLayers", () => {
  it("parses a comma-separated list", () => {
    expect(parseCacheLayers("registry,build")).toEqual(["registry", "build"]);
  });

  it("parses whitespace- and newline-separated lists", () => {
    expect(parseCacheLayers("registry\n  build")).toEqual([
      "registry",
      "build",
    ]);
  });

  it("dedupes repeated layers", () => {
    expect(parseCacheLayers("build,build,registry")).toEqual([
      "registry",
      "build",
    ]);
  });

  // Canonical order, not input order: the order decides nothing at runtime, and
  // a stable order keeps the `cache` output diffable between runs.
  it("returns canonical order regardless of input order", () => {
    expect(parseCacheLayers("build,registry")).toEqual(["registry", "build"]);
  });

  it("rejects an unknown layer and names the valid ones", () => {
    expect(() => parseCacheLayers("registry,bin")).toThrow(
      '"bin" is not a cache layer. Valid layers are: registry, build.',
    );
  });

  it("rejects a list that names no layer", () => {
    expect(() => parseCacheLayers(" , ")).toThrow(
      "`cache-layers` must name at least one of: registry, build.",
    );
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `bun test src/cache/layers.test.ts`

Expected: FAIL — `Cannot find module '@/cache/layers'`.

- [ ] **Step 4: Write the minimal implementation**

Create `src/cache/layers.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * The cache partitions, in canonical order.
 *
 * Each layer is an independent cache entry keyed on what actually invalidates
 * it: `registry` on the dependency set, `build` on the dependency set plus the
 * resolved toolchain spec. Splitting them is what stops a rustc bump from
 * re-saving the downloaded crates it did not touch.
 *
 * The `bin` layer is deliberately absent until cargo-tool installation exists:
 * its key hashes *resolved* tool versions, and nothing resolves them yet.
 */
export const CACHE_LAYER_IDS = ["registry", "build"] as const;

export type CacheLayerId = (typeof CACHE_LAYER_IDS)[number];

/**
 * Reads the `cache-layers` input into a canonical, deduped layer list.
 *
 * Accepts the same comma, whitespace and newline separators as `targets` and
 * `components`, so a workflow can write the list however reads best. Order is
 * normalised rather than preserved: it changes nothing at runtime, and a stable
 * order keeps the `cache` output diffable between runs.
 */
export function parseCacheLayers(value: string): CacheLayerId[] {
  const named = value
    .split(/[,\s\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const name of named) {
    if (!(CACHE_LAYER_IDS as readonly string[]).includes(name)) {
      throw new Error(
        `"${name}" is not a cache layer. Valid layers are: ` +
          `${CACHE_LAYER_IDS.join(", ")}.`,
      );
    }
  }

  const requested = new Set(named);
  const layers = CACHE_LAYER_IDS.filter((id) => requested.has(id));

  if (layers.length === 0) {
    throw new Error(
      "`cache-layers` must name at least one of: " +
        `${CACHE_LAYER_IDS.join(", ")}.`,
    );
  }

  return layers;
}
```

- [ ] **Step 5: Add the barrel re-export**

In `src/lib.ts`, add the new module to the export list, keeping alphabetical order:

```ts
export * from "@rust-toolchain/action";
export * from "@rust-toolchain/builder";
export * from "@rust-toolchain/cache/layers";
export * from "@rust-toolchain/config";
export * from "@rust-toolchain/core";
export * from "@rust-toolchain/outputs";
```

- [ ] **Step 6: Update the pinned export list**

In `src/lib.test.ts`, add the two new value exports to the array in the first test. `CacheLayerId` is a type and does
not appear at runtime, so it is not listed:

```ts
        // builder.ts
        "ToolchainSpec",
        "ToolchainSpecBuilder",
        // cache/layers.ts
        "CACHE_LAYER_IDS",
        "parseCacheLayers",
        // config.ts
```

- [ ] **Step 7: Run the full suite and verify it passes**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, with coverage still at 100% for lines, functions and statements.

- [ ] **Step 8: Commit**

```bash
git add src/cache/layers.ts src/cache/layers.test.ts src/lib.ts src/lib.test.ts commitlint.config.cjs
git commit -S -m "feat(cache): add cache layer identifiers and input parsing"
```

---

### Task 2: Key and restore-ladder derivation

**Files:**

- Create: `src/cache/keys.ts`
- Create: `src/cache/keys.test.ts`
- Modify: `src/lib.ts` — add the new barrel re-export
- Modify: `src/lib.test.ts` — add `joinKeySegments` and `buildLayerKey` to the pinned export list

**Interfaces:**

- Consumes: `CacheLayerId` from `@rust-toolchain/cache/layers` (Task 1).
- Produces: `joinKeySegments(...segments: (string | undefined)[]): string`,
  `interface CacheKeyContext { os: string; arch: string; suffix?: string; lockHash?: string; specCacheKey: string }`,
  `interface CacheLayerKey { key: string; restoreKeys: string[] }`,
  `buildLayerKey(layer: CacheLayerId, context: CacheKeyContext): CacheLayerKey`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/cache/keys.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { buildLayerKey, joinKeySegments } from "@/cache/keys";
import type { CacheKeyContext } from "@/cache/keys";

const base: CacheKeyContext = {
  os: "Linux",
  arch: "X64",
  suffix: "ci",
  lockHash: "a1b2c3",
  specCacheKey: "20250915abcd-1f2e3d4c",
};

describe("joinKeySegments", () => {
  it("joins every populated segment with a dash", () => {
    expect(joinKeySegments("cargo", "Linux", "X64")).toBe("cargo-Linux-X64");
  });

  // The whole reason this exists. GitHub expressions have no filter, so the
  // YAML version of this leaves `cargo-Linux-X64--<hash>` when a suffix is
  // unset, and that empty slot is part of the key.
  it("drops empty and undefined segments instead of leaving a separator", () => {
    expect(joinKeySegments("cargo", "Linux", "", undefined, "a1b2")).toBe(
      "cargo-Linux-a1b2",
    );
  });

  it("drops whitespace-only segments", () => {
    expect(joinKeySegments("cargo", "   ", "a1b2")).toBe("cargo-a1b2");
  });

  it("trims surrounding whitespace from the segments it keeps", () => {
    expect(joinKeySegments(" cargo ", "Linux")).toBe("cargo-Linux");
  });
});

describe("buildLayerKey", () => {
  it("keys the registry layer on the dependency set alone", () => {
    expect(buildLayerKey("registry", base)).toEqual({
      key: "registry-Linux-X64-ci-a1b2c3",
      restoreKeys: ["registry-Linux-X64-ci-", "registry-Linux-X64-"],
    });
  });

  // The toolchain spec is absent on purpose: downloaded crates are source
  // archives, identical whichever rustc later compiles them.
  it("omits the toolchain spec from the registry key", () => {
    const key = buildLayerKey("registry", base).key;
    expect(key).not.toContain("20250915abcd");
  });

  it("keys the build layer on the dependency set and the toolchain spec", () => {
    expect(buildLayerKey("build", base)).toEqual({
      key: "build-Linux-X64-ci-20250915abcd-1f2e3d4c-a1b2c3",
      restoreKeys: ["build-Linux-X64-ci-20250915abcd-1f2e3d4c-"],
    });
  });

  // Falling back across a different toolchain would restore artifacts cargo
  // discards on sight, then re-save them as a fresh entry — the exact write
  // amplification the layer split exists to remove.
  it("never lets the build ladder cross a toolchain-spec boundary", () => {
    const { restoreKeys } = buildLayerKey("build", base);
    expect(restoreKeys).toHaveLength(1);
    expect(restoreKeys[0]).toContain("20250915abcd-1f2e3d4c");
  });

  it("collapses the suffix slot in both key and ladder when unset", () => {
    const noSuffix: CacheKeyContext = { ...base, suffix: undefined };
    expect(buildLayerKey("registry", noSuffix)).toEqual({
      key: "registry-Linux-X64-a1b2c3",
      restoreKeys: ["registry-Linux-X64-"],
    });
  });

  it("dedupes the ladder when the suffix rung equals the bare rung", () => {
    const noSuffix: CacheKeyContext = { ...base, suffix: "" };
    expect(buildLayerKey("registry", noSuffix).restoreKeys).toEqual([
      "registry-Linux-X64-",
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cache/keys.test.ts`

Expected: FAIL — `Cannot find module '@/cache/keys'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/cache/keys.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { CacheLayerId } from "@rust-toolchain/cache/layers";

/**
 * Joins the populated segments of a cache key with `-`.
 *
 * Empty segments collapse rather than leaving an empty slot: an unset suffix
 * yields `registry-Linux-X64-<hash>`, never `registry-Linux-X64--<hash>`. This
 * is one line here and genuinely awkward in a workflow expression, where there
 * is no filter and the usual workaround is a ternary per segment.
 */
export function joinKeySegments(...segments: (string | undefined)[]): string {
  return segments
    .map((segment) => segment?.trim() ?? "")
    .filter(Boolean)
    .join("-");
}

/** Everything a layer key is derived from. */
export interface CacheKeyContext {
  /** `RUNNER_OS` — cache entries are not portable across operating systems. */
  os: string;
  /** `RUNNER_ARCH` — nor across architectures. */
  arch: string;
  /** Optional caller-supplied discriminator, e.g. a job name. */
  suffix?: string;
  /**
   * The workflow's own `hashFiles` digest over its lockfiles.
   *
   * Supplied rather than computed: `hashFiles` is a workflow-expression
   * function that a Node action cannot call. Do not write the glob pattern
   * into this comment — a lockfile glob contains the characters that close a
   * block comment.
   */
  lockHash?: string;
  /** `generateSpecCacheKey` output: rustc build plus channel, targets, components, profile. */
  specCacheKey: string;
}

/** A layer's exact key and the prefixes GitHub falls back through. */
export interface CacheLayerKey {
  key: string;
  restoreKeys: string[];
}

/**
 * Restore keys are prefix matches, so each rung keeps its trailing `-`.
 *
 * Without it, a `ci` suffix rung would also match a `ci-nightly` entry and
 * restore a cache built for a different job.
 */
function ladder(...prefixes: string[]): string[] {
  return [...new Set(prefixes.map((prefix) => `${prefix}-`))];
}

/**
 * Derives one layer's key and restore ladder.
 *
 * The two layers differ in exactly one way, and it is the point of the split:
 * `registry` holds downloaded source archives, which any rustc can compile, so
 * its key omits the toolchain entirely. `build` holds compiled artifacts, so
 * its key carries the resolved spec and its ladder never falls back past one —
 * artifacts from another toolchain are discarded on sight, and restoring them
 * costs download time only to re-save them under a new key.
 */
export function buildLayerKey(
  layer: CacheLayerId,
  context: CacheKeyContext,
): CacheLayerKey {
  const root = joinKeySegments(layer, context.os, context.arch);

  switch (layer) {
    case "registry": {
      const scoped = joinKeySegments(root, context.suffix);
      return {
        key: joinKeySegments(scoped, context.lockHash),
        restoreKeys: ladder(scoped, root),
      };
    }
    case "build": {
      const scoped = joinKeySegments(
        root,
        context.suffix,
        context.specCacheKey,
      );
      return {
        key: joinKeySegments(scoped, context.lockHash),
        restoreKeys: ladder(scoped),
      };
    }
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test src/cache/keys.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Add the barrel re-export and update the pinned list**

In `src/lib.ts`, add `export * from "@rust-toolchain/cache/keys";` above the `cache/layers` line so the list stays
alphabetical. In `src/lib.test.ts`, add the two new value exports:

```ts
        // cache/keys.ts
        "joinKeySegments",
        "buildLayerKey",
        // cache/layers.ts
        "CACHE_LAYER_IDS",
        "parseCacheLayers",
```

- [ ] **Step 6: Run the full suite**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, coverage still 100%.

- [ ] **Step 7: Commit**

```bash
git add src/cache/keys.ts src/cache/keys.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): derive per-layer cache keys and restore ladders"
```

---

### Task 3: Cache outputs

**Files:**

- Modify: `src/outputs.ts` — add `CacheLayerOutput`, `CacheOutputs`, the `cache` field, and the `cache` output entry
- Modify: `src/outputs.test.ts` — cover the new field and entry

**Interfaces:**

- Consumes: `CacheLayerId` from `@rust-toolchain/cache/layers` (Task 1); `CacheLayerKey` from
  `@rust-toolchain/cache/keys` (Task 2).
- Produces: `interface CacheOutputs { enabled: boolean; layers: Partial<Record<CacheLayerId, CacheLayerKey>> }`,
  a `cache: CacheOutputs` field on `ActionOutputs`, a required `cache: CacheOutputs` field on `ActionOutputsArgs`, and
  a `["cache", <json>]` pair from `toOutputEntries`.

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/outputs.test.ts:33-42` already defines an `args(overrides: Partial<ActionOutputsArgs>)` helper that supplies every
required field. Add `cache` to its defaults so the existing tests keep compiling:

```ts
const args = (
  overrides: Partial<ActionOutputsArgs> = {},
): ActionOutputsArgs => ({
  spec: spec({ profile: "minimal" }),
  inputs: {},
  toml: {},
  setRustupToolchain: { raw: "", value: true },
  cacheKey: "20250915abcd",
  specCacheKey: "20250915abcd-1f2e3d4c",
  cache: { enabled: false, layers: {} },
  ...overrides,
});
```

Add `type CacheOutputs` to the existing `@/outputs` import block, then append the new suite at the end of the file:

```ts
describe("cache outputs", () => {
  it("carries the per-layer keys through to the outputs", () => {
    const cache: CacheOutputs = {
      enabled: true,
      layers: {
        registry: {
          key: "registry-Linux-X64-ci-a1b2c3",
          restoreKeys: ["registry-Linux-X64-ci-", "registry-Linux-X64-"],
        },
      },
    };
    expect(buildActionOutputs(args({ cache })).cache).toEqual(cache);
  });

  it("reports a disabled cache with no layers", () => {
    expect(buildActionOutputs(args()).cache).toEqual({
      enabled: false,
      layers: {},
    });
  });

  // Action outputs are strings, so the object ships as JSON and a consumer
  // reads it with fromJSON() rather than parsing a delimited format.
  it("serialises the cache block as JSON in the flat entries", () => {
    const cache: CacheOutputs = {
      enabled: true,
      layers: {
        build: {
          key: "build-Linux-X64-20250915abcd-1f2e3d4c-a1b2c3",
          restoreKeys: ["build-Linux-X64-20250915abcd-1f2e3d4c-"],
        },
      },
    };
    const entries = toOutputEntries(buildActionOutputs(args({ cache })));
    const entry = entries.find(([name]) => name === "cache");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry?.[1] ?? "null")).toEqual(cache);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/outputs.test.ts`

Expected: FAIL — TypeScript reports that `cache` does not exist on `ActionOutputsArgs`, and the `cache` entry is not
found.

- [ ] **Step 3: Write the minimal implementation**

In `src/outputs.ts`, add the imports at the top of the existing import block:

```ts
import type { CacheLayerKey } from "@rust-toolchain/cache/keys";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";
```

Add the types above `ActionOutputs`:

```ts
/**
 * The cache keys this action derived, per layer.
 *
 * `layers` is partial because `cache-layers` selects which exist; a consumer
 * reads only the ones it enabled. Nothing here is restored or saved yet — these
 * are keys for the workflow's own `actions/cache` steps to use.
 */
export interface CacheOutputs {
  enabled: boolean;
  layers: Partial<Record<CacheLayerId, CacheLayerKey>>;
}
```

Add the field to `ActionOutputs`, after `"cachekey-full"` and before `inputs`, so the JSON key order stays
"effective values, then compatibility keys, then provenance":

```ts
  "cachekey-full": string;
  cache: CacheOutputs;
  inputs: InputProvenance;
```

Add the field to `ActionOutputsArgs`:

```ts
/** Per-layer cache keys, or a disabled marker when `cache` is false. */
cache: CacheOutputs;
```

Set it in `buildActionOutputs`, next to the existing cache-key fields:

```ts
    cachekey: args.cacheKey,
    "cachekey-full": args.specCacheKey,
    cache: args.cache,
```

Add the entry in `toOutputEntries`, after `set-rustup-toolchain` and before `json`:

```ts
    ["set-rustup-toolchain", String(outputs["set-rustup-toolchain"])],
    ["cache", JSON.stringify(outputs.cache)],
    ["json", JSON.stringify(outputs)],
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun run typecheck && bun test src/outputs.test.ts`

Expected: PASS. Existing `buildActionOutputs` call sites in `src/lib.test.ts` and `src/action.test.ts` will now fail to
type-check until they pass `cache` — add `cache: { enabled: false, layers: {} }` to each.

- [ ] **Step 5: Run the full suite**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, coverage still 100%.

- [ ] **Step 6: Commit**

```bash
git add src/outputs.ts src/outputs.test.ts src/lib.test.ts src/action.test.ts
git commit -S -m "feat(cache): publish derived cache keys as an action output"
```

---

### Task 4: Read, validate and wire the cache inputs

**Files:**

- Modify: `src/config.ts:124-130` — export the existing `parseCommaList`
- Modify: `src/action.ts` — add `resolveCacheOutputs`, call it from `run`
- Modify: `src/action.test.ts` — cover the new behaviour
- Modify: `src/lib.test.ts` — add `parseCommaList` to the pinned export list
- Modify: `action.yml` — declare four inputs and one output

**Interfaces:**

- Consumes: `parseCacheLayers`, `CACHE_LAYER_IDS` (Task 1); `buildLayerKey`, `CacheKeyContext` (Task 2); `CacheOutputs`
  (Task 3).
- Produces: nothing consumed by later Phase A tasks. Phase B replaces the body of `resolveCacheOutputs` with one that
  also restores.

**Steps:**

- [ ] **Step 1: Export `parseCommaList` from `src/config.ts`**

The function already exists and is used by `mergeConfig`. Change its declaration from private to exported so the cache
code reuses it rather than duplicating the separator grammar:

```ts
/** Splits a comma-, whitespace- or newline-separated input into entries. */
export function parseCommaList(value?: string): string[] {
```

Then add `"parseCommaList"` to the `config.ts` group in the `src/lib.test.ts` export list.

- [ ] **Step 2: Write the failing test**

`src/action.test.ts:49-110` already defines `harness(options)`, returning `{ deps, calls, outputs, exported, failures,
sleeps, paths, logs }`. Reuse it — do not add a second harness.

Two things about it matter here. Its `env` option **replaces** the default environment rather than merging into it
(`options.env ?? { ... }`), so every test below repeats `HOME` and `GITHUB_WORKSPACE`; omitting them changes where
rustup and the toml resolve. And failures land in a `failures` **array**, not a scalar.

Append this suite to the end of the file:

```ts
const cacheEnv = {
  HOME: "/home/runner",
  GITHUB_WORKSPACE: "/workspace",
  RUNNER_TEMP: "/tmp/runner",
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "X64",
};

describe("cache key outputs", () => {
  it("emits nothing but a disabled marker when cache is unset", () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    run(h.deps);
    expect(JSON.parse(h.outputs["cache"] ?? "null")).toEqual({
      enabled: false,
      layers: {},
    });
  });

  it("derives every default layer when cache is enabled", () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-key-suffix": "ci",
      },
      env: cacheEnv,
    });
    run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(h.failures).toEqual([]);
    expect(cache.enabled).toBe(true);
    expect(Object.keys(cache.layers)).toEqual(["registry", "build"]);
    expect(cache.layers.registry.key).toBe("registry-Linux-X64-ci-a1b2c3");
  });

  // The build key must carry the same spec digest the cachekey-full output
  // reports, or the two describe different toolchains.
  it("keys the build layer on the published cachekey-full value", () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
      },
      env: cacheEnv,
    });
    run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(cache.layers.build.key).toContain(h.outputs["cachekey-full"]);
  });

  it("honours an explicit layer selection", () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-layers": "registry",
      },
      env: cacheEnv,
    });
    run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(Object.keys(cache.layers)).toEqual(["registry"]);
  });

  // A missing lock hash makes both keys constant: they hit exactly on every
  // run, never re-save, and serve the same crates forever. Failing loudly
  // beats a cache that is silently wrong for the life of the repository.
  it("fails when cache is enabled without a lock hash", () => {
    const h = harness({
      inputs: { toolchain: "stable", cache: "true" },
      env: cacheEnv,
    });
    run(h.deps);
    expect(h.failures[0]).toContain("`cache-key-hash` is required");
    expect(h.failures[0]).toContain("hashFiles");
  });

  it("reports an unknown layer through setFailed", () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-layers": "bin",
      },
      env: cacheEnv,
    });
    run(h.deps);
    expect(h.failures[0]).toContain('"bin" is not a cache layer');
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `bun test src/action.test.ts`

Expected: FAIL — the `cache` output is undefined, so `JSON.parse` throws.

- [ ] **Step 4: Write the minimal implementation**

In `src/action.ts`, add the imports to the existing block:

```ts
import {
  buildLayerKey,
  type CacheKeyContext,
} from "@rust-toolchain/cache/keys";
import {
  CACHE_LAYER_IDS,
  parseCacheLayers,
  type CacheLayerId,
} from "@rust-toolchain/cache/layers";
```

`CacheOutputs` comes from the existing `@rust-toolchain/outputs` import — add it there as a type import.

Add the function above `run`:

```ts
/**
 * Derives the cache keys for the enabled layers.
 *
 * Nothing is restored or saved here: the keys go out as an output for the
 * workflow's own `actions/cache` steps. The lock hash arrives as an input
 * because `hashFiles()` is a workflow-expression function that a Node action
 * cannot call, and taking GitHub's own value keeps the keys interoperable with
 * caches the workflow already has.
 */
function resolveCacheOutputs(
  deps: ActionDeps,
  specCacheKey: string,
): CacheOutputs {
  const enabled = readBooleanInput(deps, "cache", false);
  if (!enabled.value) return { enabled: false, layers: {} };

  const layers = parseCacheLayers(
    deps.core.getInput("cache-layers").trim() || CACHE_LAYER_IDS.join(","),
  );
  const lockHash = deps.core.getInput("cache-key-hash").trim();

  // Every Phase A layer keys on the dependency set, so an absent hash makes the
  // key constant: it hits exactly forever, never re-saves, and serves stale
  // crates for the life of the repository. That is worse than failing here.
  if (!lockHash) {
    throw new Error(
      "`cache-key-hash` is required when `cache` is true. This action cannot " +
        "compute it — `hashFiles()` is a workflow-expression function — so " +
        "pass the workflow's own value:\n" +
        "  cache-key-hash: ${{ hashFiles('**/Cargo.lock') }}\n" +
        "Without it the cache keys never change: they hit exactly on every " +
        "run and serve the same crates for the life of the repository.",
    );
  }

  const context: CacheKeyContext = {
    os: deps.env.RUNNER_OS ?? "",
    arch: deps.env.RUNNER_ARCH ?? "",
    suffix: deps.core.getInput("cache-key-suffix").trim(),
    lockHash,
    specCacheKey,
  };

  const built: Partial<Record<CacheLayerId, CacheLayerKey>> = {};
  for (const layer of layers) built[layer] = buildLayerKey(layer, context);
  return { enabled: true, layers: built };
}
```

`CacheLayerKey` comes from the same import as `buildLayerKey`:

```ts
import {
  buildLayerKey,
  type CacheKeyContext,
  type CacheLayerKey,
} from "@rust-toolchain/cache/keys";
```

In `run`, replace the inline `generateSpecCacheKey` call so the value is computed once and shared:

```ts
const specCacheKey = generateSpecCacheKey(rustc.info.cacheKey, spec);
const outputs = buildActionOutputs({
  spec,
  inputs: config.inputs,
  toml: config.toml,
  setRustupToolchain,
  cacheKey: rustc.info.cacheKey,
  specCacheKey,
  cache: resolveCacheOutputs(deps, specCacheKey),
});
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `bun test src/action.test.ts`

Expected: PASS.

- [ ] **Step 6: Declare the inputs and output in `action.yml`**

Add to `inputs:`, after `set-rustup-toolchain`:

```yaml
cache:
  description: >
    Whether to derive cargo cache keys (default false). When true, the
    `cache` output carries a key and restore-key ladder per layer for the
    workflow's own `actions/cache` steps. This action does not restore or
    save anything itself.
  required: false
  default: "false"

cache-key-hash:
  description: >
    A hash of the dependency set, required when `cache` is true. Pass
    `${{ hashFiles('**/Cargo.lock') }}` — `hashFiles` is a workflow
    expression function that a Node action cannot call, and using GitHub's
    own value keeps these keys interoperable with caches you already have.
    Without it the keys never change: they hit exactly on every run and
    serve the same crates for the life of the repository.
  required: false

cache-key-suffix:
  description: >
    An optional discriminator added to every cache key, e.g. a job name.
    Omitting it collapses the slot rather than leaving an empty segment, so
    the key reads `registry-Linux-X64-<hash>` and not
    `registry-Linux-X64--<hash>`.
  required: false

cache-layers:
  description: >
    Which cache layers to derive keys for, comma, space or newline
    separated. Defaults to all of them. `registry` covers the downloaded
    crates and is keyed on the dependency set alone; `build` covers the
    target directory and is keyed on the dependency set plus the resolved
    toolchain, so a rustc bump does not invalidate the crates it never
    touched.
  required: false
  default: "registry,build"
```

Add to `outputs:`, after `cachekey-full`:

```yaml
cache:
  description: >
    The derived cache keys as one JSON object: `enabled`, plus a `layers`
    map from layer name to `{ key, restoreKeys }`. Empty when `cache` is
    false. Read it with `fromJSON()` and feed the parts straight into
    `actions/cache`.
```

- [ ] **Step 7: Run the full suite**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, coverage still 100%.

- [ ] **Step 8: Commit**

```bash
git add src/action.ts src/action.test.ts src/config.ts src/lib.test.ts action.yml
git commit -S -m "feat(cache): read cache inputs and emit derived keys"
```

---

### Task 5: Documentation and bundle

**Files:**

- Modify: `README.md` — regenerated input/output tables plus a caching recipe
- Modify: `docs/ARCHITECTURE.md` — the layer model
- Modify: `AGENTS.md` and `CLAUDE.md` — the `src/cache/` layout and the cache invariants
- Modify: `dist/index.js` — rebuilt bundle

**Interfaces:**

- Consumes: everything from Tasks 1 through 4.
- Produces: nothing consumed by later tasks.

**Steps:**

- [ ] **Step 1: Regenerate the README tables**

Run: `mise run readme && bun run fix:all`

`mise run readme` emits unpadded tables and `bun run fix:all` realigns them; running only the first leaves the diff
dirty. Verify afterwards that both `action-docs-all` markers still carry their full attribute set — dropping
`project` or `version` silently regenerates the Usage block as `- uses: @`:

```text
<!-- action-docs-all source="action.yml" project="elioseverojunior/rust-toolchain" version="v1" -->
```

- [ ] **Step 2: Add a caching recipe to the README**

Add a section after the existing outputs table:

````markdown
### Deriving cargo cache keys

Set `cache: true` and the action derives a key and restore-key ladder per layer. It does not restore or save anything
itself — the keys go to your own `actions/cache` steps.

```yaml
- id: rust
  uses: elioseverojunior/rust-toolchain@v1
  with:
    toolchain: stable
    cache: true
    cache-key-hash: ${{ hashFiles('**/Cargo.lock') }}
    cache-key-suffix: ci

- uses: actions/cache@v6
  with:
    path: |
      ~/.cargo/registry/index
      ~/.cargo/registry/cache
      ~/.cargo/git/db
    key: ${{ fromJSON(steps.rust.outputs.cache).layers.registry.key }}
    restore-keys: ${{ join(fromJSON(steps.rust.outputs.cache).layers.registry.restoreKeys, '
') }}
```

The two layers are keyed differently on purpose. `registry` holds downloaded source archives that any compiler can
build, so its key omits the toolchain — bumping stable does not re-download crates. `build` holds compiled artifacts,
so its key carries the resolved toolchain and its ladder never falls back past one.
````

- [ ] **Step 3: Document the layer model in `docs/ARCHITECTURE.md`**

Add a "Cache layers" section under Key Design Decisions, covering: why the layers are split by invalidation rate, why
the registry key omits the toolchain, why the build ladder stops one rung short, and why the lock hash is an input
rather than something the action computes. Link to `docs/design/2026-07-31-layered-cargo-cache.md` for the full
rationale, including the `bin` layer that Phase C adds.

- [ ] **Step 4: Update `AGENTS.md` and `CLAUDE.md`**

In `AGENTS.md`, add `src/cache/layers.ts` and `src/cache/keys.ts` to the source-layout list with one line each. In
`CLAUDE.md`, add a "Cache invariants" section recording the three rules that must not be "simplified":

- Empty key segments collapse; they never leave an empty slot.
- The registry key never contains the toolchain spec.
- The build restore ladder never falls back past a `cachekey-full` boundary.

Each of those reads as an omission a future reader might "fix", so record why alongside the rule, the way the existing
Rustup invariants section does.

- [ ] **Step 5: Rebuild the bundle**

Run: `bun run build`

`action.yml` runs `dist/index.js`, the bundle is tracked in git, and the CI Build job runs `git diff --exit-code dist/`.
A stale bundle fails CI.

- [ ] **Step 6: Run every gate**

Run: `bun run fix:all && bun run typecheck && bun run test && bun run build && hk check --all`

Expected: all pass. `hk check --all` is what the CI Lint job runs and covers `actionlint`, `rumdl`, `mermaid`,
`gitleaks` and whitespace hygiene, none of which `bun run fix:all` touches.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/ARCHITECTURE.md AGENTS.md CLAUDE.md dist/index.js
git commit -S -m "docs(cache): document derived cache keys and rebuild bundle"
```

---

## Phase A completion check

- [ ] `bun run test` passes with 100% lines, functions and statements.
- [ ] `bun run typecheck` is clean.
- [ ] `hk check --all` is clean.
- [ ] `git diff --exit-code dist/` is clean after `bun run build`.
- [ ] `action.yml` declares `cache`, `cache-key-hash`, `cache-key-suffix`, `cache-layers` and the `cache` output.
- [ ] The README's `action-docs-all` markers still carry `source`, `project` and `version`.
- [ ] The downstream composite's `bash` key-computation step can be replaced by reading `steps.<id>.outputs.cache`,
      for the registry and build layers.

## What Phase A deliberately leaves out

- The `bin` layer, `RUSTUP_SHIMS`, `hashToolSet` and the `cargo-tools` input — Phase C, together with installation.
- Any restore or save. No `@actions/cache`, no `post:` entrypoint, no bundle growth — Phase B.
- Pruning, budget and the job summary — Phases D and E.

## Carried into Phase B

`src/action.ts` is 473 lines after Task 4, past this project's 300-line file guideline (see the root `CLAUDE.md`
→ Engineering Rules). Phase B adds restore/save orchestration to that same file — `resolveCacheOutputs`,
the `post:` entrypoint wiring, and the `@actions/cache` calls all land there under the naive plan. **Phase B's plan
should extract the cache-input handling (`resolveCacheOutputs` and its helpers) into its own module** — e.g.
`src/cache/inputs.ts` — before adding to `action.ts`, rather than growing the file further and pushing the split to a
later phase.

## Carried into Phase C

Phase A checks `cache-key-hash` unconditionally, because both of its layers key on the dependency set. The spec scopes
that requirement to the `registry` and `build` layers specifically, so **Phase C must narrow the check** when it adds
`bin` — a workflow enabling only the `bin` layer has no lockfile component to miss, and failing it would be wrong:

```ts
const needsLockHash = layers.some(
  (layer) => layer === "registry" || layer === "build",
);
if (needsLockHash && !lockHash) {
  // ...
}
```

Two more landmines the Task 1-4 reviews found, both cases where adding the `bin` layer would silently do the wrong
thing rather than fail loudly:

- `src/cache/keys.ts`'s `buildLayerKey` uses early-return `if`s instead of the `switch` the plan specified — see
  `CLAUDE.md` → Coverage gate gotchas for why: a `switch`'s final case phantom-fails Bun's 100% coverage gate. The
  `switch` would have failed to type-check the moment `CacheLayerId` gained a third member; the `if` shape has no such
  guard and silently treats any non-`"registry"` layer, including a future `"bin"`, as `"build"`. **Phase C must
  restore exhaustiveness** — the reviewer's suggestion was a `Record<CacheLayerId, (context, root) => CacheLayerKey>`
  dispatch table, which type-errors on a missing key without reintroducing a `switch`.
- `action.yml`'s `cache-layers` default is the string literal `"registry,build"`, duplicating the ordering that
  `src/action.ts` falls back to via `CACHE_LAYER_IDS.join(",")`. Adding `bin` to `CACHE_LAYER_IDS` updates the
  TypeScript fallback automatically but does not touch the YAML default, so the two silently diverge. **Phase C must
  update both.**

Phase C also widens `parseCacheLayers`, the `cache-layers` default in `resolveCacheOutputs`, and the `CACHE_LAYER_IDS`
assertion in `src/cache/layers.test.ts`.
