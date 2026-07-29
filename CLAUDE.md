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
<!-- action-docs-all source="action.yml" project="elioseverojunior/rust-toolchain" version="v1" -->
```

`action-docs` has no CLI flag for `project`/`version` and never reads the repo
slug from git or `package.json` — it substitutes those two attributes into the
Usage block's `uses:` line. Drop them from either marker and the block silently
regenerates as `- uses: @`.

`mise run readme` emits unpadded tables, so always follow it with
`bun run fix:all` (Prettier realigns them) or the diff stays dirty.

## TOML parsing

Use `smol-toml` (`import { parse } from "smol-toml"`), never `@iarna/toml`.
