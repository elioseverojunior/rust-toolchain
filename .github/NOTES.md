# Notes

> **Decision: this repository uses option 1 — `dist/` is committed.**
>
> `action.yml` points `runs.main` at `dist/index.js`, the bundle is tracked in
> git, and the CI **Build** job runs `git diff --exit-code dist/` so a stale
> bundle fails the build. Rebuild with `bun run build` and commit `dist/`
> alongside any `src/` change. The alternative is kept below for context.

For GitHub Actions, there are two main approaches:

1. Commit dist/ (most common)
   - GitHub Actions fetches code directly from your repo at runtime
   - It needs the compiled JavaScript to execute
   - Most official actions (actions/checkout, actions/setup-node, etc.) do this

2. Build on release (cleaner history)
   - Use a CI workflow that builds and creates a release
   - Push compiled code to a release branch (e.g., v1, v1.0.0)
   - Keep main clean with only source code

For option 2, you'd typically:

1. Add dist/ to .gitignore on main
2. Create a release workflow that builds and pushes to a release branch or tag

Here's a release workflow sketch for that approach. Note it follows this repo's
conventions: Bun rather than yarn, and `uses:` pinned to a full commit SHA with
the version in a trailing comment.

## .github/workflows/release.yml

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Setup Bun
        uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2.0.2

      - name: Install
        run: bun install --frozen-lockfile

      - name: Build And Typecheck
        run: |
          bun run typecheck
          bun run build

      - name: Publish Build
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -f dist/
          git commit -m "Build for ${{ github.ref_name }}"
          git push origin HEAD:refs/heads/${{ github.ref_name }}
```
