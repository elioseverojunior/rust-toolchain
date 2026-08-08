<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

@AGENTS.md

## Runtime

Default to Bun instead of Node.js.

- `bun <file>` instead of `node <file>` / `ts-node <file>`
- `bun install` / `bun run <script>` / `bunx <pkg>` instead of the npm, yarn, or
  pnpm equivalents
- Bun loads `.env` automatically — never add `dotenv`

## Commands

Run in this order before every commit:

```sh
bun run fix:all      # eslint --fix, then prettier --write
bun run typecheck    # tsc --noEmit (covers src/*.test.ts too)
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

## `dist/` is committed

`action.yml` runs `dist/index.js` on the `node24` runtime, so the bundle is
tracked in git. The CI Build job runs `git diff --exit-code dist/` and fails on
a stale bundle — always `bun run build` and commit `dist/` alongside any `src/`
change.

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

## Commits and releases

- `commitlint` runs in `hk`'s `commit-msg` hook. Conventional Commits, with
  `type` limited to the enum in `commitlint.config.cjs` (it adds `init`) and a
  scope expected — e.g. `feat(config): resolve rustup home`.
- Every push to `main` runs the CICD **Release** job: GitVersion computes the
  version, rewrites `owner/repo/...@vX.Y.Z` references under `.github/`, tags,
  and publishes a GitHub Release. Never bump `package.json` or create tags by
  hand — the manual release steps in `docs/RUNBOOKS.md` are out of date.

## Rustup invariants — do not "simplify" these

Full reasoning in `docs/ARCHITECTURE.md` → Key Design Decisions.

- `src/action.ts` exports `RUSTUP_TOOLCHAIN`; `rustup default` alone loses to a
  workspace `rust-toolchain.toml`, which sits at precedence 4 of 5 and beats
  only the global default. `set-rustup-toolchain: false` opts out for monorepos
  whose crates pin their own toolchains.
- Every `rustup target add` / `component add` pins `--toolchain <channel>`.
- Commands are built as argv arrays and executed without a shell. Channel,
  targets, components and profile can come from an untrusted workspace
  `rust-toolchain.toml` — never interpolate them into a command string.
- `--profile` is always passed explicitly — omitting it inherits the runner's
  global `rustup set profile`.
- A `path` toolchain in the toml is rejected, never defaulted to `stable`.
- `resolveRustupEnv` honours a caller-supplied `RUSTUP_HOME`; overlayfs runners
  need it pointed at a directory created at run time, or rustup's component
  renames fail with `EXDEV`.

## Cache invariants — do not "simplify" these

Full reasoning in `docs/ARCHITECTURE.md` → Key Design Decisions, in the Cache
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
  glob set must stay files-only.** `buildPaths` (`src/cache/paths.ts`) emits
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

## Action pinning overrides the global rule

Every `uses:` in `.github/workflows/*.yml` and `.github/actions/*/action.yml`
pins the full commit SHA with a trailing `# vX.Y.Z` comment. This deliberately
overrides the "prefer the loosest tag" rule in the personal global CLAUDE.md.
Refresh pins with `mise run uapw`.

## `.github/workflows/tests/` is act-only

GitHub picks up only top-level `.github/workflows/*.yml`. `tests/act.yml` and
`tests/act-matrix.yml` run locally through `mise run act` /
`mise run act:matrix` (Docker running and `gh auth login` done first).

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

## `docs/` is a VitePress site with its own toolchain

`docs/` holds both the repository's prose (`ARCHITECTURE.md`, `COMPARISON.md`,
`RUNBOOKS.md`, `design/`, `plans/`) and a VitePress site that publishes it. It
has its **own** `package.json`, `bun.lock`, `tsconfig.json`, ESLint and Prettier
configs — `bun run <script>` from the repo root does not reach them. Build and
lint it from inside `docs/`:

```sh
cd docs && bun run build          # vitepress build — dead links FAIL it
cd docs && bun run fix:all        # its own eslint + prettier
```

The repo-root `hk check --all` still covers `docs/**/*.md` through `rumdl` and
`mermaid`, so both layers apply to the Markdown.

- **`base` must keep its trailing slash.** VitePress asserts it, and
  `.vitepress/config.mts` interpolates it directly into every `head` entry —
  `"/rust-toolchain"` makes the favicon resolve to the single path segment
  `/rust-toolchainfavicon.svg`. `DOCS_BASE=/ bun run build` targets root-domain
  hosting.
- **Dev and preview are pinned to port 5273 with `strictPort`**, overridable
  via `DOCS_PORT`. Pinned because Vite's 5173 default is claimed by every other
  checkout; strict because the silent fallback to 5174 prints a URL nobody
  reads.
- **`ignoreDeadLinks: false` only validates links in Markdown content, never in
  `themeConfig.nav`/`sidebar`.** A nav entry written ahead of its page builds
  clean and 404s in the browser, so that block is hand-maintained. Do not flip
  the setting to `true` to silence a failure — it hides the class of breakage
  that is caught while leaving the invisible class untouched.
- **A page reaching a file outside `docs/` needs an absolute repository URL.**
  `../README.md` resolves outside the srcDir and is exactly what the dead-link
  check exists to catch.
- **A referenced `public/` asset is never checked.** The `head` block pointed at
  `favicon.svg`/`favicon.ico` through an empty `public/` for as long as the
  scaffold existed, 404ing on every page, and the build stayed green throughout.

`docs/.vitepress/cache/` and `dist/` are git-ignored; the dep cache alone is
~2.8 MB and trips `hk`'s `check-added-large-files`.

## TOML parsing

Use `smol-toml` (`import { parse } from "smol-toml"`), never `@iarna/toml`.
