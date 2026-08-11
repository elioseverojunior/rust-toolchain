{/*
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
*/}

# Docusaurus Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VitePress site under `docs/` with Docusaurus 3.10.2, folded into the repository root through Bun
workspaces so there is one lockfile.

> **REVISED 2026-08-11 after Task 1:** the Bun workspace is NOT created.
> `--filter` was measured and does not scope install cost, so `docs/` keeps its own `package.json` and `bun.lock`.
> See the note at the head of Task 8.

**Architecture:** The site is assembled in `docusaurus/` — already present as a working scaffold copied from the
author's personal site — and takes the `docs/` name in the final task, so a buildable tree exists at every step. Three
independent mechanisms were proposed to carry the split. Two survive — TypeScript project references for
type-checking and one ESLint flat config with a per-glob block. The third, a Bun workspace for dependencies, was
disproved by Task 1 and dropped; the site keeps its own lockfile.

**Tech Stack:** Docusaurus 3.10.2, React 19, `@docusaurus/theme-mermaid`, `@easyops-cn/docusaurus-search-local`, Bun
1.3.14, TypeScript 6.0 project references.

**Design:** [Docusaurus Migration — Design](../design/2026-08-10-docusaurus-migration.md)

## Starting state

This plan is written against the tree as it actually stands, not a clean checkout. Verify before Task 1; if any of
this is untrue, stop and re-read the design document.

- `docs/` holds `.vitepress/` (intact), `ARCHITECTURE.md`, `COMPARISON.md`, `RUNBOOKS.md`, `design/`, `plans/`.
- `docs/`'s own scaffolding is **already deleted and staged**: `package.json`, `bun.lock`, `bunfig.toml`,
  `tsconfig.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.nvmrc`,
  `.bun-version`, `index.md`, `public/favicon.svg`, `public/favicon.ico`.
- Because of that, **the VitePress site can no longer build.** `mise run docs:build` fails at `docs:install`. This is
  expected and is repaired by Task 9.
- `docusaurus/` is the untouched personal-portfolio scaffold. It builds locally and is untracked.
- `.gitignore` and `ignorefile.toml` already ignore `/**/build/` and `/**/.docusaurus/`.

Two facts are recoverable only from files this plan later deletes, so they are reproduced here and the plan is
self-contained without them:

- The **sidebar**, from `docs/.vitepress/config.mts` — Task 6.
- The **home page hero and feature cards**, from the deleted `docs/index.md` — Task 5, recovered with
  `git show HEAD:docs/index.md`.

## Global Constraints

- Docusaurus pinned at `3.10.2` across every `@docusaurus/*` package. React and React DOM at `^19.2.8`.
- `engines` stay `node >=24.0.0,<25.0.0`, `bun ^1.3.14`, `typescript ^6.0.3`.
- Never `extend "@docusaurus/tsconfig"` — it sets `baseUrl`, which TypeScript 6.0 removed, and `extends` cannot
  delete an inherited key. Reproduce its options inline, as `docusaurus/tsconfig.json` already does.
- Every `uses:` in `.github/` pins a full commit SHA with a trailing `# vX.Y.Z` comment.
- Conventional Commits; `type` from the `commitlint.config.cjs` enum; scope expected. Commits are GPG-signed
  (`git commit -S`). Never add a `Co-Authored-By` trailer.
- Markdown obeys `.rumdl.toml`: dash bullets (MD004), code-block lines at most 120 characters, "Markdown" and
  "GitHub" capitalised (MD044). Every new file carries the SPDX header.
- A docs failure must never fail the action's gate.

---

### Task 1: Prove `bun install --filter` scopes installs

The single load-bearing assumption in the design. If it is false, the whole workspace approach costs every CI job a
React install and the fallback is two lockfiles. Prove it before building anything on top.

**Files:**

- Create: `/tmp/filter-probe/` (throwaway, deleted in step 4)

**Interfaces:**

- Produces: a yes/no answer that gates Tasks 8 and 9. Nothing else consumes it.

**Steps:**

- [ ] **Step 1: Build a two-package workspace probe**

```bash
mkdir -p /tmp/filter-probe/pkg-a /tmp/filter-probe/pkg-b
cd /tmp/filter-probe
printf '{"name":"root","private":true,"workspaces":["pkg-a","pkg-b"]}\n' > package.json
printf '{"name":"pkg-a","dependencies":{"is-odd":"3.0.1"}}\n' > pkg-a/package.json
printf '{"name":"pkg-b","dependencies":{"left-pad":"1.3.0"}}\n' > pkg-b/package.json
```

- [ ] **Step 2: Install only one workspace and inspect what landed**

```bash
cd /tmp/filter-probe && bun install --filter=pkg-a
ls node_modules | grep -E '^(is-odd|left-pad)$' || echo "neither present"
```

Expected: `is-odd` present, `left-pad` absent. If `left-pad` is also installed, the flag does not scope installs.

- [ ] **Step 3: Record the verdict in the design document**

Append one sentence to the `bun install --filter` risk bullet in `docs/design/2026-08-10-docusaurus-migration.md`
stating the observed behaviour and the date. If the flag does **not** scope installs, also change Task 8 to keep
`docs/` out of the workspace and retain a second lockfile, and say so in that bullet.

- [ ] **Step 4: Clean up and commit**

```bash
rm -rf /tmp/filter-probe
git add docs/design/2026-08-10-docusaurus-migration.md
git commit -S -m "docs(design): record whether bun install --filter scopes installs"
```

---

### Task 2: Strip the portfolio and retarget the site at this project

`docusaurus/` is currently a personal CV site. Everything specific to that has to go before it can be this project's
documentation, and the Pages target changes from a user site to a project site.

**Files:**

- Delete: `docusaurus/data/`, `docusaurus/src/components/portfolio/`, `docusaurus/src/pages/cv.tsx`,
  `docusaurus/src/pages/cv.module.css`, `docusaurus/src/data/`, `docusaurus/src/types/profile.ts`,
  `docusaurus/src/hooks/useCountUp.ts`, `docusaurus/README.md`
- Modify: `docusaurus/docusaurus.config.ts`, `docusaurus/package.json`

**Interfaces:**

- Produces: `docusaurus.config.ts` exporting a `Config` whose `baseUrl` is `process.env.DOCS_BASE ?? "/rust-toolchain/"`
  and whose `projectName` is `"rust-toolchain"`. Tasks 3, 4, 6 and 7 all extend this same object.

**Steps:**

- [ ] **Step 1: Delete the personal content**

```bash
cd docusaurus
rm -rf data src/components/portfolio src/data src/pages/cv.tsx src/pages/cv.module.css
rm -f src/types/profile.ts src/hooks/useCountUp.ts README.md
```

- [ ] **Step 2: Retarget the Pages configuration**

In `docusaurus/docusaurus.config.ts` replace the `baseUrl` constant and the `projectName` field:

```ts
// GitHub project pages serve under /<repo>/, so baseUrl must match or every asset 404s.
// DOCS_BASE=/ builds for root-domain hosting. Docusaurus asserts both leading and trailing slash.
const baseUrl = process.env.DOCS_BASE ?? "/rust-toolchain/";

const config: Config = {
  title: "rust-toolchain",
  tagline: "Install Rust and cache cargo in one action",
  url: "https://elioseverojunior.github.io",
  baseUrl,
  organizationName: "elioseverojunior",
  projectName: "rust-toolchain",
  deploymentBranch: "gh-pages",
  trailingSlash: false,
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "throw",
};
```

`onBrokenLinks: "throw"` is the replacement for VitePress's `ignoreDeadLinks: false`. Like VitePress, it checks links
in content only — never `themeConfig.navbar` or `sidebars.ts`.

- [ ] **Step 3: Rename the package**

In `docusaurus/package.json` set `"name": "docs"` and `"version": "0.0.0"`. Task 8 relies on that name for
`--filter=docs`.

- [ ] **Step 4: Verify the site still builds with no content**

Run: `cd docusaurus && bun run build`
Expected: build succeeds, or fails only with "no docs found" — any React error means a portfolio import survived the
deletion. Grep for it: `grep -rn "portfolio\|profile\|useCountUp" src/`

- [ ] **Step 5: Commit**

```bash
git add docusaurus/
git commit -S -m "docs(site): strip the portfolio scaffold and retarget at this project"
```

---

### Task 3: Move the content in and serve it from the site root

**Files:**

- Move: `docs/ARCHITECTURE.md`, `docs/COMPARISON.md`, `docs/RUNBOOKS.md`, `docs/design/`, `docs/plans/` →
  `docusaurus/content/`
- Modify: `docusaurus/docusaurus.config.ts`

**Interfaces:**

- Consumes: the `Config` object from Task 2.
- Produces: pages served at `/rust-toolchain/ARCHITECTURE`, `/rust-toolchain/COMPARISON`,
  `/rust-toolchain/RUNBOOKS`, `/rust-toolchain/design/<slug>`, `/rust-toolchain/plans/<slug>`. Task 6's sidebar
  links to exactly these.

**Steps:**

- [ ] **Step 1: Move the content, preserving history**

```bash
mkdir -p docusaurus/content
git mv docs/ARCHITECTURE.md docs/COMPARISON.md docs/RUNBOOKS.md docusaurus/content/
git mv docs/design docs/plans docusaurus/content/
```

`git mv` rather than copy-and-delete so `git log --follow` survives the move for seven thousand lines of prose.

- [ ] **Step 2: Point the docs plugin at `content/` and mount it at the root**

In the `presets` block of `docusaurus/docusaurus.config.ts`:

```ts
presets: [
  [
    "classic",
    {
      docs: {
        // `content/`, not the plugin default `docs/`: the site root is itself
        // named docs/, and docs/docs/ARCHITECTURE.md explains itself to nobody.
        path: "content",
        // Load-bearing. VitePress served these at /rust-toolchain/ARCHITECTURE.
        // The default would move them to /rust-toolchain/docs/ARCHITECTURE, and
        // because peaceiris publishes with keep_files: true the old VitePress
        // HTML would keep serving at the original URL -- no 404, no CI failure,
        // just two sites with every inbound link pointing at the stale one.
        routeBasePath: "/",
        sidebarPath: "./sidebars.ts",
        editUrl: "https://github.com/elioseverojunior/rust-toolchain/edit/main/docs/",
      },
      blog: false,
      theme: { customCss: "./src/css/custom.css" },
    } satisfies Preset.Options,
  ],
],
```

- [ ] **Step 3: Build and fix whatever MDX reports**

Run: `cd docusaurus && bun run build`

Docusaurus 3 parses `.md` as MDX, so a bare angle bracket or brace outside a code fence is a build error. Do not
pre-guess which ones — the design document explains why three regex audits gave three different answers. Fix exactly
what the build names, by wrapping the offending text in a code span. Re-run until green.

- [ ] **Step 4: Verify the URLs did not move**

```bash
cd docusaurus && ls build/ARCHITECTURE/index.html build/COMPARISON/index.html build/RUNBOOKS/index.html
```

Expected: all three exist. A `build/docs/ARCHITECTURE/` path instead means `routeBasePath` did not take.

- [ ] **Step 5: Commit**

```bash
git add -A docs/ docusaurus/
git commit -S -m "docs(site): move the prose into the Docusaurus tree"
```

---

### Task 4: Wire mermaid and delete the bespoke Vue

The reason for the migration. Four files totalling 652 lines are replaced by a theme and two config keys.

**Files:**

- Modify: `docusaurus/docusaurus.config.ts`, `docusaurus/package.json`
- Delete: `docs/.vitepress/mermaid.ts`, `docs/.vitepress/theme/Mermaid.vue`,
  `docs/.vitepress/theme/mermaid-theme.ts`, `docs/.vitepress/theme/index.ts`, `docs/.vitepress/env.d.ts`

**Interfaces:**

- Consumes: the `Config` object from Tasks 2 and 3.
- Produces: nine rendered diagrams — eight in `ARCHITECTURE.md`, one in `RUNBOOKS.md`.

**Steps:**

- [ ] **Step 1: Add the theme**

```bash
cd docusaurus && bun add @docusaurus/theme-mermaid@3.10.2
```

- [ ] **Step 2: Enable it**

In `docusaurus/docusaurus.config.ts`:

```ts
markdown: { mermaid: true },
themes: ["@docusaurus/theme-mermaid"],
// In themeConfig:
mermaid: {
  theme: { light: "neutral", dark: "dark" },
},
```

This is the whole replacement for `.vitepress/mermaid.ts` plus `Mermaid.vue`. The official theme already solves both
problems that Vue code existed for: it does not pull mermaid into the client entry, so diagram-free pages stop
emitting `modulepreload` links for katex, gantt and C4; and it does not force `theme: "dark"` over the configured
variables.

- [ ] **Step 3: Verify all nine diagrams render before deleting anything**

```bash
cd docusaurus && bun run build
grep -c 'mermaid' build/ARCHITECTURE/index.html
```

Expected: a non-zero count, and the build reports no mermaid parse errors. Confirm the count of fences still matches
the source: `grep -c '```mermaid' content/ARCHITECTURE.md` should be 8, and `content/RUNBOOKS.md` should be 1.

- [ ] **Step 4: Delete the VitePress mermaid layer**

```bash
git rm -r docs/.vitepress
```

`env.d.ts` goes with the rest: it is the `*.vue` module shim that let `theme/index.ts` import the component, so it
has no purpose once the component is gone.

- [ ] **Step 5: Confirm the repository-level mermaid lint still passes**

Run: `mise run mermaidlint`
Expected: passes. `scripts/lint-mermaid.ts` globs `**/*.md` from the repository root and parses each fence with
mermaid itself, so it never knew which framework consumed the output and needs no change.

- [ ] **Step 6: Commit**

```bash
git add -A docs/ docusaurus/
git commit -S -m "docs(site): render mermaid through the official theme"
```

---

### Task 5: Rebuild the home page

`docs/index.md` used VitePress's `layout: home` frontmatter, which has no Docusaurus counterpart. It was deleted in
the staged scaffolding removal, so recover it from git.

**Files:**

- Create: `docusaurus/src/pages/index.tsx`, `docusaurus/src/pages/index.module.css`
- Modify: `docusaurus/src/types/site.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: the site root at `/rust-toolchain/`. Task 6's sidebar does not include it.

**Steps:**

- [ ] **Step 1: Recover the original copy**

```bash
git show HEAD:docs/index.md > /tmp/old-index.md
```

It carries a hero (`name`, `text`, `tagline`) with three actions, and six feature cards each with `title` and
`details`. Every string below is transcribed from it — do not paraphrase, the copy was written deliberately.

- [ ] **Step 2: Write the page**

```tsx
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";
import styles from "./index.module.css";

const FEATURES: readonly { title: string; details: string }[] = [
  {
    title: "rust-toolchain.toml by default",
    details:
      "The channel, targets, components and profile come from the file already in your repository. Action inputs override it — scalars are replaced, lists merge deduped with your inputs leading.",
  },
  {
    title: "Layered cargo cache",
    details:
      "The registry and target directories are keyed separately, so a compiler bump no longer re-downloads the crates it never touched. The build key folds in the resolved toolchain and the CARGO_/RUST* environment.",
  },
  {
    title: "Saves what is worth saving",
    details:
      "An exact hit is never re-saved, a layer over cache-budget is skipped with a warning, and every layer's real outcome is reported in the job summary rather than behind one cache-hit boolean.",
  },
  {
    title: "RUSTUP_TOOLCHAIN wins later steps",
    details:
      "rustup default alone loses to a workspace rust-toolchain.toml. The resolved channel is exported so it applies to every later step, with set-rustup-toolchain false for monorepos that pin per crate.",
  },
  {
    title: "Typed outputs with provenance",
    details:
      "Every resolved value is published, lists as JSON arrays, plus a json output carrying all of them natively typed alongside inputs and toml blocks saying where each value came from.",
  },
  {
    title: "A drop-in superset",
    details:
      "The cachekey output matches dtolnay/rust-toolchain byte for byte, and cache-workspaces takes the same syntax as Swatinem/rust-cache, so an existing value transfers unchanged.",
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <header className={styles.hero}>
        <h1>{siteConfig.title}</h1>
        <p className={styles.text}>
          Install Rust and cache cargo in one action
        </p>
        <p className={styles.tagline}>
          Reads the rust-toolchain.toml you already committed, installs it with
          rustup, and restores and saves the cargo cache in layers — no second
          action required.
        </p>
        <div className={styles.actions}>
          <Link
            className="button button--primary button--lg"
            to="/ARCHITECTURE"
          >
            Architecture
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/COMPARISON"
          >
            What this replaces
          </Link>
          <Link
            className="button button--secondary button--lg"
            href="https://github.com/elioseverojunior/rust-toolchain"
          >
            View on GitHub
          </Link>
        </div>
      </header>
      <main className={styles.features}>
        {FEATURES.map((f) => (
          <section key={f.title} className={styles.feature}>
            <h2>{f.title}</h2>
            <p>{f.details}</p>
          </section>
        ))}
      </main>
    </Layout>
  );
}
```

- [ ] **Step 3: Write the stylesheet**

```css
.hero {
  padding: 4rem 1rem;
  text-align: center;
}
.text {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 1rem;
}
.tagline {
  max-width: 46rem;
  margin: 0 auto 2rem;
  color: var(--ifm-color-emphasis-700);
}
.actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
}
.features {
  display: grid;
  gap: 2rem;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  max-width: 72rem;
  margin: 0 auto;
  padding: 0 1rem 4rem;
}
.feature h2 {
  font-size: 1.25rem;
}
```

- [ ] **Step 4: Build and check the root page**

Run: `cd docusaurus && bun run build && ls build/index.html`
Expected: exists, and `grep -c 'drop-in superset' build/index.html` returns 1 — proving all six cards rendered.

- [ ] **Step 5: Commit**

```bash
git add docusaurus/src/pages/
git commit -S -m "docs(site): rebuild the home page as a React page"
```

---

### Task 6: Transcribe the sidebar

The structure lives in `docs/.vitepress/config.mts`, which Task 4 deleted. It is reproduced below so this task needs
no recovery; if you want the original, `git show <commit-before-task-4>:docs/.vitepress/config.mts`.

Nothing fails if this is skipped — Docusaurus builds clean with an empty sidebar — which is exactly why it is its own
task rather than a footnote.

**Files:**

- Create: `docusaurus/sidebars.ts`
- Modify: `docusaurus/docusaurus.config.ts` (the `navbar` block)

**Interfaces:**

- Consumes: the document IDs produced by Task 3.
- Produces: `sidebars.ts` default-exporting a `SidebarsConfig` under the key `docs`, which Task 3's
  `sidebarPath` already references.

**Steps:**

- [ ] **Step 1: Write the sidebar**

```ts
import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: ["ARCHITECTURE", "COMPARISON", "RUNBOOKS"],
    },
    {
      type: "category",
      label: "Design records",
      items: [
        "design/2026-07-31-layered-cargo-cache",
        "design/2026-07-31-layered-cargo-cache-phase-b",
        "design/2026-08-10-docusaurus-migration",
      ],
    },
    {
      type: "category",
      label: "Implementation plans",
      items: [
        "plans/2026-07-31-layered-cargo-cache-phase-a",
        "plans/2026-07-31-layered-cargo-cache-phase-b",
        "plans/2026-08-07-layered-cargo-cache-phase-c",
        "plans/2026-08-08-layered-cargo-cache-phase-d",
        "plans/2026-08-11-docusaurus-migration",
      ],
    },
  ],
};

export default sidebars;
```

The VitePress original carried nine entries; this has eleven, because the migration's own design and plan documents
were written after it.

- [ ] **Step 2: Write the navbar**

In `themeConfig` of `docusaurus/docusaurus.config.ts`:

```ts
navbar: {
  title: "rust-toolchain",
  items: [
    { to: "/ARCHITECTURE", label: "Architecture", position: "left" },
    { to: "/COMPARISON", label: "Comparison", position: "left" },
    { to: "/RUNBOOKS", label: "Runbooks", position: "left" },
    {
      label: "Repository",
      position: "right",
      items: [
        { href: "https://github.com/elioseverojunior/rust-toolchain#readme", label: "README" },
        { href: "https://github.com/elioseverojunior/rust-toolchain/releases", label: "Releases" },
        { href: "https://github.com/elioseverojunior/rust-toolchain/blob/main/LICENSE-MIT", label: "MIT licence" },
        { href: "https://github.com/elioseverojunior/rust-toolchain/blob/main/LICENSE-APACHE", label: "Apache-2.0 licence" },
      ],
    },
  ],
},
```

- [ ] **Step 3: Verify every entry resolves**

Run: `cd docusaurus && bun run build`
Expected: no "docs sidebar item not found" error. Docusaurus **does** validate sidebar document IDs, which is
stricter than VitePress — a wrong ID fails the build rather than 404ing silently.

- [ ] **Step 4: Commit**

```bash
git add docusaurus/sidebars.ts docusaurus/docusaurus.config.ts
git commit -S -m "docs(site): transcribe the navigation from the VitePress config"
```

---

### Task 7: Restore offline search

VitePress had `search: { provider: "local" }`. `@docusaurus/preset-classic` bundles Algolia DocSearch, not offline
search, so losing search would be a user-visible regression.

**Files:**

- Modify: `docusaurus/package.json`, `docusaurus/docusaurus.config.ts`

**Interfaces:**

- Consumes: the `Config` object.
- Produces: a search box in the navbar. Nothing later depends on it.

**Steps:**

- [ ] **Step 1: Add the plugin**

```bash
cd docusaurus && bun add @easyops-cn/docusaurus-search-local
```

- [ ] **Step 2: Register it**

```ts
themes: [
  "@docusaurus/theme-mermaid",
  [
    "@easyops-cn/docusaurus-search-local",
    // docsRouteBasePath must agree with the docs plugin's routeBasePath from
    // Task 3, or the indexer walks the wrong tree and silently indexes nothing.
    { hashed: true, indexBlog: false, docsRouteBasePath: "/" },
  ],
],
```

- [ ] **Step 3: Verify an index was produced**

Run: `cd docusaurus && bun run build && find build -name 'search-index*.json' | head -1`
Expected: one file. If the build fails, the design document's accepted fallback is to ship without search — remove
both edits, note it in the design document, and continue to Task 8.

- [ ] **Step 4: Commit**

```bash
git add docusaurus/package.json docusaurus/bun.lock docusaurus/docusaurus.config.ts
git commit -S -m "docs(site): restore offline search"
```

---

### Task 8: Unify type-checking and linting, keep the lockfiles apart

> **REVISED after Task 1.** This task originally declared a Bun workspace so the repository would have one lockfile.
> Task 1 disproved the assumption that made that affordable, so the workspace is **not** created and the site keeps
> its own `package.json` and `bun.lock`. What remains — project references and one ESLint config — never depended on
> a workspace and is unchanged.
>
> The evidence, measured on a cold cache: `bun install --filter` scopes what is **linked** into `node_modules` but
> still downloads and extracts the unfiltered workspace's whole graph. Action dependencies alone install 320 packages
> in 21.9s; the same install inside a workspace, filtered to the action, pulls 644 packages in 61.3s. Every job that
> installs would pay 2.8x for a docs site it never imports.
>
> **Do not add a `"workspaces"` key to the root `package.json` in this task or any later one.**

**Files:**

- Modify: `tsconfig.json`, `eslint.config.js`
- Create: `tsconfig.src.json`
- Delete: `docusaurus/eslint.config.mjs`
- Do NOT modify: `package.json`, `bun.lock`, `docusaurus/package.json`, `docusaurus/bun.lock`

**Interfaces:**

- Consumes: the `"name": "docs"` set in Task 2.
- Produces: a solution-style root `tsconfig.json` that type-checks both projects in one `tsc --build`, and a single
  `eslint.config.js` covering the action and the site. Two lockfiles remain, by decision.

**Steps:**

- [ ] **Step 1: Split the action's tsconfig out**

Create `tsconfig.src.json` holding what `tsconfig.json` has today (`extends`, `outDir`, `rootDir`, `paths`,
`include: ["**/*.ts"]`), then add `"exclude": ["node_modules", "docusaurus", "docs"]` so the site never reaches the
action's type-check — it needs `DOM` and React types the action must not carry.

Replace `tsconfig.json` with a solution-style config:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.src.json" },
    { "path": "./docusaurus/tsconfig.json" }
  ]
}
```

- [ ] **Step 2: Add the site's ESLint block**

In the root `eslint.config.js`, after the existing `files: ["**/*.ts"]` block:

```js
{
  files: ["docusaurus/**/*.{ts,tsx}"],
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2024, sourceType: "module", ecmaFeatures: { jsx: true } },
    globals: { ...globals.browser },
  },
  plugins: { "@typescript-eslint": tsPlugin, "import-x": importPlugin },
},
```

Then `rm docusaurus/eslint.config.mjs`.

- [ ] **Step 3: Verify both lockfiles are untouched**

```bash
git status --short package.json bun.lock docusaurus/package.json docusaurus/bun.lock
```

Expected: no output. If any of the four appears, this task has strayed into the workspace change that Task 1 ruled
out — revert those four paths before continuing.

- [ ] **Step 4: Verify both projects type-check through the references**

```bash
bunx tsc --build --dry tsconfig.json
bun run typecheck
```

Expected: the first lists both referenced projects; the second still passes.

- [ ] **Step 5: Verify the action's gate is unaffected**

```bash
bun run typecheck && bun run test && bun run build
```

Expected: all pass. The 100% coverage gate must still report 100% — Bun reports only files it loads, and no test
imports the site, so its `.tsx` should stay invisible exactly as `src/index.ts` does. If coverage drops, add
`"**/docusaurus/**"` to `coveragePathIgnorePatterns` in `bunfig.toml`.

- [ ] **Step 6: Commit**

```bash
git add tsconfig.json tsconfig.src.json eslint.config.js
git rm --cached -q docusaurus/eslint.config.mjs 2>/dev/null || true
git add -u docusaurus/eslint.config.mjs
git commit -S -m "build(config): type-check and lint the site from the root"
```

Note the commit does NOT include `package.json` or either lockfile. If `git status` shows them modified, something
went wrong — see Step 3.

---

### Task 9: Take the `docs/` name and repair the toolchain

The only task that touches paths CI depends on. Until it lands, `mise run docs:build` is broken and `gh-pages.yml`
would fail on a pull request.

**Files:**

- Rename: `docusaurus/` → `docs/`
- Modify: `mise.toml`, `.github/workflows/gh-pages.yml`, `package.json`, `tsconfig.json`

**Interfaces:**

- Consumes: everything above.
- Produces: `mise run docs:build` writing `docs/build`.

**Steps:**

- [ ] **Step 1: Rename**

```bash
git mv docusaurus docs
```

`docs/` must be empty of the old site first — Tasks 3 and 4 moved or deleted everything in it. Verify with
`git status --short docs/` showing no stragglers.

- [ ] **Step 2: Update the workspace and reference paths**

In `tsconfig.json` change the reference to `./docs/tsconfig.json`; in `tsconfig.src.json` the `exclude` already lists
`docs`. Do **not** add a `"workspaces"` key to `package.json` — see the note at the head of Task 8.

- [ ] **Step 3: Rewrite the mise tasks**

```toml
[tasks."docs:install"]
alias = ["docsi"]
description = "Install the docs site dependencies (docs/ has its own lockfile)"
dir = "docs"
run = "bun install --frozen-lockfile"

[tasks."docs:build"]
alias = ["docsb"]
description = "Build the Docusaurus site into docs/build. Set DOCS_BASE=/ for a custom domain; the default /rust-toolchain/ matches GitHub project pages"
depends = ["docs:install"]
dir = "docs"
run = "bun run build"

[tasks."docs:dev"]
alias = ["docs", "docsd"]
description = "Serve the docs site with hot reload on http://localhost:5273"
depends = ["docs:install"]
dir = "docs"
run = "bun run start --port 5273"

[tasks."docs:preview"]
alias = ["docsp"]
description = "Serve the built docs site on http://localhost:5273, to check the production build before publishing"
depends = ["docs:build"]
dir = "docs"
run = "bun run serve --port 5273"

[tasks."docs:typecheck"]
alias = ["docstc"]
description = "Type-check the site. Nothing else does: docusaurus build transpiles without type-checking, so an error in the config only ever surfaced in an editor"
depends = ["docs:install"]
dir = "docs"
run = "bun run typecheck"
```

The `docs:install` task above is already the post-Task-1 form: `dir = "docs"` with a plain
`bun install --frozen-lockfile`, because `--filter` was measured and rejected. This is the only mise task whose
shape changed from the original plan; the other four differ from today's only in the command they run.

- [ ] **Step 4: Update the workflow**

In `.github/workflows/gh-pages.yml`: change the upload `path:` from `docs/.vitepress/dist` to `docs/build`; change
**leave** the lockfile assertion as `git diff --exit-code -- docs/bun.lock` and `bun-version-file` as
`docs/.bun-version` — both were only going to change if the site joined a root workspace, which Task 1 ruled out, and
both paths keep working because the site lands at `docs/` with its own lockfile and pin. Leave the `peaceiris`
publish step, `publish_branch`, `keep_files` and the
`paths:` filter alone.

- [ ] **Step 5: Verify end to end**

```bash
mise run docs:typecheck && mise run docs:build && ls docs/build/index.html docs/build/ARCHITECTURE/index.html
bun run typecheck && bun run test && bun run build && hk check --all
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -S -m "ci(docs): build the Docusaurus site from docs/"
```

---

### Task 10: Update the repository's own documentation

**Files:**

- Modify: `CLAUDE.md`
- Modify: `docs/design/2026-08-10-docusaurus-migration.md` (status line)

**Interfaces:**

- Consumes: the finished migration. Produces nothing consumed by later tasks.

**Steps:**

- [ ] **Step 1: Rewrite the docs section of `CLAUDE.md`**

Retire four claims from "`docs/` is a VitePress site with its own toolchain": the separate `package.json` and
lockfile, the `base` trailing-slash warning, the hand-prefixed `head` entries, and the `.vitepress/cache` size note.

Carry two across, because they are still true of Docusaurus:

- Dead-link checking validates links in Markdown content only, never `navbar` or `sidebars.ts` entries. Do not
  disable it to silence a failure. One change: a **wrong sidebar document ID now fails the build**, which VitePress
  did not catch.
- A page reaching a file outside `docs/` needs an absolute repository URL.

Add three that are new: content lives in `docs/content/` with `routeBasePath: "/"` and moving it changes every
published URL while `keep_files: true` leaves the old ones serving; the site keeps its own lockfile, so add
dependencies with `bun add` from inside `docs/`; and mermaid is `@docusaurus/theme-mermaid`, not 652 lines of local Vue.

- [ ] **Step 2: Mark the design document done**

Change its `Status:` line to `implemented` and add `Implemented: 2026-08-11`.

- [ ] **Step 3: Verify**

Run: `hk check --all`
Expected: passes, including `rumdl` and the `mermaid` step.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/design/2026-08-10-docusaurus-migration.md
git commit -S -m "docs(cache): record the Docusaurus toolchain invariants"
```

---

## Self-review

**Spec coverage.** Workspace topology → Task 8. Resulting layout → Tasks 3, 9. Lifted and discarded → Task 2.
Sequencing → the task order, with the design's steps 1–5 mapping to Tasks 3, 6, 5, 4/7 and 9. Content and MDX →
Task 3. Mermaid → Task 4. Site configuration → Tasks 2, 3. Search → Task 7. Build and CI → Task 9. Documentation to
update → Task 10. Risks: `--filter` → Task 1; `@docusaurus/faster` → carried unchanged from the copied
`package.json`, dropped only if a build fails; stale URLs → the `routeBasePath` comment in Task 3 plus the prune noted
below; coverage gate → Task 8 step 5.

**Not covered, deliberately.** The design lists a prune commit against the `gh-pages` branch to clear stale VitePress
output. It cannot be scripted from this repository — it rewrites a published branch — so it stays a manual follow-up
after the first successful publish. Task 3's `routeBasePath` makes it cosmetic rather than urgent, because every URL
that mattered is reoccupied by the new build.

**Type consistency.** `sidebars.ts` exports `SidebarsConfig` under the key `docs`, matching Task 3's
`sidebarPath: "./sidebars.ts"`. `docsRouteBasePath: "/"` in Task 7 matches `routeBasePath: "/"` in Task 3. The
workspace key is a path (`docusaurus` in Task 8, `docs` in Task 9), while `--filter=docs` is the package name set in
Task 2 — these are different namespaces and both are correct as written.
