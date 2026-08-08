<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# AGENTS.md

## Toolchain

- **Runtime/Package mgr**: Bun (managed by mise). `bun.lock` is lockfile.
- **Config**: `mise.toml` manages tools/bun + env (`GITHUB_TOKEN` sourced via `gh auth token`, mise-only).
- **TypeScript**: `tsc -p tsconfig.json --noEmit` for typechecking (strict mode).

## Commands (run in this order before commit)

```sh
bun run fix:all
bun run typecheck
bun run test
```

Use `mise run` to invoke tasks defined in `mise.toml` (e.g. `mise run uap` to update action pinning).

## Testing

- **Framework**: Bun built-in test runner.
- **Files**: `**/*.test.ts` alongside source (e.g. `src/foo.test.ts`).
- **Coverage gate**: `bunfig.toml` enforces 100% lines/functions/statements for all files in `src/`, excluding `**/bin/**`, `**/__tests__/**`, `**/integration-*/**`.
- **Run single test**: `bun test src/path/to/file.test.ts`.

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
- **`cargo-tools`** — installs cargo tools and caches their binaries in a `bin` layer keyed on the resolved tool set alone, with rustup's own shims excluded so a toolchain bump does not reinstall them
- **Override by inputs** — action inputs (`toolchain`, `targets`, `target`, `components`, `profile`) override toml values. For the list inputs that means merged and deduped with inputs leading, so `targets[0]` — and therefore the `target` output — is one the caller named whenever they named one
- **Fluent Builder pattern** — `ToolchainSpecBuilder` with chaining for programmatic construction
- **Compatible outputs** — `cachekey` and `name` match dtolnay/rust-toolchain
- **Resolved-configuration outputs** — `toolchain`, `targets`, `target`, `components`, `profile`, `set-rustup-toolchain` (lists as JSON arrays), plus `json`: all of them natively typed in one object, with `inputs`/`toml` provenance blocks saying where each value came from

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

## Architecture

- **Entrypoint (action)**: `src/index.ts` dispatches on `STATE_isPost`, wiring real dependencies into either `run()` (main phase) or `runPost()` (post phase) from `src/action.ts`. Build uses `@actions/core` for inputs, outputs, state and failures.
- **Library API**: `src/lib.ts` is the barrel (re-exports action, builder, config, core, errors, inputs, outputs, tools, cache/budget, cache/client, cache/env, cache/inputs, cache/keys, cache/layers, cache/lifecycle, cache/paths and cache/summary, never `index.ts`); consumers may also import any of those seventeen modules directly.
- **Path aliases** (`tsconfig.json` `paths`): library source imports itself as `@rust-toolchain/<module>` — the same specifier a consumer maps, so internal imports resolve in their project too. `@/<module>` is the short form and is **tests only**; using it in library source silently breaks source consumption.
- **Build**: `bun run build:action`
- **Source layout**:
  - `src/index.ts` — GitHub Action entry point; a side-effecting script (no exports) bundled to `dist/index.js`. Dependency wiring only, split by `STATE_isPost`: real `spawnSync`, `readFileSync`, `@actions/core` and a synchronous `sleep` handed to `run()` for the main phase; the real `@actions/cache`-backed `CacheClient` and a `node:fs`-backed `measure()` handed to `runPost()` for the post phase. Building the `@actions/cache` adapter here, rather than in a library module, is what keeps its ~1.4 MB Azure SDK and unmockable network code out of every test process
  - `src/action.ts` — `run(deps: ActionDeps)`, the main-phase orchestration: reads the toml, merges inputs, installs the toolchain, adds targets/components, exports `RUSTUP_TOOLCHAIN`, restores every enabled cache layer, sets outputs. Also `runPost(deps: PostDeps)`, the post-phase orchestration: replays the plans and restore results `run` saved through `saveState`, saves whatever is left to save, writes the job summary. Executes argv arrays with no shell, bounds each call with a timeout, and retries network-bound commands with backoff. A cache failure in either phase warns and never fails the build
  - `src/core.ts` — toolchain spec parsing, `rust-toolchain.toml` parsing via `smol-toml`, cachekey generation
  - `src/config.ts` — merge toml config with action inputs (scalars replaced by inputs; lists accumulate deduped, inputs leading), `ToolchainInputs` + `ResolvedToolchain` types; `resolveRustupEnv` resolves `RUSTUP_HOME`/`CARGO_HOME`, honouring caller-supplied values
  - `src/builder.ts` — fluent `ToolchainSpecBuilder` with `.withChannel()`, `.withTargets()`, `.withComponents()`, `.withProfile()`, `.build()`
  - `src/outputs.ts` — `buildActionOutputs` maps the resolved spec plus the inputs, toml and cache lifecycle outcome it was merged from onto the action's outputs; `toOutputEntries` flattens them to the `name, value` pairs GitHub accepts, serialising lists as JSON arrays and the whole object as `json`
  - `src/cache/layers.ts` — `CACHE_LAYER_IDS`, the canonical layer list, and `parseCacheLayers`, which reads the `cache-layers` input into a deduped layer list
  - `src/cache/keys.ts` — `joinKeySegments` (collapses empty segments) and `buildLayerKey`, which derives a layer's key and restore-key ladder; the `build` key folds in `envHash`
  - `src/cache/inputs.ts` — reads and validates every `cache-*` input before anything is installed (`readCacheRequest`), then completes the validated request into per-layer keys once the spec digest exists (`buildCacheOutputs`). Takes a narrow `CacheInputSource` rather than `ActionDeps`, which is what keeps it free of an import cycle back to `action.ts`
  - `src/cache/env.ts` — `hashBuildEnv` digests the `CARGO_*`/`CC`/`CFLAGS`/`CXX`/`CMAKE`/`RUST*` environment into the `build` key's `envHash` segment, so two jobs differing only in `RUSTFLAGS` stop sharing a key
  - `src/cache/paths.ts` — `parseWorkspaces` reads `cache-workspaces` into resolved `<manifest-dir> -> <target-dir>` mappings, rejecting anything that resolves outside the checkout; `registryPaths` and `buildPaths` name each layer's paths. `registryPaths` lists bare directories and lets tar recurse; `buildPaths` cannot, because it has exclusions — it emits a files-only glob set (`<target>/**` plus `!<target>/**/incremental/**`, `!<target>/**/examples/**` and the `!<target>/` and `!<target>/**/` directory negations), since `@actions/cache` runs `tar --files-from` without `--no-recursion` and any directory left in the manifest re-includes the excluded subtrees
  - `src/cache/budget.ts` — `parseSize` reads `cache-budget` into a byte count (binary suffixes, `0` disables it); `measurePaths` sums a layer's on-disk size through an injected `StatFs` port
  - `src/cache/client.ts` — `CacheClient`, the restore/save port. Its only real implementation wraps `@actions/cache` and lives in `src/index.ts`
  - `src/cache/lifecycle.ts` — `restoreLayers` restores every enabled layer concurrently, downgrading any failure to a miss; `saveLayers`/`saveLayer` decide whether each layer is worth saving (skip on an exact hit, skip when its size can't be measured, skip over budget) and save the rest concurrently, each independently caught
  - `src/cache/summary.ts` — `renderSummary` renders the per-layer restore/save outcome as the job summary's Markdown table — the only place a per-layer result is visible, since `cache-hit` is a single all-layers boolean
  - `src/errors.ts` — `describeError` renders a caught `unknown` as a message; extracted because the `instanceof Error` ternary was written out nine times across `action.ts`, `cache/lifecycle.ts` and `core.ts`
  - `src/tools.ts` — everything `cargo-tools` needs: `parseToolSpecs` reads the input into `<name>@<version>` specs, rejecting anything that is not a cargo identifier before a command runs; `resolveToolVersions` turns `latest` into a concrete version through the `RegistryClient` port, retrying with backoff and degrading a failure to `UNRESOLVED_VERSION` rather than throwing; `hashToolSet` digests the resolved set into the `bin` key's final segment; `ensureTools` probes `<name> --version` and installs only what the restore did not supply. A pinned version never reaches the client, which is what makes a registry outage unable to affect it
  - `src/inputs.ts` — `readBooleanInput` and the `InputReader` port it takes; shared by `action.ts` and `cache/inputs.ts`, so it belongs to neither
  - `src/lib.ts` — the library barrel. Re-exports every other library module and deliberately **not** `index.ts`, whose import executes the action
  - `src/*.test.ts` — co-located tests; `tsconfig.json` includes `**/*.ts`, so `bun run typecheck` type-checks them too

## GitHub Actions

- **GitHub Actions Toolkit**: Use `@actions/core` (`getInput`, `setOutput`, `setFailed`) and `@actions/github` (`context`) from <https://github.com/actions/toolkit/tree/main>. Never write raw env var access (`process.env.INPUT_*`) or direct GitHub_OUTPUT manipulation — always use the toolkit.
- **Pin to commit SHA**: All `uses:` references in `.github/workflows/*.yml` and `.github/actions/*/action.yml` MUST use the full commit SHA of the release tag (e.g. `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`). Never use `@v{major}` or `@v{major}.{minor}` tag annotations — they are mutable and undermine supply-chain security. The comment after the pin documents the SemVer for human readability.
- **Name every job and step in Title Case**: Every `jobs:` and `steps:` entry MUST have a `name:` key using Title Case (e.g., `Setup`, `Lint`, `Build Action`, `Run Tests`). Separate job properties from `steps:` with an empty line.
- **Use `gh` CLI to inspect runs**: `gh run view <run-id>`, `gh run view <run-id> --log-failed`, `gh run list`.
- **Local testing with `act`**: `mise run act` runs the workflow from `.github/workflows/tests/act.yml` locally via Docker (catthehacker/ubuntu:full-latest). Ensure Docker is running and `gh auth login` is done first.

## Code Style

- **ESLint**: Flat config v9+, strict TS rules. `explicit-function-return-type: error`, `no-explicit-any: error` (relaxed in test files).
- **Imports**: `import-x/order` enforced — builtin → external → internal → parent → sibling. `bun:` prefixed to external. Blank lines between groups.
- **Format**: Prettier with `prettier-plugin-organize-imports`. Double quotes, trailing commas, 80-width.
- **Fluent Builder pattern**: prefer chained builder methods with a terminal `.build()` call over large constructors.
- **No `console.log` restriction** (off by config).
- **Unused vars**: `error` (prefix with `_` to ignore).
