<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Layered Cargo Cache — Phase B Design

Status: approved
Date: 2026-07-31
Parent: [Phase A design](2026-07-31-layered-cargo-cache.md)

## Summary

Phase A derives cache keys and publishes them. Phase B acts on them: the action restores the layers at the start of a
job and saves them at the end, through a `post:` entrypoint. That is the step which retires `Swatinem/rust-cache` from
a workflow rather than merely complementing it.

Two things arrive alongside the lifecycle because building the lifecycle on top of them would be building on a known
defect: the `build` key gains an environment digest, and saving is bounded by a size budget.

## Settled decisions

| #   | Decision                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Use `@actions/cache`, accepting a ~2.1 MB committed bundle | Measured: `@actions/cache` adds 1,420,414 bytes to a 774,094-byte bundle, 283% of today, almost entirely the Azure storage SDK. Accepted because `.gitattributes` already anticipates a 3+ MB bundle and marks `dist/**` `linguist-generated`, and because the alternative is reimplementing `ACTIONS_RUNTIME_TOKEN` auth, the v2 twirp API and tar+zstd streaming — a security-sensitive surface that breaks whenever GitHub revises the protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | The `build` key gains an `envHash`                         | Two jobs differing only in `RUSTFLAGS` derive the same key today. The second restores artifacts cargo rejects, rebuilds everything, then cannot save because the key is taken — so it never benefits from the cache, silently and permanently. Phase B's skip-on-exact-hit deepens this: the second job gets an exact match and skips saving by design, so nothing ever registers as a miss.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | A fixed env prefix set, no `cache-env-vars` input          | `CARGO_`, `CC`, `CFLAGS`, `CXX`, `CMAKE`, `RUST` — `rust-cache`'s default set. A project driven by some other variable already has `cache-key-suffix`; a second mechanism for one problem is not worth the surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Phase B ships minimal exclusions, not pruning              | Deterministic pruning needs `cargo metadata` and a keep-set, which is Phase D. Everything excluded here is provably regenerable or provably unwanted, so it needs no ownership analysis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | `cache-budget` defaults to `2GB` per layer, not `0`        | A departure from the Phase A spec, which had it off. With Phase B actually writing, off-by-default means the first oversized `target/` evicts other workflows' caches with no warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | `run` becomes `async`                                      | `@actions/cache` is promise-based. This is a breaking change to a public export and belongs in the release notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7   | Exclusions are negation globs on a files-only manifest     | `rust-cache` deletes what it does not want before saving, which is why its own README warns against self-hosted runners. Describing what to archive beats mutating the machine to make the archive smaller, and a failed save leaves nothing damaged — that conclusion stands. The mechanism first specified here did not: negation globs only take effect when the manifest contains files and no ancestor directories, because `@actions/cache` runs `tar --files-from` without `--no-recursion`, so any directory left in the manifest is expanded wholesale and re-includes everything the negations removed. `buildPaths` therefore also excludes directories (`!<target>/` and `!<target>/**/`). The cost is that the archive carries no directory entries, so empty directories and directory permissions and mtimes are not preserved. Acceptable for a cargo target directory: cargo decides freshness from file mtimes, recreates any directory it needs, and an empty directory in `target/` holds no build state. `registryPaths` keeps naming bare directories, because it has nothing to exclude and recursion is exactly what archives it. |
| 8   | A cache failure never fails the build                      | `@actions/cache` throws on service outages, oversized entries and reserved-key races. None is a reason to fail a job that otherwise succeeded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Key algebra

Only the `build` key changes.

```text
registry-<os>-<arch>-<suffix>-<lockHash>                          unchanged
  ↳ registry-<os>-<arch>-<suffix>-
  ↳ registry-<os>-<arch>-

build-<os>-<arch>-<suffix>-<cachekeyFull>-<envHash>-<lockHash>
  ↳ build-<os>-<arch>-<suffix>-<cachekeyFull>-<envHash>-
```

`envHash` is a SHA-256 over the sorted `NAME=VALUE` pairs of every environment variable whose name begins with
`CARGO_`, `CC`, `CFLAGS`, `CXX`, `CMAKE` or `RUST`, truncated to the first 8 hex characters — the same width
`generateSpecCacheKey` uses. The restore ladder carries it too, so a fallback never crosses an environment boundary any
more than it crosses a toolchain one.

### The deny-list inside that prefix set

Three matches describe where or how rather than what gets built, and hashing them would churn keys without changing a
single artifact:

- `CARGO_HOME`, `RUSTUP_HOME` — absolute paths that vary per machine on self-hosted runners.
- `CARGO_TERM_COLOR` — presentation only.
- `RUSTUP_TOOLCHAIN` — already inside `cachekeyFull`.

Three more are denied for a different reason: they are the action's own output read back as its input. That list must
stay in sync with `applyCargoDefaults` — see "Why reading it early is not enough on its own" below.

- `CARGO_INCREMENTAL`, `CARGO_REGISTRIES_CRATES_IO_PROTOCOL`, `CARGO_HTTP_MULTIPLEXING`.

### Why reading it early is not enough on its own

The action exports `CARGO_INCREMENTAL=0`, `CARGO_TERM_COLOR` and — on 1.66–1.71 —
`CARGO_REGISTRIES_CRATES_IO_PROTOCOL` and `CARGO_HTTP_MULTIPLEXING` through `core.exportVariable`. Reading the digest
before `applyCargoDefaults` runs keeps those out of this process's `deps.env`, which is necessary: reading it after
would put values the action invented into every key.

It is not sufficient, and the argument first written here stopped one step short. `core.exportVariable` writes to
`GITHUB_ENV`, so a **second invocation of the action in the same job** starts with everything the first one exported
already in its environment, indistinguishable from values the caller set. Measured: `envHash` was `e3b0c442` on the
first invocation and `dd704211` on the second, so the second derived a `build` key that nothing would ever restore and
that the first would never save. The CI `E2E` job invokes the action twice in one job by design, so this is a
configuration that exists rather than one that might.

The deny-list therefore covers the action's own exports as well, and must stay in sync with `applyCargoDefaults`:
adding a `setIfUnset` call there without adding the name to `EXCLUDED` reintroduces the drift, and no test of
`applyCargoDefaults` alone would notice.

### Cost

Adding `envHash` changes every existing `build` key once, so every workflow takes one cold build. Paid deliberately at
0.1.x, while the feature is days old, rather than after adoption.

## Layers

| Layer      | Paths                                                                            | Phase B exclusions                                                                                           |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `registry` | `$CARGO_HOME/registry/index`, `$CARGO_HOME/registry/cache`, `$CARGO_HOME/git/db` | none needed                                                                                                  |
| `build`    | per workspace: `<target>/**`                                                     | `!<target>/**/incremental/**`, `!<target>/**/examples/**`, plus `!<target>/` and `!<target>/**/` (see below) |

The registry layer needs no exclusion because listing the three wanted directories explicitly means
`$CARGO_HOME/registry/src` is never included — better than excluding it, since there is nothing to keep in sync. It
also means the layer can name bare directories and let tar recurse into them: one manifest line per layer, and
directory entries preserved.

The build layer cannot do that, because it has something to exclude. Two corrections to the reasoning first written
here:

1. **The glob depth was wrong.** This table named `<triple>/debug` as a layout it could not enumerate, then specified
   `!<target>/*/incremental` — single-level, and therefore unable to reach `<target>/<triple>/debug/incremental`,
   which is precisely the layout the action's own `targets` input produces. It has to be `**` at both ends.
2. **The mechanism was wrong.** "Negation globs, which `@actions/cache` honours through `@actions/glob`" is true of the
   glob step alone. `@actions/cache` resolves the patterns with `implicitDescendants: false`, writes the matches to a
   manifest, then runs `tar --files-from <manifest>` with no `--no-recursion`. Any directory left in that manifest is
   expanded wholesale by tar, re-including everything the negations removed. The original `[<target>, …]` form resolved
   to exactly one entry — the directory `<target>` — from which tar archived the entire tree, negations and all.

So the exclusions are only real on a files-only manifest, which is what `!<target>/` and `!<target>/**/` produce. The
trade-off is recorded in decision 7: no directory entries in the archive, hence no empty directories and no directory
permissions or mtimes. Cargo depends on none of those.

## Lifecycle

### Entrypoints

```yaml
runs:
  using: "node24"
  main: "dist/index.js"
  post: "dist/index.js"
  post-if: "success() || env.RUST_TOOLCHAIN_CACHE_ON_FAILURE == 'true'"
```

One bundle serves both phases, branching on `process.env.STATE_isPost`, which GitHub sets once the main phase calls
`core.saveState("isPost", "true")`. Two bundles would each inline the Azure SDK. `post-if` reads an environment
variable because the `inputs` context is unavailable there; the main phase exports it so the post gate can see the
input's value.

### Main phase

```text
0    saveState("isPost")           first statement in the try, before anything
                                   that can throw — see below
1    readCacheRequest              validation first among the throwing steps
2-6  resolve toml, install toolchain, export RUSTUP_TOOLCHAIN, read rustc -vV
7    buildCacheOutputs             per-layer keys, now including envHash
--- when caching is enabled --------------------------------------------------
8    resolve layer paths           CARGO_HOME plus cache-workspaces
9    restore the enabled layers    concurrently
10   record per layer              exact | partial | miss
11   saveState                     isPost, layers, keys, paths, restored key,
                                   budget
12   set outputs                   including cache-hit
```

`saveState("isPost", "true")` runs before `readCacheRequest`, and the ordering is load-bearing rather than
incidental. `post-if: success()` still fires when the main phase threw, because `continue-on-error: true` on the
action's step keeps the job status successful. With `isPost` set after validation, a bad `cache-budget` would leave
`STATE_isPost` unset, and `src/index.ts`'s dispatch would then re-run the entire main phase as the post step. "isPost
set, no cache payload" is already the proven caching-disabled no-op. The dispatch lives in coverage-excluded
`src/index.ts`, so no unit test can reach it — which is exactly why the invariant is structural rather than argued.

Restore lands after the toolchain install unavoidably: the `build` key contains `cachekeyFull`, which does not exist
until `rustc -vV` has run. That costs nothing in practice — these are cargo caches consumed by later `cargo` steps, not
by rustup.

### Post phase

```text
1  read state; return if caching was disabled
2  measure each layer
3  per layer: an exact hit means the entry already exists, so skip the save
4  per layer: over budget after exclusions means skip the save, with a warning
5  save what remains
6  write the job summary
```

There is no `cache-save-if` step. An earlier draft of this section listed one; the input does not exist and Phase B
never shipped it. It is Phase C scope if it is wanted at all — recorded here so Phase C does not inherit it as an
assumed requirement.

Step 3 is where the layering pays off. Skip-on-exact-hit is only sound when the key covers everything that could have
changed the content; a monolithic key cannot offer that guarantee, which is why `rust-cache` saves unconditionally and
accepts the write amplification. Per-layer keys make the guarantee checkable, so the optimisation becomes available
rather than reckless.

### Error handling

Every `restore` and `save` is wrapped: on throw, warn and continue. The only fail-fast path remains Phase A's input
validation, because a malformed key is a configuration error rather than a transient.

## Ports

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

The real implementation wraps `@actions/cache`; tests pass a fake. Without this the 100% coverage gate is unreachable
for the lifecycle, since the alternative is 1.39 MB of unmockable network code.

## `cache-workspaces`

One `<manifest-dir> -> <target-dir>` mapping per line, default `. -> target`, both sides resolved against
`GITHUB_WORKSPACE`. The syntax matches `rust-cache`, so existing workflow values transfer unchanged.

A mapping resolving outside `GITHUB_WORKSPACE` is rejected. Cache paths come from workflow input, and a path escaping
the checkout would let a cache entry read or overwrite files outside it.

## Budget

`cache-budget` accepts a bare byte count or a suffixed size — `K`, `M`, `G`, `T`, optionally with a trailing `B`,
case-insensitive, binary rather than decimal. `0` disables the check. An unparseable value fails the step rather than
silently disabling the budget.

Sizes are measured by walking the resolved paths during the post phase. On a multi-GB tree that costs a few seconds,
which buys the warning; letting `@actions/cache` fail on an oversized entry instead would be free but silent.

## Outputs

- `cache-hit` — `true` only when every enabled layer hit exactly.
- `cache` — the existing JSON, each layer gaining `result` (`exact`, `partial` or `miss`) plus restored, excluded and
  saved byte counts.

Both also fold into the existing `json` output.

## Module layout

```text
src/cache/client.ts      CacheClient port and the @actions/cache adapter
src/cache/env.ts         envHash: prefix set, deny-list, digest
src/cache/paths.ts       cache-workspaces parsing, layer paths, exclusion globs
src/cache/budget.ts      size parsing, measurement, enforcement
src/cache/lifecycle.ts   restore (main) and save (post)
src/cache/summary.ts     the job summary table
src/cache/keys.ts        modified: envHash enters the build key
src/cache/inputs.ts      modified: reads cache-workspaces and cache-budget
src/action.ts            modified: async, restores, hands state to the post phase
src/index.ts             modified: branches on STATE_isPost, awaits run
```

## Testing

The 100% line, function and statement gate applies throughout, and TDD is mandatory.

- **`env`, `paths`, `budget` parsing, `keys`** — pure functions, directly unit tested.
- **`lifecycle`** — driven through the `CacheClient` port with a fake, so no network and no `@actions/cache`.
- **`budget` measurement** — a fixture tree written to a temporary directory.
- **End to end** — two CI jobs, because one cannot do it. A second action invocation inside the `E2E` job cannot
  observe a warm cache: `post:` runs only after every other step in the job, so nothing that job saves is visible to
  it. What the second same-job invocation does prove is that the derived keys do not move between two invocations —
  the `envHash` regression above. Observing a real save needs a separate `E2E Warm Cache` job with `needs: [e2e]`,
  which starts only once the first job's post step has finished; it asserts `cache-hit == 'true'` and that the
  restored target directory contains no `incremental`. Those two jobs are the only place restore and save meet the
  real cache service, and `release` gates on both.

Bun's two documented coverage quirks still apply: a class with field declarations needs an explicit `constructor()`,
and a `switch` whose `case` bodies are braced blocks that return loses coverage on the last closing brace.

## Risks

| Risk                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The committed bundle nearly triples, and `dist/` changes on every source commit | Measured and accepted (decision 1). `.gitattributes` already collapses the diff. Revisit only if repository growth becomes a real problem.                                                                                                                                                                                                                                     |
| `run` going async breaks library consumers                                      | Called out in the release notes. The package is `private: true` with no `exports` map, so the blast radius is small and the break is a loud compile error.                                                                                                                                                                                                                     |
| Negation globs in `@actions/cache` paths are less exercised than plain paths    | They were also wrong as first specified — see decision 7. Verified twice over now: at the tar layer against a fixture tree, and in CI by the `E2E Warm Cache` job, which restores an entry saved by a _previous_ job and asserts no `incremental` directory survived into it. If they prove unreliable, the fallback is `rust-cache`'s destructive delete, accepted only then. |
| A `2GB` default silently stops caching a large project                          | It is not silent: an over-budget layer warns with the measured size and the input to raise.                                                                                                                                                                                                                                                                                    |
| Saving unpruned target directories still produces large entries                 | Bounded by the budget, and Phase D replaces the exclusions with a deterministic keep-set.                                                                                                                                                                                                                                                                                      |

## Out of scope

- Deterministic pruning from `cargo metadata` — Phase D.
- The `bin` layer and cargo-tool installation — Phase C.
- Cache backends other than GitHub's.
- `sccache` or any distributed compilation cache.
- A `cache-env-vars` input (decision 3).
