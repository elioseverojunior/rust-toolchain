<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase B's blunt negation globs on the `build` layer with a keep-set computed from `cargo metadata`
and cargo's own fingerprint records, so a cached `target/` carries the artifacts a later build can actually use and
nothing else — and report what that removed, per layer, in the job summary and the `cache` output.

**Architecture:** Two new modules. `src/cache/metadata.ts` turns `cargo metadata` output into the set of packages the
workspace still depends on, behind a `MetadataReader` port so tests never spawn cargo. `src/cache/prune.ts` maps
artifacts to packages by reading `target/<profile>/.fingerprint/<pkg>-<hash>/*.json` and returns a keep-set. Neither
deletes anything — see D1, which is the decision the whole phase turns on.

**Tech Stack:** TypeScript 6 (strict), Bun test runner, `node:path`, `@actions/core`, `@actions/cache`.

**Design:** [docs/design/2026-07-31-layered-cargo-cache.md](../design/2026-07-31-layered-cargo-cache.md) — the
Pruning, Registry pruning, Budget and Visibility sections.

**Parent plan:** [Phase C](2026-08-07-layered-cargo-cache-phase-c.md), whose "Carried into Phase D" section this plan
discharges.

## Global Constraints

Every task's requirements implicitly include this section. It is Phase C's list, unchanged except where noted.

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then write the minimal implementation.
- **Coverage gate is 100%** for lines, functions and statements across `src/`, enforced by `bunfig.toml`.
- **`src/index.ts` is excluded from coverage** because nothing imports it. The `cargo metadata` adapter goes there,
  alongside the `@actions/cache` and crates.io ones. Nothing with logic worth testing may live there.
- **Two Bun 1.3.14 coverage quirks**, both in `CLAUDE.md`: a class with field declarations needs an explicit
  `constructor()`, and a `switch` whose `case` bodies are braced blocks that return loses coverage on the last
  closing brace. Use a lookup object — which also buys exhaustiveness, and `cache-prune` is a three-member union.
- **Library source imports siblings as `@rust-toolchain/<module>`**, never `./<module>` and never `@/<module>`.
- **`src/lib.ts` is the barrel** and must never re-export `src/index.ts`. `src/lib.test.ts` pins the complete runtime
  export list; adding a module means updating both, and the module count in the doc comment and the test description.
  Phase C left it at seventeen.
- **Commands are argv arrays executed without a shell.**
- **Every file starts with the SPDX header.**
- **Before every commit**, in this order: `bun run fix:all`, `bun run typecheck`, `bun run test`.
- **Commits are GPG-signed** (`git commit -S`), Conventional Commits, scope `cache`. **Never** a `Co-Authored-By`
  trailer or any attribution line.
- **`dist/` is rebuilt only in the final task, EXCEPT when a task changes `action.yml`.** Phase C learned this the
  hard way: Task 4 changed the `cache-layers` default, the committed bundle rejected it, and every local `act` run
  failed on an action that was broken rather than stale.

## Scope

### In

- A keep-set computed from `cargo metadata` plus cargo's fingerprint records, replacing the `build` layer's
  `incremental/`/`examples/` negations with something deterministic.
- A `cache-prune` input — `off` / `safe` / `aggressive` — governing unattributable artifacts.
- Registry pruning: drop `registry/src`, drop `.crate` files for packages absent from the resolved set, drop git
  checkouts nothing references, keep the index.
- Per-layer `restored`, `pruned` and `saved` byte counts, in the summary table and the `cache` output.
- Settling the `cache-budget` default, which Phase B shipped as `2GB` and the design still describes as `0`.

### Out

- **`cache-save-if`.** Deferred out of Phases C and D deliberately. Orthogonal — _when_ to save, not _what_.
- **Fixing the `ensureTools` binary-name assumption.** Phase C recorded it: the probe is `<crate-name> --version`,
  so `ripgrep` (ships `rg`), `fd-find` and `du-dust` reinstall every run despite a perfect `bin` hit. It is a
  `cargo-tools` defect, not a pruning one, and its fix is a new input spelling or reading `.crates2.json`.
- **Cache backends other than GitHub's**, `sccache`, and a `cache-env-vars` input.

## Decisions this plan settles

### D1. Pruning filters the manifest; it never deletes from disk

This is the decision the phase turns on, and the design and the shipped invariant disagree.

The design says step 4 is _"prune everything in `deps/` and `.fingerprint/` outside the keep-set"_ and step 5
_"always drop"_ several directories — the language of deletion. `CLAUDE.md` says the opposite, in a rule Phase B
wrote after being burned:

> Exclusions from a saved layer are negation globs, never deletion. […] Nothing on disk is ever touched, so a save
> failure cannot damage the working tree. Do not "clean up" a layer by deleting files instead — that changes a
> save-time filter into a destructive operation on the checkout.

**The invariant wins.** Pruning computes which files the archive carries; it does not touch the working tree. Three
reasons, in order of weight:

1. A post step that deletes from `target/` is destructive at the worst possible moment. It runs after the job's real
   work, so a bug in the keep-set calculation surfaces as a build that succeeded and a checkout that is now missing
   artifacts — and on a self-hosted runner, that damage persists into the next job.
2. `cargo metadata` and the fingerprint format are both inputs we do not control. The design already concedes the
   fingerprint format has no stability guarantee. A filter that mis-reads them produces a fatter or thinner archive;
   a deleter that mis-reads them destroys work.
3. Save failures are already caught and downgraded to a `core.warning`, on the principle that a flaky cache service
   must not fail a job that otherwise succeeded. Deletion cannot be undone by a `catch`.

**The mechanism changes with it.** Phase B emits `<target>/**` plus negations, which forced the load-bearing
`!<target>/**/` directory negation, because `@actions/cache` runs `tar --files-from` with no `--no-recursion` and any
directory left in the manifest re-includes everything below it. A keep-set inverts this: emit the kept files
**explicitly** and pass no globstar at all. Nothing to re-include, so the directory-negation hack disappears with the
thing that made it necessary.

That trade has to be measured, not assumed. An explicit manifest for a large workspace may hold tens of thousands of
entries, and `@actions/cache` resolves every path it is handed. Task 4 measures it against the `e2e-probe` crate and
a deliberately larger fixture, and the plan does not proceed to registry pruning until the number is known.

### D2. `cache-prune` governs unattributable artifacts only, and `safe` is the default

An artifact is _unattributable_ when its fingerprint directory is missing, unparseable, or names a package absent
from `cargo metadata`. The design's table stands: `off` prunes nothing at all, `safe` keeps unattributable artifacts
and logs them, `aggressive` prunes them and logs them.

`off` is not the same as Phase B's behaviour and must not be conflated with it. `off` means the archive carries the
whole `target/` — including `incremental/`, which Phase B excluded for good reason and which is worthless in a cache
because cargo rebuilds it per machine. So `off` disables **keep-set** pruning and keeps the Phase B exclusions, which
are unconditional. This is worth stating in the input description, because "off" reading as "Phase B" is the obvious
wrong guess.

### D3. `cache-budget` keeps its `2GB` default

The design says `0` (disabled). Phase B shipped `2GB`, and Phase C's carry-over asked for a revisit once pruning
lands. It stays at `2GB`, and the design text is what changes.

Pruning lowers the typical entry, which makes the ceiling _less_ likely to bite — that is an argument for keeping a
guard that now rarely fires, not for removing it. The reason for the default was never typical size anyway: an
oversized entry does not degrade its own hit rate, it evicts other workflows out of the repository's shared 10 GB
budget. Pruning does not change that externality, it only makes hitting it less common.

### D4. Byte counts are reported, and `pruned` means "excluded from the archive"

`CacheLayerOutput` gains `restoredBytes`, `prunedBytes` and `savedBytes`, all optional for the same reason `result`
and `bytes` are: a consumer reading an older output must not break.

`prunedBytes` is the size of what the keep-set excluded — measured, not deleted, consistent with D1. It is
`measurePaths(everything) - measurePaths(keepSet)`, which is exactly the number that makes the summary table's
"Pruned" column meaningful, and it is only computable because `measurePaths` became negation-aware in Phase C. Before
that fix it would have reported the same number for both.

## File Structure

| File                     | Change | What                                                                      |
| ------------------------ | ------ | ------------------------------------------------------------------------- |
| `src/cache/metadata.ts`  | new    | `MetadataReader` port, `parsePackageSet`                                  |
| `src/cache/prune.ts`     | new    | `PrunePolicy`, `parsePrunePolicy`, `readFingerprints`, `computeKeepSet`   |
| `src/cache/paths.ts`     | modify | `buildPaths` takes an optional keep-set and emits explicit files          |
| `src/cache/budget.ts`    | modify | expose the measured total so `prunedBytes` is a subtraction, not a rescan |
| `src/cache/lifecycle.ts` | modify | thread the keep-set and the three byte counts through save                |
| `src/cache/summary.ts`   | modify | Restored / Pruned / Saved columns                                         |
| `src/outputs.ts`         | modify | `restoredBytes`, `prunedBytes`, `savedBytes` on `CacheLayerOutput`        |
| `src/action.ts`          | modify | read `cache-prune`, build the keep-set before saving                      |
| `src/index.ts`           | modify | the real `cargo metadata` adapter                                         |
| `action.yml`             | modify | `cache-prune` input                                                       |
| `src/lib.ts`             | modify | barrel: seventeen modules becomes nineteen                                |

## The one invariant most likely to be got wrong

**A keep-set that comes back empty must fall back to the Phase B behaviour, never to an empty archive.**

Every failure mode in this phase — `cargo metadata` not on `PATH`, a workspace with no `Cargo.toml`, a fingerprint
directory cargo has restructured, a `--locked` failure on a stale lockfile — produces the same symptom: no packages
resolved, therefore nothing attributable, therefore a keep-set of zero files. Saving that is not a small cache, it is
a **poisoned** one: an entry that exists, hits its key, restores nothing, and makes every later job rebuild from
scratch while believing it was warm.

So an empty or unresolvable keep-set is not a valid result. It falls back to Phase B's glob set and warns. `off` does
the same thing deliberately, which means the fallback path is exercised by an ordinary supported configuration rather
than only by a rare failure.

---

## Task 1: Read the package set from `cargo metadata`

**Files:** create `src/cache/metadata.ts`, `src/cache/metadata.test.ts`; modify `src/lib.ts`, `src/lib.test.ts`.

**Behaviour.** A `MetadataReader` port with one method returning `cargo metadata --format-version 1 --locked` stdout.
`parsePackageSet` reads that JSON into a `Set<string>` of `<name> <version>` identifiers, plus the workspace members
separately, since step 5 of the design always drops the workspace's own crates — they are rebuilt from source that is
already in the checkout.

Malformed JSON, a missing `packages` array, and an entry missing `name` or `version` each throw a message naming what
was wrong. The caller downgrades that to a warning and the Phase B fallback; the parser does not decide policy.

**Steps:**

- [ ] Tests: a two-package document; workspace members separated from dependencies; malformed JSON; absent `packages`; an entry missing `version`; an empty but valid document resolving to an empty set. Watch them fail.
- [ ] Implement `parsePackageSet` and declare `MetadataReader`.
- [ ] Barrel, pinned export list, module count, gates.
- [ ] `git commit -S -m "feat(cache): read the resolved package set from cargo metadata"`

---

## Task 2: Map artifacts to packages through cargo's fingerprints

**Files:** create `src/cache/prune.ts`, `src/cache/prune.test.ts`; modify `src/lib.ts`, `src/lib.test.ts`.

**Behaviour.** `parsePrunePolicy` reads `cache-prune` into `off | safe | aggressive`, rejecting anything else by
name — a `Record<PrunePolicy, …>` lookup, not a `switch`, per the coverage quirk.

`readFingerprints` walks `target/<profile>/.fingerprint/`, whose directory names are `<pkg>-<hash>`, and reads the
`*.json` inside each to recover the package a hash belongs to. This is the whole point of the phase: `rust-cache`
infers ownership by stripping a trailing `-$hash` from a filename and string-comparing the remainder, which is a
guess; the fingerprint directory records the mapping authoritatively.

`computeKeepSet` takes the package set, the fingerprint map and the policy, and returns the files to archive plus the
unattributable ones it decided about. Per the design's risk table, an unparseable fingerprint **keeps** its artifacts
under `safe` and never throws: worst case on a cargo upgrade is a fatter cache, never a corrupted one.

**Steps:**

- [ ] Tests for `parsePrunePolicy`: each of the three values, whitespace, an unknown value naming the input, the empty string defaulting to `safe`. Watch them fail.
- [ ] Tests for `readFingerprints` against an injected directory reader: a well-formed pair; a directory whose name has no `-<hash>`; an unreadable JSON; an empty `.fingerprint/`.
- [ ] Tests for `computeKeepSet`: an artifact belonging to a resolved package is kept; one belonging to a dropped package is not; a workspace member's own artifacts are never kept; unattributable under each of the three policies; `off` returning no keep-set at all.
- [ ] Implement, barrel, pinned list, gates.
- [ ] `git commit -S -m "feat(cache): map target artifacts to packages by fingerprint"`

---

## Task 3: Emit the keep-set as an explicit manifest

**Files:** modify `src/cache/paths.ts`, `src/cache/paths.test.ts`.

**Behaviour.** `buildPaths` gains an optional keep-set. Given one it emits those files explicitly and **no** globstar;
given none it emits exactly today's Phase B glob set, unchanged, which is both the `off` path and the fallback.

Pin the absence of the globstar in a test, not just the presence of the files. The reason the directory negations
existed was that a globstar re-included excluded subtrees; a keep-set manifest that still carried one would silently
archive everything and every pruning test above it would pass anyway.

**Steps:**

- [ ] Tests: a keep-set emits exactly its files and nothing matching `**`; an absent keep-set reproduces the Phase B array byte for byte, including both directory negations; an empty keep-set is treated as absent, not as "archive nothing".
- [ ] Implement, gates.
- [ ] `git commit -S -m "feat(cache): archive the keep-set as an explicit manifest"`

---

## Task 4: Measure the manifest before going further

**Files:** none committed except a note in this plan.

**Behaviour.** Not a code task. D1 defers a real question — an explicit manifest for a large workspace may hold tens
of thousands of entries, and `@actions/cache` resolves every path it is handed. Measure it before building registry
pruning on top.

Build `e2e-probe` and a second fixture with a dependency tree deep enough to matter, then compare the two manifests
for entry count, resolution wall-clock, and resulting archive size.

**Record the numbers in this task's commit message**, including the case against: if resolution costs more than the
transfer it saves, the keep-set becomes negation globs over the pruned set instead, which is a smaller change than it
sounds because D1 already forbids deletion either way.

**Steps:**

- [ ] Build both fixtures, resolve both manifests, record entry count, wall-clock and archive size.
- [ ] `git commit -S -m "docs(cache): record the keep-set manifest measurements"` — amend this plan with the result and, if the explicit manifest loses, replace Task 3's approach before continuing.

---

## Task 5: Registry pruning

**Files:** modify `src/cache/paths.ts`, `src/cache/paths.test.ts`, `src/cache/prune.ts`.

**Behaviour.** `registryPaths` gains the same treatment: drop `registry/src` wholesale (regenerable from the `.crate`
files beside it), drop `.crate` files for packages absent from the resolved set, drop git checkouts nothing
references, and keep the index.

Note what makes this safe where the `build` layer needed care: `registry/src` is derived data with a deterministic
source sitting next to it in the same archive, so excluding it costs a decompression on the far side and nothing else.

**Steps:**

- [ ] Tests: `registry/src` never appears; a `.crate` for a resolved package is kept; one for an absent package is not; the index is always kept; with no package set the Phase B behaviour returns.
- [ ] Implement, gates.
- [ ] `git commit -S -m "feat(cache): prune the registry layer to the resolved package set"`

---

## Task 6: Report restored, pruned and saved bytes

**Files:** modify `src/cache/budget.ts`, `src/cache/lifecycle.ts`, `src/cache/summary.ts`, `src/outputs.ts` and their
tests.

**Behaviour.** D4. `CacheLayerOutput` gains three optional counts; `renderSummary` grows Restored / Pruned / Saved
columns; `prunedBytes` is `measurePaths(all) - measurePaths(keepSet)`.

The subtraction is only correct because `measurePaths` became negation-aware in Phase C. Assert that directly, with a
layer whose exclusions are non-trivial: before that fix both measurements returned the same number and the column
would have read `0` for every layer while pruning worked perfectly.

**Steps:**

- [ ] Tests for the three counts through the lifecycle, the summary table's new columns, and the `cache` output's shape. Watch them fail.
- [ ] Implement, gates.
- [ ] `git commit -S -m "feat(cache): report restored, pruned and saved bytes per layer"`

---

## Task 7: Wire it into the action

**Files:** modify `src/action.ts`, `src/action.test.ts`, `src/index.ts`, `action.yml`.

**Behaviour.** Read and validate `cache-prune` alongside the other `cache-*` inputs, before anything is installed.
Build the keep-set in the **post** phase, not the main phase: it describes what to save, the main phase has not built
anything yet, and computing it early would read a `target/` that does not exist.

The real `cargo metadata` adapter goes in `src/index.ts`, next to the `@actions/cache` and crates.io ones.

**The fallback is the assertion that matters.** A `cargo metadata` failure, an empty package set, and an empty
keep-set must each fall back to the Phase B glob set and warn — never save an empty archive. Test all three.

Rebuilds the bundle in this task, because it changes `action.yml`.

**Steps:**

- [ ] Tests: `cache-prune` validated before any command runs; the keep-set computed in the post phase; a metadata failure warning and falling back; an empty package set falling back; `off` using the Phase B set without calling metadata at all.
- [ ] Implement, wire `src/index.ts`, declare the input in `action.yml`, rebuild `dist/`, gates.
- [ ] `git commit -S -m "feat(cache): prune the build layer against the resolved package set"`

---

## Task 8: Documentation, bundle, and end-to-end proof

**Files:** modify `README.md`, `docs/ARCHITECTURE.md`, `docs/COMPARISON.md`, `AGENTS.md`, `CLAUDE.md`,
`.github/workflows/cicd.yml`, `docs/design/2026-07-31-layered-cargo-cache.md`, `dist/index.js`.

**Behaviour.** The E2E assertion carries the risk again, and Phase C's lesson applies directly: **an assertion that a
pruned file is absent from the restored tree proves nothing on its own** unless that file provably existed when the
job saved. `e2e` already builds `e2e-probe` with an example target, so assert against a dependency the probe crate
does not use, introduced into `target/` on purpose and then removed from `Cargo.toml`, so the keep-set must drop it.

Docs: `CLAUDE.md` gains D1 as an invariant next to the existing negation-glob rule — the two are the same principle
and a reader who finds only one of them will assume the other was an oversight. The design document's Budget section
is corrected to `2GB` per D3, and its Pruning section reworded from deletion to filtering per D1.

**Steps:**

- [ ] Add the E2E pruning assertion, non-vacuously.
- [ ] `mise run readme && bun run fix:all` — both `action-docs-all` markers keep `source`, `project` and `version`.
- [ ] Update the prose docs, correct the design document, and the VitePress sidebar.
- [ ] `bun run build`, recording the new `wc -c dist/index.js`. No new dependency, so a large jump means something was imported that should have stayed behind a port.
- [ ] `bun run fix:all && bun run typecheck && bun run test && bun run build && hk check --all`
- [ ] `git commit -S -m "docs(cache): document pruning and rebuild the bundle"`

---

## Phase D completion check

- [ ] `bun run test` passes at 100% lines, functions and statements.
- [ ] `hk check --all` is clean.
- [ ] `git diff --exit-code dist/` is clean after `bun run build`.
- [ ] `action.yml` declares `cache-prune`, and the design document no longer says `cache-budget` defaults to `0`.
- [ ] A workspace whose `cargo metadata` fails still saves a usable cache, and warns.
- [ ] `E2E Warm Cache` proves a dropped dependency's artifacts are absent from the restored tree, on all three operating systems.
- [ ] Nothing in `src/` deletes from the working tree.

## Carried into Phase E

- `cache-save-if`, if it is ever actually wanted.
- The `ensureTools` binary-name assumption from Phase C: `ripgrep` ships `rg`, so the `<crate-name> --version` probe fails and the tool reinstalls on every run despite a perfect `bin` hit. The fix is a `<name>@<version>=<binary>` spelling or reading cargo's `.crates2.json`.
- Revisit `cache-budget` again if pruning turns out to change typical entry sizes by more than an order of magnitude.
