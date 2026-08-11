<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Docusaurus Migration — Design

Status: approved, not yet planned
Date: 2026-08-10
Supersedes: the VitePress site described in `CLAUDE.md` → "`docs/` is a VitePress site with its own toolchain"

## Summary

Replace the VitePress site under `docs/` with Docusaurus 3.10.2, outright rather than side by side.

The site keeps its own `package.json` and `bun.lock`. That was not the original intent — this document proposed
folding both into the root through Bun workspaces so there would be one lockfile — but Task 1 of the plan measured
the idea and it does not pay. See **Dependencies** below for the numbers and what they cost.

The migration is worth doing for one measurable reason: it deletes 652 lines of bespoke Vue and TypeScript that exist
only to work around gaps in VitePress's mermaid story, replacing them with roughly six lines of configuration against
`@docusaurus/theme-mermaid`. Everything else — eleven Markdown pages, the `gh-pages` publish chain, the `DOCS_BASE`
override — carries across with small, enumerable changes.

A working Docusaurus + Bun site already exists at `docusaurus/` in this checkout, copied from the author's
`elioseverojunior.github.io` project. It is the scaffold the site is built on: four pieces are kept, the personal
content is stripped, and the directory is renamed to `docs/` at the end rather than deleted.

## Why this is low risk

Two independent facts, both verified against the checkout rather than assumed.

**The toolchains already agree.** `docusaurus/package.json` and the root `package.json` pin fourteen of sixteen
devDependencies at byte-identical versions — `@eslint/js` 10.0.1, `@happy-dom/global-registrator` 20.11.2,
`@types/bun` 1.3.14, both `@typescript-eslint/*` at 8.66.0, `eslint` 10.8.1, `eslint-import-resolver-typescript`
4.4.5, `eslint-plugin-import-x` 4.17.1, `globals` 17.9.0, `mermaid` 11.16.1, `prettier` 3.9.6,
`prettier-plugin-organize-imports` 4.3.0 and `typescript` at `~6.0.3`/`^6.0.3`. The `engines` block
(`node >=24.0.0,<25.0.0`, `bun ^1.3.14`, `typescript ^6.0.3`) and `peerDependencies` are identical;
`trustedDependencies` is a superset. All three `.bun-version` files hold `1.3.14`. The merge is therefore purely
additive — thirteen genuinely new packages, and no version conflict to reconcile.

**The hardest incompatibility is already solved.** `@docusaurus/tsconfig@3.10.2` sets `baseUrl`, which TypeScript 6.0
removed; because `extends` can override an inherited key but cannot delete one, any config inheriting it fails to
load under the pinned `typescript@~6.0`. `docusaurus/tsconfig.json` resolves this by reproducing the base verbatim
minus `baseUrl`, with `paths` made relative so it resolves against its own directory. That is the same `TS5101` trap
this repository already documents for its own configs, fixed the same way, and proven in a site that builds.

## Non-goals

- Docusaurus versioning and i18n. Both ship with the framework; neither is enabled. There is one version of these
  docs and one language.
- Migrating the personal-portfolio content from `docusaurus/`. None of its eleven React components describe this
  action.
- Changing what is published, where, or by whom. The `gh-pages` branch, `peaceiris/actions-gh-pages`, `keep_files`
  and the `cicd.yml` → `gh-pages.yml` call chain are all unchanged.
- Custom-domain hosting. `DOCS_BASE=/` keeps working for it, exactly as today, but nothing is set up.

## Architecture

### Workspace topology

Three separate mechanisms were proposed to carry the "one project, many sub-projects" idea. Two of them ship. They
are independent of each other, which is why losing the first costs the other two nothing.

**Dependencies — two lockfiles, deliberately.** `docs/` keeps its own `package.json` and `bun.lock`. The root does
**not** declare `"workspaces"`.

This reverses what this document originally proposed, on measurement rather than taste. The workspace idea rested on
one assumption: that `bun install --filter=<workspace>` would let the action's own CI jobs install without paying for
React and Docusaurus. Task 1 tested it and the assumption is false. `--filter` scopes what gets **linked** into
`node_modules` — the unfiltered workspace's `node_modules` is never even created — but Bun still resolves, downloads
and fully extracts that workspace's entire dependency graph into its shared package cache. Confirmed twice, the
second time with a provably cold `--cache-dir` to rule out a warm cache.

The cost of being wrong about this is not theoretical. Measured on a cold cache:

| Install                               | Packages | Time  |
| ------------------------------------- | -------- | ----- |
| Action dependencies alone             | 320      | 21.9s |
| Workspace, `--filter`ed to the action | 644      | 61.3s |

Every job that installs would pay 2.8x for a docs site it never imports. Two lockfiles is the cheaper mistake.

What this forfeits is real and worth naming: Bun would have failed the install if the two manifests ever disagreed on
one of their fourteen shared pins, and nothing enforces that now. The cheap replacement is a CI check that compares
the shared pins directly — it buys the drift protection back for no install cost. That is a follow-up, not part of
this migration.

The other two mechanisms below are unaffected: neither depends on a workspace.

**Type-checking — TypeScript project references.** This layer cannot be merged into one file. The action needs
`lib: ["ESNext"]` with `types: ["bun", "node"]`; the site needs `lib: ["ESNext", "DOM"]`, `jsx: "preserve"` and
`paths: { "@site/*": ["./*"] }`. Worse, the root config's `include: ["**/*.ts"]` would otherwise sweep
`docusaurus.config.ts` and the site's `src/types/*.ts` into the action's type-check and fail them on DOM and React
types. The root `tsconfig.json` therefore becomes solution style — `"files": []` plus `references` to
`./tsconfig.src.json` and `./docs/tsconfig.json` — so one invocation checks both, each under its own options.

**Linting — one flat config.** ESLint flat config already expresses this natively. The root `eslint.config.js` gains
a `files: ["docs/**/*.{ts,tsx}"]` block carrying `globals.browser` and the React settings, alongside the existing
`files: ["**/*.ts"]` block. No second config file.

### Resulting layout

```text
rust-toolchain/
├── package.json          action deps + action-docs; NO "workspaces" key
├── bun.lock              the action's lockfile; docs/ keeps its own
├── tsconfig.json         solution style: "files": [], "references": [...]
├── tsconfig.src.json     the action: lib ESNext, types bun+node
├── eslint.config.js      + a files:["docs/**/*.{ts,tsx}"] block
└── docs/
    ├── package.json      name "docs", its own dependencies
    ├── bun.lock          the site's own lockfile, not merged into the root
    ├── .bun-version      1.3.14, matching the root's copy
    ├── tsconfig.json     the TS6-safe config, lifted from docusaurus/
    ├── docusaurus.config.ts
    ├── sidebars.ts
    ├── src/{pages,components,css}/
    ├── static/           favicon.svg, favicon.ico, .nojekyll
    └── content/          the eleven Markdown pages, git mv'd from docs/
```

The content subdirectory is `content/`, not the plugin's default `docs/`, because the site root is itself named
`docs/` and `docs/docs/ARCHITECTURE.md` is a path nobody should have to explain. It is one line of configuration:
`docs: { path: "content", routeBasePath: "/" }`.

`routeBasePath: "/"` is the load-bearing half of that line, and it is about URLs rather than tidiness. VitePress
served these pages at `/rust-toolchain/ARCHITECTURE`; the Docusaurus docs plugin would default to
`/rust-toolchain/docs/ARCHITECTURE`. Since `keep_files: true` leaves the old published output in place on the
`gh-pages` branch, a changed route would not 404 — it would leave the **stale VitePress page still serving** at the
old URL while the new one appeared elsewhere, which is worse than a broken link because nothing reports it. Serving
from the root keeps every existing URL, and every external link to one, pointing at the new build.

### What is lifted from `docusaurus/`, and what is discarded

Lifted: `tsconfig.json` (the TypeScript 6 fix), `eslint.config.mjs` (folded into the root flat config), the
`docusaurus.config.ts` skeleton, and the `Section`/`Hero` component pattern used to rebuild the home page.

Discarded: `data/` (a complete Python and `uv` toolchain for download statistics), `scripts/`, the eleven portfolio
components under `src/components/portfolio/`, `src/pages/cv.tsx`, and `docusaurus/.github/`. That last one is inert
today — GitHub reads workflows only from the repository-root `.github/workflows` — but it is confusing dead weight
and a trap for anyone who later moves the directory.

### Sequencing — build beside, then rename

The site is assembled in `docusaurus/` and takes the `docs/` name last, rather than replacing `docs/` in place. The
end state is identical; the difference is that a buildable tree exists at every step instead of one commit in which
nothing works.

1. Move content and assets into `docusaurus/`, preserving history: `git mv docs/{ARCHITECTURE,COMPARISON,RUNBOOKS}.md
docs/design docs/plans docusaurus/content/` and the two favicons into `docusaurus/static/img/`. `git mv` rather
   than copy-and-delete so `git log --follow` survives — seven thousand lines moving directories is precisely the
   case where rename detection earns its keep.
2. Recover the navigation structure from history and write `sidebars.ts` (see the risk below).
3. Transform `docs/index.md`'s frontmatter into `src/pages/index.tsx`.
4. Wire mermaid and search; get `bun run build` green inside `docusaurus/`.
5. Retire the old scaffolding — `docs/`'s `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig*.json`,
   `eslint.config.js`, `.prettier*`, `.nvmrc`, `.bun-version` — then `git mv docusaurus docs`.

Only step 5 touches the paths that CI and tooling depend on, which is what keeps `gh-pages.yml`'s `paths:` filter,
the `mise run docs:*` tasks and the `editLink` pattern working without amendment.

One consequence is worth stating rather than discovering: while the site lives at `docusaurus/`, edits to it do not
trigger `gh-pages.yml`, whose `paths:` filter is `docs/**`. The docs build is therefore unverified by CI until step 5
lands, and step 5 should be the commit that gets the closest reading.

## Components

### Content

The eleven Markdown pages move to `content/` unchanged, by `git mv`. Note that eleven is the file count; the sidebar
carries nine entries, because `index.md` becomes the home page and this design document was written after that
sidebar.

Docusaurus 3 parses `.md` as MDX, so a bare angle bracket or brace in prose is a build error. This repository is
unusually well placed for that, because its writing already puts every identifier in backticks — placeholders such
as `<package>`, `<os>-<arch>` and `${{ hashFiles('**/Cargo.lock') }}` all sit inside fenced blocks or code spans,
where MDX leaves them alone.

Do not, however, trust a count here. Three successive regular-expression audits of this repository returned three
different answers — four constructs, then six, then seven — and every candidate that survived to manual inspection
turned out to be inside a code span after all. The technique is simply unsound: stripping fenced blocks and inline
spans with regular expressions desynchronises on multi-line code spans and on any file with an odd backtick count.
**The MDX parser is the only reliable oracle.** The plan therefore runs `docusaurus build` over the copied content
as an early step and fixes whatever it reports, rather than pre-committing to a list. The expectation, on the
evidence, is that few or no pages need an escape, and the risk of being wrong is bounded because every such failure
is a loud build error rather than a silent one.

`docs/index.md` is the exception and is rewritten. Its `layout: home` frontmatter — a hero block plus six feature
cards — is a VitePress theme feature with no Docusaurus counterpart. It becomes `docs/src/pages/index.tsx` carrying
the same hero copy and the same six features, built from the lifted `Section` component. The existing constraint
that the SPDX header sits _below_ the frontmatter, never above it, applies to MDX for the same reason it applied to
VitePress: anything preceding the opening delimiter stops it being read as frontmatter at all.

Navigation moves from `themeConfig.nav`/`sidebar` into `docusaurus.config.ts` and `sidebars.ts`. It stays
hand-maintained.

### Mermaid

This is the reason to migrate. Four files totalling 652 lines are deleted:

| File                                | Lines |
| ----------------------------------- | ----- |
| `.vitepress/theme/Mermaid.vue`      | 355   |
| `.vitepress/theme/mermaid-theme.ts` | 179   |
| `.vitepress/mermaid.ts`             | 94    |
| `.vitepress/theme/index.ts`         | 24    |

A fifth file, `.vitepress/env.d.ts` (21 lines), goes with them. It is the `*.vue` module shim that lets
`theme/index.ts` import the component at all, so it has no purpose once the component is gone; it is counted
separately because it is a Vue-support file rather than mermaid code.

They are replaced by adding `@docusaurus/theme-mermaid` to `themes`, setting `markdown: { mermaid: true }`, and
declaring the palette under `themeConfig.mermaid`. The two problems that Vue code was written to solve are both
handled natively by the official theme: it does not pull mermaid into the client entry, so diagram-free pages stop
emitting `modulepreload` links for katex, gantt, C4 and the rest; and it does not force `theme: "dark"` over the
configured theme variables.

Note that the copied site pins `mermaid` but never wires it — it has no `@docusaurus/theme-mermaid`, no
`markdown.mermaid` and no `themes` entry. Adding the theme is new work, not a copy. Nine fences must keep rendering:
eight in `ARCHITECTURE.md`, one in `RUNBOOKS.md`.

`scripts/lint-mermaid.ts` is untouched. It globs `**/*.md` from the repository root and parses each fence with
mermaid itself, so it never knew which framework consumed the output. The `hk` `mermaid` step keeps working
unchanged.

### Site configuration

The one mandatory semantic change is user site to project site. The copied config targets
`elioseverojunior.github.io` and therefore serves from the domain root:

```ts
// from (personal user site)
const baseUrl = "/";
projectName: "elioseverojunior.github.io",

// to (this repository's project site)
const baseUrl = process.env.DOCS_BASE ?? "/rust-toolchain/";
projectName: "rust-toolchain",
```

`url: "https://elioseverojunior.github.io"`, `organizationName: "elioseverojunior"`,
`deploymentBranch: "gh-pages"` and `trailingSlash: false` are unchanged from the copy.

Docusaurus resolves assets through `useBaseUrl`, so the hand-written `${base}favicon.svg` interpolation in the
VitePress `head` block disappears, and with it the invariant warning about `base` needing its trailing slash for
that interpolation to work. Docusaurus asserts leading and trailing slashes on `baseUrl` itself.

Search needs a replacement for VitePress's `search: { provider: "local" }`. `@docusaurus/preset-classic` bundles
Algolia DocSearch, not offline search, so the site takes the community `@easyops-cn/docusaurus-search-local` plugin.
The decision is to keep search: losing it is a user-visible regression from the site being replaced, and Algolia is
not an option because it would make a static site depend on an external service and an application process. If the
plugin cannot be made to build, shipping without search is the accepted fallback — eleven pages remain navigable from
the sidebar — and that is a plan-time escape hatch, not a second design.

## Build and CI

| Concern                       | From                                            | To                                              |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Build output                  | `docs/.vitepress/dist`                          | `docs/build`                                    |
| `gh-pages.yml` upload `path:` | `docs/.vitepress/dist`                          | `docs/build`                                    |
| Lockfile assertion            | `git diff --exit-code -- docs/bun.lock`         | unchanged                                       |
| `bun-version-file`            | `docs/.bun-version`                             | unchanged                                       |
| `mise run docs:install`       | `dir = "docs"`, `bun install --frozen-lockfile` | unchanged                                       |
| `mise run docs:dev`           | `vitepress dev` on 5273                         | `docusaurus start --port 5273`                  |
| `mise run docs:build`         | `vitepress build`                               | `docusaurus build`                              |
| `mise run docs:preview`       | `vitepress preview --port 5273`                 | `docusaurus serve --port 5273`                  |
| `mise run docs:typecheck`     | `tsc --noEmit -p tsconfig.json`                 | unchanged in intent, now via project references |
| Base URL                      | `DOCS_BASE ?? "/rust-toolchain/"`               | same variable, now Docusaurus `baseUrl`         |

Unchanged: the `peaceiris` publish step, `publish_branch: gh-pages`, `keep_files: true`, the `permissions` blocks,
the artifact hand-off between the `build` and `publish` jobs, and `gh-pages.yml`'s `paths:` filter on `docs/**`.

The `Typecheck`-before-`Build` ordering is kept. Its original justification — that `vitepress build` transpiles
without type-checking, so an error in the config only ever surfaced in an editor — holds identically for
`docusaurus build`.

## Documentation to update

`CLAUDE.md`'s "`docs/` is a VitePress site with its own toolchain" section is rewritten. Four of its bullets are
retired: the separate-`package.json`-and-lockfile premise (workspaces), the `base` trailing-slash warning and the
hand-prefixed `head` entries (`useBaseUrl`), and the `.vitepress/cache` size note.

Two bullets survive and must be carried across verbatim in substance:

- Dead-link checking validates links in Markdown content only, never navigation or sidebar entries. An entry written
  ahead of its page builds clean and 404s in the browser, so that block stays hand-maintained. Do not disable the
  check to silence a failure.
- A page reaching a file outside `docs/` needs an absolute repository URL. A relative `../README.md` resolves
  outside the site root and is exactly what the check exists to catch.

`AGENTS.md` needs no change; it does not describe the docs toolchain.

## Risks

- **The navigation structure is deleted before it is transcribed.** It lives in `docs/.vitepress/config.mts`, which
  step 5 removes along with the rest of the VitePress scaffolding — so step 2 has to come first, and the ordering is
  the whole safeguard. Nothing fails if it is forgotten: Docusaurus builds clean with an empty or partial sidebar, so
  the loss is silent and surfaces only as a site nobody can navigate. If it has already gone, recover it with
  `git show <commit>:docs/.vitepress/config.mts`. Recorded here so this document stands alone either way: three
  sidebar groups — `Reference` (Architecture, Comparison, Runbooks), `Design records` (two layered-cargo-cache
  documents) and `Implementation plans` (Phases A through D) — plus a top-level `Repository` menu carrying README,
  Releases and the two licence links.
- **`bun install --filter` is load-bearing.** If it does not scope installs as documented on Bun 1.3.14, every CI
  job that installs at the root pays for React and Docusaurus. Proved in the first task; the fallback is to leave
  `docs/` outside the workspace and accept two lockfiles, which loses the deduplication but nothing else. Observed
  2026-08-11 on Bun 1.3.14: `--filter=<workspace>` keeps the unfiltered workspace's dependency out of
  `node_modules` but still downloads and extracts it into Bun's shared package cache, so it scopes what gets
  linked, not the network/CPU cost the CI-jobs-must-not-pay claim above actually depends on.
- **`@docusaurus/faster` is the least-trodden path.** It is already in the copied project and swaps in Rspack and
  SWC. Keep it, but it is the first thing to drop if the build misbehaves.
- **Stale URLs persist.** `keep_files: true` means the published VitePress output is not cleared when the new site
  lands. VitePress used `cleanUrls` and Docusaurus uses `trailingSlash: false`, so most paths coincide, but a
  deliberate prune commit against the `gh-pages` branch is part of the work rather than an afterthought.
- **The coverage gate is adjacent but should not fire.** `bunfig.toml` gates `src/` at 100% and its
  `coveragePathIgnorePatterns` do not mention a docs site. Bun reports only files it actually loads, and no test
  imports the site, so the site's `.tsx` should stay invisible exactly as `src/index.ts` does. This is asserted, not
  assumed, by running `bun test` after the workspace lands.

## Success criteria

- `mise run docs:build` produces `docs/build` and the published site renders all eleven pages plus the rewritten
  home page, each at the URL it had under VitePress.
- All nine mermaid diagrams render, and `.vitepress/` no longer exists.
- Two lockfiles, deliberately: `bun.lock` at the root for the action, `docs/bun.lock` for the site. No `docusaurus/`
  directory — because it has
  become `docs/`, not because it was removed.
- `bun run typecheck`, `bun run test`, `bun run build` and `hk check --all` all pass from the root.
- The action's CI jobs do not install React, verified by inspecting the install step's package count.
- `gh-pages.yml` publishes to the `gh-pages` branch with no change to its publish step.
