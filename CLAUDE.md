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
  hand — the manual release steps in `docs/content/RUNBOOKS.md` are out of
  date.

## Rustup invariants — do not "simplify" these

Full reasoning in `docs/content/ARCHITECTURE.md` → Key Design Decisions.

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
- **Markdown files carry NO SPDX header; `.ts`/`.tsx` files do.**
  `REUSE.toml` licenses everything, `docs/**` included, through its
  `path = ["**"]` aggregate annotation, and its own comment records that
  Markdown needs no inline header on top of that. This matters specifically
  because MDX rejects HTML comments: an SPDX header written as `<!-- -->`
  fails the build, and rewriting it as a JSX comment `{/* */}` only trades
  that failure for a header that renders as literal visible text on GitHub.
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
  `themeConfig.image` and the `apple-touch-icon` `head` tag in
  `docusaurus.config.ts` all reference files under `static/img/` by a bare
  path string, and none of those paths are validated at build time — the same
  gap VitePress had with its `public/` directory, carried across unchanged. A
  typo there 404s silently in production; nothing here catches it.

## TOML parsing

Use `smol-toml` (`import { parse } from "smol-toml"`), never `@iarna/toml`.
