<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install cargo-managed tools and cache their binaries in a third layer, `bin`, keyed on the _resolved_ tool
versions — so a toolchain bump stops forcing a reinstall of every tool, and the calendar-rotation workaround a
hand-written cache key needs disappears.

**Architecture:** One new module, `src/tools.ts`, owns the `cargo-tools` input end to end: parsing, version
resolution, and installation. Resolution is network-bound, so crates.io is reached through a port
(`RegistryClient`) exactly as `@actions/cache` is reached through `CacheClient` — the real implementation is wired
in `src/index.ts`, which nothing imports and the coverage gate does not measure. The `bin` layer itself is an
ordinary third entry in the structures Phase A built: one more `CACHE_LAYER_IDS` member, one more `DERIVERS` entry,
one more path function.

**Tech Stack:** TypeScript 6 (strict), Bun test runner, `node:crypto`, `@actions/core`, `@actions/cache`.

**Design:** [docs/design/2026-07-31-layered-cargo-cache.md](../design/2026-07-31-layered-cargo-cache.md) — decisions
4, 5, 6 and the `bin` rows of the Layer model and Key algebra.

**Parent plans:** [Phase A](2026-07-31-layered-cargo-cache-phase-a.md) and
[Phase B](2026-07-31-layered-cargo-cache-phase-b.md), whose "Carried into Phase C" sections this plan discharges.

## A note on what this document contains

Phase B's plan embedded complete implementations and is now headed _"Superseded in parts — do not copy code out of
this document"_, because the code in it drifted from what shipped while still reading as authoritative. This plan
therefore embeds **tests and interfaces** — the parts that are contracts — and describes behaviour for everything
else. TDD produces the implementation; the plan does not pre-write it.

## Global Constraints

Every task's requirements implicitly include this section.

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then write the minimal implementation.
- **Coverage gate is 100%** for lines, functions and statements across `src/`, enforced by `bunfig.toml`.
  Unreachable or unused code fails the build, which is the reason the `bin` layer could not ship in Phase A.
- **`src/index.ts` is excluded from coverage** because nothing imports it. That is deliberate and load-bearing
  here: it is where the crates.io adapter goes, alongside the `@actions/cache` one. Nothing with logic worth
  testing may live there.
- **Two Bun 1.3.14 coverage quirks**, both in `CLAUDE.md`: a class with field declarations needs an explicit
  `constructor()`, and a `switch` whose `case` bodies are braced blocks that return loses coverage on the last
  closing brace. Use a lookup object.
- **Library source imports siblings as `@rust-toolchain/<module>`**, never `./<module>` and never `@/<module>`.
  Test files use `@/<module>`.
- **`src/lib.ts` is the barrel** and must never re-export `src/index.ts`. `src/lib.test.ts` pins the complete
  runtime export list; adding a module means updating both, and the module count in the doc comment and the test
  description.
- **Commands are argv arrays executed without a shell.** A tool name can come from workflow input, so it is
  validated and never interpolated into a command string.
- **Every file starts with the SPDX header** exactly as the existing `src/*.ts` files have it.
- **Before every commit**, in this order: `bun run fix:all`, `bun run typecheck`, `bun run test`.
- **Commits are GPG-signed** (`git commit -S`), Conventional Commits, scope `cache`. **Never** a `Co-Authored-By`
  trailer or any attribution line.
- **`dist/` is rebuilt only in the final task, EXCEPT when a task changes `action.yml`.** Intermediate commits
  leave a stale bundle on purpose, and for a `src/`-only change that is harmless — the bundle is merely out of
  date, and CI's Build job catches it with `git diff --exit-code dist/`. It is not harmless once `action.yml`
  gains an input or default the old bundle rejects. Task 4 changed the `cache-layers` default to
  `registry,build,bin`, the committed bundle's `parseCacheLayers` threw `"bin" is not a cache layer`, and every
  local `act` run failed on an action that was broken rather than stale. **A task that adds, removes or re-defaults
  an `action.yml` input rebuilds the bundle in the same commit.** Editing a `description` does not — the bundle
  never reads one, so the two halves cannot diverge in behaviour; that only leaves the README stale until Task 8
  regenerates it.

## Scope

### In

- The `cargo-tools` input, its parsing, `latest` resolution, and installation.
- The `bin` cache layer: identifier, key deriver, paths, and shim exclusion.
- The four carry-overs Phases A and B booked into this phase (see below).
- A `cargo-tools` output carrying the resolved `name@version` set.

### Out

- **`cache-save-if`.** Design decision 10 booked it, and the Phase B design then recorded it as _"Phase C scope if
  it is wanted at all — recorded here so Phase C does not inherit it as an assumed requirement."_ It is an
  orthogonal concern — _when_ to save, not _what_ to install — and the two levers it was meant to provide against
  budget exhaustion both shipped in Phase B: skip-save-on-exact-hit, and `cache-budget`. Adding it here would widen
  a phase that already introduces a module, a network dependency, a cache layer and a signature change. It remains
  available as its own small change.
- **Deterministic pruning** — Phase D.
- **Cache backends other than GitHub's**, `sccache`, and a `cache-env-vars` input — out of scope for the whole
  design.

### Carried in from Phases A and B, and discharged here

| #   | Carry-over                                                                                                                                                                                                   | Task |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1   | `cache-key-hash` is required whenever caching is on; narrow it to the `registry` and `build` layers, since a `bin`-only workflow has no lockfile component to miss                                           | 5    |
| 2   | `action.yml`'s `cache-layers` default is the literal `"registry,build"`, duplicating `CACHE_LAYER_IDS.join(",")`; adding `bin` updates the TypeScript fallback automatically and the YAML default not at all | 4    |
| 3   | `parseCacheLayers`, the `DERIVERS` table and the `CACHE_LAYER_IDS` assertion in `layers.test.ts` all widen together                                                                                          | 4    |
| 4   | Exhaustiveness needs no work: `DERIVERS` is a `Record<CacheLayerId, …>`, so adding `bin` fails to compile until it has a deriver                                                                             | 4    |

## Decisions this plan settles

Three points where the design is silent or self-contradicting. Each is settled here so the tasks below do not
reopen them.

### D1. What happens when crates.io is unreachable

The design says _"If resolution fails after retries and a restored binary exists, the action uses the restored
binary and warns."_ That cannot be read literally: resolution happens at step 5 of the main phase and the restore
at step 7, so at the moment resolution fails **nothing has been restored yet**. The `bin` key cannot even be
derived without the resolved versions.

Settled as follows:

- A spec carrying an **explicit version** (`cargo-deny@0.16.1`) needs no resolution at all, so a registry outage
  cannot affect it. This is the case worth protecting, and it is protected by construction.
- Only a bare name or `@latest` needs resolution. When that fails after retries, restore the `bin` layer through
  its **widest rung** (`bin-<os>-<arch>-`) and accept a binary that satisfies the requested _name_. Its version is
  unverifiable in that state, so the step warns loudly and the `cargo-tools` output reports the version as
  `unknown`.
- If the widest rung yields nothing for a requested tool, **fail the step.** A missing tool is a broken job either
  way, and failing beats proceeding into a `cargo` step that will fail more obscurely.

The rule underneath: an outage may cost precision about _which_ version is present; it may never cause a
_pinned_ version to be silently replaced.

### D2. Where restored-binary verification lives

The design requires restored binaries be version-verified before acceptance. That needs `exec`, which the cache
lifecycle deliberately does not have — `restoreLayers` takes a `CacheClient` and a log, and nothing else, which is
what lets it be tested against plain values.

Verification therefore lives in `src/tools.ts` and is called from `src/action.ts` **after** `restoreLayers`
returns. `src/cache/lifecycle.ts` is not touched by this phase.

### D0. `cache-key-suffix` does not apply to the `bin` key

Settled during Task 4, and user-visible, so recorded rather than left in a commit message. The design's key
algebra is `bin-<os>-<arch>-<toolSetHash>` — no suffix — while `action.yml` promised the suffix was "added to
every cache key". The design wins: two jobs resolving the same tool set need byte-identical binaries, so
fragmenting that layer by a caller's discriminator costs sharing and buys nothing. `action.yml`'s wording is
corrected to say `registry` and `build`, with the reason.

### D3. The `bin` key needs a stand-in at validation time

`readCacheRequest` validates key length before anything is installed, and `toolSetHash` is not known until
crates.io has answered. This is the same shape as the existing `specCacheKey` problem, and it takes the same
answer: a `TOOL_SET_HASH_STAND_IN` built through `hashToolSet` itself, so the stand-in can never be narrower than
the real value and the two cannot drift.

Consequently `buildCacheOutputs(request, specCacheKey)` gains a third parameter, `toolSetHash`. It is an exported
function, so this is a breaking change for a direct caller and belongs in the release notes.

## The one invariant most likely to be got wrong

The `bin` layer excludes rustup's shims, and **an exclusion is only real on a files-only manifest**.

`@actions/cache` resolves patterns with `implicitDescendants: false`, writes the matches to a manifest, then runs
`tar --files-from <manifest>` with no `--no-recursion`. Any directory left in that manifest is expanded wholesale
by tar, re-including everything the negations removed. This is not hypothetical: it is exactly how Phase B's
`buildPaths` shipped excluding nothing and survived eight reviews, and it was caught only by the `E2E Warm Cache`
job.

So `binPaths` must emit the directory negations alongside the shim negations, and Task 8's end-to-end assertion —
that no shim survived into the restored `bin` entry — is the only check that can actually prove it. A unit test of
the glob set alone cannot.

## File Structure

| File                              | Responsibility                                                                            | Task       |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `src/tools.ts`                    | `cargo-tools` parsing, resolution, `hashToolSet`, verification, installation              | 1, 2, 3, 6 |
| `src/tools.test.ts`               | Tests for the above                                                                       | 1, 2, 3, 6 |
| `src/cache/keys.ts`               | The `bin` deriver                                                                         | 4          |
| `src/cache/layers.ts`             | `bin` joins `CACHE_LAYER_IDS`                                                             | 4          |
| `src/cache/paths.ts`              | `binPaths`, `RUSTUP_SHIMS`                                                                | 4          |
| `src/cache/inputs.ts`             | `cache-key-hash` narrowing, `TOOL_SET_HASH_STAND_IN`, third `buildCacheOutputs` parameter | 5          |
| `src/action.ts`                   | Resolve before keys, verify and install after restore                                     | 6          |
| `src/outputs.ts`                  | `cargo-tools` output, folded into `json`                                                  | 7          |
| `src/index.ts`                    | The crates.io adapter                                                                     | 6          |
| `action.yml`                      | `cargo-tools` input, `cache-layers` default, `cargo-tools` output                         | 4, 7       |
| `src/lib.ts`, `src/lib.test.ts`   | Barrel and pinned export list                                                             | 1, 3, 4    |
| docs, `dist/index.js`, `cicd.yml` | Regenerated, rebuilt, and the E2E shim assertion                                          | 8          |

---

### Task 1: Parse the `cargo-tools` input

**Files:** create `src/tools.ts` and `src/tools.test.ts`; modify `src/lib.ts`, `src/lib.test.ts`.

**Interfaces.** Consumes `parseCommaList` from `@rust-toolchain/config`. Produces
`interface ToolSpec { name: string; version: string }` where `version` is `"latest"` when unpinned, and
`parseToolSpecs(value: string): ToolSpec[]`.

**Behaviour.** Accepts the same comma, whitespace and newline separators as `targets` and `components`, so the
separator grammar keeps one definition. Each entry is `<name>` or `<name>@<version>`; a bare name means `latest`.
Names are validated against the same identifier class `mergeConfig` uses for targets and components, because a
tool name reaches `cargo install` as argv. An empty input yields `[]` — `cargo-tools` is optional. Duplicate names
are an error rather than a silent last-wins, since two different pinned versions of one tool cannot both be
installed and picking one would be a guess.

**Steps:**

- [ ] Write `src/tools.test.ts` covering: the three separators; a bare name defaulting to `latest`; an explicit `name@version`; rejection of a name that is not an identifier; rejection of a duplicate name; the empty input.
- [ ] Run `bun test src/tools.test.ts` and watch it fail with `Cannot find module '@/tools'`.
- [ ] Implement `parseToolSpecs` minimally.
- [ ] Add the barrel re-export and the pinned export list entry; bump the module count in `src/lib.ts`'s doc comment and in `src/lib.test.ts`'s description.
- [ ] `bun run fix:all && bun run typecheck && bun run test`
- [ ] `git commit -S -m "feat(cache): parse the cargo-tools input"`

---

### Task 2: Resolve `latest` against crates.io

**Files:** modify `src/tools.ts`, `src/tools.test.ts`.

**Interfaces.** Produces the port and the resolver:

```ts
/**
 * The crates.io lookup resolution needs, as a port.
 *
 * The only real implementation lives in `src/index.ts`, which nothing imports
 * and the coverage gate does not measure — the same placement, for the same
 * reason, as the `@actions/cache` adapter behind `CacheClient`.
 */
export interface RegistryClient {
  latestVersion(name: string): Promise<string>;
}

export interface ResolvedTool {
  name: string;
  /** The concrete version, or `UNRESOLVED_VERSION` after an outage (see D1). */
  version: string;
}

/** A tool the registry could not answer for, and why. */
export interface UnresolvedTool {
  name: string;
  reason: string;
}

/** Every tool, plus the subset the registry could not answer for. */
export interface ToolResolution {
  tools: ResolvedTool[];
  unresolved: UnresolvedTool[];
}
```

**Behaviour.** A spec with an explicit version passes through untouched and never reaches the client. A `latest`
spec is resolved through `RegistryClient`, retried with the same bounded backoff `rustupOrThrow` uses. On
exhaustion the resolver does not throw: it reports the tool as unresolved, and Task 6 decides what to do with that
under D1. Resolution runs concurrently across tools, each caught at its own boundary, so one unreachable tool
cannot lose the results of the others — the same shape `saveLayers` uses.

**Two shapes this task settled, recorded because they differ from the sketch above as first written.**

`resolveToolVersions` returns `ToolResolution`, not a bare `ResolvedTool[]`. A sentinel version alone cannot carry
_why_ the registry failed, and D1 requires the step to warn loudly — a warning naming the cause is the whole point
of warning. The two-list shape is `measurePaths`'s (`{ bytes, unmeasured }`), for the same reason. `unresolved` is
the authoritative signal and callers must branch on it rather than on `version === UNRESOLVED_VERSION`, since
nothing stops someone pinning `@unknown`.

The retry policy arrives through `ResolveDeps` rather than being restated in `src/tools.ts`. `MAX_ATTEMPTS` and
`BACKOFF_BASE_MS` are module-private in `src/action.ts`, and `action.ts` will import `tools.ts` in Task 6 — so
importing them back would be a cycle. Its `delay` is promise-based rather than reusing `ActionDeps.sleep`, whose
`Atomics.wait` would block the thread and serialise the concurrent resolution above into one lookup at a time.

**Steps:**

- [ ] Extend `src/tools.test.ts`: an explicit version never calls the client; `latest` resolves; a transient failure retries and then succeeds; exhaustion reports unresolved rather than throwing; one tool's failure leaves the others resolved.
- [ ] Watch the new cases fail.
- [ ] Implement `RegistryClient` and the resolver.
- [ ] Barrel, pinned list, gates, `git commit -S -m "feat(cache): resolve cargo-tool versions against crates.io"`

---

### Task 3: `hashToolSet`

**Files:** modify `src/tools.ts` and `src/tools.test.ts`.

**Interfaces.** Produces `hashToolSet(tools: ResolvedTool[]): string`.

**Behaviour.** SHA-256 over the sorted, newline-joined `name@version` pairs, truncated to the first 8 hex
characters — the same width `generateSpecCacheKey` and `hashBuildEnv` use, so every key segment stays uniform.
Sorted before hashing, so declaring the same tools in a different order still hits the same key. Joined on a
newline unambiguously, because `parseToolSpecs` has already refused any name or version that could contain one.

An empty set has a stable digest; it is never special-cased to the empty string. `joinKeySegments` drops an empty
segment, so a tools-less job's key would collapse to `bin-<os>-<arch>` while its widest restore rung stayed
`bin-<os>-<arch>-` — which matches a _tooled_ job's entry, and the tools-less job would restore binaries it never
asked for.

**Placement, which this task moved.** The section above first said `src/cache/keys.ts`. It lives in `src/tools.ts`
instead, for the reason `hashBuildEnv` lives in `cache/env.ts` and `generateSpecCacheKey` in `core.ts`: a digest
belongs with the thing it digests, and `keys.ts` assembles segments rather than computing them. It also avoids a
dependency edge from the cache subsystem to the tools module that nothing structural needed.

**Steps:**

- [ ] Tests: stability, order independence, a different version changing the digest, the 8-hex-character shape, the empty set.
- [ ] Watch them fail, implement, barrel, pinned list, gates.
- [ ] `git commit -S -m "feat(cache): digest the resolved cargo-tool set"`

---

### Task 4: The `bin` layer

**Files:** modify `src/cache/layers.ts`, `src/cache/layers.test.ts`, `src/cache/keys.ts`, `src/cache/keys.test.ts`,
`src/cache/paths.ts`, `src/cache/paths.test.ts`, `action.yml`, `src/lib.ts`, `src/lib.test.ts`.

**Interfaces.** Produces `RUSTUP_SHIMS: readonly string[]` and `binPaths(cargoHome: string): string[]`;
`CacheLayerId` gains `"bin"`; `CacheKeyContext` gains `toolSetHash: string`.

**Behaviour.** Three things move together, and the compiler enforces two of them.

`CACHE_LAYER_IDS` becomes `["registry", "build", "bin"]`. `DERIVERS` will not compile until `bin` has an entry:
its key is `bin-<os>-<arch>-<toolSetHash>` and — unlike `build` — **its ladder does fall back**, to
`bin-<os>-<arch>-`. That asymmetry is deliberate and worth a comment beside it: a partial `bin` restore is
useful, because three of four tools present means installing one, whereas a partial `build` restore is artifacts
cargo discards on sight. The `bin` key carries no toolchain segment at all, which is the entire point of decision
6 — excluding the shims is what lets the toolchain leave that key, so bumping stable no longer reinstalls every
tool.

`binPaths` emits `<cargoHome>/bin/**`, then `!<cargoHome>/bin/<shim>` for each of the fourteen shims, and then
**the directory negations** `!<cargoHome>/bin/` and `!<cargoHome>/bin/**/`. Re-read "The one invariant most likely
to be got wrong" above before writing this function. The shims are the fixed set the design names: `cargo`,
`cargo-clippy`, `cargo-fmt`, `cargo-miri`, `clippy-driver`, `rls`, `rust-analyzer`, `rust-gdb`, `rust-gdbgui`,
`rust-lldb`, `rustc`, `rustdoc`, `rustfmt`, `rustup`. On Windows they carry `.exe`; handle that rather than
assuming POSIX, since the E2E matrix runs `windows-latest`.

`action.yml`'s `cache-layers` default becomes `"registry,build,bin"` — carry-over 2, and the one change here no
compiler will catch.

**Steps:**

- [ ] Update the `CACHE_LAYER_IDS` assertion in `src/cache/layers.test.ts` and add a `bin` case to the `parseCacheLayers` tests; watch them fail.
- [ ] Widen `CACHE_LAYER_IDS`; observe `DERIVERS` fail to compile; add the `bin` deriver and its key/ladder tests, including one asserting the ladder falls back where `build`'s does not.
- [ ] Write the `binPaths` tests **first**, pinning the exact array including both directory negations and the `.exe` variants, then implement.
- [ ] Update `action.yml`'s `cache-layers` default and its description.
- [ ] Barrel, pinned list, gates.
- [ ] `git commit -S -m "feat(cache): add the bin layer, keyed on the resolved tool set"`

---

### Task 5: Narrow `cache-key-hash`, and complete the key at the right moment

**Files:** modify `src/cache/inputs.ts`, `src/cache/inputs.test.ts`, and every `buildCacheOutputs` call site.

**Behaviour.** `cache-key-hash` becomes required only when `registry` or `build` is enabled — carry-over 1. A
workflow enabling `bin` alone has no lockfile component to miss, and failing it would be wrong.

**D3 already landed, in Task 4.** Making `toolSetHash` a required field of `CacheKeyContext` immediately broke
`PendingCacheKeyContext`, `readCacheRequest`'s length-check loop and `buildCacheOutputs`, so `TOOL_SET_HASH_STAND_IN`
and the third `buildCacheOutputs` parameter had to arrive with the type rather than after it. The alternative was
making the field optional, which this codebase rejects on principle — an optional field is one a caller can forget.
Task 5 is therefore only the `cache-key-hash` narrowing.

**Steps:**

- [ ] Tests: `bin`-only with no `cache-key-hash` succeeds; `registry`-only and `build`-only without one still fail; the 512-character check measures the `bin` key with the stand-in.
- [ ] Watch them fail, implement, fix the call sites the signature change breaks.
- [ ] Gates, `git commit -S -m "feat(cache): scope cache-key-hash to the layers that need it"`

---

### Task 6: Install what is missing, verify what was restored

**Files:** modify `src/tools.ts`, `src/tools.test.ts`, `src/action.ts`, `src/action.test.ts`, `src/index.ts`.

**Behaviour.** In `run`, resolution happens **before** the cache keys are derived, since `toolSetHash` is a key
segment. Verification and installation happen **after** `restoreLayers` returns, per D2.

Verification runs `<tool> --version` through the existing injected `exec` and compares against the resolved
version. A tool that is absent, or present at the wrong version, is installed with `cargo install` — argv, no
shell, bounded by a timeout, retried with backoff, exactly as the rustup calls are. A tool that verifies is left
alone, which is what makes a warm `bin` restore worth anything.

`src/index.ts` gains the real `RegistryClient`. It is dependency wiring and nothing else, so it stays free of
logic — the file is invisible to the coverage gate.

D1 is implemented here: an unresolved tool that the widest-rung restore satisfies by name is accepted with a
warning and reported as `unknown`; an unresolved tool with nothing restored fails the step.

**Steps:**

- [ ] Extend the `src/action.test.ts` harness with a fake `RegistryClient`, mirroring how the `cache` fake was added in Phase B. Extend the existing harness; do not add a second one.
- [ ] Tests: a verified tool is not reinstalled; a missing tool is installed; a wrong-version tool is reinstalled; an install failure fails the step; the D1 outage paths, both accepted and fatal.
- [ ] Watch them fail, implement, wire `src/index.ts`.
- [ ] Gates, `git commit -S -m "feat(cache): install and verify cargo tools"`

---

### Task 7: The `cargo-tools` output

**Files:** modify `src/outputs.ts`, `src/outputs.test.ts`, `action.yml`.

**Behaviour.** A `cargo-tools` output carrying the resolved `name@version` values as a JSON array string, folded
into `json` as a real array — the same treatment `targets` and `components` get, and the same input-and-output
name reuse the action already establishes with `targets`.

`toOutputEntries`'s key order and `src/outputs.test.ts`'s "emits every documented output key exactly once" test
both need updating; that test failing is the point of it.

**Steps:**

- [ ] Tests for the new field, its JSON serialisation, its place in the `json` key order, and the exhaustive key list; watch them fail.
- [ ] Implement, declare the output in `action.yml`, gates.
- [ ] `git commit -S -m "feat(cache): publish the resolved cargo-tool set as an output"`

---

### Task 8: Documentation, bundle, and end-to-end proof

**Files:** modify `README.md`, `docs/ARCHITECTURE.md`, `docs/COMPARISON.md`, `docs/RUNBOOKS.md`, `AGENTS.md`,
`CLAUDE.md`, `.github/workflows/cicd.yml`, `dist/index.js`, and `docs/.vitepress/config.mts`.

**Behaviour.** The E2E work is the part that carries real risk, and it is two assertions, not one:

- In `e2e`, request a small, fast, widely-available tool through `cargo-tools` and assert it is on `PATH` and
  reports the resolved version.
- In `e2e-warm`, assert the restored `$CARGO_HOME/bin` contains that tool **and contains none of the rustup
  shims**. That second assertion is the only thing in the repository that can prove the shim exclusion reached
  the archive, for the reason set out above. Make it fail loudly, naming any shim it finds.

Docs: the README roadmap moves Phase C to released and the `moonrepo/setup-rust` and `taiki-e/install-action` rows
move in both replacement matrices; `docs/COMPARISON.md` gets the same rows; `docs/ARCHITECTURE.md` gets the third
layer, `src/tools.ts` in the source-file map, and the `RegistryClient` port beside `CacheClient`; `AGENTS.md` gets
the new module; `CLAUDE.md` gets the shim-exclusion invariant next to the existing cache invariants. Add the Phase
C plan and any Phase C design record to the `docs/.vitepress/config.mts` sidebar — VitePress does not dead-link-check
that block, so an entry is only safe once its page exists.

**Steps:**

- [ ] Add both E2E assertions; they are the acceptance criteria for the whole phase.
- [ ] `mise run readme && bun run fix:all` — confirm both `action-docs-all` markers keep `source`, `project` and `version`.
- [ ] Update the prose docs listed above, and the sidebar.
- [ ] `bun run build`, recording the new `wc -c dist/index.js` in the commit message. The design predicted "small" growth for this phase because it adds no dependency; a large jump means something was imported that should have stayed behind a port.
- [ ] `bun run fix:all && bun run typecheck && bun run test && bun run build && hk check --all`
- [ ] `git commit -S -m "docs(cache): document the bin layer and rebuild the bundle"`

---

## Phase C completion check

- [ ] `bun run test` passes at 100% lines, functions and statements.
- [ ] `hk check --all` is clean.
- [ ] `git diff --exit-code dist/` is clean after `bun run build`.
- [ ] `action.yml` declares `cargo-tools` as both an input and an output, and its `cache-layers` default names all three layers.
- [ ] A `bin`-only workflow runs without `cache-key-hash`.
- [ ] `E2E Warm Cache` proves the restored `bin` entry carries the tool and none of the shims, on all three operating systems.
- [ ] A workflow using `cargo-tools` needs no `taiki-e/install-action` and no `baptiste0928/cargo-install`.

## Carried into Phase D

- Deterministic pruning from `cargo metadata` replaces Phase B's negation globs for the `build` layer. The
  `bin` layer's shim negations are unaffected — they exclude a fixed, known set rather than inferring ownership,
  which is the thing pruning exists to fix.
- Revisit the `2GB` `cache-budget` default once pruning lands.
- `cache-save-if`, if it is wanted at all. It was deferred out of this phase deliberately (see Scope), and it has
  no dependency on pruning, so it can land whenever it is actually needed.
