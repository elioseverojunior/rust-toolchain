<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# AGENTS.md

The canonical instruction file for every AI agent in this repository. Codebase
knowledge belongs here — architecture, invariants, commands, conventions, and
the reasoning behind them — because it is true whichever agent or harness is
reading.

`CLAUDE.md` includes this file with `@AGENTS.md` and carries only what is
specific to Claude Code as a harness. A tool that offers to record what it
learned about this codebase updates THIS file, whatever its own documentation
says about `CLAUDE.md`.

## Toolchain

- **Runtime/Package mgr**: Bun (managed by mise). ONE `bun.lock`, at the repository root — `docs/` is a Bun workspace, not a separate project.
- **`docs/` is a Bun workspace of the root; there is ONE lockfile and the shared pins live in a `catalog`.** The root declares `workspaces: { packages: ["docs"], catalog: {...} }`, and CI installs with `bun install --frozen-lockfile --filter rust-toolchain`.
- **The filter form is the whole thing.** `--filter '!docs'` — excluding a workspace — still resolves, downloads and extracts that workspace's entire graph; selecting the wanted package BY NAME does not. Measured on Bun 1.3.14 with a per-run `--cache-dir`, counting cache directories: action alone 1335, `--filter '!docs'` 4098 (3 docusaurus, 38 react), `--filter rust-toolchain` 1338 (0 docusaurus, 2 react). Testing the exclusion form is what produced the earlier "workspaces cost 2.8x here" conclusion, which was wrong. Do not re-derive this from timings: the same command varied 18.3s to 25.8s, so wall-clock cannot settle it — check what lands in the cache.
- **Add dependencies from the root, never by `cd docs`.** Use `bun add --filter docs <pkg>` for the site. For a pin both sides share, add it to the root `catalog` and reference it as `"catalog:"` from both manifests — that is what makes drift impossible rather than merely detectable. It had already happened twice: `typescript` was `^6.0.3` at the root against `~6.0.3` under `docs/`, and the undeclared `@types/node` had resolved to 26.1.1 against 26.2.0.
- **`@types/node` is declared, and must stay declared.** `tsconfig.base.json` asks for `types: ["bun", "node"]`. Neither manifest used to declare `@types/node`; it arrived as a transitive of `@types/bun` and was hoisted to the top level, where TypeScript happened to find it. Bun's workspace layout scopes transitives under `node_modules/.bun/` and nothing hoists, so both type-checks failed with `TS2688` the moment the workspace landed. The previous arrangement type-checked by luck; deleting either declaration restores the luck and breaks the workspace.
- **Config**: `mise.toml` manages tools/bun + env (`GITHUB_TOKEN` sourced via `gh auth token`, mise-only).
- **TypeScript**: `tsc --build` for typechecking (strict mode). The root
  `tsconfig.json` is solution-style (`files: []` + `references`), so
  `tsc --noEmit` alone would check zero files — `--build` is what traverses
  the references and actually checks the action (`tsconfig.src.json`). It
  does NOT check the site: `docs/tsconfig.json` is deliberately not
  referenced from the root, because CI's Lint job never installs
  `docs/node_modules` (see "`docs/` is a Docusaurus site with its own
  toolchain" below). The
  site is type-checked separately by `mise run docs:typecheck`.

## Runtime

Default to Bun instead of Node.js.

- `bun <file>` instead of `node <file>` / `ts-node <file>`
- `bun install` / `bun run <script>` / `bunx <pkg>` instead of the npm, yarn, or
  pnpm equivalents
- Bun loads `.env` automatically — never add `dotenv`

## Commands

Use `mise run` to invoke tasks defined in `mise.toml` (e.g. `mise run uap` to
update action pinning).

Run in this order before every commit:

```sh
bun run fix:all      # eslint --fix, then prettier --write
bun run typecheck    # tsc --build (covers the action, including src/*.test.ts;
                      # the docs/ site is type-checked separately, see below)
bun run test         # 100% line/function/statement gate from bunfig.toml
bun run build        # regenerate dist/index.js
hk check --all       # exactly what the CI Lint job runs
```

`bun run fix:all` is only ESLint + Prettier. The CI **Lint** job is
`hk check --all`, which also runs `actionlint`, `rumdl` (Markdown), `mermaid`
(parses every ` ```mermaid ` block — `rumdl` only checks the fence), `gitleaks`,
and whitespace/EOF hygiene over the whole repo. Fix Markdown with
`mise run markdownlint:fix`. `mise run yamllint` exists but is wired into
neither hk nor CI.

`mise run mutate` is **not** in that list and is not a gate. It runs Stryker
over the modules dense with boundary logic, reports a mutation score and never
fails on it. Reach for it when changing a threshold, a comparison or an error
path — a full run is minutes, and `mise run mutate <file>` is seconds. Three
things about it are not guessable and cost a run each to rediscover:

- Stryker runs under **Node**, not Bun; `bunx --bun` dies before the first
  mutant on its Babel instrumenter. Only the command it invokes is `bun test`.
- **`stryker-bunfig.toml` must exist.** The command runner judges a mutant by
  exit code, and `bunfig.toml`'s 100% coverage threshold fails on instrumented
  code, so every mutant would be recorded as killed — the score inflates
  silently, survivors included. `bun test` can only switch coverage _on_, so a
  second config passed with `--config=` is the only way off.
- The config file is a **positional** argument; `--configFile` is not a flag.

A surviving mutant is a question, not a defect. Some are equivalent — no test
can kill them — and chasing those is how a suite starts serving the tool. What
mutation testing cannot see at all is a fake that misrepresents the real thing,
which is why `src/cache/fs.ts` is tested against a real filesystem.

## `dist/` is committed

`action.yml` runs `dist/index.js` on the `node24` runtime, so the bundle is
tracked in git. The CI Build job runs `git diff --exit-code dist/` and fails on
a stale bundle — always `bun run build` and commit `dist/` alongside any `src/`
change.

## Testing

- **Framework**: Bun built-in test runner.
- **Files**: `**/*.test.ts` alongside source (e.g. `src/foo.test.ts`).
- **Coverage gate**: `bunfig.toml` enforces 100% lines/functions/statements for all files in `src/`, excluding `**/dist/**`, `**/bin/**`, `**/__tests__/**`, `**/integration-*/**`.
- **Run single test**: `bun test src/path/to/file.test.ts`.
- **Mutation testing**: `mise run mutate` (or `mise run mutate <file>` for one module) runs Stryker over the modules dense with boundary logic. Not a gate and not part of the pre-commit list — it reports a score and never fails on it. Coverage proves a line ran; this asks whether any assertion would notice it being wrong. Stryker runs under **Node**, not Bun, and `stryker-bunfig.toml` is required: the command runner judges a mutant by exit code, and the 100% coverage threshold would mark every mutant killed and inflate the score silently. See ARCHITECTURE.md → Testing Strategy → Mutation Testing.
- **Fakes are claims about someone else's code**: a hand-written double that disagrees with the real API cannot be caught by coverage OR by mutation testing, and has caused a shipped bug here twice. Where a port wraps `node:fs`, test the real adapter against a real temp directory — see `src/cache/fs.test.ts`.

## Coverage gate gotchas

- A class with field declarations and **no explicit `constructor()`** creates a
  phantom uncovered function under Bun coverage (Bun #7025) — always write the
  constructor, even when it is empty.
- `src/index.ts` is never imported, so Bun never loads it and it is absent from
  the coverage report. It is dependency wiring only — orchestration lives in
  `action.ts` behind the injected `ActionDeps`. Anything you add to `index.ts`
  is silently uncovered, so put it in `action.ts` instead.
- A `switch` whose `case` bodies are **braced blocks that return** loses
  coverage on the last case's closing brace under Bun 1.3.14, phantom-failing
  the 100% gate. Confirmed twice: reordering the cases moves the phantom to
  whichever case is now last, and a minimal pair under identical tests reports
  87.5% lines for `case "a": { return "A"; }` against 100% for
  `case "a": out = "A"; break;`. A plain `case`/`break` switch is **not**
  affected — `resolveChannel` in `src/core.ts` uses one and the repo is at
  100%. So the rule is narrower than "avoid `switch`": when a branch needs to
  return a value, reach for a lookup object keyed by the union, the way
  `src/cache/keys.ts` does with `DERIVERS`. That also buys back the
  exhaustiveness a `switch` would have given, since a `Record<Union, …>`
  fails to type-check when the union grows a member.

## Development Workflow

### Mandatory: TDD

1. Write test first (red).
2. Write minimal code to pass (green).
3. Refactor while keeping green.

### Principles

- **100% coverage** at all times.
- **TDD** for new code AND when refactoring existing code (test first, then refactor).
- **KISS/DRY/YAGNI/TDA/SOLID** — apply what fits, don't over-engineer.

## Project

This is a **GitHub Action** for Rust toolchain installation, inspired by [dtolnay/rust-toolchain](https://github.com/dtolnay/rust-toolchain) with extensions:

- **`rust-toolchain.toml` by default** — reads the project's `rust-toolchain.toml` to determine channel/targets/components/profile
- **`cargo-tools`** — installs cargo tools and caches their binaries in a `bin` layer keyed on the resolved tool set alone, with rustup's own shims excluded so a toolchain bump does not reinstall them. Entries are `<name>[@<version>][:<binary>]`, the suffix naming the executable to probe when a crate does not install one named after itself
- **`msrv-install`** — installs the crate's declared MSRV alongside the resolved toolchain, inert and reachable only via `cargo +<msrv>`, so a later step can run `cargo +<msrv> check` without its own `rustup toolchain install`
- **Override by inputs** — action inputs (`toolchain`, `targets`, `target`, `components`, `profile`) override toml values. For the list inputs that means merged and deduped with inputs leading, so `targets[0]` — and therefore the `target` output — is one the caller named whenever they named one
- **Fluent Builder pattern** — `ToolchainSpecBuilder` with chaining for programmatic construction
- **Compatible outputs** — `cachekey` and `name` match dtolnay/rust-toolchain; `cachekey-full` extends it with the full-precision digest the `build` restore ladder refuses to fall back past
- **Resolved-configuration outputs** — `toolchain`, `targets`, `target`, `components`, `profile`, `set-rustup-toolchain`, `cargo-tools`, `cache` and `cache-hit` (lists as JSON arrays), plus `json`: all of them natively typed in one object, with `inputs`/`toml` provenance blocks saying where each value came from

## Rustup Concepts (Reference)

Refer to the [rustup book](https://rust-lang.github.io/rustup/concepts/index.html) for core concepts:

- [Channels](https://rust-lang.github.io/rustup/concepts/channels.html) — stable, beta, nightly release channels
- [Toolchains](https://rust-lang.github.io/rustup/concepts/toolchains.html) — `<channel>[-<date>][-<host>]` specification
- [Components](https://rust-lang.github.io/rustup/concepts/components.html) — `rustc`, `cargo`, `clippy`, `rustfmt`, etc.
- [Profiles](https://rust-lang.github.io/rustup/concepts/profiles.html) — `minimal`, `default`, `complete` groupings of components
- [Overrides](https://rust-lang.github.io/rustup/overrides.html) — how `rustup` resolves which toolchain to use. Precedence, highest first: `+toolchain` shorthand → `RUSTUP_TOOLCHAIN` → directory override → `rust-toolchain.toml` → default. Note `rust-toolchain.toml` is _fourth of five_: it beats only the global default. Between the middle two, the docs add a proximity rule — "directory overrides and the `rust-toolchain.toml` file are also preferred by their proximity to the current directory" — so a nearer toml outranks a directory override registered further up the tree. The action exports `RUSTUP_TOOLCHAIN` so its resolved channel beats a workspace `rust-toolchain.toml` in every later step; because that also outranks _nested_ toolchain files the action never read, `set-rustup-toolchain: false` opts out for monorepos that pin per crate
- [`rustup toolchain install`](https://rust-lang.github.io/rustup/concepts/toolchains.html) — supports `--profile`, `--target`, `--component` flags

### Key `rustup` Commands

- `rustup toolchain install <channel> [--profile <name>] [--target <triple>]... [--component <name>]...` — install toolchain with profile, targets, components in one command
- `rustup default <channel>` — set the default toolchain (proxies delegate to this)
- `rustup set profile <name>` — set the **global default** profile for new installations (side effect: changes behavior of ALL future `rustup toolchain install` commands)
- `rustup target add <triple>` — add a target to an existing toolchain
- `rustup component add <name>` — add a component to an existing toolchain

## Rustup invariants — do not "simplify" these

Full reasoning in `docs/content/ARCHITECTURE.md` → Key Design Decisions.

- `src/action.ts` exports `RUSTUP_TOOLCHAIN`; `rustup default` alone loses to a
  workspace `rust-toolchain.toml`, which sits at precedence 4 of 5 and beats
  only the global default. `set-rustup-toolchain: false` opts out for monorepos
  whose crates pin their own toolchains.
- Every `rustup target add` / `component add` pins `--toolchain <channel>`.
- **`hasRustup` probes with `rustup --help`, never `rustup --version`.** The
  probe only asks whether rustup runs, but `--version` also prints the _active_
  rustc, which makes rustup walk the override chain. It runs before
  `RUSTUP_TOOLCHAIN` is exported, so a workspace `rust-toolchain.toml` wins
  there and rustup **downloads that whole toolchain** — six components — to
  print one line the action then discards, before installing the channel the
  caller actually asked for. Nothing about the result is wrong, which is why it
  went unnoticed: the resolved toolchain is still correct and the cost is
  invisible. It lands on precisely the workflows this action exists for — a
  toml overridden by an input. Verified outside the action: beside a toml
  naming an uninstalled channel, `rustup --version` emits
  `syncing channel updates` and `rustup --help` does not.
  `.github/workflows/tests/act.yml` guards it by asserting the overridden
  channel never appears in `rustup toolchain list`.
- Commands are built as argv arrays and executed without a shell. Channel,
  targets, components and profile can come from an untrusted workspace
  `rust-toolchain.toml` — never interpolate them into a command string.
- `--profile` is always passed explicitly — omitting it inherits the runner's
  global `rustup set profile`.
- A `path` toolchain in the toml is rejected, never defaulted to `stable`.
- `resolveRustupEnv` honours a caller-supplied `RUSTUP_HOME`; overlayfs runners
  need it pointed at a directory created at run time, or rustup's component
  renames fail with `EXDEV`.
- **`rust-version` is a floor; `rust-toolchain.toml` is a pin.** `msrv-fallback`
  therefore sits BELOW the toml in `mergeConfig`'s channel chain, and defaults
  to `false`. Reversing either would silently move a repository that declares
  an MSRV off `stable`, or let a floor overrule a pin the author wrote down.
- **A `cargo metadata` MSRV check that cannot run never fails, even under
  `msrv-check: error`.** It warns for every cannot-run cause except one: a
  missing `Cargo.toml` skips silently instead, because there was never
  anything to check — a warning there would land on every run for a consumer
  who enabled neither MSRV feature. Inability to verify is not a violation;
  conflating any of these with one fails every repository without a lockfile.
  `evaluateMsrv` keeps `skipped` distinct from `ok` for exactly this reason.
- **The MSRV comes from the resolved graph, not the manifest.** cargo-binstall
  1.21.1 declares `rust-version = 1.79` while pinning vergen 10.0.1, which
  needs 1.95, so a manifest-only check passes and the build then fails. This is
  why `msrv` and `msrv-effective` are separate outputs.
- **`msrv-install` installs the DECLARED `msrv`, never `msrv-effective`, and
  never becomes the active toolchain.** It exists so a later step can run
  `cargo +<msrv> check` without its own `rustup toolchain install`; the point
  is proving the crate builds at the floor it advertises, so a dependency that
  pushed the real floor higher should fail that check rather than have this
  action quietly install a newer toolchain instead. Default `false`, for the
  same "no behaviour change on upgrade" reason as `msrv-fallback`/`msrv-check`
  — the toolchain is inert until named, so the cost is a wasted download, not
  a correctness hazard. Grouped with the primary install in `src/action.ts`,
  not with the MSRV check: it reads only `config.manifest`, already parsed in
  Phase 1, and never touches `cargo metadata`. No `rustup default` and no
  `RUSTUP_TOOLCHAIN` export for it — those two lines are what make the
  resolved channel win every override chain, and doing either for the MSRV
  toolchain would make `cargo +<msrv>` redundant with plain `cargo`. Skipped
  with a `core.info` line when the declared MSRV already equals the resolved
  channel, silently a no-op when no `rust-version` is declared. Unlike the
  check, a failed install here is never downgraded to a warning: the
  toolchain was explicitly requested, so an unresolvable channel is a real
  configuration error the caller needs to see now, not a confusing failure in
  their own `cargo +<msrv>` step later. It also installs at `spec.profile` —
  the SAME resolved profile the primary toolchain uses, built via a second
  `ToolchainSpec` so `toRustupInstallArgs`/`toRustupProfileComponentAddArgs`
  need no re-derivation — never a profile of its own; a hardcoded `minimal`
  was tried and rejected, because it silently drops `clippy`/`rustfmt` from a
  `default`-profile job's `cargo +<msrv> clippy` step. The implied components
  are added afterwards pinned to the MSRV toolchain with `--toolchain`, for
  the same reason the primary's own profile-component step exists: rustup
  honours `--profile` only on a toolchain's first install.
- **`checkMsrv` runs `cargo metadata` once per `cache-workspaces` directory,
  not once at `GITHUB_WORKSPACE`.** A monorepo whose crates live under
  `crates/a`, `crates/b` is checked in every one of them, with a directory's
  packages skipped silently when it has no `Cargo.toml` and a directory's
  `cargo metadata` failure warned by name rather than aborting the others;
  every directory's packages are pooled and evaluated once, since one
  installed toolchain compiles all of them. `cacheRequest.workspaces` only
  exists when `cache` is enabled, so the check falls back to a direct
  `readCacheWorkspaces` parse (`src/cache/inputs.ts`) when it is off — the
  common default — rather than silently narrowing to one directory for every
  consumer who has not opted into caching. `msrv`/`msrv-source` are
  unaffected and stay root-manifest-only: see the note on `src/msrv.ts` below.

## Architecture

- **Entrypoint (action)**: `src/index.ts` dispatches on `STATE_isPost`, wiring real dependencies into either `run()` (main phase) or `runPost()` (post phase) from `src/action.ts`. Build uses `@actions/core` for inputs, outputs, state and failures.
- **Library API**: `src/lib.ts` is the barrel (re-exports action, builder, config, core, errors, inputs, msrv, outputs, tools, cache/budget, cache/metadata, cache/prune, cache/client, cache/env, cache/inputs, cache/keys, cache/layers, cache/fs, cache/lifecycle, cache/paths, cache/stage and cache/summary, never `index.ts`); consumers may also import any of those twenty-two modules directly.
- **Path aliases**: see the Path aliases section below — the specifier is consumer-visible.
- **Build**: `bun run build:action`
- **Source layout**:
  - `src/index.ts` — GitHub Action entry point; a side-effecting script (no exports) bundled to `dist/index.js`. Dependency wiring only, split by `STATE_isPost`: real `spawnSync`, `readFileSync`, `@actions/core`, a synchronous `sleep` and a promise-based `delay` handed to `run()` for the main phase; `@actions/core`'s state/summary slice plus the `cache/fs.ts` walk and measure adapters handed to `runPost()` for the post phase. The `@actions/cache`-backed `CacheClient`, the `nodeStageFs` adapter and the `cargo metadata` reader go to **both** — `run` restores and unstages, and reads `metadata` for the MSRV check; `runPost` stages and saves, and reads `metadata` again to compute a pruned layer's keep-set — while the crates.io `registry` client stays main-phase only. What stays here earns the coverage exemption individually — the `@actions/cache` client for its ~1.4 MB Azure SDK and unmockable network code, `metadata` for shelling out to cargo, `registry` for calling crates.io. The `node:fs` adapters moved to `cache/fs.ts` precisely because they qualified for none of those reasons
  - `src/action.ts` — `run(deps: ActionDeps)`, the main-phase orchestration: reads the toml, merges inputs, installs the toolchain, adds targets/components, exports `RUSTUP_TOOLCHAIN`, restores every enabled cache layer, moves a pruned layer's restored files out of the stage and back into place, sets outputs. Also `runPost(deps: PostDeps)`, the post-phase orchestration: replays the plans and restore results `run` saved through `saveState`, computes each pruned layer's keep-set and hard-links it into the stage, saves whatever is left to save, clears the stages, writes the job summary. Executes argv arrays with no shell, bounds each call with a timeout, and retries network-bound commands with backoff. A cache failure in either phase warns and never fails the build
  - `src/core.ts` — toolchain spec parsing, `rust-toolchain.toml` parsing via `smol-toml`, cachekey generation
  - `src/config.ts` — merge toml config with action inputs (scalars replaced by inputs; lists accumulate deduped, inputs leading), `ToolchainInputs` + `ResolvedToolchain` types; `resolveRustupEnv` resolves `RUSTUP_HOME`/`CARGO_HOME`, honouring caller-supplied values
  - `src/builder.ts` — fluent `ToolchainSpecBuilder` with `.withChannel()`, `.withTargets()`, `.withComponents()`, `.withProfile()`, `.build()`
  - `src/outputs.ts` — `buildActionOutputs` maps the resolved spec plus the inputs, toml and cache lifecycle outcome it was merged from onto the action's outputs; `toOutputEntries` flattens them to the `name, value` pairs GitHub accepts, serialising lists as JSON arrays and the whole object as `json`
  - `src/cache/layers.ts` — `CACHE_LAYER_IDS`, the canonical layer list, and `parseCacheLayers`, which reads the `cache-layers` input into a deduped layer list
  - `src/cache/keys.ts` — `joinKeySegments` (collapses empty segments) and `buildLayerKey`, which derives a layer's key and restore-key ladder; the `build` key folds in `envHash`
  - `src/cache/inputs.ts` — reads and validates every `cache-*` input before anything is installed (`readCacheRequest`), then completes the validated request into per-layer keys once the spec digest exists (`buildCacheOutputs`). `readCacheWorkspaces` reads `cache-workspaces` on its own, independent of whether `cache` itself is enabled — `readCacheRequest` calls it internally, and `action.ts` calls it a second time as the MSRV check's fallback for when `cacheRequest` is `undefined`. Takes a narrow `CacheInputSource` rather than `ActionDeps`, which is what keeps it free of an import cycle back to `action.ts`
  - `src/cache/env.ts` — `hashBuildEnv` digests the `CARGO_*`/`CC`/`CFLAGS`/`CXX`/`CMAKE`/`RUST*` environment into the `build` key's `envHash` segment, so two jobs differing only in `RUSTFLAGS` stop sharing a key
  - `src/cache/paths.ts` — `parseWorkspaces` reads `cache-workspaces` into resolved `<manifest-dir> -> <target-dir>` mappings, rejecting anything that resolves outside the checkout; `registryPaths` and `buildPaths` name each layer's **unpruned** paths, used when `cache-prune: off`. `registryPaths` lists bare directories and lets tar recurse; `buildPaths` cannot, because it has exclusions — it emits a files-only glob set (`<target>/**` plus `!<target>/**/incremental/**`, `!<target>/**/examples/**` and the `!<target>/` and `!<target>/**/` directory negations), since `@actions/cache` runs `tar --files-from` without `--no-recursion` and any directory left in the manifest re-includes the excluded subtrees. Neither takes a keep-set: narrowing the paths array changes the cache entry's identity, so a pruned layer archives a stage instead — see `cache/stage.ts`
  - `src/cache/budget.ts` — `parseSize` reads `cache-budget` into a byte count (binary suffixes, `0` disables it); `measurePaths` sums a layer's on-disk size through an injected `StatFs` port
  - `src/cache/client.ts` — `CacheClient`, the restore/save port. Its only real implementation wraps `@actions/cache` and lives in `src/index.ts`
  - `src/cache/lifecycle.ts` — `restoreLayers` restores every enabled layer concurrently, downgrading any failure to a miss; `saveLayers` decides, per layer, whether it is worth saving (skip on an exact hit, skip when its size can't be measured, skip over budget) and save the rest concurrently, each independently caught
  - `src/cache/fs.ts` — the real `node:fs` implementations of the cache's filesystem ports: `walkFiles`, `nodeStatFs` and `nodeStageFs`. They lived in `src/index.ts` until a fake that disagreed with `readdirSync` about a missing directory cost every pruned layer its save; nothing here vendors an SDK or touches the network, so the coverage exemption they inherited by proximity was never earned. `cache/fs.test.ts` holds them to a real temp directory — the hard link's shared inode and mtime included, since `stageFiles` depends on both
  - `src/cache/stage.ts` — the staging layer that makes pruning possible at all. `@actions/cache` folds the paths array into a cache entry's version, so a content-derived array writes entries no restore can ever find; `buildStageRoots`/`registryStageRoot` name one fixed directory per tree and `stagePaths` hands that alone to the client, keeping the array constant across both phases. `stageFiles` hard-links the keep-set in before a save (links, not copies: they share the mtime cargo's freshness check reads), `unstageFiles` moves it back out after a restore, and nothing is ever removed from the working tree
  - `src/cache/summary.ts` — `renderSummary` renders the per-layer restore/save outcome as the job summary's Markdown table — the only place a per-layer result is visible, since `cache-hit` is a single all-layers boolean
  - `src/errors.ts` — `describeError` renders a caught `unknown` as a message; extracted because the `instanceof Error` ternary was written out nine times across `action.ts`, `cache/lifecycle.ts` and `core.ts`
  - `src/cache/metadata.ts` — `parsePackageSet` reads `cargo metadata --format-version 1 --locked` into the packages a workspace still resolves to, with its own crates called out separately; `MetadataReader` is the port the real `cargo` invocation hides behind
  - `src/msrv.ts` — everything MSRV-related: `parseVersion`/`compareVersions` compare Rust versions numerically, never lexically (`"1.9"` sorts above `"1.10"` as a string and below it as a version); `parseMsrvPolicy` reads `msrv-check` into `off`/`warn`/`error`, defaulting to `warn`; `parseCargoManifest` reads a `Cargo.toml`'s `rust-version`, resolving workspace inheritance (`rust-version.workspace = true` parses to the object `{ workspace: true }`, not a version — the one trap in the function) across the three shapes that matter: a plain `[package]`, a virtual manifest's `[workspace.package]`, and a member that opts into inheriting it; `effectiveMsrv`/`bestRequirement` take the maximum `rust-version` across the **resolved graph** `cargo metadata` returns, not any one manifest; `evaluateMsrv` compares the installed `rustc` against that maximum and returns `ok`/`skipped`/`violation`, keeping `skipped` distinct from `ok` so a check that could not run is never reported as one that passed; `describeVerdict` renders the outcome as the line a human reads in the log
  - `src/cache/prune.ts` — `parsePrunePolicy` reads `cache-prune` into `off`/`safe`/`aggressive`; `readFingerprints` recovers the hash-to-package mapping cargo records under `target/<profile>/.fingerprint/<name>-<hash>/`, which is what makes attribution authoritative rather than the filename guess `Swatinem/rust-cache` makes; `computeKeepSet` decides which files the archive carries. Nothing here deletes — the keep-set selects what is linked into the stage
  - `src/tools.ts` — everything `cargo-tools` needs: `parseToolSpecs` reads the input into `<name>[@<version>][:<binary>]` specs, rejecting anything that is not a cargo identifier before a command runs; `resolveToolVersions` turns `latest` into a concrete version through the `RegistryClient` port, retrying with backoff and degrading a failure to `UNRESOLVED_VERSION` rather than throwing; `hashToolSet` digests the resolved set into the `bin` key's final segment; `ensureTools` probes `<binary> --version` and then `-V` (see the version-probe bullet below) and installs only what the restore did not supply. A pinned version never reaches the client, which is what makes a registry outage unable to affect it. **`cargo-binstall` cannot be installed at all**, and this one is measured rather than reasoned about: installs are always `cargo install --locked` from source and its tree exceeds `CARGO_INSTALL_TIMEOUT_MS` (15 min) on all three attempts — 46m22s to `spawnSync cargo ETIMEDOUT`. It is not an MSRV problem and a declared `rust-version` will not predict one: `cargo-binstall` declares 1.79 yet pins `vergen 10.0.1`, which needs 1.95, so `--locked` makes the graph the binding constraint. Nothing should reach that path any more — the `-V` probe reads its version, so it is kept in every cache state — but the timeout is why the probe fix mattered rather than being cosmetic, and it is still what happens to any tool the probe cannot identify
  - **The version probe asks `--version`, then `-V`, and a captured command never inherits stderr.** Both halves come from one run (glaucus-perf 33131288195), whose _successful_ job logged `error: a value is required for '--version <VERSION>' but none was supplied` with nothing to attribute it to. That is `cargo-binstall`'s own stderr: its clap parser defines `--version <VERSION>` as the crate version to INSTALL, shadowing the conventional flag entirely, so the probe exits 2 — while `-V`, untouched, answers `1.21.1` (verified against 1.21.1 on disk). Asking only the long flag therefore read a tool that names itself perfectly well as _mute_, and muteness is not free: a mute binary is kept only on the strength of an exact `bin` hit, so a **prefix** hit hands `cargo-binstall` straight to `cargo install`, which does not finish. Order is load-bearing both ways — `--version` stays first because nearly every tool answers it, so the common case is still one spawn and `-V` is never reached; `-V` is never first, because one letter is scarce enough that a tool may have spent it on something of its own. A spawn error still returns immediately rather than trying the second flag: there is no binary left to ask. The stderr half is independent and would be needed even if every tool answered `--version`: `capture` marks a question the action asks and then interprets, so `src/index.ts` pipes both streams (`["ignore", "pipe", "pipe"]`) instead of inheriting stderr, and `ExecResult.stderr` carries the text back for whoever wants it. Exactly one caller does — `readRustcVersion`, the only captured command whose failure is fatal — and dropping that append is not a tidy-up but a trade of a noisy log for a mute one, leaving `failed with exit code 3` as the entire diagnosis. `ToolExecResult` deliberately has no `stderr`: return-type covariance lets `action.ts` pass the richer `exec` through unchanged, and a probe's stderr is precisely the noise that module exists to interpret away
  - **The `:<binary>` suffix redirects the probe and NOTHING else**, and every other half of the system deliberately ignores it. A crate whose executables are not named after it — `ignorefile-cli` ships `ign` and `ignorefile` — spawn-errors on `<crate> --version`, reads as absent under the "a spawn error is the only evidence of absence" rule, and is rebuilt from source on every run _on top of an exact `bin` hit that already restored it_: 10.9s of a 33.7s action, measured on rustup-toolchain-tests run 31744249910. `cargo install` still takes the crate name, and both `hashToolSet` and the `cargo-tools` output still read `name@version` only. That exclusion is the load-bearing part, not a tidiness choice: folding `bin` into the digest would mean adding `:ign` to a working workflow **misses the very entry the suffix exists to make usable**, paying one full rebuild to stop paying full rebuilds and splitting the cache between two spellings of one request thereafter. Both exclusions are pinned by their own tests (`hashToolSet > ignores a declared binary`, `cargo-tools output > omits a declared probe binary`) because nothing in the types would catch a regression — `bin` is optional, so a spread that starts carrying it type-checks fine
  - `src/inputs.ts` — `readBooleanInput` and the `InputReader` port it takes; shared by `action.ts` and `cache/inputs.ts`, so it belongs to neither
  - `src/lib.ts` — the library barrel. Re-exports every other library module and deliberately **not** `index.ts`, whose import executes the action
  - `src/*.test.ts` — co-located tests; `tsconfig.src.json` includes `**/*.ts` and the root config references it, so `bun run typecheck` (`tsc --build`) type-checks them too

## Path aliases — the specifier is consumer-visible

`tsconfig.json` maps `@rust-toolchain` to the barrel `src/lib.ts`,
`@rust-toolchain/*` to `src/*`, and `@/*` to `src/*` as a short form.

- **Library source imports siblings as `@rust-toolchain/<module>`** — never
  `./<module>`, never `@/<module>`. A consumer maps `@rust-toolchain/*` in their
  own `tsconfig.json`, so that specifier resolves both here and there. An
  internal-only alias typechecks in this repo and fails in every consumer with
  `TS2307: Cannot find module`.
- **`@/<module>` is tests only.** A consumer's own `@/` almost certainly points
  at their `src`, so a library import through it would resolve into their tree.
- **No `baseUrl`.** Deprecated in TypeScript 6.0 (this repo pins `^6.0.3`) and
  it errors with `TS5101`. Relative `paths` entries resolve against the
  `tsconfig.json` that declares them, so it is redundant anyway.
- **`src/lib.ts` is the barrel and must never re-export `src/index.ts`** — that
  file calls `run()` at the top level, so importing it executes the action.
  `src/lib.test.ts` asserts both the exclusion and the full export list; adding
  a library module means updating the barrel and that list.

## Cache invariants — do not "simplify" these

Full reasoning in `docs/content/ARCHITECTURE.md` → Key Design Decisions, in the Cache
Layers, Cache Lifecycle, and `@actions/cache` Adapter Lives In `index.ts`
subsections.

- **Empty key segments collapse; they never leave an empty slot.**
  `joinKeySegments` (`src/cache/keys.ts`) filters blanks before joining, so an
  unset `cache-key-suffix` yields `registry-Linux-X64-<hash>`, never
  `registry-Linux-X64--<hash>`. A stray empty segment reads as harmless
  cosmetics but is a distinct cache key from the padded form, so "cleaning it
  up" by joining unconditionally silently invalidates every existing cache
  entry.
- **The registry key never contains the toolchain spec.** `registry` holds
  downloaded crate sources that any rustc can compile; keying it on the
  resolved toolchain would force a full re-download on every channel bump for
  a layer that did not change. This is the entire reason the layers are split
  rather than sharing one key.
- **The build restore ladder never falls back past a `cachekey-full`
  boundary.** `build` holds compiled artifacts, which are specific to the
  resolved toolchain; a looser rung would let it restore artifacts `cargo`
  discards on sight, paying a download only to re-save it under a new key.
  Adding a shorter fallback rung "for a better hit rate" removes the guarantee
  that a `build` restore is ever useful.
- **The `@actions/cache` adapter lives in `src/index.ts`, not in a library
  module.** `src/index.ts` is never imported, so it is invisible to the
  coverage gate (see Coverage gate gotchas above). `@actions/cache` vendors
  the Azure Storage SDK — most of the ~1.4 MB it added to `dist/index.js` —
  plus unmockable network code; importing it from a module under test would
  make the 100% gate unreachable. Every module that restores or saves takes
  the `CacheClient` port (`src/cache/client.ts`) instead, so tests inject a
  fake and the real adapter is exercised only by the actual runtime, plus
  CI's `E2E` and `E2E Warm Cache` jobs.
- **The paths array is a cache entry's identity, so pruning must never touch
  it.** `@actions/cache` does not look an entry up by key. It matches on
  `(key, version)` where
  `version = sha256(paths.join("|") | compressionMethod | salt)` —
  see `getCacheVersion` in `node_modules/@actions/cache/lib/internal/cacheUtils.js`.
  A save that narrows `paths` to a computed keep-set therefore writes an entry
  under a version no restore ever asks for. This is not a degraded hit rate but
  a **permanent** miss: the restore cannot know the content it has not built
  yet, so it asks under the coarse array forever, and the layer pays the upload
  on every run while never once being readable. It shipped that way and cost
  every `build` and `registry` hit until the staging rewrite; the only layer
  that kept working was `bin`, the one nothing rewrote. Whatever else changes
  here, **both phases must derive the identical `paths` array**, which is why
  `layerPathsByLayer` switches on the `cache-prune` _input_ and never on
  whether a keep-set turned out to be usable.
- **Pruning fills a stage; it never deletes from the working tree and never
  rewrites the manifest.** `buildStageRoots`/`registryStageRoot`
  (`src/cache/stage.ts`) name one directory per tree —
  `<target>/.rust-toolchain-stage`, `<cargo-home>/.rust-toolchain-stage` — and
  that single directory is the whole `paths` array. `stageLayers`
  (`src/action.ts`) hard-links the keep-set into it before the save, and
  `unstageRestored` moves the files back out after a restore. Hard links
  because they cost an inode reference rather than the bytes and share the
  source file's mtime, which is what cargo's freshness check reads; the stage
  lives _inside_ the tree it mirrors because a link cannot cross a filesystem
  and both locations are already git-ignored. Nothing is removed from the
  checkout — a link is an addition — so a save failure still cannot damage the
  working tree. A post step that deleted from `target/` would be destructive at
  the worst moment: it runs after the job's real work, so a bad keep-set
  surfaces as a build that succeeded and a checkout now missing artifacts, and
  on a self-hosted runner the damage outlives the job. Both inputs are outside
  our control — cargo concedes the fingerprint format has no stability
  guarantee — and a filter that misreads them yields a wrong-sized archive
  where a deleter yields lost work.
- **An empty or unusable keep-set stages the whole tree, never an empty
  stage.** Every failure mode converges on the same symptom — no packages
  resolved, therefore nothing attributable, therefore zero files — and saving
  that is not a small cache but a **poisoned** one: an entry that exists, hits
  its key, restores nothing, and leaves every later job rebuilding from scratch
  while believing it was warm. Three guards, because it is silent and paid by
  every later run: `computeKeepSet` refuses to mark such a set usable;
  `stageLayers` catches a keep-set it cannot resolve **itself** rather than
  letting it reach `runPost`'s outer guard, since under staging an escaping
  throw would leave every stage empty where the old design still archived
  everything; and any layer that ends with zero files staged is dropped from
  the plans so it is never saved at all.
- **Pruning is skipped when it would not pay.** `PRUNE_WORTH_IT` in
  `src/action.ts` stages the whole tree when the keep-set would drop under 5%
  of the bytes. Measured, not guessed: resolution runs about 1.5 ms per kept
  entry, so an explicit keep-set costs _more_ the less there is to prune — a
  churned tree dropped 46% of 220 MB for 495 ms, an unchurned one spent 904 ms
  to drop 0.2%. Note this decides only what goes _into_ the stage; it cannot
  decide the `paths` array, for the reason the first bullet gives.
- **The `bin` layer excludes rustup's shims, and only a marker can prove it.**
  `binPaths` (`src/cache/paths.ts`) emits `<cargo-home>/bin/**` plus a
  `!<bin>/<shim>` and `!<bin>/<shim>.exe` pair for each of the fourteen names
  in `RUSTUP_SHIMS`, then the same `!<bin>/` and `!<bin>/**/` directory
  negations `buildPaths` needs — for the same `tar --files-from` reason. The
  exclusion is what lets the `bin` key omit the toolchain entirely, so a
  compiler bump does not reinstall tools that did not change. **A test that
  merely checks a shim is absent from `$CARGO_HOME/bin` after a restore proves
  nothing**: this job's own rustup put every shim back on disk, so the check
  passes whether or not the archive contained them. The proof has to plant
  marked content in the saving job and look for it in the restoring one —
  `.github/workflows/cicd.yml` replaces the `rust-gdbgui` shim with a marked
  plain file, and `.github/workflows/tests/act-cache.yml` does the local
  equivalent. Replace rather than append: the shims are hardlinks to one inode,
  so appending rewrites `rustup` itself, and on macOS arm64 it also
  invalidates the signature the kernel requires.
- **A cache failure never fails the build.** Restore, save, size measurement
  and the job summary write are each caught at their own boundary and reduced
  to a `core.warning` — a flaky cache service is not a reason to fail a job
  that would otherwise have succeeded. Do not let a fix for one of these
  propagate a throw past its own boundary "to be safe"; that reintroduces the
  exact failure mode these guards exist to remove.
- **Exclusions from a saved layer are negation globs, never deletion, and the
  glob set must stay files-only.** This is the `cache-prune: off` shape — the default
  `safe` policy archives a stage instead, whose paths array is one fixed directory.
  `buildPaths` (`src/cache/paths.ts`) emits
  `<target>/**`, `!<target>/**/incremental/**`, `!<target>/**/examples/**`,
  `!<target>/` and `!<target>/**/`. **`!<target>/**/` is load-bearing**:
  `@actions/cache` runs `tar --files-from <manifest>` with no
  `--no-recursion`, so any directory left in the manifest is expanded wholesale
  and re-includes everything the negations removed, and a trailing `/` is what
  matches directories only. Delete it and every exclusion above it silently
  stops working, with no unit test of the glob layer alone noticing — verify at
  the tar layer. `!<target>/` is redundant belt-and-braces: dropping it changes
  the resolved set not at all, since the globstar already matches the root
  through its own trailing slash. Keep it, but do not mistake the pair for two
  independent guards. The trade-off is
  that the archive carries no directory entries, so empty directories and
  directory permissions/mtimes are not preserved; cargo does not depend on
  either. `registryPaths` keeps naming bare directories on purpose: it has
  nothing to exclude, so recursion is what archives it. Nothing on disk is ever
  touched, so a save failure cannot damage the working tree. Do not "clean up"
  a layer by deleting files instead — that changes a save-time filter into a
  destructive operation on the checkout.

## Commits and releases

- `commitlint` runs in `hk`'s `commit-msg` hook. Conventional Commits, with
  `type` limited to the enum in `commitlint.config.cjs` (it adds `init`) and a
  scope expected — e.g. `feat(config): resolve rustup home`.
- Every push to `main` runs the CICD **Release** job: GitVersion computes the
  version, rewrites `owner/repo/...@vX.Y.Z` references under `.github/`, tags,
  and publishes a GitHub Release. Never bump `package.json` or create tags by
  hand — the job does both, and a hand-made tag desynchronises GitVersion.
- **A release moves four tags, and only the longest is stable.** For `0.5.0-11`
  it publishes `v0.5.0-11` — created once and never moved — plus `v0.5.0`,
  `v0.5` and `v0`, each deleted and recreated at the new commit. So `v0.5.0`
  floats across `-N` rebuilds (verified: `v0.2.1` resolves to `v0.2.1-4`, not
  `-2`), and `v0` crosses **minor** bumps, which pre-1.0 is where the
  compatibility boundary is — `@v0` is the trap, not the safe default. When
  checking any of this locally, note `git fetch --tags` will **not** overwrite a
  tag you already have; a local `v0` can sit releases behind the remote and read
  as a broken ladder. Use `git ls-remote --tags origin`.
- **The rewrite covers `.github/` only, and extending it to `README.md` would be
  a bug, not an improvement.** The `sed` rewrites any `@vX.Y` to the exact new
  version, which is right for `.github/`, where every reference is a literal pin
  that must move together. README's version references are pedagogical — the
  Versioning table exists to contrast `@v0.5` against `@v0.5.0-11` — so the same
  rewrite would collapse the recommended float into a fixed release and delete
  the distinction the table teaches. The pattern also requires a path after the
  repo name (`owner/repo/...@v`), so a bare `owner/repo@v0.5` never matches
  anyway. README pins are updated by hand on a minor bump; there were 17 sitting
  at `@v0.1` when the action had shipped `0.5`.
  `docs/content/RUNBOOKS.md` → Release Process documents the same job and was
  verified accurate against `cicd.yml`; the note that once called it out of
  date was itself the stale claim.

## GitHub Actions

- **GitHub Actions Toolkit**: Use `@actions/core` (`getInput`, `setOutput`, `setFailed`) and `@actions/github` (`context`) from <https://github.com/actions/toolkit/tree/main>. Never write raw env var access (`process.env.INPUT_*`) or direct GitHub_OUTPUT manipulation — always use the toolkit.
- **Pin to commit SHA**: All `uses:` references in `.github/workflows/*.yml` and `.github/actions/*/action.yml` MUST use the full commit SHA of the release tag (e.g. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`). Never use `@v{major}` or `@v{major}.{minor}` tag annotations — they are mutable and undermine supply-chain security. The comment after the pin documents the SemVer for human readability.
- **Name every job and step in Title Case**: Every `jobs:` and `steps:` entry MUST have a `name:` key using Title Case (e.g., `Setup`, `Lint`, `Build Action`, `Run Tests`). Separate job properties from `steps:` with an empty line.
- **Use `gh` CLI to inspect runs**: `gh run view <run-id>`, `gh run view <run-id> --log-failed`, `gh run list`.
- **Local testing with `act`**: `mise run act` runs the workflow from `.github/workflows/tests/act.yml` locally via Docker (catthehacker/ubuntu:full-latest). Ensure Docker is running and `gh auth login` is done first.

GitHub picks up only top-level `.github/workflows/*.yml`. `tests/act.yml`,
`tests/act-matrix.yml` and `tests/act-cache.yml` run locally through
`mise run act` / `mise run act:matrix` / `mise run act -t act-cache` (Docker
running and `gh auth login` done first). The last is the local half of the
marker proof for the `bin` layer's shim exclusion.

## README inputs/outputs are generated

The blocks between the `action-docs-all` markers in `README.md` come from
`action.yml` via `mise run readme`. Edit `action.yml` and regenerate; hand edits
inside the markers are overwritten.

Both markers must keep their full attribute set:

```text
<!-- action-docs-all source="action.yml" project="elioseverojunior/rust-toolchain" version="v0.1" -->
```

`action-docs` has no CLI flag for `project`/`version` and never reads the repo
slug from git or `package.json` — it substitutes those two attributes into the
Usage block's `uses:` line. Drop them from either marker and the block silently
regenerates as `- uses: @`.

`mise run readme` emits unpadded tables, so always follow it with
`bun run fix:all` (Prettier realigns them) or the diff stays dirty.

## `docs/` is a Docusaurus site

`docs/` holds both the repository's prose — `ARCHITECTURE.md`,
`COMPARISON.md`, `RUNBOOKS.md`, `design/`, `plans/`, all under
`docs/content/` — and the Docusaurus site that publishes it. Formatting and
linting are unified into the root's own tooling: `bun run fix:all` and the
root `eslint.config.js` both cover `docs/**/*.{ts,tsx}` alongside `src/`, and
`hk check --all` covers `docs/**/*.md` through `rumdl` and `mermaid` exactly
as it does everywhere else. Type-checking is **not** unified — see the
`tsc --build` bullet below for why — and the site keeps its own `typecheck`
script, run through `mise run docs:typecheck`. Building or serving the site
itself still goes through `docs/` — `mise run docs:build` / `mise run
docs:dev` (aliases `docsb`/`docsd`), not `bun run build` from the repo root,
which only rebuilds the action's `dist/index.js`.

- **`bun run typecheck` is `tsc --build`, and it must stay that way.** The
  root `tsconfig.json` is solution-style — `"files": []` plus a `references`
  entry to `tsconfig.src.json` — so a plain `tsc --noEmit` against it
  type-checks ZERO files and exits 0, which is how the action's own source
  could silently stop being type-checked at all. Only `tsc --build` traverses
  project references. If you ever need to prove the typecheck actually works,
  inject a deliberate type error and confirm the run FAILS; a passing run on
  clean code is exactly what the broken invocation also produces.
- **The root typecheck covers the action only; the site is checked
  separately, and this is deliberate, not an oversight.** `docs/tsconfig.json`
  used to be a second `references` entry, so one `tsc --build` covered both —
  until CI proved that wrong. `hk check --all`'s `typecheck` step runs `bun
run typecheck` in the Lint job, but `.github/actions/setup/action.yml`
  installs only the action's workspace
  (`bun install --frozen-lockfile --filter rust-toolchain`), never
  `docs/node_modules`. With the reference in place, the Lint job hit 40+
  `TS2307 Cannot find module '@docusaurus/…'` on every run — invisible on any
  machine that had ever run `mise run docs:*` and picked up
  `docs/node_modules` locally, which is exactly why the defect reached final
  review undetected. The site is instead type-checked by `mise run
docs:typecheck`, which `gh-pages.yml` runs (`dir = "docs"`, so it installs
  and uses the site's own `tsconfig.json` and dependencies) before `mise run
docs:build`. Installing `docs/` in the shared setup action was rejected as
  the fix: it would cost every action CI job the whole Docusaurus tree, which
  is exactly what `--filter rust-toolchain` exists to avoid. To prove the root typecheck
  still works after touching this, move `docs/node_modules` aside and run
  `bun run typecheck` — it must still PASS, since it no longer touches
  `docs/` at all; a pass with the directory present proves nothing, since
  that is precisely how this defect got through.
- **`compilerOptions.paths` is duplicated between the root `tsconfig.json`
  and `tsconfig.src.json`, on purpose.** Bun reads path aliases off the root
  `tsconfig.json` directly and does not follow `references`, so removing the
  copy breaks `bun test`'s `@rust-toolchain/*` and `@/*` imports. `extends` is
  not a fix: it also inherits `include: ["**/*.ts"]`, which sweeps every
  source file back into the root program and breaks `tsc --build` with
  `TS6305`/`TS6306` against the referenced project.
- **`*.ts` does not match `*.tsx`.** This bit three separate configs during
  the migration, all now fixed: the site's old (now-retired) ESLint config was
  scoped to `**/*.ts` and never linted a single React component; the root
  `eslint.config.js` ignored `docs/**` entirely until it gained its own
  `files: ["docs/**/*.{ts,tsx}"]` block; and `hk.pkl`'s `eslint`, `prettier`
  and `typecheck` steps globbed `*.ts` and would silently skip a commit that
  touched only `.tsx` files. `hk.pkl`'s `test` step still globs `*.ts` alone,
  on purpose — the site has no tests.
- **Dev and preview default to port 5273, without VitePress's `strictPort`.**
  `mise run docs:dev` / `docs:preview` pass `--port {{env.DOCS_PORT | default(value="5273")}}`
  to `docusaurus start` / `serve`, but neither enforces the port the way
  VitePress's `strictPort: true` did. A busy 5273 does not fail loudly —
  `docusaurus start` silently falls back to the next free port and prints the
  real URL in the terminal, which is easy to miss if you assume `:5273`
  without reading the output.
- **Content lives in `docs/content/`, served from the site root.** The docs
  plugin in `docusaurus.config.ts` sets `path: "content"` and
  `routeBasePath: "/"`. Moving it changes every published URL, and the URLs it
  currently serves are the ones VitePress served — so `README.md`, the
  Marketplace listing and every external link already point at them. Nothing in
  CI checks an inbound link, so a route change is silent: the build stays green
  and the links rot. It used to carry a second, sharper hazard: publishing ran
  `peaceiris/actions-gh-pages` with `keep_files: true`, which never deleted, so
  a moved route left the OLD page serving at the old URL alongside the new one —
  two sites, no error anywhere. Publishing is now an artifact deployment
  (`upload-pages-artifact` + `deploy-pages`), which replaces the site wholesale,
  so that trap is gone. The rule survives it: the reason is inbound links, not
  stale files.
- **Every file carries an SPDX header, Markdown included, and that is not a
  choice.** `REUSE.toml` licenses the whole tree through its `path = ["**"]`
  aggregate annotation, so an inline header is redundant — but `comply
annotate` has no ignore mechanism at all. Its `[tool.comply] ignore` list
  governs `comply lint` only; `annotate` adds a header to every file with a
  recognised comment style, every run. Verified by probing every glob form
  against `docs/content/`, exact literal path included: none of them stopped
  it. This is why those headers moved twice — 2cbf53f removed them by hand and
  the next `annotate` put them straight back. Uniform headers are the stable
  state; hand-removing them is not. **The site survives that only because
  `docusaurus.config.ts` sets `markdown.format: "detect"`.** Docusaurus 3
  defaults to MDX for `.md` as well as `.mdx`, and MDX reads the leading
  `<!--` of an SPDX header as a JSX tag: every page in `docs/content/` failed
  to compile with "Unexpected character `!` (U+0021) before name" at line 1
  column 2, from the commit that applied the headers until the format was set.
  Nothing here relies on MDX — no page imports a component and there are no
  `.mdx` files — and Docusaurus still runs its own remark plugins in
  CommonMark mode, so admonitions, heading anchors and ` ```mermaid ` fences
  are unaffected.
- **Mermaid is `@docusaurus/theme-mermaid`, six lines of configuration,
  replacing the old `.vitepress/` directory** — 861 lines in total, of which
  the bespoke Vue mermaid component and its theme wiring accounted for 652.
  It renders client-side inside a `useEffect`, so grepping the built HTML for
  mermaid markup returns ZERO even when every diagram renders correctly.
  Verify with a browser, not a grep. There are eight diagrams, all in
  `ARCHITECTURE.md`.
- **Offline search is `@easyops-cn/docusaurus-search-local`.** Its
  `docsRouteBasePath` must match the docs plugin's `routeBasePath` (both
  `"/"` here), and its `docsDir` must match the docs plugin's `path`
  (`"content"` — the plugin's own default, `"docs"`, does not exist in this
  layout). A mismatch in either indexes nothing while the build still passes:
  a search box that silently returns zero results, with no error at build
  time.
- **Dead-link checking validates links in Markdown content only.**
  `onBrokenLinks`/`onBrokenMarkdownLinks: "throw"` never look inside
  `navbar.items` or `sidebars.ts`. Do not disable it to silence a failure — it
  hides the class of breakage that is caught while leaving the class it never
  could catch exactly as invisible as before. One thing genuinely improved
  crossing from VitePress: Docusaurus validates `sidebars.ts` against the
  actual document tree, so a **wrong sidebar document ID now fails the
  build**, where VitePress built clean and 404'd only in the browser — a real
  reduction in a class of silent breakage.
- **A page reaching a file outside the site root needs an absolute
  repository URL.** `../README.md` resolves outside `docs/content` and is
  exactly what the dead-link check exists to catch.
- **A referenced `static/` asset is never checked.** `favicon`,
  `themeConfig.image` and the `apple-touch-icon` entry in the `headTags` array of
  `docusaurus.config.ts` all reference files under `static/img/` by a bare
  path string, and none of those paths are validated at build time — the same
  gap VitePress had with its `public/` directory, carried across unchanged. A
  typo there 404s silently in production; nothing here catches it.

## Code Style

- **ESLint**: flat config, pinned at v10 (`eslint.config.js` documents
  v10-specific behaviour), strict TS rules. `explicit-function-return-type: error`, `no-explicit-any: error` (relaxed in test files).
- **Imports**: `import-x/order` enforced — builtin → external → internal → parent → sibling. `bun:` prefixed to external. Blank lines between groups.
- **Format**: Prettier with `prettier-plugin-organize-imports`. Double quotes, trailing commas, 80-width.
- **Fluent Builder pattern**: prefer chained builder methods with a terminal `.build()` call over large constructors.
- **No `console.log` restriction** (off by config).
- **Unused vars**: `error` (prefix with `_` to ignore).

## TOML parsing

Use `smol-toml` (`import { parse } from "smol-toml"`), never `@iarna/toml`.
