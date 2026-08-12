<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# MSRV Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the action to read `rust-version`, verify the installed toolchain against the locked dependency
graph's effective MSRV, and publish both numbers as outputs.

**Architecture:** A new `src/msrv.ts` of pure functions holds every decision — version parsing, comparison, manifest
reading, graph aggregation, policy application — so `src/action.ts` only wires I/O to them. Phase 1 (channel
fallback) parses the workspace-root `Cargo.toml` with `smol-toml` before any toolchain exists; Phase 2 (the check)
reads `cargo metadata --format-version 1 --locked` after the install, which requires wiring the existing
`MetadataReader` port into `run`'s `ActionDeps` for the first time.

**Tech Stack:** TypeScript (strict), Bun test runner, `smol-toml`, `@actions/core`.

**Design:** `docs/content/design/2026-08-12-msrv-awareness.md`

## Global Constraints

- **TDD is mandatory.** Write the failing test, watch it fail, write minimal code, watch it pass. Every task below
  is ordered that way; do not reorder.
- **100% line/function/statement coverage** for everything under `src/`, enforced by `bunfig.toml`. `bun run test`
  fails below it.
- **No `switch` whose `case` bodies are braced blocks that return.** Bun 1.3.14 loses coverage on the last case's
  closing brace and phantom-fails the gate. Use a lookup object keyed by the union, as `src/cache/keys.ts` does with
  `DERIVERS`, or a plain `if` chain.
- **Library source imports siblings as `@rust-toolchain/<module>`**, never `./<module>` and never `@/<module>`. The
  `@/` alias is tests only.
- **`src/lib.ts` is the barrel and `src/lib.test.ts` asserts the complete export list.** Adding a public function
  breaks that test until both are updated, so every task that adds one updates both in the same commit.
- **`dist/` is committed.** CI runs `git diff --exit-code dist/`. Any task touching `src/` must end with
  `bun run build` and commit `dist/index.js` alongside.
- **Commits are GPG-signed** (`git commit -S`), Conventional Commits, scope from the enum in `commitlint.config.cjs`.
  **Never add a `Co-Authored-By` trailer.**
- **Defaults are fixed:** `msrv-fallback` is `false`, `msrv-check` is `warn`. Do not change them.
- **Inputs and outputs are kebab-case**, matching every existing name in `action.yml`.

---

### Task 1: Version primitives and policy parsing

**Files:**

- Create: `src/msrv.ts`
- Modify: `src/lib.ts`
- Test: `src/msrv.test.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface Version { major: number; minor: number; patch: number }`;
  `parseVersion(value: string): Version | undefined`; `compareVersions(a: Version, b: Version): number`;
  `type MsrvPolicy = "off" | "warn" | "error"`; `parseMsrvPolicy(value: string): MsrvPolicy`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/msrv.test.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { compareVersions, parseMsrvPolicy, parseVersion } from "@/msrv";

describe("parseVersion", () => {
  it("reads a two-component version, defaulting the patch", () => {
    expect(parseVersion("1.88")).toEqual({ major: 1, minor: 88, patch: 0 });
  });

  it("reads a three-component version", () => {
    expect(parseVersion("1.88.1")).toEqual({ major: 1, minor: 88, patch: 1 });
  });

  // rustc on nightly reports "1.99.0-nightly"; the suffix is not part of the
  // number and must not make the whole value unreadable.
  it("ignores a pre-release suffix", () => {
    expect(parseVersion("1.99.0-nightly")).toEqual({
      major: 1,
      minor: 99,
      patch: 0,
    });
  });

  it("returns undefined for a value that is not a version", () => {
    expect(parseVersion("stable")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("1")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  // The whole reason this is not a string comparison: "1.9" > "1.10"
  // lexically, and the opposite numerically.
  it("orders 1.9 below 1.10", () => {
    const a = parseVersion("1.9");
    const b = parseVersion("1.10");
    expect(a && b && compareVersions(a, b)).toBeLessThan(0);
  });

  it("returns zero for equal versions", () => {
    const a = parseVersion("1.88.0");
    const b = parseVersion("1.88");
    expect(a && b && compareVersions(a, b)).toBe(0);
  });

  it("orders by patch when major and minor match", () => {
    const a = parseVersion("1.88.2");
    const b = parseVersion("1.88.1");
    expect(a && b && compareVersions(a, b)).toBeGreaterThan(0);
  });

  it("orders by major first", () => {
    const a = parseVersion("2.0.0");
    const b = parseVersion("1.99.99");
    expect(a && b && compareVersions(a, b)).toBeGreaterThan(0);
  });
});

describe("parseMsrvPolicy", () => {
  it("defaults an empty input to warn", () => {
    expect(parseMsrvPolicy("")).toBe("warn");
  });

  it("accepts each policy, case-insensitively and trimmed", () => {
    expect(parseMsrvPolicy("off")).toBe("off");
    expect(parseMsrvPolicy(" WARN ")).toBe("warn");
    expect(parseMsrvPolicy("Error")).toBe("error");
  });

  it("rejects anything else by name", () => {
    expect(() => parseMsrvPolicy("strict")).toThrow(
      "`msrv-check` is `strict`, which is not a policy. Valid values are off, warn, error.",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/msrv.test.ts`
Expected: FAIL with `Cannot find module '@/msrv'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/msrv.ts`:

```ts
// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/** A Rust version as three numbers, with the pre-release suffix discarded. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** `1.88`, `1.88.1`, or either with a `-nightly`-style suffix. */
const VERSION = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/;

/**
 * Reads a Rust version, or `undefined` when the value is not one.
 *
 * `undefined` rather than a throw: `rust_version` reaches this from crates
 * nobody here controls, and one unreadable value must not fail a job. The
 * caller skips what it cannot read.
 *
 * The pre-release suffix is dropped because `rustc --version` reports
 * `1.99.0-nightly` on nightly, and the channel is not part of the ordering.
 */
export function parseVersion(value: string): Version | undefined {
  const match = value.trim().match(VERSION);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/**
 * Orders two versions numerically: negative when `a` precedes `b`.
 *
 * Never compare these as strings — `"1.9"` sorts *above* `"1.10"`
 * lexically and below it numerically, which is the whole reason this exists.
 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** What `msrv-check` does when the installed toolchain is too old. */
export type MsrvPolicy = "off" | "warn" | "error";

const POLICIES: Record<MsrvPolicy, true> = {
  off: true,
  warn: true,
  error: true,
};

const DEFAULT_POLICY: MsrvPolicy = "warn";

/**
 * Reads the `msrv-check` input.
 *
 * `warn` by default: the effective MSRV depends on the dependency graph, so a
 * `cargo update` can raise it without the repository changing. Failing by
 * default would turn an unrelated bump into a red build.
 */
export function parseMsrvPolicy(value: string): MsrvPolicy {
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return DEFAULT_POLICY;
  if (Object.hasOwn(POLICIES, normalised)) return normalised as MsrvPolicy;
  throw new Error(
    `\`msrv-check\` is \`${value.trim()}\`, which is not a policy. ` +
      `Valid values are off, warn, error.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/msrv.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Add the module to the barrel**

In `src/lib.ts`, add alongside the other exports, keeping alphabetical position among the top-level modules:

```ts
export * from "@rust-toolchain/msrv";
```

In `src/lib.test.ts`, the assertion lists every export with a `// <module>.ts` comment above each group. Add:

```ts
        // msrv.ts
        "parseVersion",
        "compareVersions",
        "parseMsrvPolicy",
```

Update the `it(...)` title from `"exposes every value export of the twenty-one library modules"` to
`"exposes every value export of the twenty-two library modules"`.

- [ ] **Step 6: Run the full suite and the type-checker**

Run: `bun run typecheck && bun run test`
Expected: PASS, coverage 100%.

- [ ] **Step 7: Commit**

```bash
git add src/msrv.ts src/msrv.test.ts src/lib.ts src/lib.test.ts
git commit -S -m "feat(config): add version comparison and msrv-check policy parsing

Numeric comparison, never lexical: \"1.9\" sorts above \"1.10\" as a string
and below it as a version. parseVersion returns undefined rather than
throwing, because rust_version arrives from crates nobody here controls and
one unreadable value must not fail a job."
```

---

### Task 2: Read `rust-version` from a Cargo manifest

**Files:**

- Modify: `src/msrv.ts`, `src/lib.ts`
- Test: `src/msrv.test.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1 at runtime; same module.
- Produces: `type MsrvSource = "cargo-toml" | "workspace-inherit" | "none"`;
  `interface ManifestMsrv { rustVersion?: string; source: MsrvSource }`;
  `parseCargoManifest(contents: string): ManifestMsrv`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/msrv.test.ts`, and add `parseCargoManifest` to the import from `@/msrv`:

```ts
describe("parseCargoManifest", () => {
  it("reads rust-version from [package]", () => {
    expect(
      parseCargoManifest('[package]\nname = "x"\nrust-version = "1.88"\n'),
    ).toEqual({ rustVersion: "1.88", source: "cargo-toml" });
  });

  // A virtual manifest has no [package]; the value lives under
  // [workspace.package] and is inherited by members.
  it("reads rust-version from [workspace.package]", () => {
    expect(
      parseCargoManifest('[workspace.package]\nrust-version = "1.75"\n'),
    ).toEqual({ rustVersion: "1.75", source: "workspace-inherit" });
  });

  // THE trap: a member writes `rust-version.workspace = true`, and a naive
  // read returns the object { workspace: true } instead of a version.
  it("resolves an inheriting member against the workspace table", () => {
    const toml = [
      "[workspace.package]",
      'rust-version = "1.75"',
      "",
      "[package]",
      'name = "x"',
      "rust-version.workspace = true",
    ].join("\n");
    expect(parseCargoManifest(toml)).toEqual({
      rustVersion: "1.75",
      source: "workspace-inherit",
    });
  });

  it("reports none when the member inherits but no workspace value exists", () => {
    const toml = '[package]\nname = "x"\nrust-version.workspace = true\n';
    expect(parseCargoManifest(toml)).toEqual({ source: "none" });
  });

  it("reports none when nothing declares a rust-version", () => {
    expect(parseCargoManifest('[package]\nname = "x"\n')).toEqual({
      source: "none",
    });
  });

  // The single-crate-workspace layout: [package] and [workspace] in one file.
  // Cargo does NOT inherit here — the member never opted in — so neither do
  // we. Reporting 1.75 would claim an MSRV the crate does not declare, and
  // under `msrv-fallback: true` would install it.
  it("does not inherit into a package that did not opt in", () => {
    const toml = [
      "[workspace.package]",
      'rust-version = "1.75"',
      "",
      "[package]",
      'name = "root-crate"',
    ].join("\n");
    expect(parseCargoManifest(toml)).toEqual({ source: "none" });
  });

  it("reports none for an empty manifest", () => {
    expect(parseCargoManifest("")).toEqual({ source: "none" });
  });

  // Loud, matching parseRustToolchainToml: a syntax error hides the author's
  // intent, and guessing would install a toolchain nobody asked for.
  it("throws on invalid TOML", () => {
    expect(() => parseCargoManifest("[package")).toThrow(
      "Cargo.toml is not valid TOML",
    );
  });

  it("ignores a rust-version that is not a string", () => {
    expect(parseCargoManifest("[package]\nrust-version = 188\n")).toEqual({
      source: "none",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/msrv.test.ts`
Expected: FAIL with `parseCargoManifest is not a function` (or an import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/msrv.ts`, adding these imports at the top of the file:

```ts
import { parse } from "smol-toml";

import { describeError } from "@rust-toolchain/errors";
```

```ts
/** Where a resolved `rust-version` came from. */
export type MsrvSource = "cargo-toml" | "workspace-inherit" | "none";

/** A manifest's declared MSRV, with its provenance. */
export interface ManifestMsrv {
  rustVersion?: string;
  source: MsrvSource;
}

const NONE: ManifestMsrv = { source: "none" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The string at `<table>.rust-version`, or undefined when absent or typed wrong. */
function declaredVersion(table: unknown): string | undefined {
  if (!isRecord(table)) return undefined;
  const value = table["rust-version"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** True for `rust-version.workspace = true`, cargo's inheritance marker. */
function inherits(table: unknown): boolean {
  if (!isRecord(table)) return false;
  const value = table["rust-version"];
  return isRecord(value) && value.workspace === true;
}

/**
 * Reads a `Cargo.toml`'s MSRV, resolving workspace inheritance.
 *
 * Three shapes matter. `[package] rust-version` is the plain case. A virtual
 * manifest has no `[package]` and declares `[workspace.package] rust-version`.
 * A member writes `rust-version.workspace = true`, which parses to the OBJECT
 * `{ workspace: true }` — read naively that is not a version at all, and it is
 * the one trap in this function.
 *
 * Throws on malformed TOML rather than guessing, matching
 * `parseRustToolchainToml`: a syntax error hides the author's intent, and
 * falling back would install a toolchain nobody asked for.
 */
export function parseCargoManifest(contents: string): ManifestMsrv {
  if (!contents.trim()) return NONE;

  let document: unknown;
  try {
    document = parse(contents);
  } catch (error) {
    throw new Error(`Cargo.toml is not valid TOML: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(document)) return NONE;

  const workspacePackage = isRecord(document.workspace)
    ? document.workspace.package
    : undefined;
  const workspaceVersion = declaredVersion(workspacePackage);

  const own = declaredVersion(document.package);
  if (own !== undefined) return { rustVersion: own, source: "cargo-toml" };

  // Inheritance is opt-in, and that is the whole subtlety. Cargo hands a
  // member the workspace value ONLY when it writes
  // `rust-version.workspace = true`; a `[package]` that simply omits the key
  // has no MSRV, even with `[workspace.package]` sitting in the same file.
  // A virtual manifest is the other case — no `[package]` at all, so the
  // workspace table IS the declaration rather than something inherited.
  //
  // Falling back to the workspace value unconditionally would report an MSRV
  // the crate does not have, and under `msrv-fallback: true` would install a
  // toolchain cargo never asked for.
  const inheritable = !isRecord(document.package) || inherits(document.package);
  if (inheritable && workspaceVersion !== undefined) {
    return { rustVersion: workspaceVersion, source: "workspace-inherit" };
  }
  return NONE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/msrv.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Update the barrel and its test**

In `src/lib.test.ts`, add under the `// msrv.ts` group:

```ts
        "parseCargoManifest",
```

`src/lib.ts` already re-exports the module, so no change there.

- [ ] **Step 6: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: PASS, coverage 100%.

- [ ] **Step 7: Commit**

```bash
git add src/msrv.ts src/msrv.test.ts src/lib.test.ts
git commit -S -m "feat(config): read rust-version from Cargo.toml with workspace inheritance

Three shapes: [package] rust-version, a virtual manifest's
[workspace.package] rust-version, and a member's rust-version.workspace =
true. The last parses to the object { workspace: true }, which read naively
is not a version at all."
```

---

### Task 3: Extract `rust_version` from `cargo metadata`

**Files:**

- Modify: `src/cache/metadata.ts:45-49` (the `RawPackage` interface), `src/lib.ts`
- Test: `src/cache/metadata.test.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface PackageMsrv { name: string; version: string; rustVersion: string }`;
  `parsePackageMsrv(json: string): PackageMsrv[]`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/cache/metadata.test.ts`, importing `parsePackageMsrv` from `@/cache/metadata`:

```ts
describe("parsePackageMsrv", () => {
  it("returns only packages that declare a rust_version", () => {
    const json = JSON.stringify({
      packages: [
        { id: "a", name: "alpha", version: "1.0.0", rust_version: "1.75" },
        { id: "b", name: "beta", version: "2.0.0" },
        { id: "c", name: "gamma", version: "3.0.0", rust_version: "1.95" },
      ],
    });
    expect(parsePackageMsrv(json)).toEqual([
      { name: "alpha", version: "1.0.0", rustVersion: "1.75" },
      { name: "gamma", version: "3.0.0", rustVersion: "1.95" },
    ]);
  });

  it("returns an empty list when no package declares one", () => {
    const json = JSON.stringify({
      packages: [{ id: "a", name: "alpha", version: "1.0.0" }],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  it("skips a rust_version that is not a string", () => {
    const json = JSON.stringify({
      packages: [{ id: "a", name: "alpha", version: "1.0.0", rust_version: 1 }],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  // Each guard needs its own input, or it is merely executed rather than
  // pinned: with every fixture carrying a valid `version`, the version guard
  // runs on every package and evaluates false every time, so deleting it
  // would not fail a single test while 100% line coverage still passed.
  it("skips a package whose version is missing or not a string", () => {
    const json = JSON.stringify({
      packages: [
        { id: "a", name: "alpha", rust_version: "1.75" },
        { id: "b", name: "beta", version: 2, rust_version: "1.80" },
        { id: "c", name: "gamma", version: "", rust_version: "1.85" },
      ],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  it("skips a package whose name is empty", () => {
    const json = JSON.stringify({
      packages: [{ id: "a", name: "", version: "1.0.0", rust_version: "1.75" }],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  it("skips an empty rust_version string", () => {
    const json = JSON.stringify({
      packages: [
        { id: "a", name: "alpha", version: "1.0.0", rust_version: "" },
      ],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  // Unlike parsePackageSet, this never throws on a half-formed entry: the
  // MSRV check is advisory, and a malformed package should cost its own
  // contribution, not the whole check.
  it("skips entries that are not objects or lack a name", () => {
    const json = JSON.stringify({
      packages: [null, { version: "1.0.0", rust_version: "1.75" }],
    });
    expect(parsePackageMsrv(json)).toEqual([]);
  });

  it("returns an empty list when packages is missing", () => {
    expect(parsePackageMsrv("{}")).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePackageMsrv("not json")).toThrow(
      "`cargo metadata` did not emit valid JSON",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cache/metadata.test.ts`
Expected: FAIL — `parsePackageMsrv` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/cache/metadata.ts`, extend `RawPackage`:

```ts
interface RawPackage {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  rust_version?: unknown;
}
```

Then append to the module:

```ts
/** A package's declared MSRV, named so a message can say who demands it. */
export interface PackageMsrv {
  name: string;
  version: string;
  rustVersion: string;
}

/**
 * Collects every declared `rust_version` in the resolved graph.
 *
 * Deliberately lenient where `parsePackageSet` is strict: that function's
 * output decides which files a cache archives, so a half-formed entry is a
 * real problem. This one only advises, so a malformed package costs its own
 * contribution rather than the whole check. The JSON itself must still parse —
 * unreadable output means the check could not run, which the caller reports
 * differently from a violation.
 */
export function parsePackageMsrv(json: string): PackageMsrv[] {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `\`cargo metadata\` did not emit valid JSON: ${describeError(error)}`,
      { cause: error },
    );
  }

  const raw = isRecord(document) ? document.packages : undefined;
  if (!Array.isArray(raw)) return [];

  const found: PackageMsrv[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { name, version, rust_version: rustVersion } = entry as RawPackage;
    if (typeof name !== "string" || name === "") continue;
    if (typeof version !== "string" || version === "") continue;
    if (typeof rustVersion !== "string" || rustVersion === "") continue;
    found.push({ name, version, rustVersion });
  }
  return found;
}
```

If `describeError` is not already imported in this module, add
`import { describeError } from "@rust-toolchain/errors";` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cache/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the barrel test**

In `src/lib.test.ts`, under the `// cache/metadata.ts` group, add:

```ts
        "parsePackageMsrv",
```

- [ ] **Step 6: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: PASS, coverage 100%.

- [ ] **Step 7: Commit**

```bash
git add src/cache/metadata.ts src/cache/metadata.test.ts src/lib.test.ts
git commit -S -m "feat(cache): collect rust_version from the cargo metadata graph

Lenient where parsePackageSet is strict. That function decides which files a
cache archives, so a half-formed entry matters; this one only advises, so a
malformed package costs its own contribution rather than the whole check."
```

---

### Task 4: Compute the effective MSRV and apply the policy

**Files:**

- Modify: `src/msrv.ts`, `src/lib.ts`
- Test: `src/msrv.test.ts`, `src/lib.test.ts`

**Interfaces:**

- Consumes: `Version`, `parseVersion`, `compareVersions`, `MsrvPolicy` (Task 1); `PackageMsrv` (Task 3).
- Produces: `interface MsrvRequirement { version: string; package: string }`;
  `effectiveMsrv(packages: PackageMsrv[]): MsrvRequirement | undefined`;
  `type MsrvVerdict = { kind: "ok" } | { kind: "skipped"; reason: string } | { kind: "violation"; installed: string; required: MsrvRequirement }`;
  `evaluateMsrv(installed: string, packages: PackageMsrv[]): MsrvVerdict`; `describeVerdict(verdict: MsrvVerdict): string`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/msrv.test.ts`, extending the `@/msrv` import with `describeVerdict`, `effectiveMsrv`, `evaluateMsrv`:

```ts
// The measured case that motivates walking the graph at all: cargo-binstall
// declares 1.79 while its locked graph needs 1.95.
const BINSTALL_GRAPH = [
  { name: "cargo-binstall", version: "1.21.1", rustVersion: "1.79" },
  { name: "fs-lock", version: "0.1.16", rustVersion: "1.89.0" },
  { name: "cargo-platform", version: "0.3.3", rustVersion: "1.91" },
  { name: "vergen", version: "10.0.1", rustVersion: "1.95.0" },
];

describe("effectiveMsrv", () => {
  it("returns the highest requirement and who demands it", () => {
    expect(effectiveMsrv(BINSTALL_GRAPH)).toEqual({
      version: "1.95.0",
      package: "vergen 10.0.1",
    });
  });

  it("returns undefined when nothing declares a version", () => {
    expect(effectiveMsrv([])).toBeUndefined();
  });

  it("ignores versions it cannot parse", () => {
    expect(
      effectiveMsrv([
        { name: "a", version: "1.0.0", rustVersion: "not-a-version" },
        { name: "b", version: "2.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({ version: "1.70", package: "b 2.0.0" });
  });

  it("returns undefined when no version is parseable", () => {
    expect(
      effectiveMsrv([{ name: "a", version: "1.0.0", rustVersion: "???" }]),
    ).toBeUndefined();
  });

  // Every other fixture here lists its highest requirement LAST, so the
  // max-tracking comparison in `bestRequirement` is executed by all of them
  // and pinned by none — delete it and each still passes. This one puts the
  // maximum first, so a later, lower entry must not displace it.
  it("keeps the maximum when a later entry declares a lower requirement", () => {
    expect(
      effectiveMsrv([
        { name: "high", version: "1.0.0", rustVersion: "1.95" },
        { name: "low", version: "2.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({ version: "1.95", package: "high 1.0.0" });
  });
});

describe("evaluateMsrv", () => {
  it("reports a violation naming the crate that demands it", () => {
    expect(evaluateMsrv("1.88.0", BINSTALL_GRAPH)).toEqual({
      kind: "violation",
      installed: "1.88.0",
      required: { version: "1.95.0", package: "vergen 10.0.1" },
    });
  });

  // `ok` carries the requirement it cleared, so the caller can publish
  // `msrv-effective` without recomputing the maximum.
  it("is ok when the installed toolchain meets the requirement", () => {
    expect(evaluateMsrv("1.97.1", BINSTALL_GRAPH)).toEqual({
      kind: "ok",
      required: { version: "1.95.0", package: "vergen 10.0.1" },
    });
  });

  it("is ok when the installed toolchain matches exactly", () => {
    expect(
      evaluateMsrv("1.70.0", [
        { name: "a", version: "1.0.0", rustVersion: "1.70" },
      ]),
    ).toEqual({
      kind: "ok",
      required: { version: "1.70", package: "a 1.0.0" },
    });
  });

  it("skips when no package declares a requirement", () => {
    expect(evaluateMsrv("1.88.0", [])).toEqual({
      kind: "skipped",
      reason: "no package in the graph declares a rust-version",
    });
  });

  it("skips when the installed version cannot be read", () => {
    expect(evaluateMsrv("", BINSTALL_GRAPH)).toEqual({
      kind: "skipped",
      reason: "the installed rustc version could not be read",
    });
  });
});

describe("describeVerdict", () => {
  it("names the crate, its requirement and what is installed", () => {
    expect(describeVerdict(evaluateMsrv("1.88.0", BINSTALL_GRAPH))).toBe(
      "vergen 10.0.1 requires rustc 1.95.0, but 1.88.0 is installed.",
    );
  });

  it("explains a skip", () => {
    expect(describeVerdict(evaluateMsrv("1.88.0", []))).toBe(
      "MSRV check skipped: no package in the graph declares a rust-version.",
    );
  });

  it("says nothing interesting when the check passed", () => {
    expect(
      describeVerdict({
        kind: "ok",
        required: { version: "1.95.0", package: "vergen 10.0.1" },
      }),
    ).toBe("The installed toolchain satisfies every declared rust-version.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/msrv.test.ts`
Expected: FAIL — `effectiveMsrv is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/msrv.ts`, adding the type import at the top:

```ts
import type { PackageMsrv } from "@rust-toolchain/cache/metadata";
```

```ts
/** The highest declared requirement, and the package that declares it. */
export interface MsrvRequirement {
  version: string;
  package: string;
}

/** The highest requirement, keeping the parsed form for comparison. */
interface BestRequirement {
  parsed: Version;
  requirement: MsrvRequirement;
}

/**
 * The maximum `rust-version` across the graph, parsed form included.
 *
 * Private, and the parsed value is why: `evaluateMsrv` needs it to compare
 * without parsing the same string twice, while callers outside this module
 * only ever want the requirement.
 */
function bestRequirement(packages: PackageMsrv[]): BestRequirement | undefined {
  let best: BestRequirement | undefined;

  for (const entry of packages) {
    const parsed = parseVersion(entry.rustVersion);
    if (!parsed) continue;
    if (best && compareVersions(parsed, best.parsed) <= 0) continue;
    best = {
      parsed,
      requirement: {
        version: entry.rustVersion,
        package: `${entry.name} ${entry.version}`,
      },
    };
  }

  return best;
}

/**
 * The maximum `rust-version` across the resolved graph.
 *
 * A crate's own declaration is not the answer: cargo-binstall 1.21.1 declares
 * 1.79 while pinning vergen 10.0.1, which needs 1.95. Under `--locked` the
 * graph binds, so the floor is sixteen minor versions above what the crate
 * advertises. Unparseable values are skipped rather than fatal — see
 * `parseVersion`.
 */
export function effectiveMsrv(
  packages: PackageMsrv[],
): MsrvRequirement | undefined {
  return bestRequirement(packages)?.requirement;
}

/**
 * The outcome of comparing the installed toolchain against the graph.
 *
 * `ok` carries the requirement it cleared so the caller can publish
 * `msrv-effective` from the verdict alone. Without it every caller would run
 * the maximum a second time, and the two results could drift apart under a
 * later edit.
 */
export type MsrvVerdict =
  | { kind: "ok"; required: MsrvRequirement }
  | { kind: "skipped"; reason: string }
  | { kind: "violation"; installed: string; required: MsrvRequirement };

/**
 * Compares the installed rustc against the graph's effective MSRV.
 *
 * `skipped` is a distinct outcome from `ok` on purpose: a check that could not
 * run is not a check that passed, and the caller reports the two differently.
 * Inability to verify never fails a build, even under `msrv-check: error`.
 */
export function evaluateMsrv(
  installed: string,
  packages: PackageMsrv[],
): MsrvVerdict {
  const current = parseVersion(installed);
  if (!current) {
    return {
      kind: "skipped",
      reason: "the installed rustc version could not be read",
    };
  }

  const best = bestRequirement(packages);
  if (!best) {
    return {
      kind: "skipped",
      reason: "no package in the graph declares a rust-version",
    };
  }

  // `best.parsed` rather than re-parsing `best.requirement.version`: the same
  // string, already read once, and re-reading it would add a branch for a
  // failure that cannot happen here.
  if (compareVersions(current, best.parsed) < 0) {
    return { kind: "violation", installed, required: best.requirement };
  }
  return { kind: "ok", required: best.requirement };
}

/** Renders a verdict as the line a human reads in the log. */
export function describeVerdict(verdict: MsrvVerdict): string {
  if (verdict.kind === "violation") {
    return (
      `${verdict.required.package} requires rustc ${verdict.required.version}, ` +
      `but ${verdict.installed} is installed.`
    );
  }
  if (verdict.kind === "skipped") {
    return `MSRV check skipped: ${verdict.reason}.`;
  }
  return "The installed toolchain satisfies every declared rust-version.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/msrv.test.ts`
Expected: PASS, 31 tests.

- [ ] **Step 5: Update the barrel test**

In `src/lib.test.ts`, under `// msrv.ts`, add:

```ts
        "effectiveMsrv",
        "evaluateMsrv",
        "describeVerdict",
```

- [ ] **Step 6: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: PASS, coverage 100%.

- [ ] **Step 7: Commit**

```bash
git add src/msrv.ts src/msrv.test.ts src/lib.test.ts
git commit -S -m "feat(config): compute the graph's effective MSRV and judge it

skipped is a distinct outcome from ok: a check that could not run is not a
check that passed, and inability to verify never fails a build even under
msrv-check: error."
```

---

### Task 5: Declare the inputs and outputs

**Files:**

- Modify: `action.yml`, `src/outputs.ts`, `README.md`
- Test: `src/outputs.test.ts`

**Interfaces:**

- Consumes: `MsrvSource` (Task 2).
- Produces: `ActionOutputs` gains `msrv: string`, `"msrv-effective": string`, `"msrv-source": MsrvSource`;
  `ActionOutputsArgs` gains `msrv: { declared?: string; source: MsrvSource; effective?: string }`.

**Steps:**

- [ ] **Step 1: Write the failing test**

In `src/outputs.test.ts`, find the existing `buildActionOutputs` test that builds a full `ActionOutputsArgs` and add a
new test beside it:

```ts
it("publishes the declared and effective MSRV with their provenance", () => {
  const outputs = buildActionOutputs({
    ...baseArgs,
    msrv: { declared: "1.79", source: "cargo-toml", effective: "1.95.0" },
  });

  expect(outputs.msrv).toBe("1.79");
  expect(outputs["msrv-effective"]).toBe("1.95.0");
  expect(outputs["msrv-source"]).toBe("cargo-toml");
});

it("emits empty strings when no MSRV was found", () => {
  const outputs = buildActionOutputs({
    ...baseArgs,
    msrv: { source: "none" },
  });

  expect(outputs.msrv).toBe("");
  expect(outputs["msrv-effective"]).toBe("");
  expect(outputs["msrv-source"]).toBe("none");
});

it("flattens the MSRV outputs into the entry list", () => {
  const entries = toOutputEntries(
    buildActionOutputs({
      ...baseArgs,
      msrv: { declared: "1.79", source: "cargo-toml", effective: "1.95.0" },
    }),
  );
  const byName = Object.fromEntries(entries);

  expect(byName["msrv"]).toBe("1.79");
  expect(byName["msrv-effective"]).toBe("1.95.0");
  expect(byName["msrv-source"]).toBe("cargo-toml");
  expect(JSON.parse(byName["json"] ?? "{}").msrv).toBe("1.79");
});
```

If `baseArgs` does not already exist in that file, hoist the argument object from the nearest existing
`buildActionOutputs` test into a `const baseArgs: ActionOutputsArgs = { ... }` above the tests and have the existing
test spread it too — do not duplicate the object.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/outputs.test.ts`
Expected: FAIL — `msrv` is not a property of `ActionOutputsArgs`.

- [ ] **Step 3: Write minimal implementation**

In `src/outputs.ts`, add the import:

```ts
import type { MsrvSource } from "@rust-toolchain/msrv";
```

Add to `ActionOutputs`, after `profile`:

```ts
  /**
   * The workspace root's declared `rust-version`, or `""`.
   *
   * The root manifest only, never a maximum over members: this is read before
   * cargo exists, so expanding member globs would mean reimplementing cargo's
   * workspace resolution. A member declaring more still surfaces, through
   * `msrv-effective`.
   */
  msrv: string;
  /**
   * The highest `rust-version` in the resolved graph, or `""`.
   *
   * Distinct from `msrv` because they routinely differ, and the gap is the
   * finding: cargo-binstall declares 1.79 and its graph needs 1.95. A consumer
   * choosing a toolchain wants this one; a consumer reporting the project's
   * own floor wants `msrv`.
   */
  "msrv-effective": string;
  /** Where `msrv` came from. */
  "msrv-source": MsrvSource;
```

Add to `ActionOutputsArgs`:

```ts
  /** The declared and effective MSRV, and where the declared one was read. */
  msrv: {
    declared?: string;
    source: MsrvSource;
    effective?: string;
  };
```

In `buildActionOutputs`, after the `profile` line:

```ts
    msrv: args.msrv.declared ?? "",
    "msrv-effective": args.msrv.effective ?? "",
    "msrv-source": args.msrv.source,
```

In `toOutputEntries`, after the `profile` entry:

```ts
    ["msrv", outputs.msrv],
    ["msrv-effective", outputs["msrv-effective"]],
    ["msrv-source", outputs["msrv-source"]],
```

- [ ] **Step 4: Declare them in `action.yml`**

Under `inputs:`, after `set-rustup-toolchain`:

```yaml
msrv-fallback:
  description: >
    Whether to derive the toolchain from `Cargo.toml`'s `rust-version` when
    neither the `toolchain` input nor `rust-toolchain.toml` names a channel
    (default false). Off by default because `rust-version` is a floor, not a
    pin: turning it on silently moves a repository that has one from
    `stable` to its MSRV.
  required: false
  default: "false"

msrv-check:
  description: >
    What to do when the installed toolchain is older than the highest
    `rust-version` in the resolved dependency graph: `off`, `warn` (default)
    or `error`. The graph is what binds, not the crate's own declaration —
    a crate can declare 1.79 while pinning a dependency that needs 1.95.
    A check that cannot run, for want of a lockfile or a manifest, always
    warns and never fails, whatever this is set to.
  required: false
  default: "warn"
```

Under `outputs:`, after `profile`:

```yaml
msrv:
  description: >
    The `rust-version` declared by the workspace-root `Cargo.toml`, or an
    empty string. The root manifest only, never a maximum over workspace
    members.

msrv-effective:
  description: >
    The highest `rust-version` across every package in the resolved
    dependency graph, or an empty string. Use this, not `msrv`, to choose a
    toolchain: the two differ whenever a dependency outruns the crate's own
    declared floor.

msrv-source:
  description: >
    Where `msrv` was read from — `cargo-toml`, `workspace-inherit`, or
    `none`.
```

- [ ] **Step 5: Run tests and regenerate the README**

```bash
bun test src/outputs.test.ts
mise run readme
bun run fix:all
```

Expected: tests PASS. `mise run readme` rewrites the block between the `action-docs-all` markers; `fix:all` realigns
the tables Prettier owns. Confirm both markers still carry their full
`source="action.yml" project="elioseverojunior/rust-toolchain" version="v0.1"` attribute set — dropping them
regenerates the Usage block as `- uses: @`.

- [ ] **Step 6: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: FAIL in `src/action.test.ts`, because `buildActionOutputs` is called there without the new required `msrv`
argument. Fix those call sites by adding `msrv: { source: "none" }`, then re-run until PASS with 100% coverage.

- [ ] **Step 7: Commit**

```bash
git add action.yml src/outputs.ts src/outputs.test.ts src/action.test.ts README.md
git commit -S -m "feat(config): declare the msrv inputs and outputs

msrv and msrv-effective are separate because they routinely differ, and the
gap is the finding rather than noise. A consumer choosing a toolchain needs
the effective one; publishing a single number hands a matrix the value that
is wrong exactly when the feature matters."
```

---

### Task 6: Phase 1 — derive the channel from `rust-version`

**Files:**

- Modify: `src/config.ts:211-250` (`mergeConfig`), `src/action.ts` (`readTomlConfig` neighbourhood and
  `resolveConfiguration`)
- Test: `src/config.test.ts`, `src/action.test.ts`

**Interfaces:**

- Consumes: `parseCargoManifest`, `ManifestMsrv` (Task 2); `readBooleanInput` from `@rust-toolchain/inputs`.
- Produces: `mergeConfig(tomlConfig, inputs, msrvFallback?: string)` — a third optional parameter, source-compatible
  with every existing caller. `ResolvedConfiguration` gains `manifest: ManifestMsrv`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
describe("mergeConfig msrv fallback", () => {
  it("uses the fallback when neither input nor toml names a channel", () => {
    expect(mergeConfig({}, {}, "1.88").channel).toBe("1.88");
  });

  it("loses to the toml channel", () => {
    expect(mergeConfig({ channel: "1.97" }, {}, "1.88").channel).toBe("1.97");
  });

  it("loses to the toolchain input", () => {
    expect(mergeConfig({}, { toolchain: "nightly" }, "1.88").channel).toBe(
      "nightly",
    );
  });

  it("falls through to stable when no fallback is supplied", () => {
    expect(mergeConfig({}, {}).channel).toBe("stable");
  });
});
```

Append to `src/action.test.ts`:

```ts
describe("msrv-fallback", () => {
  it("installs the rust-version when the flag is on and nothing else names a channel", async () => {
    const h = harness({
      toml: null,
      inputs: { "msrv-fallback": "true" },
      files: { "Cargo.toml": '[package]\nrust-version = "1.88"\n' },
    });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("1.88");
    expect(h.outputs["msrv"]).toBe("1.88");
    expect(h.outputs["msrv-source"]).toBe("cargo-toml");
  });

  it("installs stable when the flag is off, whatever Cargo.toml says", async () => {
    const h = harness({
      toml: null,
      files: { "Cargo.toml": '[package]\nrust-version = "1.88"\n' },
    });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("stable");
    // The declared MSRV is still reported; only the channel is unaffected.
    expect(h.outputs["msrv"]).toBe("1.88");
  });

  it("falls through to stable when the flag is on but no Cargo.toml exists", async () => {
    const h = harness({ toml: null, inputs: { "msrv-fallback": "true" } });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("stable");
    expect(h.outputs["msrv-source"]).toBe("none");
  });
});
```

The harness's `readFile` (`src/action.test.ts:155`) ignores the path entirely and returns `options.toml`, so it
cannot serve two files. Add `files?: Record<string, string>;` to the options object at `src/action.test.ts:115`, and
replace `readFile` with a version that dispatches on the basename:

```ts
    readFile: (path: string) => {
      const name = path.split(/[\\/]/).pop() ?? "";
      if (name === "rust-toolchain.toml") {
        if (options.toml == null) throw new Error("ENOENT");
        return options.toml;
      }
      const extra = options.files?.[name];
      if (extra === undefined) throw new Error("ENOENT");
      return extra;
    },
```

The existing `toml` option keeps working unchanged, so no existing test needs touching.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/config.test.ts src/action.test.ts`
Expected: FAIL — `mergeConfig` takes two arguments; `msrv-fallback` is not read.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, change the signature and the channel line:

```ts
export function mergeConfig(
  tomlConfig: ToolchainTomlConfig,
  inputs: ToolchainInputs,
  msrvFallback?: string,
): ResolvedToolchain {
```

```ts
// `msrvFallback` sits BELOW the toml deliberately. `rust-version` is a floor
// and `rust-toolchain.toml` is a pin; a repository that states a pin has
// answered this question, and an MSRV must not overrule it.
const channel =
  inputs.toolchain ?? tomlConfig.channel ?? msrvFallback ?? "stable";
```

Leave the `path` guard above it untouched — a `path` toolchain is still rejected before this line.

In `src/action.ts`, add a manifest reader beside `readTomlConfig`:

```ts
function readCargoManifest(deps: ActionDeps): ManifestMsrv {
  const workspace = deps.env.GITHUB_WORKSPACE ?? ".";
  let contents: string;
  try {
    contents = deps.readFile(join(workspace, "Cargo.toml"));
  } catch {
    // No manifest in the workspace — not every consumer of this action has
    // one at the root, and its absence is not an error.
    return { source: "none" };
  }
  return parseCargoManifest(contents);
}
```

In `resolveConfiguration`, read the flag and pass the fallback through:

```ts
const inputs = readInputs(deps);
const toml = readTomlConfig(deps);
const manifest = readCargoManifest(deps);
const fallback = readBooleanInput(deps.core, "msrv-fallback", false);
const resolved = mergeConfig(
  toml,
  inputs,
  fallback.value ? manifest.rustVersion : undefined,
);
```

and return `manifest` alongside the rest:

```ts
return { spec: builder.build(), inputs, toml, manifest };
```

Add `manifest: ManifestMsrv` to the `ResolvedConfiguration` interface, and import
`parseCargoManifest`, `type ManifestMsrv` from `@rust-toolchain/msrv` plus `readBooleanInput` from
`@rust-toolchain/inputs` if it is not already imported.

Finally, in `run`, pass the declared MSRV into `buildActionOutputs`:

```ts
      msrv: {
        declared: config.manifest.rustVersion,
        source: config.manifest.source,
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/config.test.ts src/action.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and rebuild**

```bash
bun run typecheck && bun run test && bun run build
```

Expected: PASS, coverage 100%, `dist/index.js` regenerated.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/action.ts src/action.test.ts dist/index.js
git commit -S -m "feat(config): optionally derive the channel from Cargo.toml rust-version

The fallback sits below rust-toolchain.toml, not above: rust-version is a
floor and the toml is a pin, so a repository that states a pin has already
answered the question. Off by default, so no existing workflow moves off
stable on upgrade."
```

---

### Task 7: Phase 2 — run the check after the install

**Files:**

- Modify: `src/action.ts` (the `ActionDeps` interface and `run`), `src/index.ts:152-163`
- Test: `src/action.test.ts`

**Interfaces:**

- Consumes: `parseMsrvPolicy`, `evaluateMsrv`, `describeVerdict` (Tasks 1, 4); `parsePackageMsrv` (Task 3);
  `MetadataReader` from `@rust-toolchain/cache/metadata`.
- Produces: `ActionDeps` gains `metadata: MetadataReader`. `run` publishes `msrv-effective`.

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/action.test.ts`:

```ts
const GRAPH_JSON = JSON.stringify({
  packages: [
    {
      id: "a",
      name: "cargo-binstall",
      version: "1.21.1",
      rust_version: "1.79",
    },
    { id: "b", name: "vergen", version: "10.0.1", rust_version: "1.95.0" },
  ],
});

describe("msrv-check", () => {
  it("warns by default when the graph outruns the installed toolchain", async () => {
    const h = harness({ metadataJson: GRAPH_JSON, release: "1.88.0" });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(
      h.warnings.some((w) =>
        /vergen 10\.0\.1 requires rustc 1\.95\.0, but 1\.88\.0 is installed/.test(
          w,
        ),
      ),
    ).toBe(true);
    expect(h.outputs["msrv-effective"]).toBe("1.95.0");
  });

  it("fails the step under error", async () => {
    const h = harness({
      metadataJson: GRAPH_JSON,
      release: "1.88.0",
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures.some((f) => /vergen 10\.0\.1 requires/.test(f))).toBe(
      true,
    );
  });

  it("stays silent when the toolchain satisfies the graph", async () => {
    const h = harness({ metadataJson: GRAPH_JSON, release: "1.97.1" });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.warnings.some((w) => /requires rustc/.test(w))).toBe(false);
    expect(h.outputs["msrv-effective"]).toBe("1.95.0");
  });

  it("does not read metadata at all when off", async () => {
    const h = harness({
      metadataJson: GRAPH_JSON,
      release: "1.88.0",
      inputs: { "msrv-check": "off" },
    });
    await run(h.deps);

    expect(h.metadataCalls).toEqual([]);
    expect(h.outputs["msrv-effective"]).toBe("");
  });

  // Inability to verify is not a violation, so it warns even under `error`.
  it("warns and succeeds under error when metadata cannot run", async () => {
    const h = harness({
      metadataError: new Error("could not find `Cargo.toml`"),
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.warnings.some((w) => /MSRV check could not run/.test(w))).toBe(
      true,
    );
  });

  it("warns when the graph declares nothing", async () => {
    const h = harness({
      metadataJson: JSON.stringify({ packages: [] }),
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(
      h.warnings.some((w) => /no package in the graph declares/.test(w)),
    ).toBe(true);
  });
});
```

Extend the harness. Add to the options object at `src/action.test.ts:115`:

```ts
    metadataJson?: string;
    metadataError?: Error;
```

Add a recorder beside the other collectors (`const calls: ExecCall[] = []` and friends):

```ts
const metadataCalls: string[] = [];
```

Add the dep to the `ActionDeps` object literal:

```ts
    metadata: {
      read: (manifestDir: string) => {
        metadataCalls.push(manifestDir);
        if (options.metadataError) return Promise.reject(options.metadataError);
        return Promise.resolve(options.metadataJson ?? "{}");
      },
    },
```

and expose `metadataCalls` on the returned `Harness`, adding `metadataCalls: string[];` to the `Harness` interface
beside the existing `calls`, `outputs` and `warnings` fields.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/action.test.ts`
Expected: FAIL — `metadata` is not a property of `ActionDeps`.

- [ ] **Step 3: Write minimal implementation**

In `src/action.ts`, add to `ActionDeps` (mirroring the existing declaration in `PostDeps`):

```ts
/** Runs `cargo metadata`; the real one is in `src/index.ts`. */
metadata: MetadataReader;
```

Add a helper above `run`:

```ts
/**
 * Compares the installed toolchain against the resolved graph's MSRV.
 *
 * Returns the effective requirement for the outputs, or `undefined` when the
 * check did not run. Never throws: a check that cannot run is reported as a
 * warning even under `error`, because inability to verify is not a violation
 * and would otherwise fail every repository without a lockfile.
 */
async function checkMsrv(
  deps: ActionDeps,
  policy: MsrvPolicy,
  installed: string,
  manifestDir: string,
): Promise<string | undefined> {
  if (policy === "off") return undefined;

  let packages: PackageMsrv[];
  try {
    packages = parsePackageMsrv(await deps.metadata.read(manifestDir));
  } catch (error) {
    deps.core.warning(`MSRV check could not run: ${describeError(error)}`);
    return undefined;
  }

  const verdict = evaluateMsrv(installed, packages);
  if (verdict.kind === "skipped") {
    deps.core.warning(describeVerdict(verdict));
    return undefined;
  }

  if (verdict.kind === "ok") {
    deps.core.info(describeVerdict(verdict));
    return verdict.required.version;
  }

  if (policy === "error") {
    deps.core.setFailed(describeVerdict(verdict));
  } else {
    deps.core.warning(describeVerdict(verdict));
  }
  return verdict.required.version;
}
```

In `run`, after `const rustc = readRustcVersion(deps, env);` and its `deps.core.info(rustc.banner)`:

```ts
const msrvPolicy = parseMsrvPolicy(deps.core.getInput("msrv-check"));
const msrvEffective = await checkMsrv(
  deps,
  msrvPolicy,
  rustc.info.version,
  deps.env.GITHUB_WORKSPACE ?? ".",
);
```

and extend the `buildActionOutputs` call's `msrv` block from Task 6 with `effective: msrvEffective`.

Import `parseMsrvPolicy`, `evaluateMsrv`, `describeVerdict`, `type MsrvPolicy` from
`@rust-toolchain/msrv`, and `parsePackageMsrv`, `type MetadataReader` from `@rust-toolchain/cache/metadata`.

- [ ] **Step 4: Wire the real reader into the main phase**

In `src/index.ts`, the `else` branch calling `run({...})` currently omits `metadata`. Add it, so the same object
serves both phases:

```ts
    metadata,
```

Add a line to the comment block above the wiring noting that `metadata` now goes to **both** phases — `run` for the
MSRV check, `runPost` for cache pruning — since the existing comment says it is post-phase only.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/action.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and rebuild**

```bash
bun run typecheck && bun run test && bun run build
```

Expected: PASS, coverage 100%.

- [ ] **Step 7: Commit**

```bash
git add src/action.ts src/action.test.ts src/index.ts dist/index.js
git commit -S -m "feat(config): verify the installed toolchain against the graph MSRV

Wires the metadata port into run() for the first time; it served runPost
alone. A check that cannot run warns even under error, because inability to
verify is not a violation and would otherwise fail every repository without a
lockfile."
```

---

### Task 8: Prove it end to end and document it

**Files:**

- Modify: `.github/workflows/tests/act.yml`, `AGENTS.md`, `docs/content/design/2026-08-12-msrv-awareness.md`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing consumed by later tasks.

**Steps:**

- [ ] **Step 1: Add the matrix fields**

In `.github/workflows/tests/act.yml`, add `msrv-check: ""` and `msrv-expected: ""` to **both** existing matrix
entries, then add a third entry. Every key must appear in every entry or `actionlint` reports an undefined matrix
property:

```yaml
- name: "msrv check against the workspace graph"
  toolchain: "1.88"
  targets: ""
  components: ""
  profile: ""
  expected: "1.88"
  unexpected: ""
  cargo-tools: ""
  tool-bins: ""
  msrv-check: "warn"
  # This repository has no Cargo.toml, so the check cannot run and
  # must warn rather than fail — the degradation path, which is the
  # half most likely to regress unnoticed.
  msrv-expected: ""
  toml: |
    [toolchain]
    channel = "1.88"
```

- [ ] **Step 2: Pass the input and assert the outputs**

In the `Setup Rust Toolchain And Cache` step's `with:` block add:

```yaml
msrv-check: ${{ matrix.msrv-check }}
```

After `Verify Cachekey Output`, add:

```yaml
- name: Verify MSRV Outputs
  if: matrix.msrv-check != ''
  shell: bash
  env:
    MSRV: ${{ steps.rust-toolchain.outputs.msrv }}
    MSRV_EFFECTIVE: ${{ steps.rust-toolchain.outputs.msrv-effective }}
    MSRV_SOURCE: ${{ steps.rust-toolchain.outputs.msrv-source }}
    EXPECTED: ${{ matrix.msrv-expected }}
  run: |
    echo "msrv:           $MSRV"
    echo "msrv-effective: $MSRV_EFFECTIVE"
    echo "msrv-source:    $MSRV_SOURCE"

    if [[ "$MSRV" != "$EXPECTED" ]]; then
      echo "msrv is '$MSRV', expected '$EXPECTED'"
      exit 1
    fi
    # The check cannot run here, so the source must say so rather than
    # inventing a value.
    if [[ -z "$EXPECTED" && "$MSRV_SOURCE" != "none" ]]; then
      echo "msrv-source is '$MSRV_SOURCE', expected 'none'"
      exit 1
    fi
```

- [ ] **Step 3: Run it**

```bash
mise run --no-deps actionlint .github/workflows/tests/act.yml
bunx prettier --check .github/workflows/tests/act.yml
mise run act -t act
```

Expected: actionlint and Prettier clean; every matrix row succeeds; the new row's log shows the step warning that the
MSRV check could not run, and the job still passes.

- [ ] **Step 4: Record the invariants in `AGENTS.md`**

Under the **Architecture** → **Source layout** list, add an `src/msrv.ts` bullet describing the module. Then add
these to the **Rustup invariants — do not "simplify" these** list:

```markdown
- **`rust-version` is a floor; `rust-toolchain.toml` is a pin.** `msrv-fallback`
  therefore sits BELOW the toml in `mergeConfig`'s channel chain, and defaults
  to `false`. Reversing either would silently move a repository that declares
  an MSRV off `stable`, or let a floor overrule a pin the author wrote down.
- **A `cargo metadata` MSRV check that cannot run always warns, never fails,
  even under `msrv-check: error`.** Inability to verify is not a violation;
  conflating them fails every repository without a lockfile. `evaluateMsrv`
  keeps `skipped` distinct from `ok` for exactly this reason.
- **The MSRV comes from the resolved graph, not the manifest.** cargo-binstall
  1.21.1 declares `rust-version = 1.79` while pinning vergen 10.0.1, which
  needs 1.95, so a manifest-only check passes and the build then fails. This is
  why `msrv` and `msrv-effective` are separate outputs.
```

- [ ] **Step 5: Mark the design implemented**

In `docs/content/design/2026-08-12-msrv-awareness.md`, change the header to:

```markdown
Status: implemented
Date: 2026-08-12
Implemented: 2026-08-12
```

Set `Implemented:` to the date of this commit, matching how
`docs/content/design/2026-08-10-docusaurus-migration.md` records both dates.

- [ ] **Step 6: Run every gate**

```bash
bun run fix:all
bun run typecheck
bun run test
bun run build
hk check --all
git diff --exit-code dist/
```

Expected: all PASS. `git diff --exit-code dist/` must be silent — a non-empty diff means `dist/` was not rebuilt
after the last `src/` change, which is the exact failure the CI Build job catches.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/tests/act.yml AGENTS.md docs/content/design/2026-08-12-msrv-awareness.md
git commit -S -m "test(tests): cover the MSRV check end to end and record its invariants

The act row exercises the degradation path — no Cargo.toml, so the check
cannot run and must warn rather than fail. That is the half most likely to
regress unnoticed, since the happy path fails loudly and this one does not."
```

---

## Verification

The feature is done when all of these hold:

1. `bun run test` passes with 100% line, function and statement coverage.
2. `bun run typecheck` is clean and `hk check --all` is green.
3. `git diff --exit-code dist/` is silent.
4. `mise run act -t act` passes every matrix row, including the new one.
5. A repository with `rust-version` and no other source installs `stable` by default, and its MSRV still appears in
   `msrv`.
6. Setting `msrv-fallback: true` on that same repository installs the `rust-version` instead.
7. A graph whose dependency outruns the installed toolchain warns by default and fails under `msrv-check: error`,
   naming the dependency.
8. A repository with no lockfile warns and still succeeds under `msrv-check: error`.
