<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Contributing

Thanks for taking the time. This is a GitHub Action written in TypeScript, run
on Bun, published to the Marketplace as **Rust Toolchain and Cache**.

Two things about this repository surprise people, so they are first rather than
buried:

- **`dist/` is committed.** `action.yml` runs `dist/index.js`, so the bundle is
  tracked in git and CI fails on drift. Any change under `src/` needs
  `bun run build` and the rebuilt `dist/` in the same commit.
- **The coverage gate is 100%,** on lines, functions and statements, and it
  fails the build rather than reporting a number.

`AGENTS.md` is the canonical description of the codebase — architecture, the
invariants that must not be "simplified", and the reasoning behind them. Read it
before a non-trivial change. It is written for AI agents and humans alike; there
is no separate developer handbook.

## Setup

[mise](https://mise.jdx.dev) manages the toolchain, including Bun itself, so it
is the only thing to install by hand.

```sh
mise run setup     # aliases: install, dev:setup, dev:up
```

That resolves every pin in `mise.toml`, writes a machine-specific
`mise.local.toml` so mise steps aside where Homebrew already satisfies a pin,
and installs dependencies.

Dependencies are installed from the **repository root**, never by `cd docs`.
`docs/` is a Bun workspace of the root: there is one `bun.lock` and the shared
pins live in the root `catalog`. To add a dependency:

```sh
bun add <pkg>                  # the action
bun add --filter docs <pkg>    # the documentation site
```

If both sides need the same package, add it to the root `catalog` and reference
it as `"catalog:"` from both manifests. That is what makes version drift
impossible rather than merely detectable — it had already happened twice before
the catalog existed.

## The loop

Tests come first. Write the failing test, write the smallest thing that passes
it, then refactor with the test green. This applies to refactoring existing code
too, not only to new features.

```sh
bun test src/path/to/file.test.ts   # one file, while you work
bun run test                        # the suite, with the coverage gate
```

Tests live beside the code they cover (`src/foo.ts` → `src/foo.test.ts`).

### Before every commit

```sh
bun run fix:all      # eslint --fix, then prettier --write
bun run typecheck    # tsc --build
bun run test         # the 100% gate
bun run build        # regenerate dist/index.js
hk check --all       # exactly what the CI Lint job runs
```

`mise run dev` is a shorthand for the middle three (lint, typecheck, test) when
you just want to know if you broke something.

The last one is the one to actually run. `bun run fix:all` is only ESLint and
Prettier; `hk check --all` additionally runs `actionlint`, `rumdl` for Markdown,
a real mermaid parse of every ` ```mermaid ` block, `gitleaks`, and the
whitespace and end-of-file fixers, over the whole repository. Markdown findings
are fixable with `mise run markdownlint:fix`.

`bun run typecheck` is `tsc --build`, and that matters: the root `tsconfig.json`
is solution-style, so a bare `tsc --noEmit` selects zero files and exits 0
having checked nothing. The documentation site is type-checked separately, by
`mise run docs:typecheck`.

### Optional, and not a gate

```sh
mise run mutate <file>    # Stryker over one module — seconds
mise run mutate           # everything it covers — minutes
```

Mutation testing reports a score and never fails on it. Reach for it when
changing a threshold, a comparison or an error path: coverage proves a line ran,
this asks whether any assertion would notice it being wrong. A surviving mutant
is a question, not a defect — some are equivalent and no test can kill them.

## Writing tests that are worth having

One rule here is worth more than the rest, because ignoring it has shipped a bug
in this repository twice:

**A hand-written fake is a claim about someone else's code, and neither coverage
nor mutation testing can check it.** A double that disagrees with the real API
passes every gate and fails in production. Where a port wraps `node:fs`, test
the real adapter against a real temporary directory — `src/cache/fs.test.ts` is
the worked example, down to asserting the shared inode and mtime of a hard link,
because the code under test depends on both.

The same instinct applies to end-to-end proofs. A test that checks a file is
_absent_ after a cache restore can prove nothing when the surrounding tooling
recreates that file anyway; the proof has to plant marked content in the saving
job and look for it in the restoring one.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), validated by
`commitlint` in `hk`'s `commit-msg` hook.

- **Type** is required and checked as an error. One of: `init`, `build`, `ci`,
  `chore`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- **Scope** is expected and checked as a _warning_, so a scope outside the enum
  in `commitlint.config.cjs` will pass while telling you it is unusual.

```text
feat(config): resolve rustup home
fix(cache): archive pruned layers from a stage
```

Please sign your commits (`git commit -S`) — the history here is signed
throughout.

Say **why** in the body, not what: the diff already shows what changed. A commit
that reverses an earlier decision should say what evidence changed, because the
next person to read it will otherwise reverse it back.

### Never bump the version by hand

Every push to `main` runs the Release job. GitVersion computes the version,
rewrites the `owner/repo/...@vX.Y.Z` references under `.github/`, creates the
tags and publishes the release. Editing `package.json`'s version or creating a
tag by hand desynchronises GitVersion.

## Pull requests

Fill in the template — What, Why, Testing. The Testing section is the one
reviewers read first; "how was this validated" is a real question, and `act` runs
count.

```sh
mise run act                  # .github/workflows/tests/act.yml
mise run act:matrix           # the OS matrix
mise run act -t act-cache     # the cache layers, including the shim-exclusion proof
```

Docker has to be running and `gh auth login` done first. These are worth the
minutes: bugs in this repository have twice been caught by `act` and not by the
unit suite, because they only appear when a real filesystem is involved.

CI runs Lint, Test, SAST (CodeQL, both the `javascript-typescript` and `actions`
languages), Build with the `dist/` drift check, and E2E across Linux, macOS and
Windows. The docs site builds on any pull request touching `docs/`.

## Documentation

- **`AGENTS.md`** is the source of truth for anything true of the codebase.
  `CLAUDE.md` carries only what is specific to Claude Code as a harness and
  includes `AGENTS.md`. If a note would help any reader, it belongs in
  `AGENTS.md`.
- **Prose lives in `docs/content/`** — `ARCHITECTURE.md`, `COMPARISON.md`,
  `RUNBOOKS.md`, plus `design/` and `plans/` — and is published by Docusaurus
  from the site root. Changing a route breaks inbound links that nothing in CI
  checks, so treat the existing URLs as fixed.
- **The README's input and output tables are generated** from `action.yml` by
  `mise run readme`. Edit `action.yml`, regenerate, then run `bun run fix:all`
  so Prettier re-pads the tables. Hand edits between the `action-docs-all`
  markers are overwritten.
- **Every file carries an SPDX header,** Markdown included. `comply annotate`
  adds them and has no ignore mechanism, so removing one by hand does not stick.

```sh
mise run docs:dev      # hot reload, http://localhost:5273
mise run docs:build    # what CI builds
```

## Security

Do not open a public issue for a vulnerability. `SECURITY.md` has the private
advisory link and the response times.

## Licence

MIT OR Apache-2.0, and contributions are accepted under the same terms.

The repository is REUSE-compliant, but nothing enforces that automatically:
`comply` is not wired into CI, into `hk`, or into any mise task, so it is run by
hand. `comply annotate` is what puts an SPDX header on every file — including
Markdown, where it has no ignore mechanism at all, so a header removed by hand
comes back on the next run.
