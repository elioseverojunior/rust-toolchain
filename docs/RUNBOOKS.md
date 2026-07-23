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
├── core.test.ts        # TOML parsing, channel resolution, cache key, rustc parsing
├── config.test.ts      # Merge toml + inputs, path rejection, resolveRustupEnv
├── builder.test.ts     # Fluent builder, ToolchainSpec, rustup command generation
```

`src/index.ts` has no co-located test: it is a side-effecting entry script whose
logic lives in the three modules above. Nothing imports it, so Bun never loads it
and it does not appear in the coverage report.

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
5. **coverage** — `bun test --coverage` (100% gate)

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

There is no barrel to update: `src/index.ts` is the action entry point and
exports nothing. Public API lives in `src/core.ts`, `src/config.ts`, and
`src/builder.ts`, which consumers import directly.

## Release Process

1. Update version in `package.json`
2. Run full quality gate (`lint + typecheck + coverage + build`)
3. Draft release notes via cliff.toml:

   ```sh
   mise run release  # Or use changesets
   ```

4. Tag with `vX.Y.Z` and push
5. GitHub Release automatically triggers action publication
