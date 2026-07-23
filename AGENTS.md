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
- **Override by inputs** — action inputs (`toolchain`, `targets`, `target`, `components`, `profile`) override toml values
- **Fluent Builder pattern** — `ToolchainSpecBuilder` with chaining for programmatic construction
- **Compatible outputs** — `cachekey` and `name` outputs matching dtolnay/rust-toolchain

## Rustup Concepts (Reference)

Refer to the [rustup book](https://rust-lang.github.io/rustup/concepts/index.html) for core concepts:

- [Channels](https://rust-lang.github.io/rustup/concepts/channels.html) — stable, beta, nightly release channels
- [Toolchains](https://rust-lang.github.io/rustup/concepts/toolchains.html) — `<channel>[-<date>][-<host>]` specification
- [Components](https://rust-lang.github.io/rustup/concepts/components.html) — `rustc`, `cargo`, `clippy`, `rustfmt`, etc.
- [Profiles](https://rust-lang.github.io/rustup/concepts/profiles.html) — `minimal`, `default`, `complete` groupings of components
- [Overrides](https://rust-lang.github.io/rustup/overrides.html) — how `rustup` resolves which toolchain to use. Precedence, highest first: `+toolchain` shorthand → `RUSTUP_TOOLCHAIN` → directory override → `rust-toolchain.toml` → default. The action exports `RUSTUP_TOOLCHAIN` so its resolved channel beats a workspace `rust-toolchain.toml` in every later step
- [`rustup toolchain install`](https://rust-lang.github.io/rustup/concepts/toolchains.html) — supports `--profile`, `--target`, `--component` flags

### Key `rustup` Commands

- `rustup toolchain install <channel> [--profile <name>] [--target <triple>]... [--component <name>]...` — install toolchain with profile, targets, components in one command
- `rustup default <channel>` — set the default toolchain (proxies delegate to this)
- `rustup set profile <name>` — set the **global default** profile for new installations (side effect: changes behavior of ALL future `rustup toolchain install` commands)
- `rustup target add <triple>` — add a target to an existing toolchain
- `rustup component add <name>` — add a component to an existing toolchain

## Architecture

- **Entrypoint (action)**: `src/index.ts`. Build uses `@actions/core` for inputs, outputs, and failures.
- **Library API**: no barrel export — programmatic consumers import `src/core.ts`, `src/config.ts`, and `src/builder.ts` directly.
- **Build**: `bun run build:action`
- **Source layout**:
  - `src/index.ts` — GitHub Action entry point; a side-effecting script (no exports) bundled to `dist/index.js`. Reads inputs, installs toolchain, exports `RUSTUP_TOOLCHAIN`, sets outputs via `@actions/core`
  - `src/core.ts` — toolchain spec parsing, `rust-toolchain.toml` parsing via `smol-toml`, cachekey generation
  - `src/config.ts` — merge toml config with action inputs (inputs win), `ToolchainInputs` + `ResolvedToolchain` types; `resolveRustupEnv` resolves `RUSTUP_HOME`/`CARGO_HOME`, honouring caller-supplied values
  - `src/builder.ts` — fluent `ToolchainSpecBuilder` with `.withChannel()`, `.withTargets()`, `.withComponents()`, `.withProfile()`, `.build()`
  - `src/*.test.ts` — co-located tests (excluded from tsc via tsconfig)

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
