<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Runbooks

## Development Setup

### Prerequisites

- **mise** — tool version manager (`brew install mise`)
- **Docker** — required by `act` for local workflow testing

### First-Time Setup

```sh
mise run setup   # Installs mise-managed tools and project dependencies
```

`setup` (aliases: `install`, `dev`, `dev:setup`, `dev:up`) runs `mise install`,
`mise deps`, and `bun install` for you. To do it by hand:

```sh
mise install     # Managed tools (bun, gh, actionlint, …)
bun install      # Project dependencies
```

### Environment

`GITHUB_TOKEN` is needed for `act` and `gh` operations:

```sh
gh auth login        # Authenticate with GitHub
mise run gh:token    # Verify token works
```

## Development Workflow

### TDD Cycle

This project follows strict TDD:

1. Write a failing test (`bun test` — **red**)
2. Write minimal code to pass (**green**)
3. Refactor while keeping tests passing

```sh
bun test                    # Run tests once
bun test --watch            # Watch mode for TDD
bun test src/path/to/file.test.ts  # Single file
```

### Quality Gate

Run before every commit — enforced by hk:

```sh
bun run fix:all      # ESLint fix + Prettier format
bun run typecheck    # tsc --noEmit (strict mode)
bun run test:coverage # 100% line/function/statement gate
```

## Testing

### Coverage Thresholds

Defined in `bunfig.toml`:

```toml
[test]
coverageThreshold = { lines = 1.0, functions = 1.0, statements = 1.0 }
```

All three metrics must be **100%** per source file. Coverage excludes:

- `dist/` — build output
- `bin/` — CLI bootstraps
- `__tests__/` — test infrastructure
- `integration-*/` — integration test suites

### Test Layout

```text
src/
├── action.test.ts      # run() against injected fakes — argv, timeouts, retries, failures, outputs
├── core.test.ts        # TOML parsing, channel resolution, cache key, rustc parsing
├── config.test.ts      # Merge toml + inputs, path rejection, validation, resolveRustupEnv
├── builder.test.ts     # Fluent builder, ToolchainSpec, rustup argv generation
├── outputs.test.ts     # Resolved config → action outputs, JSON serialisation, provenance
├── lib.test.ts         # Barrel export surface, and that it never re-exports index.ts
```

`src/index.ts` has no co-located test: it is a side-effecting entry script, so
importing it would run the action. Nothing imports it, so Bun never loads it and
it does not appear in the coverage report — which is exactly why it holds only
dependency wiring. All orchestration lives in `src/action.ts`, where
`src/action.test.ts` drives it through the injected `ActionDeps`.

## Building

### Build the Action Bundle

```sh
bun run build:action
# Output: dist/index.js
```

This bundles `src/index.ts` with all dependencies into a single file for the
GitHub Actions `node24` runtime (`runs.using` in `action.yml`).

`dist/` is committed: GitHub fetches the action straight from the repository and
needs the built bundle. The CI **Build** job runs `git diff --exit-code dist/`,
so always rebuild and commit `dist/` alongside any `src/` change.

## Local GitHub Action Testing with `act`

### Setup

The `.actrc` file configures the local runner:

```text
-P=ubuntu-latest=catthehacker/ubuntu:full-latest
--pull=false
--container-daemon-socket=/var/run/docker.sock
--eventpath=./.act/event.json
--secret-file=./.act/.secrets
--var-file=./.act/.vars
--detect-event
--use-gitignore
--use-new-action-cache
```

### Run

```sh
mise run act          # .github/workflows/tests/act.yml  — single case
mise run act:matrix   # .github/workflows/tests/act-matrix.yml — full matrix
```

Both workflows exercise **this** action (`uses: ./`) end-to-end against a real
rustup. GitHub does not run them: only `.github/workflows/*.yml` at the top level
is picked up, and these live in a `tests/` subdirectory.

Each job:

1. Checks out the repository
2. Creates an isolated `RUSTUP_HOME` (see the overlayfs note under Troubleshooting)
3. Optionally writes a `rust-toolchain.toml` for the case under test
4. Runs the action via `uses: ./`
5. Asserts the `cachekey` and `name` outputs are non-empty
6. Asserts the isolated `RUSTUP_HOME` was honoured
7. Asserts the **effective** toolchain — `RUSTUP_TOOLCHAIN`, `rustup show active-toolchain`, and `rustc --version`
8. Asserts requested targets, components, profile effects, and the default toolchain

The matrix covers `stable`, `nightly`, a pinned `1.85.0`, a `<major.minor>`
series from toml, toml-vs-input override precedence, and `profile: minimal`.

### `.act/` Directory

| File              | Purpose                      | Tracked in Git |
| ----------------- | ---------------------------- | -------------- |
| `.act/README.md`  | Documentation                | Yes            |
| `.act/event.json` | Event payload for act        | No             |
| `.act/.secrets`   | Secrets (e.g., GitHub_TOKEN) | No             |
| `.act/.vars`      | Variables for act            | No             |
| `.act/.env`       | Environment variables        | No             |

## CI/CD Pipeline

### GitHub Actions

`.github/workflows/cicd.yml` runs on push, pull request, and `workflow_dispatch`,
with these jobs:

| Job       | Purpose                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `setup`   | Checkout and provision the toolchain via mise                               |
| `lint`    | `hk` lint suite (ESLint, Prettier, actionlint, yamllint, markdownlint)      |
| `test`    | `bun test` with the 100% coverage gate                                      |
| `sast`    | Static analysis / secret scanning                                           |
| `build`   | Rebuilds the bundle and fails on a stale `dist/` via `git diff --exit-code` |
| `release` | Publishes the action on tagged releases                                     |

Supporting workflows: `labeler.yml`, `stale-tags-cleanup.yml`, and
`update-floating-tag.yml`.

### Pre-Commit Hooks (hk)

Enforced before every commit:

1. **commitlint** — validates conventional commit format
2. **ESLint** — strict mode, zero warnings
3. **Prettier** — formatting check
4. **typecheck** — `tsc --noEmit`
5. **markdownlint** — `rumdl`
6. **mermaid** — parses every ` ```mermaid ` block with mermaid's own parser
7. **actionlint**, **gitleaks**, and the whitespace/EOF fixers
8. **coverage** — `bun test --coverage` (100% gate), on `pre-commit:all`

### Mermaid diagrams

`rumdl` validates the fence, not the diagram inside it, so a syntax error would
otherwise surface only as a broken render on GitHub. `scripts/lint-mermaid.ts`
extracts every block and runs it through mermaid's own parser, reporting
`file:line` on failure.

```sh
mise run mermaidlint            # every Markdown file
mise run mermaidlint docs/x.md  # just one
```

Mermaid 11 treats `@` as edge-id syntax, so a node label containing one must be
quoted — `TK["@actions/core"]`, not `TK[@actions/core]`.

## Dependency Management

### Check for Updates

```sh
bun run deps:check    # List available minor updates
bun run deps:latest   # Update to latest versions
```

### Add a Dependency

```sh
bun add <package>              # Production dependency
bun add --dev <package>        # Dev dependency
```

Runtime dependencies are `@actions/core` (inputs, outputs, `exportVariable`,
failures), `@actions/github` (workflow context), and `smol-toml` (TOML parsing).

## Troubleshooting

### Coverage Gate Fails

```sh
bun test --coverage           # See which file/metric fails
cat coverage/lcov.info        # Inspect line coverage data
```

Common causes:

- **Bun #7025**: Classes with field declarations but no explicit constructor create a phantom function. Always add an explicit `constructor()`.
- **New code**: Ensure all functions, lines, and statements are covered.

### `act` Fails

```sh
# Check Docker is running
docker info

# Verify secrets file exists
ls -la .act/.secrets

# Regenerate GitHub token — the secret file is KEY=VALUE, not a bare token.
# `mise run act` does this for you.
echo "GITHUB_TOKEN=$(gh auth token)" > .act/.secrets

# Run with verbose output
act -W .github/workflows/tests/act.yml --verbose
```

### `Invalid cross-device link (os error 18)` during rustup install

```text
error: could not rename 'component' file from
'/home/runner/.rustup/toolchains/stable-.../share/doc/clippy'
to '/home/runner/.rustup/tmp/<random>_dir/bk': Invalid cross-device link (os error 18)
```

This is an overlayfs limitation, not a rustup or toolchain-version problem.
rustup renames a component's **directory** into `$RUSTUP_HOME/tmp` before
replacing it, and overlayfs returns `EXDEV` for any directory rename whose source
still lives in a lower image layer. Files are copied up on demand; directories
are not, unless the mount uses `redirect_dir=on`. It therefore hits any toolchain
baked into the container image — `stable` in `catthehacker/ubuntu:full-latest`,
for example — while a freshly downloaded toolchain is unaffected.

Fix: point `RUSTUP_HOME` at a directory created at run time, so every rename
stays inside the writable upper layer.

```yaml
- name: Prepare Isolated Rustup Home
  shell: bash
  run: |
    rustup_home="${RUNNER_TEMP:-/tmp}/rustup"
    mkdir -p "$rustup_home"
    echo "RUSTUP_HOME=$rustup_home" >> "$GITHUB_ENV"
```

Leave `CARGO_HOME` alone so the rustup binary and its proxies stay on `PATH`;
they read `RUSTUP_HOME` from the environment. Set this in a step rather than a
job-level `env:` block — the `runner` context is not available there.

### Later steps run a different toolchain than the one installed

`rustup default` is only the _last_ entry in rustup's override chain, so a
`rust-toolchain.toml` in the workspace beats it. The action exports
`RUSTUP_TOOLCHAIN` (precedence 2) to prevent this. To confirm what is actually
active:

```sh
rustup show active-toolchain   # names the override source
rustc --version
```

### `"..." is not a valid rustup toolchain name`

`resolveChannel` rejected the channel before anything ran. Expected shapes are
`stable`, `nightly`, `1.89.0`, `nightly-2025-01-01`, optionally with a host
triple. The same guard applies to targets, components and profiles via
`mergeConfig`, which reports which kind of value was rejected.

### `Input \`set-rustup-toolchain\` must be "true" or "false"`

The input accepts only YAML booleans. A typo is rejected rather than being read
as `false`, which would silently stop pinning the toolchain for later steps.

### rustup was installed but the job cannot find it

`bootstrapRustup` adds `$CARGO_HOME/bin` to `PATH` through `core.addPath`, which
only affects **subsequent** steps — never the step already running. Within the
action itself, rustup is invoked through the environment it was installed into.
If a later step still cannot find it, check that `CARGO_HOME` was not changed
between steps.

### A bare `1.9` installed something unexpected

It resolves to `1.90`, not the 2015 release. `scaleBareMinor` scales a truncated
minor while the scaled value names a release that already exists. Write the full
`1.9.0` if you genuinely want the old one.

### TypeScript Errors

```sh
bun run typecheck           # Full check
tsc --noEmit --pretty       # With colored output
```

Common issues:

- `verbatimModuleSyntax` requires `import type` for type-only imports
- `noUncheckedIndexedAccess` requires `!` assertions on array access

### Bun Test Runner Issues

```sh
# Clear V8 coverage cache
rm -rf coverage/

# Verify bun version
bun --version   # Should be ^1.3.14

# Run single test file
bun test src/core.test.ts
```

## Adding a New Feature

1. **Write test first** — create or extend `src/*.test.ts`
2. **Implement** — write minimal code to pass
3. **Verify** — `bun run test:coverage` must show 100%
4. **Typecheck** — `bun run typecheck` must pass
5. **Lint** — `bun run fix:all` must be clean
6. **Build** — `bun run build:action`, and commit the regenerated `dist/`

A new library module must be added to the barrel, `src/lib.ts`, and to the
export list `src/lib.test.ts` pins — that test fails until both are updated,
which is deliberate. Never add `src/index.ts` to the barrel: it is the action
entry point, exports nothing, and calls `run()` on import.

Import siblings as `@rust-toolchain/<module>`, never `./<module>` and never
`@/<module>`. The package specifier is what a consumer maps, so it is the only
form that resolves both here and in their project; `@/` is for tests only.

Put new orchestration in `src/action.ts`, never in `src/index.ts` — the entry
script is excluded from coverage, so logic added there is untested by
construction.

## Release Process

Releases are automatic. Every push to `main` runs the CICD **Release** job,
which:

1. Computes the next version with GitVersion
2. Rewrites `owner/repo/...@vX.Y.Z` references under `.github/`
3. Tags and publishes a GitHub Release

Do **not** bump `package.json` or create tags by hand — the job does both, and a
hand-made tag collides with the one it creates. To release, merge to `main` with
a conventional commit message; the bump level follows from the commit type.

Prereleases are skipped: the job exits early when GitVersion reports a
prerelease label.
