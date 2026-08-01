<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Design

Status: approved, not yet planned
Date: 2026-07-31

## Summary

Extend this action from "install a Rust toolchain" to "install a Rust toolchain, install cargo tools, and manage the
caches for both". Caching is partitioned into three independent GitHub Actions cache entries — `registry`, `build` and
`bin` — each keyed on what actually invalidates it. The action gains a `post:` phase that prunes deterministically and
saves only the layers whose inputs moved.

The immediate trigger was a 29-line `bash` step in a downstream composite action that computed three cache keys by
hand. That step disappears: its three keys become the three layers, and its portability workarounds (`sha256sum` versus
`shasum`, ISO-week rotation) stop being necessary.

## Motivation

### What Swatinem/rust-cache actually does

Worth stating precisely, because the common description is wrong and the wrong description leads to the wrong fix.

`rust-cache` stores `~/.cargo` **and** `./target` in a single cache entry. Its primary key includes a hash of the
lockfile; its restore-keys array is a single fallback key that omits the lockfile hash
(`src/restore.ts`, `src/config.ts`).

So on a dependency bump:

- the exact key misses;
- the fallback key hits, and the previous entry is restored — registry and target together;
- cargo rebuilds what changed;
- `src/save.ts` then saves a **complete new entry** under the new key. There is no exact-hit check on the restore path.

The failure is therefore **not** a wasted download. It is write amplification: every lockfile change writes another full
copy of `~/.cargo` plus `target` into a repository-wide 10 GB budget, and GitHub evicts globally by least-recent-use.
An oversized entry does not degrade its own hit rate — it evicts other workflows' caches, so the symptom surfaces
somewhere else entirely.

### The four failure modes this design targets

| Failure mode                                        | Root cause                                                            | Addressed by                               |
| --------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| Everything re-saves when one input moves            | One entry, one key, mixed invalidation rates                          | Layer model                                |
| 10 GB budget exhaustion and cross-workflow eviction | Full re-save per lockfile change; no size accounting                  | Skip-save on exact hit; `cache-budget`     |
| Pruning is heuristic and silent                     | Ownership inferred by string-munging filenames; `catch {}` everywhere | Deterministic keep-set; no silent failures |
| No way to tell a cold run from a broken key         | A single `cache-hit` boolean                                          | Per-layer outputs and job summary          |

The first two are one problem. Monolithic entries cause the eviction churn, so partitioning fixes both.

## Settled decisions

Each was decided explicitly during design. Recorded here so the implementation plan does not reopen them.

| #   | Decision                                                                    | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clean-sheet input surface, not `rust-cache`-compatible                      | Its vocabulary (`prefix-key`, `cache-all-crates`, `cache-targets`) describes one monolithic entry. Those names cannot honestly map onto N layers.                                                                                                                                                                                                                                                                           |
| 2   | The caller passes `hashFiles()` in as `cache-key-hash`                      | `hashFiles()` is a workflow-expression function; a Node action cannot call it. Taking GitHub's own value guarantees parity with any existing cache and adds no dependency.                                                                                                                                                                                                                                                  |
| 3   | Empty key segments collapse rather than leaving a separator                 | `cargo-Linux-X64-<hash>`, never `cargo-Linux-X64--<hash>`. Trivial in TypeScript, awkward in GitHub expressions — one of the strongest reasons to move the logic in.                                                                                                                                                                                                                                                        |
| 4   | The action installs cargo tools, and keys on resolved versions              | Whoever installs knows the version. Putting it in the key removes the calendar-rotation workaround entirely.                                                                                                                                                                                                                                                                                                                |
| 5   | Three layers: `registry`, `build`, `bin`                                    | Partition by invalidation rate, which is what makes independent saves possible.                                                                                                                                                                                                                                                                                                                                             |
| 6   | `bin` excludes rustup's shims, so the toolchain leaves its key              | Cargo-installed binaries are standalone executables. Filtering the shims removes the only reason the toolchain was in that key.                                                                                                                                                                                                                                                                                             |
| 7   | The `build` restore ladder never crosses a `cachekey-full` boundary         | Artifacts from a different rustc are discarded on sight. Restoring them costs download time to gain nothing, then re-saves as a fresh entry.                                                                                                                                                                                                                                                                                |
| 8   | One bundle serves both `main` and `post`, branching on `STATE_isPost`       | Two bundles would each inline `@actions/cache` and double what is committed to git.                                                                                                                                                                                                                                                                                                                                         |
| 9   | `post-if` reads an exported env var, not `inputs`                           | The `inputs` context is unavailable in `post-if`. Without the indirection the post step silently never runs.                                                                                                                                                                                                                                                                                                                |
| 10  | `cache-save-if` defaults to `true` — every branch saves                     | User's call, matching `rust-cache`. Consequence: budget enforcement is the only remaining defence against eviction, so it carries more weight. **Not shipped in Phase B, and not implemented anywhere: the input does not exist.** Phase B saves unconditionally, gated only by `cache-on-failure`. Deferred to Phase C — recorded here so the references below read as a plan rather than as a description of what exists. |
| 11  | Keep-set derived from `cargo metadata` cross-referenced with `.fingerprint` | Turns an ownership guess into a lookup.                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | The `mtime` older-than-one-week sweep is deleted                            | A proxy for "probably unused" that silently discards valid artifacts on any repo building less than weekly. An authoritative keep-set leaves it no job.                                                                                                                                                                                                                                                                     |
| 13  | No `catch {}` — every prune failure is reported                             | A failed prune must not fail the job, but must never be invisible.                                                                                                                                                                                                                                                                                                                                                          |
| 14  | `cache-budget` defaults to `0`, meaning off                                 | Refusing to save is an opinion, and opinions belong behind an opt-in.                                                                                                                                                                                                                                                                                                                                                       |
| 15  | Fingerprint parse failure keeps the file and warns — never deletes          | See Risks. This single rule is what makes depending on an unstable format acceptable.                                                                                                                                                                                                                                                                                                                                       |

## Layer model

Three independent cache entries, partitioned by what invalidates them.

| Layer      | Paths                                                                   | Invalidated by                                       | Deliberately not invalidated by              |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `registry` | `~/.cargo/registry/index`, `~/.cargo/registry/cache`, `~/.cargo/git/db` | dependency set (`Cargo.lock`)                        | rustc version, targets, profile, `RUSTFLAGS` |
| `build`    | workspace `target/` directories                                         | lockfile, `cachekey-full`, `RUSTFLAGS` and `CARGO_*` | cargo tool versions                          |
| `bin`      | `~/.cargo/bin` minus rustup's shims                                     | resolved cargo-tool version set                      | toolchain, lockfile, calendar                |

`~/.cargo/registry/src` holds extracted sources regenerable from the `.crate` files in `registry/cache`. It is never
saved.

### Shim exclusion

`~/.cargo/bin` contains both rustup's shims and cargo-installed tools. The shims belong to the toolchain and must not
enter the `bin` layer. They are a known fixed set:

```text
cargo, cargo-clippy, cargo-fmt, cargo-miri, clippy-driver, rls, rust-analyzer,
rust-gdb, rust-gdbgui, rust-lldb, rustc, rustdoc, rustfmt, rustup
```

Excluding them is what allows the toolchain to leave the `bin` key, so bumping stable no longer forces a reinstall of
every cargo tool. It also avoids `rust-cache`'s destructive alternative — deleting any binary present before the action
ran, which is why that action warns against self-hosted runners.

## Key algebra

```text
registry-<os>-<arch>-<suffix>-<lockHash>
  ↳ registry-<os>-<arch>-<suffix>-
  ↳ registry-<os>-<arch>-

build-<os>-<arch>-<suffix>-<cachekeyFull>-<envHash>-<lockHash>
  ↳ build-<os>-<arch>-<suffix>-<cachekeyFull>-<envHash>-

bin-<os>-<arch>-<toolSetHash>
  ↳ bin-<os>-<arch>-
```

- `<os>` and `<arch>` come from `RUNNER_OS` and `RUNNER_ARCH`.
- `<suffix>` is `cache-key-suffix`, omitted entirely when empty (decision 3).
- `<lockHash>` is `cache-key-hash`, supplied by the caller (decision 2).
- `<cachekeyFull>` is the existing `generateSpecCacheKey` output in `src/core.ts`, which already digests channel,
  targets, components and profile with the lists sorted. The build layer reuses it rather than inventing a second
  rustc identity.
- `<envHash>` is a SHA-256 over the sorted `NAME=VALUE` pairs of every environment variable whose name begins with
  `CARGO_`, `CC`, `CFLAGS`, `CXX`, `CMAKE` or `RUST`, truncated to 8 hex characters. It is what makes this table's
  `RUSTFLAGS` and `CARGO_*` claim true; without it two jobs differing only in build flags share a key, and the second
  restores artifacts cargo rejects, rebuilds everything, then cannot save because the key is taken. **Lands in Phase
  B** — Phase A shipped the build key without it, and
  [the Phase B design](2026-07-31-layered-cargo-cache-phase-b.md) records why it could not wait any longer than that.
- `<toolSetHash>` is a SHA-256 over the resolved `name@version` pairs, sorted and newline-joined, truncated to the
  first 8 hex characters — the same truncation `generateSpecCacheKey` already uses, so key segments stay a uniform
  width.

Every key is assembled by joining non-empty segments with `-`.

The `bin` ladder does fall back, because a partial restore is useful there: three of four tools present means installing
one. Restored binaries are version-verified before being accepted, so a partial restore cannot serve a stale tool.

## Lifecycle

### Entrypoints

```yaml
runs:
  using: "node24"
  main: "dist/index.js"
  post: "dist/index.js"
  post-if: "success() || env.RUST_TOOLCHAIN_CACHE_ON_FAILURE == 'true'"
```

The script branches on `process.env.STATE_isPost`, which GitHub sets automatically once the main phase calls
`core.saveState("isPost", "true")`.

### Main phase

```text
1-4  existing: parse rust-toolchain.toml, merge inputs, install toolchain,
     export RUSTUP_TOOLCHAIN, read rustc -vV for cachekey and cachekey-full
--- when cache is enabled -------------------------------------------------
5    resolve cargo-tool specs to concrete versions
6    compute the three layer keys
7    restore the enabled layers in parallel
8    record per layer: exact | partial | miss
9    verify restored tool versions, install what is missing or outdated
10   saveState: isPost, layer keys, restored keys, prune mode, budget
11   set outputs
```

### Post phase

```text
1  read state; return immediately if caching was disabled
2  return if cache-save-if evaluated false, after writing the summary  [Phase C: input not yet implemented]
3  prune every enabled layer: build and registry both have prune rules
4  measure layer sizes
5  per layer: exact hit means the entry already exists, so skip the save
6  per layer: over budget after pruning means skip the save, with a warning
7  save the layers that remain
8  write the job summary
```

Step 2 still writes the summary. A run that restored but deliberately did not save is a normal outcome, and it should
report what it restored rather than going silent.

Step 4 is the write-churn control. Because keys are per-layer, a lockfile bump re-saves `registry` and `build` while
`bin` skips. Under a monolithic entry the same bump re-saves everything.

## Cargo tools

`cargo-tools` accepts a comma-, space- or newline-separated list, matching how `targets` and `components` already parse.
Each entry is `<name>` or `<name>@<version>`, where `<version>` may be `latest`.

- `latest` resolves against crates.io to a concrete version before the key is computed.
- Resolution is network-bound, so it uses the same retry-with-backoff and timeout treatment `src/action.ts` already
  applies to rustup commands.
- If resolution fails after retries and a restored binary exists, the action uses the restored binary and warns. It does
  not fail the job over a registry outage.
- If resolution fails and no binary exists, the step fails.

Tool names are validated against the same character class used for toolchain names, and every install is executed as an
argv array with no shell, consistent with the existing rustup invariants.

## Pruning

```text
1. cargo metadata --format-version 1 --locked          → exact package set
2. read target/<profile>/.fingerprint/<pkg>-<hash>/*.json → hash → package
3. keep-set = artifacts whose hash maps to a package still present in (1)
4. prune everything in deps/ and .fingerprint/ outside the keep-set
5. always drop: incremental/, examples/, the workspace's own crates,
                build/<pruned-pkg>/out, and registry/src/
```

Step 2 is the difference from `rust-cache`, which infers ownership by stripping a trailing `-$hash` from a filename and
string-comparing the remainder. The fingerprint directories already record the mapping authoritatively.

Unattributable files are handled explicitly rather than by assumption:

| `cache-prune`    | Unattributable file |
| ---------------- | ------------------- |
| `off`            | nothing is pruned   |
| `safe` (default) | kept, logged        |
| `aggressive`     | pruned, logged      |

`safe` is the default because trading cache size for never deleting something a build needed is the right side to err
on.

### Registry pruning

- Drop `registry/src` wholesale — regenerable from `.crate` files.
- Drop `.crate` files for packages absent from the lockfile.
- Drop git checkouts not referenced by the package set.
- Keep the registry index.

## Budget

`cache-budget` accepts a size (`2GB`) and defaults to `0`, meaning disabled. When set, a layer still exceeding the
budget after pruning is **not saved**, and the action warns with the measured size and the input to raise.

Refusing to save keeps the cost attached to the job that caused it. An over-budget save externalises its cost onto
unrelated workflows through global least-recent-use eviction, and surfaces as a mystery cache miss elsewhere.

## Visibility

`core.summary` writes one table per run:

| Layer    | Result  | Restored | Pruned | Saved               |
| -------- | ------- | -------- | ------ | ------------------- |
| registry | exact   | 412 MB   | 38 MB  | skipped — unchanged |
| build    | partial | 1.2 GB   | 340 MB | 1.1 GB              |
| bin      | miss    | —        | —      | 46 MB               |

Outputs:

- `cache-hit` — `true` only when every enabled layer hit exactly.
- `cache` — per-layer JSON carrying key, restore key, result, and restored, pruned and saved byte counts.
- `cargo-tools` — resolved `name@version` values as a JSON array.

All three also fold into the existing `json` output, following the pattern `src/outputs.ts` already establishes.

## Input and output surface

```yaml
cache: "false" # opt-in
cache-key-hash: "" # ${{ hashFiles('**/Cargo.lock') }}; required when cache is true
cache-key-suffix: "" # collapses when empty
cache-layers: "registry,build,bin"
cache-save-if: "true" # Phase C — not implemented in Phase B
cache-on-failure: "false"
cache-prune: "safe" # off | safe | aggressive
cache-budget: "0" # off
cache-workspaces: ". -> target"
cache-directories: "" # extra directories, newline separated
cargo-tools: "" # cargo-nextest@latest, cargo-deny@0.16.1
```

### `cache-workspaces` and `cache-directories`

`cache-workspaces` takes one `<manifest-dir> -> <target-dir>` mapping per line, the same syntax `rust-cache` uses, so
existing workflow values transfer unchanged. Both sides are resolved relative to `GITHUB_WORKSPACE`. The default
`. -> target` covers the single-crate and single-workspace cases. Each mapping contributes its target directory to the
`build` layer and its manifest directory to the `cargo metadata` invocation that builds the keep-set.

A mapping resolving outside `GITHUB_WORKSPACE` is rejected. Cache paths come from workflow input, and a path escaping
the workspace would let a cache entry read or overwrite files outside the checkout.

`cache-directories` takes additional absolute or workspace-relative directories, one per line, appended to the `build`
layer. They are cached and restored but never pruned — the action has no ownership model for arbitrary directories, and
guessing one would be exactly the heuristic deletion this design removes.

### `cache-budget` parsing

Accepts a bare byte count or a suffixed size: `K`, `M`, `G`, `T`, optionally with a trailing `B`, case-insensitive.
Suffixes are **binary** — `2GB` means 2 × 1024³ bytes, matching how GitHub reports cache entry sizes. `0` disables the
check. An unparseable value fails the step rather than silently disabling the budget.

### `cache-key-hash` is required, conditionally

It is a hard error, not a warning, when `cache` is `true` and either the `registry` or `build` layer is enabled. Without
a lockfile component those keys never change: they hit exactly forever, never re-save, and silently serve stale crates
for the life of the repository. A permanently-wrong cache is worse than a step that fails on line one telling the caller
what to paste.

It is **not** required when `cache-layers` names only `bin`, whose key derives entirely from the resolved tool set and
has no lockfile component to miss.

## Module layout

`src/` is flat today. Cache code goes in a subdirectory; the `@rust-toolchain/*` alias already resolves nested paths, so
no `tsconfig.json` change is required.

```text
src/cache/layers.ts      layer definitions: id, paths, shim exclusions
src/cache/keys.ts        key and restore-ladder derivation (pure)
src/cache/client.ts      CacheClient port plus the @actions/cache adapter
src/cache/prune.ts       keep-set from cargo metadata and .fingerprint
src/cache/budget.ts      size measurement and budget enforcement
src/cache/lifecycle.ts   restore (main) and save (post)
src/cache/summary.ts     job summary table and cache outputs
src/tools.ts             cargo-tool spec parsing, resolution, installation
```

`src/lib.ts` gains the public modules, and `src/lib.test.ts` asserts the export list — that test fails until updated, by
design.

## Testing strategy

The 100% line, function and statement gate applies throughout, and TDD is mandatory: test first, then the minimal
implementation.

- **Keys and layers** — pure functions, directly unit tested.
- **Lifecycle** — the existing `run(deps: ActionDeps)` injection extends with one port, keeping `@actions/cache` out of
  the unit tests entirely:

```ts
export interface CacheClient {
  restore(
    paths: string[],
    key: string,
    restoreKeys: string[],
  ): Promise<string | undefined>;
  save(paths: string[], key: string): Promise<void>;
}
```

- **Tools** — fake exec plus a fake crates.io client.
- **Pruning** — fixture `target` trees written to a temporary directory. This is the most expensive area to cover and
  should be budgeted accordingly.
- **End to end** — an `act` workflow under `.github/workflows/tests/` building a real small crate, to check prune
  behaviour against a genuine `target` directory rather than a synthetic one.

Any class with field declarations needs an explicit constructor, even an empty one, or Bun's coverage reports a phantom
uncovered function.

## Build order

| Phase | Ships                                                      | New dependencies | Bundle impact |
| ----- | ---------------------------------------------------------- | ---------------- | ------------- |
| A     | Layer model and key algebra, exposed as outputs            | none             | unchanged     |
| B     | `CacheClient`, lifecycle, `post:` entrypoint               | `@actions/cache` | measure here  |
| C     | Cargo-tool resolution and installation; `bin` becomes real | none             | small         |
| D     | Deterministic pruning and budget                           | none             | small         |
| E     | Summary, outputs, docs, README regeneration                | none             | none          |

Phase A ships useful on its own — it is the downstream `bash` step, deleted. Phase B is the structural commitment.
Phase D is where the effort concentrates.

## Risks

| Risk                                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.fingerprint/*/*.json` is cargo's internal format with no stability guarantee and changes between releases without notice | An unparseable or unrecognised fingerprint keeps the file and warns; it never deletes. Worst case on a cargo upgrade is a fatter cache, never a corrupted one. This rule is what makes depending on the format acceptable, and is very likely why `rust-cache` resorts to string-munging instead. |
| `@actions/cache` pulls the Azure storage SDK; `dist/index.js` is 769 KB, committed, with CI failing on drift               | Measure at the start of phase B. Egregious growth is legitimate grounds to reopen the lifecycle design.                                                                                                                                                                                           |
| Synthetic prune fixtures diverge from real `target` layouts                                                                | `safe` default, every decision logged, plus the `act` end-to-end build against a real crate.                                                                                                                                                                                                      |
| crates.io unavailable during `@latest` resolution                                                                          | Retry with backoff, then fall back to a restored binary; fail only when neither is available.                                                                                                                                                                                                     |
| Every branch saves (decision 10), so PR-scoped entries consume the shared budget and are discarded when the PR closes      | `cache-budget` and skip-save-on-exact-hit are the available levers, and both ship in Phase B. The `cache-save-if` default-branch-only recipe needs the input to exist first — Phase C.                                                                                                            |

## Documentation to update

- `README.md` — regenerate between the `action-docs-all` markers via `mise run readme`, then `bun run fix:all` so
  Prettier realigns the tables.
- `AGENTS.md` and `CLAUDE.md` — the new module layout, the `post:` entrypoint, and the cache invariants.
- `docs/ARCHITECTURE.md` — layer model and lifecycle diagram.
- `docs/COMPARISON.md` — the comparison against `rust-cache`, including the write-amplification analysis above.

## Out of scope

- Cache backends other than GitHub's. No `warpbuild`, `buildjet` or S3 provider.
- `sccache` or any distributed compilation cache.
- Incremental compilation artifacts. `CARGO_INCREMENTAL=0` remains the expectation in CI; incremental state is large,
  machine-specific, and rebuilt cheaply.
- Compatibility aliases for `rust-cache` input names (decision 1). A migration table in the README covers the move.
