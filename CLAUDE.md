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
bun run typecheck    # tsc --noEmit
bun run test         # 100% line/function/statement gate from bunfig.toml
bun run build        # regenerate dist/index.js
```

### Broken scripts — do not run

- `bun run lint` — `--filter '*'` matches the root package, so the script
  recursively re-invokes itself and forks until killed. Use
  `bun run eslint:lint`, `bun run prettier:format`, or `mise run lint`.
- `mise run typecheck` — points at a nonexistent `tsconfig.test.json`. Use
  `bun run typecheck`.
- `bun run config:sync:check` — `scripts/check-config-sync.ts` does not exist.

## `dist/` is committed

`action.yml` runs `dist/index.js` on the `node24` runtime, so the bundle is
tracked in git. The CI Build job runs `git diff --exit-code dist/` and fails on
a stale bundle — always `bun run build` and commit `dist/` alongside any `src/`
change.

## Action pinning overrides the global rule

Every `uses:` in `.github/workflows/*.yml` and `.github/actions/*/action.yml`
pins the full commit SHA with a trailing `# vX.Y.Z` comment. This deliberately
overrides the "prefer the loosest tag" rule in the personal global CLAUDE.md.
Refresh pins with `mise run uapw`.

## TOML parsing

Use `smol-toml` (`import { parse } from "smol-toml"`), never `@iarna/toml`.
