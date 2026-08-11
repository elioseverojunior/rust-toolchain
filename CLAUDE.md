<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

@AGENTS.md

## AGENTS.md is the source of truth — write codebase knowledge THERE

`AGENTS.md` is the canonical instruction file for every AI agent working in
this repository, and `CLAUDE.md` inherits it through the `@AGENTS.md` include
above. The split is by _audience_, not by topic:

- **`AGENTS.md`** — everything true of the codebase regardless of which agent
  or harness is reading: architecture, invariants, commands, conventions,
  testing rules, why a decision was made.
- **`CLAUDE.md`** — only what is specific to Claude Code as a harness, plus
  this rule. If a note would be just as useful to a different agent, it does
  not belong here.

**Any skill, slash command or workflow that would write codebase learnings to
`CLAUDE.md` must write them to `AGENTS.md` instead.** That explicitly includes
`/claude-md-management:revise-claude-md` and the
`claude-md-management:claude-md-improver` skill, both of which hardcode
`CLAUDE.md` in a plugin cache this repository cannot edit. Project
instructions outrank skill instructions, so this rule wins — follow it rather
than the skill's wording, and say so when you do.

`/learn-codebase` needs no redirect: it only reads source files to prime
context and writes nothing at all. Anything it teaches you that is worth
keeping goes into `AGENTS.md` by the rule above.

## Action pinning overrides the global rule

Every `uses:` in `.github/workflows/*.yml` and `.github/actions/*/action.yml`
pins the full commit SHA with a trailing `# vX.Y.Z` comment. This deliberately
overrides the "prefer the loosest tag" rule in the personal global CLAUDE.md.
Refresh pins with `mise run uapw`.
