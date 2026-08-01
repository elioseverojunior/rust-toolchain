<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the action restore the cargo cache layers at the start of a job and save them from a `post:` step,
retiring `Swatinem/rust-cache` from a workflow rather than complementing it.

**Architecture:** Phase A's keys become a lifecycle. The `build` key gains an environment digest so `RUSTFLAGS`
variants stop colliding. `@actions/cache` is reached only through a `CacheClient` port whose sole real implementation
lives in `src/index.ts` — dependency wiring that no test imports — so the library and its tests never load the Azure
SDK. Saving is bounded by a per-layer budget because deterministic pruning is Phase D.

**Tech Stack:** TypeScript 6 (strict), Bun test runner, `@actions/cache`, `@actions/core`, `node:crypto`, `node:fs`.

**Design:** [docs/design/2026-07-31-layered-cargo-cache-phase-b.md](../design/2026-07-31-layered-cargo-cache-phase-b.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then write the minimal implementation.
- **Coverage gate is 100%** for lines, functions and statements across `src/`, enforced by `bunfig.toml`. Unreachable
  or unused code fails the build.
- **`src/index.ts` is excluded from coverage** because nothing imports it. That is deliberate and load-bearing here:
  it is where the `@actions/cache` adapter goes. Anything with logic worth testing must not live there.
- **Two Bun 1.3.14 coverage quirks**, both documented in `CLAUDE.md`: a class with field declarations needs an
  explicit `constructor()`, and a `switch` whose `case` bodies are braced blocks that return loses coverage on the
  last closing brace. Use a lookup object instead of `switch`.
- **Library source imports siblings as `@rust-toolchain/<module>`**, never `./<module>` and never `@/<module>`. Test
  files use `@/<module>`.
- **`src/lib.ts` is the barrel** and must never re-export `src/index.ts`. `src/lib.test.ts` pins the complete runtime
  export list; adding a library module means updating both.
- **Every file starts with the SPDX header** exactly as the existing `src/*.ts` files have it.
- **Commands are argv arrays executed without a shell.** No value from inputs or a workspace `rust-toolchain.toml` is
  ever interpolated into a command string.
- **Before every commit**, in this order: `bun run fix:all`, `bun run typecheck`, `bun run test`.
- **Commits are GPG-signed** (`git commit -S`), Conventional Commits, scope `cache`. **Never** a `Co-Authored-By`
  trailer or any attribution line.
- **`dist/` is rebuilt only in the final task.** Intermediate commits leave it stale on purpose.

## File Structure

| File                              | Responsibility                                                 | Task |
| --------------------------------- | -------------------------------------------------------------- | ---- |
| `src/cache/env.ts`                | `hashBuildEnv` — prefix set, deny-list, digest                 | 1    |
| `src/cache/keys.ts`               | modified: `envHash` enters the build key and its ladder        | 1    |
| `src/cache/paths.ts`              | `cache-workspaces` parsing, layer paths, exclusion globs       | 2    |
| `src/cache/budget.ts`             | size parsing, directory measurement, enforcement               | 3    |
| `src/cache/client.ts`             | the `CacheClient` port — types only, no runtime                | 4    |
| `src/cache/lifecycle.ts`          | restore and save orchestration against the port                | 5    |
| `src/cache/summary.ts`            | the job summary table                                          | 6    |
| `src/cache/inputs.ts`             | modified: reads `cache-workspaces`, `cache-budget`, env digest | 6    |
| `src/outputs.ts`                  | modified: per-layer result and byte counts, `cache-hit`        | 6    |
| `action.yml`                      | modified: `post:`, `post-if:`, two inputs, one output          | 6    |
| `src/action.ts`                   | modified: async, restores, hands state to the post phase       | 7    |
| `src/index.ts`                    | modified: `STATE_isPost` branch, awaits `run`, the adapter     | 7    |
| docs, `dist/index.js`, `cicd.yml` | regenerated and rebuilt; E2E warm-cache assertion              | 8    |

---

### Task 1: Environment digest in the build key

**Files:**

- Create: `src/cache/env.ts`, `src/cache/env.test.ts`
- Modify: `src/cache/keys.ts` — `CacheKeyContext` gains `envHash`, the build deriver uses it
- Modify: `src/cache/keys.test.ts` — every build-key expectation gains the segment
- Modify: `src/cache/inputs.test.ts` — build-key expectations
- Modify: `src/action.test.ts` — build-key expectations
- Modify: `src/lib.ts`, `src/lib.test.ts` — barrel and pinned list

**Interfaces:**

- Consumes: nothing.
- Produces: `hashBuildEnv(env: Record<string, string | undefined>): string`;
  `CacheKeyContext` gains a required `envHash: string`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/cache/env.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { hashBuildEnv } from "@/cache/env";

describe("hashBuildEnv", () => {
  it("is stable for an empty environment", () => {
    expect(hashBuildEnv({})).toBe(hashBuildEnv({}));
    expect(hashBuildEnv({})).toMatch(/^[0-9a-f]{8}$/);
  });

  it("ignores variables outside the prefix set", () => {
    expect(hashBuildEnv({ PATH: "/usr/bin", HOME: "/root" })).toBe(
      hashBuildEnv({}),
    );
  });

  // The whole reason this exists: two jobs differing only in RUSTFLAGS must
  // not derive the same build key.
  it("changes when RUSTFLAGS changes", () => {
    expect(hashBuildEnv({ RUSTFLAGS: "-C target-cpu=native" })).not.toBe(
      hashBuildEnv({ RUSTFLAGS: "" }),
    );
  });

  it("covers every prefix in the set", () => {
    const base = hashBuildEnv({});
    for (const name of [
      "CARGO_BUILD_JOBS",
      "CC",
      "CFLAGS",
      "CXX",
      "CMAKE_C_COMPILER",
      "RUSTDOCFLAGS",
    ]) {
      expect(hashBuildEnv({ [name]: "x" })).not.toBe(base);
    }
  });

  // Order must not matter: an environment is a set, and object key order is
  // an implementation detail of whoever built it.
  it("is independent of insertion order", () => {
    expect(hashBuildEnv({ RUSTFLAGS: "-O", CC: "clang" })).toBe(
      hashBuildEnv({ CC: "clang", RUSTFLAGS: "-O" }),
    );
  });

  // These match the prefix set but describe where or how, not what gets
  // built. Hashing them would churn the key on self-hosted runners without
  // changing a single artifact.
  it.each([
    "CARGO_HOME",
    "RUSTUP_HOME",
    "CARGO_TERM_COLOR",
    "RUSTUP_TOOLCHAIN",
  ])("excludes %s", (name) => {
    expect(hashBuildEnv({ [name]: "/some/path" })).toBe(hashBuildEnv({}));
  });

  it("ignores undefined values", () => {
    expect(hashBuildEnv({ RUSTFLAGS: undefined })).toBe(hashBuildEnv({}));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cache/env.test.ts`

Expected: FAIL — `Cannot find module '@/cache/env'`.

- [ ] **Step 3: Write the implementation**

Create `src/cache/env.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";

/**
 * Environment variables that change what cargo produces.
 *
 * The same prefix set `Swatinem/rust-cache` defaults to. Matching by prefix
 * rather than by name is what makes it cover `RUSTFLAGS`, `RUSTDOCFLAGS`,
 * `CARGO_BUILD_JOBS` and the rest without enumerating a list that goes stale.
 */
const BUILD_ENV_PREFIXES = [
  "CARGO_",
  "CC",
  "CFLAGS",
  "CXX",
  "CMAKE",
  "RUST",
] as const;

/**
 * Matches a prefix but describes where or how, not what gets built.
 *
 * `CARGO_HOME` and `RUSTUP_HOME` are absolute paths that differ per machine on
 * self-hosted runners, so hashing them would churn the key without changing an
 * artifact. `CARGO_TERM_COLOR` is presentation. `RUSTUP_TOOLCHAIN` is already
 * inside `cachekey-full`, and hashing it twice buys nothing.
 */
const EXCLUDED = new Set([
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_TERM_COLOR",
  "RUSTUP_TOOLCHAIN",
]);

/**
 * Digests the build-affecting environment into a key segment.
 *
 * Sorted before hashing, so the digest describes the environment as a set
 * rather than as whatever order the caller happened to build the object in.
 * Truncated to 8 hex characters, the same width `generateSpecCacheKey` uses,
 * so every key segment stays uniform.
 */
export function hashBuildEnv(env: Record<string, string | undefined>): string {
  const canonical = Object.entries(env)
    .filter(([name, value]) => {
      if (value === undefined) return false;
      if (EXCLUDED.has(name)) return false;
      return BUILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    })
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join("\n");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test src/cache/env.test.ts`

Expected: PASS.

- [ ] **Step 5: Add `envHash` to the key context**

In `src/cache/keys.ts`, add the field to `CacheKeyContext`, after `specCacheKey`:

```ts
/**
 * Digest of the build-affecting environment, from `hashBuildEnv`.
 *
 * Required rather than optional even though only the build layer uses it: an
 * optional field is one a caller can forget, and forgetting it here means
 * two jobs with different `RUSTFLAGS` silently sharing a key.
 */
envHash: string;
```

Then, in the `DERIVERS` table, change the `build` entry so both the key and its
single ladder rung carry the digest:

```ts
  build: (context, root) => {
    const scoped = joinKeySegments(
      root,
      context.suffix,
      context.specCacheKey,
      context.envHash,
    );
    return {
      key: joinKeySegments(scoped, context.lockHash),
      restoreKeys: ladder(scoped),
    };
  },
```

Leave `registry` untouched — crate sources compile under any flags, and keying
them on the environment would re-download every crate on a `RUSTFLAGS` change.

- [ ] **Step 6: Update every build-key expectation**

`bun run typecheck` now fails at each `CacheKeyContext` literal. Add
`envHash: "e1e2e3e4"` to the fixtures in `src/cache/keys.test.ts`, and update
the build-key expectations there, in `src/cache/inputs.test.ts` and in
`src/action.test.ts` to include the segment. In `src/cache/keys.test.ts` add a
test asserting the registry key does **not** contain it:

```ts
it("keeps the environment digest out of the registry key", () => {
  expect(buildLayerKey("registry", base).key).not.toContain(base.envHash);
});
```

- [ ] **Step 7: Wire the digest at the one call site**

In `src/cache/inputs.ts`, import `hashBuildEnv` from `@rust-toolchain/cache/env`
and add it to the context built in `readCacheRequest`:

```ts
const context: PendingCacheKeyContext = {
  os: requireRunnerEnv(source, "RUNNER_OS"),
  arch: requireRunnerEnv(source, "RUNNER_ARCH"),
  suffix,
  lockHash,
  envHash: hashBuildEnv(source.env),
};
```

`PendingCacheKeyContext` is `Omit<CacheKeyContext, "specCacheKey">`, so it picks
up the new field automatically.

- [ ] **Step 8: Update the barrel and the pinned export list**

Add `export * from "@rust-toolchain/cache/env";` to `src/lib.ts` in alphabetical
position (before `cache/inputs`), add `"hashBuildEnv"` to the list in
`src/lib.test.ts` under a `// cache/env.ts` comment, and change "nine library
modules" to "ten" in both `src/lib.ts`'s doc comment and that test's
description.

- [ ] **Step 9: Run the full suite**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, coverage still 100%.

- [ ] **Step 10: Commit**

```bash
git add src/cache/env.ts src/cache/env.test.ts src/cache/keys.ts src/cache/keys.test.ts \
        src/cache/inputs.ts src/cache/inputs.test.ts src/action.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): key the build layer on the build environment"
```

---

### Task 2: Layer paths and workspaces

**Files:**

- Create: `src/cache/paths.ts`, `src/cache/paths.test.ts`
- Modify: `src/lib.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `interface Workspace { manifestDir: string; targetDir: string }`;
  `parseWorkspaces(value: string, workspaceRoot: string): Workspace[]`;
  `registryPaths(cargoHome: string): string[]`;
  `buildPaths(workspaces: Workspace[]): string[]`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/cache/paths.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { buildPaths, parseWorkspaces, registryPaths } from "@/cache/paths";

const ROOT = "/workspace";

describe("parseWorkspaces", () => {
  it("defaults a bare directory to a target sibling", () => {
    expect(parseWorkspaces(". -> target", ROOT)).toEqual([
      { manifestDir: "/workspace", targetDir: "/workspace/target" },
    ]);
  });

  it("parses one mapping per line, ignoring blank lines", () => {
    expect(
      parseWorkspaces("crates/a -> target\n\ncrates/b -> out", ROOT),
    ).toEqual([
      { manifestDir: "/workspace/crates/a", targetDir: "/workspace/target" },
      { manifestDir: "/workspace/crates/b", targetDir: "/workspace/out" },
    ]);
  });

  it("tolerates loose spacing around the arrow", () => {
    expect(parseWorkspaces(".->target", ROOT)).toEqual([
      { manifestDir: "/workspace", targetDir: "/workspace/target" },
    ]);
  });

  it("rejects a line with no arrow", () => {
    expect(() => parseWorkspaces("crates/a", ROOT)).toThrow(
      "`cache-workspaces` entries look like `<manifest-dir> -> <target-dir>`",
    );
  });

  // Cache paths come from workflow input. A mapping escaping the checkout
  // would let a cache entry read or overwrite files outside it.
  it.each(["../etc -> target", ". -> ../outside", "/etc -> target"])(
    "rejects %s for escaping the workspace",
    (line) => {
      expect(() => parseWorkspaces(line, ROOT)).toThrow(
        "outside the workspace",
      );
    },
  );

  it("rejects an empty list", () => {
    expect(() => parseWorkspaces("   ", ROOT)).toThrow(
      "must name at least one",
    );
  });
});

describe("registryPaths", () => {
  // registry/src is extracted source, regenerable from the .crate files in
  // registry/cache. Listing what we want means it is never included, which
  // beats excluding it because there is nothing to keep in sync.
  it("names only the three directories worth keeping", () => {
    expect(registryPaths("/home/runner/.cargo")).toEqual([
      "/home/runner/.cargo/registry/index",
      "/home/runner/.cargo/registry/cache",
      "/home/runner/.cargo/git/db",
    ]);
  });

  it("never includes registry/src", () => {
    expect(registryPaths("/c").join("\n")).not.toContain("registry/src");
  });
});

describe("buildPaths", () => {
  // Profile directories cannot be enumerated up front (debug, release,
  // <triple>/debug), so the unwanted ones are excluded by negation rather
  // than by listing what to include.
  it("includes each target dir and excludes the regenerable subtrees", () => {
    expect(buildPaths([{ manifestDir: "/w", targetDir: "/w/target" }])).toEqual(
      ["/w/target", "!/w/target/*/incremental", "!/w/target/*/examples"],
    );
  });

  it("handles multiple workspaces", () => {
    const paths = buildPaths([
      { manifestDir: "/w/a", targetDir: "/w/ta" },
      { manifestDir: "/w/b", targetDir: "/w/tb" },
    ]);
    expect(paths).toContain("/w/ta");
    expect(paths).toContain("/w/tb");
    expect(paths.filter((p) => p.startsWith("!"))).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cache/paths.test.ts`

Expected: FAIL — `Cannot find module '@/cache/paths'`.

- [ ] **Step 3: Write the implementation**

Create `src/cache/paths.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { isAbsolute, resolve } from "node:path";

/** One `<manifest-dir> -> <target-dir>` mapping, both resolved absolutely. */
export interface Workspace {
  manifestDir: string;
  targetDir: string;
}

/**
 * Resolves one side of a mapping, refusing anything outside the checkout.
 *
 * Cache paths come from workflow input, and a path escaping `GITHUB_WORKSPACE`
 * would let a cache entry read or overwrite files outside the checkout. An
 * absolute input is rejected for the same reason rather than trusted.
 */
function resolveInside(root: string, part: string): string {
  const resolved = isAbsolute(part) ? part : resolve(root, part);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(
      `\`cache-workspaces\` entry "${part}" resolves to "${resolved}", which ` +
        `is outside the workspace "${root}". Cache paths come from workflow ` +
        "input, so one escaping the checkout is refused rather than trusted.",
    );
  }
  return resolved;
}

/**
 * Reads `cache-workspaces` into resolved mappings.
 *
 * The `<manifest-dir> -> <target-dir>` syntax matches `Swatinem/rust-cache`, so
 * an existing workflow value transfers unchanged.
 */
export function parseWorkspaces(value: string, root: string): Workspace[] {
  const workspaces = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("->").map((part) => part.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          "`cache-workspaces` entries look like `<manifest-dir> -> <target-dir>`, " +
            `one per line; got ${JSON.stringify(line)}.`,
        );
      }
      return {
        manifestDir: resolveInside(root, parts[0]),
        targetDir: resolveInside(root, parts[1]),
      };
    });

  if (workspaces.length === 0) {
    throw new Error(
      "`cache-workspaces` must name at least one `<manifest-dir> -> <target-dir>` mapping.",
    );
  }
  return workspaces;
}

/**
 * The registry layer's paths.
 *
 * `registry/src` holds extracted sources, regenerable from the `.crate` files
 * in `registry/cache`, so it is simply never listed. Naming what to keep beats
 * excluding what to drop: there is nothing here to keep in sync.
 */
export function registryPaths(cargoHome: string): string[] {
  return [
    `${cargoHome}/registry/index`,
    `${cargoHome}/registry/cache`,
    `${cargoHome}/git/db`,
  ];
}

/**
 * The build layer's paths, with the regenerable subtrees excluded.
 *
 * Profile directories cannot be enumerated up front — `debug`, `release`,
 * `<triple>/debug` — so these are negation globs, which `@actions/cache`
 * honours through `@actions/glob`. Excluding rather than deleting keeps the
 * working tree intact, so a failed save leaves nothing damaged.
 */
export function buildPaths(workspaces: Workspace[]): string[] {
  return workspaces.flatMap(({ targetDir }) => [
    targetDir,
    `!${targetDir}/*/incremental`,
    `!${targetDir}/*/examples`,
  ]);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test src/cache/paths.test.ts`

Expected: PASS.

- [ ] **Step 5: Update the barrel and pinned list**

Add `export * from "@rust-toolchain/cache/paths";` to `src/lib.ts` (after
`cache/layers`), add `"parseWorkspaces"`, `"registryPaths"` and `"buildPaths"`
to `src/lib.test.ts` under a `// cache/paths.ts` comment, and bump the module
count from ten to eleven in both places.

- [ ] **Step 6: Run the full suite and commit**

Run: `bun run fix:all && bun run typecheck && bun run test`

```bash
git add src/cache/paths.ts src/cache/paths.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): resolve layer paths and cache-workspaces mappings"
```

---

### Task 3: Size parsing, measurement and the budget

**Files:**

- Create: `src/cache/budget.ts`, `src/cache/budget.test.ts`
- Modify: `src/lib.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `parseSize(value: string): number` (0 means disabled);
  `measurePaths(paths: string[], stat: StatFs): number`;
  `interface StatFs { readdir(dir: string): string[]; stat(path: string): { size: number; isDirectory(): boolean } }`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/cache/budget.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { measurePaths, parseSize } from "@/cache/budget";
import type { StatFs } from "@/cache/budget";

describe("parseSize", () => {
  it("treats zero as disabled", () => {
    expect(parseSize("0")).toBe(0);
    expect(parseSize("")).toBe(0);
  });

  it("reads a bare byte count", () => {
    expect(parseSize("1024")).toBe(1024);
  });

  // Binary, not decimal: GitHub reports cache entry sizes in binary units, so
  // a budget expressed in decimal would not match what the user sees.
  it.each([
    ["1K", 1024],
    ["1KB", 1024],
    ["2M", 2 * 1024 ** 2],
    ["2GB", 2 * 1024 ** 3],
    ["1T", 1024 ** 4],
  ])("parses %s as binary", (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it("is case-insensitive and tolerates spacing", () => {
    expect(parseSize(" 2gb ")).toBe(2 * 1024 ** 3);
  });

  // Silently disabling the budget on a typo would let an oversized entry
  // evict other workflows' caches, which is the harm the budget prevents.
  it.each(["2 gigabytes", "-1", "MB", "1.5G"])("rejects %s", (input) => {
    expect(() => parseSize(input)).toThrow("`cache-budget`");
  });
});

const fakeFs = (tree: Record<string, number | string[]>): StatFs => ({
  readdir: (dir) => {
    const entry = tree[dir];
    return Array.isArray(entry) ? entry : [];
  },
  stat: (path) => {
    const entry = tree[path];
    if (entry === undefined) throw new Error(`ENOENT: ${path}`);
    return {
      size: Array.isArray(entry) ? 0 : entry,
      isDirectory: () => Array.isArray(entry),
    };
  },
});

describe("measurePaths", () => {
  it("sums a flat directory", () => {
    const fs = fakeFs({ "/t": ["a", "b"], "/t/a": 100, "/t/b": 200 });
    expect(measurePaths(["/t"], fs)).toBe(300);
  });

  it("recurses into subdirectories", () => {
    const fs = fakeFs({
      "/t": ["deep"],
      "/t/deep": ["f"],
      "/t/deep/f": 42,
    });
    expect(measurePaths(["/t"], fs)).toBe(42);
  });

  // A path that does not exist is normal: a workspace may never have been
  // built, and a missing target dir is not an error.
  it("treats a missing path as zero", () => {
    expect(measurePaths(["/nope"], fakeFs({}))).toBe(0);
  });

  // Negation entries describe what to exclude from the archive; they are not
  // paths to walk, and treating them as such would throw ENOENT on "!...".
  it("skips negation globs", () => {
    const fs = fakeFs({ "/t": ["a"], "/t/a": 10 });
    expect(measurePaths(["/t", "!/t/*/incremental"], fs)).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cache/budget.test.ts`

Expected: FAIL — `Cannot find module '@/cache/budget'`.

- [ ] **Step 3: Write the implementation**

Create `src/cache/budget.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test src/cache/budget.test.ts`

Expected: PASS.

- [ ] **Step 5: Update the barrel and pinned list**

Add `export * from "@rust-toolchain/cache/budget";` to `src/lib.ts` (before
`cache/env`), add `"parseSize"` and `"measurePaths"` to `src/lib.test.ts` under
a `// cache/budget.ts` comment, and bump eleven to twelve in both places.

- [ ] **Step 6: Run the full suite and commit**

Run: `bun run fix:all && bun run typecheck && bun run test`

```bash
git add src/cache/budget.ts src/cache/budget.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): parse and measure the per-layer size budget"
```

---

### Task 4: The CacheClient port

**Files:**

- Create: `src/cache/client.ts`
- Modify: `package.json` — add `@actions/cache`
- Modify: `src/lib.ts` — re-export the (type-only) module

**Interfaces:**

- Consumes: nothing.
- Produces: `interface CacheClient { restore(paths: string[], key: string, restoreKeys: string[]): Promise<string | undefined>; save(paths: string[], key: string): Promise<void> }`.

**Steps:**

- [ ] **Step 1: Add the dependency and record the bundle cost**

```bash
bun add @actions/cache
```

Then measure, because the design accepted a specific number and a later reader
should be able to check it:

```bash
bun run build && wc -c dist/index.js
```

Expected: roughly 2.1 MB, against 774,094 bytes before. Note the actual figure
in the commit message. If it materially exceeds ~2.5 MB, stop and report —
the design named egregious growth as grounds to reopen.

- [ ] **Step 2: Write the port**

Create `src/cache/client.ts`. There is deliberately **no test file**: this
module declares types and no runtime behaviour, so there is nothing to execute
and nothing for the coverage gate to measure.

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * The cache operations the lifecycle needs, as a port.
 *
 * The only real implementation wraps `@actions/cache` and lives in
 * `src/index.ts`, which nothing imports and the coverage gate does not measure.
 * That placement is the point: `@actions/cache` is 1.39 MB of Azure storage SDK
 * and unmockable network code, so a library module importing it would put it
 * into every test process and make the 100% gate unreachable for the lifecycle.
 *
 * `restore` returns the key that actually matched — which may be a restore-key
 * prefix rather than the exact key — or `undefined` on a miss. The caller
 * compares it against the exact key to decide whether saving is worth doing.
 */
export interface CacheClient {
  restore(
    paths: string[],
    key: string,
    restoreKeys: string[],
  ): Promise<string | undefined>;
  save(paths: string[], key: string): Promise<void>;
}
```

- [ ] **Step 3: Re-export it from the barrel**

Add `export * from "@rust-toolchain/cache/client";` to `src/lib.ts` (before
`cache/env`). The pinned list in `src/lib.test.ts` does **not** change: the
module has no runtime exports. Bump twelve to thirteen in the doc comment and
the test description.

- [ ] **Step 4: Run the full suite**

Run: `bun run fix:all && bun run typecheck && bun run test`

Expected: PASS, coverage unchanged — a type-only module contributes no
executable lines.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/cache/client.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): add the CacheClient port and @actions/cache"
```

---

### Task 5: Restore and save orchestration

**Files:**

- Create: `src/cache/lifecycle.ts`, `src/cache/lifecycle.test.ts`
- Modify: `src/lib.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: `CacheClient` (Task 4), `CacheLayerId` from `@rust-toolchain/cache/layers`.
- Produces: `interface LayerPlan { layer: CacheLayerId; key: string; restoreKeys: string[]; paths: string[] }`;
  `type LayerResult = "exact" | "partial" | "miss"`;
  `interface RestoredLayer { layer: CacheLayerId; result: LayerResult; restoredKey?: string }`;
  `interface SavedLayer { layer: CacheLayerId; saved: boolean; reason?: string; bytes: number }`;
  `restoreLayers(client: CacheClient, plans: LayerPlan[], log: LifecycleLog): Promise<RestoredLayer[]>`;
  `saveLayers(args: SaveArgs): Promise<SavedLayer[]>`;
  `interface LifecycleLog { info(message: string): void; warning(message: string): void }`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/cache/lifecycle.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { CacheClient } from "@/cache/client";
import { restoreLayers, saveLayers } from "@/cache/lifecycle";
import type { LayerPlan, LifecycleLog } from "@/cache/lifecycle";

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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cache/lifecycle.test.ts`

Expected: FAIL — `Cannot find module '@/cache/lifecycle'`.

- [ ] **Step 3: Write the implementation**

Create `src/cache/lifecycle.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { CacheClient } from "@rust-toolchain/cache/client";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";

/** Everything needed to restore or save one layer. */
export interface LayerPlan {
  layer: CacheLayerId;
  key: string;
  restoreKeys: string[];
  paths: string[];
}

/** `exact` means the key matched; `partial` means a restore-key prefix did. */
export type LayerResult = "exact" | "partial" | "miss";

export interface RestoredLayer {
  layer: CacheLayerId;
  result: LayerResult;
  restoredKey?: string;
}

export interface SavedLayer {
  layer: CacheLayerId;
  saved: boolean;
  reason?: string;
  bytes: number;
}

/** The logging surface, narrowed so tests need no `@actions/core`. */
export interface LifecycleLog {
  info: (message: string) => void;
  warning: (message: string) => void;
}

export interface SaveArgs {
  client: CacheClient;
  plans: LayerPlan[];
  restored: RestoredLayer[];
  budget: number;
  measure: (paths: string[]) => number;
  log: LifecycleLog;
}

/**
 * Restores every layer, concurrently, downgrading any failure to a miss.
 *
 * `@actions/cache` throws on service outages and reserved-key races. A job that
 * would otherwise succeed must not fail because a cache was unavailable, so
 * every failure becomes a warning and an ordinary miss.
 */
export async function restoreLayers(
  client: CacheClient,
  plans: LayerPlan[],
  log: LifecycleLog,
): Promise<RestoredLayer[]> {
  return Promise.all(
    plans.map(async (plan): Promise<RestoredLayer> => {
      try {
        const restoredKey = await client.restore(
          plan.paths,
          plan.key,
          plan.restoreKeys,
        );
        if (restoredKey === undefined) {
          log.info(`${plan.layer}: no cache entry matched ${plan.key}`);
          return { layer: plan.layer, result: "miss" };
        }
        const result: LayerResult =
          restoredKey === plan.key ? "exact" : "partial";
        log.info(`${plan.layer}: ${result} match on ${restoredKey}`);
        return { layer: plan.layer, result, restoredKey };
      } catch (error) {
        log.warning(
          `${plan.layer}: restore failed, continuing without it — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return { layer: plan.layer, result: "miss" };
      }
    }),
  );
}

/**
 * Saves the layers worth saving.
 *
 * Two reasons to skip. An exact hit means the entry already exists under that
 * key, so writing it again is pure budget burn — the optimisation the layer
 * split makes safe, because a per-layer key covers everything that could have
 * changed its contents. Over budget means saving would evict other workflows'
 * caches, which is a cost paid by someone who did nothing wrong.
 */
export async function saveLayers(args: SaveArgs): Promise<SavedLayer[]> {
  const { client, plans, restored, budget, measure, log } = args;

  return Promise.all(
    plans.map(async (plan): Promise<SavedLayer> => {
      const previous = restored.find((entry) => entry.layer === plan.layer);
      if (previous?.result === "exact") {
        log.info(`${plan.layer}: unchanged since an exact hit, not saving`);
        return {
          layer: plan.layer,
          saved: false,
          reason: "unchanged since an exact hit",
          bytes: 0,
        };
      }

      const bytes = measure(plan.paths);
      if (budget > 0 && bytes > budget) {
        log.warning(
          `${plan.layer}: ${bytes} bytes exceeds the ${budget}-byte ` +
            "`cache-budget`, so it was not saved. An oversized entry evicts " +
            "other workflows' caches. Raise `cache-budget` to keep it.",
        );
        return {
          layer: plan.layer,
          saved: false,
          reason: `over the ${budget}-byte budget`,
          bytes,
        };
      }

      try {
        await client.save(plan.paths, plan.key);
        log.info(`${plan.layer}: saved ${bytes} bytes as ${plan.key}`);
        return { layer: plan.layer, saved: true, bytes };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warning(`${plan.layer}: save failed, continuing — ${message}`);
        return { layer: plan.layer, saved: false, reason: message, bytes };
      }
    }),
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test src/cache/lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 5: Update the barrel and pinned list**

Add `export * from "@rust-toolchain/cache/lifecycle";` to `src/lib.ts` (after
`cache/layers`), add `"restoreLayers"` and `"saveLayers"` to `src/lib.test.ts`
under a `// cache/lifecycle.ts` comment, and bump thirteen to fourteen.

- [ ] **Step 6: Run the full suite and commit**

Run: `bun run fix:all && bun run typecheck && bun run test`

```bash
git add src/cache/lifecycle.ts src/cache/lifecycle.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): orchestrate per-layer restore and save"
```

---

### Task 6: Inputs, outputs, summary and the action surface

**Files:**

- Create: `src/cache/summary.ts`, `src/cache/summary.test.ts`
- Modify: `src/cache/inputs.ts` — read `cache-workspaces` and `cache-budget`
- Modify: `src/cache/inputs.test.ts`
- Modify: `src/outputs.ts`, `src/outputs.test.ts` — per-layer result and bytes, `cache-hit`
- Modify: `action.yml` — `post:`, `post-if:`, `cache-workspaces`, `cache-budget`, `cache-hit`
- Modify: `src/lib.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: `RestoredLayer`, `SavedLayer` (Task 5); `parseSize` (Task 3); `parseWorkspaces` (Task 2).
- Produces: `renderSummary(restored: RestoredLayer[], saved: SavedLayer[]): string`;
  `CacheRequest` gains `workspaces: Workspace[]` and `budget: number`;
  `CacheLayerKey` output gains `result` and `bytes`.

**Steps:**

- [ ] **Step 1: Write the failing summary test**

Create `src/cache/summary.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { renderSummary } from "@/cache/summary";

describe("renderSummary", () => {
  it("renders one row per layer with its result and size", () => {
    const table = renderSummary(
      [
        { layer: "registry", result: "exact", restoredKey: "registry-a1" },
        { layer: "build", result: "miss" },
      ],
      [
        {
          layer: "registry",
          saved: false,
          reason: "unchanged since an exact hit",
          bytes: 0,
        },
        { layer: "build", saved: true, bytes: 2048 },
      ],
    );

    expect(table).toContain(
      "| registry | exact | unchanged since an exact hit |",
    );
    expect(table).toContain("| build | miss |");
    expect(table).toContain("2048");
  });

  // A restore-only run is a normal outcome, not an absence of one, so it must
  // still report what it restored rather than rendering nothing.
  it("renders rows even when nothing was saved", () => {
    const table = renderSummary(
      [{ layer: "registry", result: "partial", restoredKey: "registry-" }],
      [],
    );
    expect(table).toContain("| registry | partial |");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test src/cache/summary.test.ts`

Expected: FAIL — `Cannot find module '@/cache/summary'`.

- [ ] **Step 3: Write the summary**

Create `src/cache/summary.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type {
  RestoredLayer,
  SavedLayer,
} from "@rust-toolchain/cache/lifecycle";

/**
 * Renders the per-layer outcome as a Markdown table.
 *
 * Without this a cold run and a broken key look identical: both report a miss
 * and nothing else. Naming the result, the reason a save was skipped and the
 * bytes involved is what separates them.
 */
export function renderSummary(
  restored: RestoredLayer[],
  saved: SavedLayer[],
): string {
  const rows = restored.map((entry) => {
    const outcome = saved.find((item) => item.layer === entry.layer);
    const note = outcome?.saved
      ? `saved ${outcome.bytes} bytes`
      : (outcome?.reason ?? "not saved");
    return `| ${entry.layer} | ${entry.result} | ${note} |`;
  });

  return ["| Layer | Result | Save |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}
```

- [ ] **Step 4: Verify it passes**

Run: `bun test src/cache/summary.test.ts` → PASS.

- [ ] **Step 5: Read the two new inputs**

In `src/cache/inputs.ts`, import `parseSize` from `@rust-toolchain/cache/budget`
and `parseWorkspaces` from `@rust-toolchain/cache/paths`, extend `CacheRequest`:

```ts
export interface CacheRequest {
  layers: CacheLayerId[];
  context: PendingCacheKeyContext;
  workspaces: Workspace[];
  budget: number;
}
```

and populate both in `readCacheRequest`, before the key-length loop:

```ts
const workspaces = parseWorkspaces(
  source.getInput("cache-workspaces").trim() || ". -> target",
  (source.env.GITHUB_WORKSPACE ?? "").trim() || ".",
);
const budget = parseSize(source.getInput("cache-budget"));
```

Return them alongside the existing fields. Add tests to
`src/cache/inputs.test.ts` covering the defaults, an explicit multi-workspace
value, and that an unparseable `cache-budget` throws.

- [ ] **Step 6: Extend the outputs**

In `src/outputs.ts`, add the two fields to the per-layer shape and a top-level
flag:

```ts
export interface CacheLayerOutput extends CacheLayerKey {
  /** Absent until the layer has been restored — Phase A emitted keys only. */
  result?: LayerResult;
  /** Bytes measured for the save decision; `0` when nothing was measured. */
  bytes?: number;
}
```

Add `"cache-hit": boolean` to `ActionOutputs` and to `toOutputEntries` as
`["cache-hit", String(outputs["cache-hit"])]`, placed after `set-rustup-toolchain`
and before `cache`. `buildActionOutputs` takes it from a new
`cacheHit: boolean` field on `ActionOutputsArgs`. Extend `src/outputs.test.ts`
to cover a true and a false case and the flat entry.

- [ ] **Step 7: Declare the action surface**

In `action.yml`, change the `runs` block:

```yaml
runs:
  using: "node24"
  main: "dist/index.js"
  post: "dist/index.js"
  post-if: "success() || env.RUST_TOOLCHAIN_CACHE_ON_FAILURE == 'true'"
```

Add two inputs after `cache-layers`:

```yaml
cache-workspaces:
  description: >
    Cargo workspaces to cache build artifacts for, one
    `<manifest-dir> -> <target-dir>` mapping per line. Both sides resolve
    against the workspace root, and a mapping resolving outside it is
    rejected. Matches the syntax Swatinem/rust-cache uses, so an existing
    value transfers unchanged.
  required: false
  default: ". -> target"

cache-budget:
  description: >
    Largest cache entry to save per layer, as a byte count with an optional
    K, M, G or T suffix; binary rather than decimal. A layer exceeding it is
    not saved, and the step warns with the measured size. Set to 0 to
    disable. Defaults to 2GB because an oversized entry does not degrade its
    own hit rate — it evicts other workflows' caches out of the repository's
    shared budget.
  required: false
  default: "2GB"

cache-on-failure:
  description: >
    Whether to save the cache when the job failed (default false). A failed
    job usually has a partial or poisoned `target/`, so saving it by default
    would serve those artifacts to the next run. Turn it on for a long build
    that fails late and would otherwise restart from nothing.
  required: false
  default: "false"
```

`cache-on-failure` is what `post-if` reads, indirectly. The `inputs` context is
unavailable in `post-if`, so the main phase exports its value as
`RUST_TOOLCHAIN_CACHE_ON_FAILURE` and the gate tests the environment variable
instead. Declaring the input without exporting it would leave the post step
running only on success, silently ignoring the input.

And one output after `cache`:

```yaml
cache-hit:
  description: >
    `true` only when every enabled cache layer matched its exact key. A
    partial match through a restore key counts as false, because the layer
    will be saved again under the new key.
```

- [ ] **Step 8: Update the barrel, run the suite, commit**

Add `export * from "@rust-toolchain/cache/summary";` to `src/lib.ts`, add
`"renderSummary"` to the pinned list, bump fourteen to fifteen.

Run: `bun run fix:all && bun run typecheck && bun run test`

```bash
git add src/cache/summary.ts src/cache/summary.test.ts src/cache/inputs.ts src/cache/inputs.test.ts \
        src/outputs.ts src/outputs.test.ts action.yml src/lib.ts src/lib.test.ts
git commit -S -m "feat(cache): add the lifecycle inputs, outputs and job summary"
```

---

### Task 7: Wire the lifecycle into the action

**Files:**

- Modify: `src/action.ts` — `run` becomes async, restores, saves state; add `runPost`
- Modify: `src/action.test.ts`
- Modify: `src/index.ts` — branch on `STATE_isPost`, await, provide the adapter

**Interfaces:**

- Consumes: everything from Tasks 1–6.
- Produces: `run(deps: ActionDeps): Promise<void>`; `runPost(deps: PostDeps): Promise<void>`;
  `ActionDeps` gains `cache: CacheClient` and `core` gains `saveState`, `getState`, `warning`, `summary`.

**Steps:**

- [ ] **Step 1: Extend the harness, then write the failing test**

`src/action.test.ts` already defines `harness(options)` returning
`{ deps, calls, outputs, exported, failures, sleeps, paths, logs }`. Extend it
rather than adding a second harness — add `state: Record<string, string>`,
`warnings: string[]`, `summaries: string[]` and a `restores`/`saves` recorder,
and add to `deps`:

```ts
    cache: {
      restore: async (paths: string[], key: string, restoreKeys: string[]) => {
        restores.push({ paths, key, restoreKeys });
        return options.restoreResult?.(key);
      },
      save: async (paths: string[], key: string) => {
        saves.push({ paths, key });
      },
    },
```

and to `deps.core`:

```ts
      saveState: (name: string, value: string) => {
        state[name] = value;
      },
      getState: (name: string) => state[name] ?? "",
      warning: (message: string) => {
        warnings.push(message);
      },
      summary: {
        addRaw: (text: string) => ({
          write: async () => {
            summaries.push(text);
          },
        }),
      },
```

`options` gains `restoreResult?: (key: string) => string | undefined`.

**Every existing `run(h.deps)` call becomes `await run(h.deps)`**, and each
enclosing `it` callback becomes `async`. That is mechanical but touches every
test in the file; do it in one pass before adding new cases.

Then append:

```ts
describe("cache lifecycle", () => {
  const withCache = {
    toolchain: "stable",
    cache: "true",
    "cache-key-hash": "a1b2c3",
    "cache-key-suffix": "ci",
  };

  it("restores every enabled layer with its derived key and paths", async () => {
    const h = harness({ inputs: withCache, env: cacheEnv });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.restores.map((r) => r.key)).toEqual([
      expect.stringContaining("registry-Linux-X64-ci-"),
      expect.stringContaining("build-Linux-X64-ci-"),
    ]);
    // The registry layer never carries the toolchain digest.
    expect(h.restores[0]?.paths.join("\n")).toContain("registry/index");
    expect(h.restores[1]?.paths.join("\n")).toContain("target");
  });

  it("hands the post phase everything it needs through state", async () => {
    const h = harness({ inputs: withCache, env: cacheEnv });
    await run(h.deps);

    expect(h.state["isPost"]).toBe("true");
    const handoff = JSON.parse(h.state["cache"] ?? "null");
    expect(handoff.plans).toHaveLength(2);
    expect(handoff.restored).toHaveLength(2);
    expect(typeof handoff.budget).toBe("number");
  });

  // A partial match means the layer will be saved again under the new key, so
  // it is not a hit from the caller's point of view.
  it("reports cache-hit only when every layer matched exactly", async () => {
    const exact = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) => key,
    });
    await run(exact.deps);
    expect(exact.outputs["cache-hit"]).toBe("true");

    const partial = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) =>
        key.startsWith("registry") ? key : "build-older",
    });
    await run(partial.deps);
    expect(partial.outputs["cache-hit"]).toBe("false");
  });

  it("neither restores nor saves state when cache is unset", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(h.restores).toEqual([]);
    expect(h.state["isPost"]).toBe(undefined);
  });
});

describe("runPost", () => {
  const postDeps = (
    state: Record<string, string>,
  ): { deps: PostDeps; saves: { key: string }[]; summaries: string[] } => {
    const saves: { key: string }[] = [];
    const summaries: string[] = [];
    return {
      saves,
      summaries,
      deps: {
        cache: {
          restore: async () => undefined,
          save: async (_paths, key) => {
            saves.push({ key });
          },
        },
        core: {
          getState: (name) => state[name] ?? "",
          info: () => {},
          warning: () => {},
          summary: {
            addRaw: (text: string) => ({
              write: async () => {
                summaries.push(text);
              },
            }),
          },
        },
        measure: () => 128,
      },
    };
  };

  it("does nothing when the main phase never enabled caching", async () => {
    const { deps, saves, summaries } = postDeps({});
    await runPost(deps);
    expect(saves).toEqual([]);
    expect(summaries).toEqual([]);
  });

  it("saves the layers that did not hit exactly and writes the summary", async () => {
    const { deps, saves, summaries } = postDeps({
      cache: JSON.stringify({
        budget: 0,
        plans: [
          {
            layer: "registry",
            key: "registry-k",
            restoreKeys: [],
            paths: ["/c"],
          },
          { layer: "build", key: "build-k", restoreKeys: [], paths: ["/t"] },
        ],
        restored: [
          { layer: "registry", result: "exact", restoredKey: "registry-k" },
          { layer: "build", result: "miss" },
        ],
      }),
    });

    await runPost(deps);

    expect(saves.map((s) => s.key)).toEqual(["build-k"]);
    expect(summaries[0]).toContain("| registry | exact |");
    expect(summaries[0]).toContain("| build | miss |");
  });
});
```

`cacheEnv` already exists in the file from Phase A; reuse it. Import `runPost`
and `type PostDeps` alongside `run`.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test src/action.test.ts`

Expected: FAIL — `run(...)` returns `undefined`, not a promise, and `runPost` is
not exported.

- [ ] **Step 3: Make `run` async and restore**

In `src/action.ts`: change the signature to
`export async function run(deps: ActionDeps): Promise<void>`; add
`cache: CacheClient` to `ActionDeps`; add `saveState`, `getState`, `warning` and
`summary: { addRaw(text: string): { write(): Promise<unknown> } }` to
`ActionDeps["core"]`.

After the outputs are computed, when `cacheRequest` is defined, build the
`LayerPlan[]` from the derived keys plus `registryPaths(rustupEnv.CARGO_HOME)`
and `buildPaths(cacheRequest.workspaces)`, call `restoreLayers`, fold each
layer's `result` into the `cache` output, set `cache-hit`, then
`deps.core.saveState("isPost", "true")` and
`deps.core.saveState("cache", JSON.stringify({ plans, restored, budget }))`.

Export `RUST_TOOLCHAIN_CACHE_ON_FAILURE` from the `cache-on-failure` input so
`post-if` can read it.

- [ ] **Step 4: Add the post phase**

Add to `src/action.ts`:

```ts
/** The post phase's dependencies — a subset of the main phase's. */
export interface PostDeps {
  cache: CacheClient;
  core: Pick<ActionDeps["core"], "getState" | "info" | "warning" | "summary">;
  measure: (paths: string[]) => number;
}

/**
 * Saves the layers the main phase restored.
 *
 * Runs from `action.yml`'s `post:`, so it sees none of the main phase's
 * locals — everything it needs crossed the boundary through `saveState`.
 */
export async function runPost(deps: PostDeps): Promise<void> {
  const raw = deps.core.getState("cache");
  if (!raw) return;

  const { plans, restored, budget } = JSON.parse(raw) as {
    plans: LayerPlan[];
    restored: RestoredLayer[];
    budget: number;
  };

  const saved = await saveLayers({
    client: deps.cache,
    plans,
    restored,
    budget,
    measure: deps.measure,
    log: { info: deps.core.info, warning: deps.core.warning },
  });

  await deps.core.summary.addRaw(renderSummary(restored, saved)).write();
}
```

- [ ] **Step 5: Verify the tests pass**

Run: `bun test src/action.test.ts` → PASS.

- [ ] **Step 6: Wire `src/index.ts`**

Replace the top-level `run({...})` call with a phase branch, the real
`@actions/cache` adapter and a real measurement function. This file is
dependency wiring only and is invisible to the coverage gate, which is why the
adapter belongs here:

```ts
import * as cache from "@actions/cache";
import { readdirSync, statSync } from "node:fs";

import { run, runPost } from "@rust-toolchain/action";
import { measurePaths } from "@rust-toolchain/cache/budget";

const client = {
  restore: (paths: string[], key: string, restoreKeys: string[]) =>
    cache.restoreCache(paths.slice(), key, restoreKeys.slice()),
  save: async (paths: string[], key: string): Promise<void> => {
    await cache.saveCache(paths.slice(), key);
  },
};

const fs = {
  readdir: (dir: string): string[] => readdirSync(dir),
  stat: (path: string) => statSync(path),
};

// GitHub sets STATE_isPost once the main phase has called saveState("isPost").
if (process.env.STATE_isPost === "true") {
  await runPost({
    cache: client,
    core: { getState, info, warning, summary },
    measure: (paths) => measurePaths(paths, fs),
  });
} else {
  await run({ /* existing wiring */, cache: client });
}
```

Add `getState`, `saveState`, `warning` and `summary` to the `@actions/core`
import, and `await` the existing `run` call. The synchronous `sleep` using
`Atomics.wait` can stay — `exec` is still `spawnSync` — but note in a comment
that it no longer _has_ to be synchronous.

- [ ] **Step 7: Run the full suite and commit**

Run: `bun run fix:all && bun run typecheck && bun run test`

```bash
git add src/action.ts src/action.test.ts src/index.ts
git commit -S -m "feat(cache): restore on main and save from the post step"
```

---

### Task 8: Documentation, bundle and end-to-end proof

**Files:**

- Modify: `README.md`, `docs/COMPARISON.md`, `docs/ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`
- Modify: `.github/workflows/cicd.yml` — E2E asserts a warm second run
- Modify: `dist/index.js`

**Interfaces:**

- Consumes: everything.
- Produces: nothing.

**Steps:**

- [ ] **Step 1: Prove the cache round-trips in CI**

In `cicd.yml`'s `e2e` job, after the existing assertions, add a second
invocation of the action in the same job with identical inputs and a different
step id, then assert the second run reports `cache-hit == 'true'` for the
registry layer. This is the only place restore and save meet the real cache
service.

Also assert the saved entry honoured the negation globs, by checking that the
second run's restored `target/` contains no `incremental` directory:

```yaml
- name: Verify The Cache Round-Trips
  shell: bash
  env:
    FIRST: ${{ steps.rust-toolchain.outputs.cache }}
    SECOND: ${{ steps.rust-toolchain-warm.outputs.cache }}
    WARM_HIT: ${{ steps.rust-toolchain-warm.outputs.cache-hit }}
  run: |
    set -eo pipefail
    echo "cold: $FIRST"
    echo "warm: $SECOND"
    echo "warm cache-hit: $WARM_HIT"
    if [[ -d target ]] && find target -type d -name incremental | grep -q .; then
      echo "::error::an incremental directory survived into the restored cache"
      exit 1
    fi
```

- [ ] **Step 2: Update the README**

Change the `Swatinem/rust-cache` row in both replacement matrices from
`◐ Keys today · restore/save in Phase B` to `✅ Replaced`, likewise
`actions-rust-lang/setup-rust-toolchain` and `moonrepo/setup-rust` for their
caching halves. Move Phase B from `Planned` to `✅ Released` in the Roadmap.
Replace the "Deriving cargo cache keys" recipe with a `cache: true` example that
needs no `actions/cache` step at all, keeping the key-only recipe below it for
anyone who wants to wire caching themselves. Add `cache-workspaces`,
`cache-budget` and `cache-hit` to the prose. State plainly that `run` is now
async, and that the `build` key changed so the first run after upgrading is
cold.

- [ ] **Step 3: Update the other docs**

`docs/COMPARISON.md`: the same matrix rows, and rewrite "Against
Swatinem/rust-cache" so the "Addressed by" column names shipped behaviour rather
than a future phase. `docs/ARCHITECTURE.md`: the lifecycle, the two entrypoints
and the state handoff. `AGENTS.md`: the six new modules in the source layout.
`CLAUDE.md`: add to Cache invariants — the `@actions/cache` adapter lives in
`index.ts` because that file is invisible to the coverage gate; a cache failure
warns and never fails the build; exclusions are negation globs, never deletion.

- [ ] **Step 4: Regenerate and rebuild**

```bash
mise run readme && bun run fix:all && bun run build
```

Confirm both `action-docs-all` markers still carry `source`, `project` and
`version`, and record the final `wc -c dist/index.js` in the commit message.

- [ ] **Step 5: Run every gate**

Run: `bun run fix:all && bun run typecheck && bun run test && bun run build && hk check --all`

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ AGENTS.md CLAUDE.md .github/workflows/cicd.yml dist/index.js
git commit -S -m "docs(cache): document the cache lifecycle and rebuild the bundle"
```

---

## Phase B completion check

- [ ] `bun run test` passes at 100% lines, functions and statements.
- [ ] `hk check --all` is clean.
- [ ] `git diff --exit-code dist/` is clean after `bun run build`.
- [ ] `action.yml` declares `post:`, `post-if:`, `cache-workspaces`, `cache-budget` and `cache-hit`.
- [ ] The CI `E2E` job proves a warm second run hits, on all three operating systems.
- [ ] A workflow using `cache: true` needs no `Swatinem/rust-cache` and no `actions/cache` step.

## Carried into Phase C

- The `bin` layer, `RUSTUP_SHIMS`, `hashToolSet` and the `cargo-tools` input.
- `parseCacheLayers`, the `DERIVERS` table, the `cache-layers` default in both `action.yml` and `readCacheRequest`,
  and the `CACHE_LAYER_IDS` assertion in `src/cache/layers.test.ts` all widen together.
- `cache-key-hash` is currently required whenever caching is on. Phase C must narrow it to the `registry` and `build`
  layers, since a workflow enabling only `bin` has no lockfile component to miss.

## Carried into Phase D

- Deterministic pruning from `cargo metadata` replaces Phase B's negation globs. The `!.../incremental` and
  `!.../examples` exclusions become the trivial cases of a keep-set.
- Once pruning lands, revisit the `2GB` default: it exists because Phase B saves more than it eventually will.
