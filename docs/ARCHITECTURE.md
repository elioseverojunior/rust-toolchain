<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Architecture

## Overview

A TypeScript library for reading `rust-toolchain.toml` and building `rustup` toolchain install commands, designed as a GitHub Action component. Inspired by [dtolnay/rust-toolchain](https://github.com/dtolnay/rust-toolchain).

```text
GitHub Actions Runner
        |
  ┌─────┴────────┐
  │  action.yml  │  runs: node24, main: dist/index.js
  └─────┬────────┘
        │
  ┌─────┴─────────────┐
  │  src/index.ts     │  Wiring — spawnSync, readFileSync,
  │       ↓           │  @actions/core, sleep
  │  src/action.ts    │  run(deps) — orchestration
  └──┬───┬───┬───┬────┘
     │   │   │   └──────────────┐
  ┌──┘   │   └────────┐         │
  v      v            v         v
┌──────┐ ┌──────┐ ┌───────┐ ┌─────────┐
│ core │ │config│ │builder│ │ outputs │
└──┬───┘ └──┬───┘ └───┬───┘ └────┬────┘
   │        │         │          │
   └───┬────┘         │          │
       v              v          v
 ┌────────────┐ ┌──────────┐ ┌─────────────┐
 │ resolve/   │ │ Toolchain│ │ flat keys + │
 │ merge/parse│ │ Spec     │ │ json output │
 └────────────┘ └────┬─────┘ └─────────────┘
                     │
                     v
                ┌──────────┐
                │ rustup   │
                │ install  │
                └──────────┘
```

`src/lib.ts` sits outside this flow: it is the library barrel for programmatic
consumers, never loaded by the action itself.

## Module Dependency Graph

```mermaid
graph TD
    subgraph "Source Layer"
        A[src/core.ts]
        B[src/config.ts]
        C[src/builder.ts]
        O[src/outputs.ts]
        R[src/action.ts]
        L[src/lib.ts]
        I[src/index.ts]
    end

    subgraph "Build Output"
        E[dist/index.js]
    end

    subgraph "External"
        TK["@actions/core"]
    end

    subgraph "Tests"
        F[src/core.test.ts]
        G[src/config.test.ts]
        H[src/builder.test.ts]
        J[src/action.test.ts]
        K[src/outputs.test.ts]
        M[src/lib.test.ts]
    end

    I --> R
    I --> TK
    R --> A
    R --> B
    R --> C
    R --> O
    O --> A
    O --> B
    O --> C
    C --> B
    B --> A
    I --> E
    F --> A
    G --> B
    H --> C
    J --> R
    K --> O
    M --> L
    L --> R
    L --> A
    L --> B
    L --> C
    L --> O
```

## Data Flow

```mermaid
flowchart LR
    TOML[rust-toolchain.toml]
    INPUTS[Action Inputs]

    subgraph Core
        PARSER[parseRustToolchainToml]
        RESOLVER[resolveChannel + scaleBareMinor]
        RUSTC[parseRustcVersion]
        CACHEKEY[generateCacheKey]
        SPECKEY[generateSpecCacheKey]
    end

    subgraph Config
        MERGE[mergeConfig + validation]
        ENV[resolveRustupEnv]
    end

    subgraph Builder
        BUILDER[ToolchainSpecBuilder]
        SPEC[ToolchainSpec]
        CMD[toRustupInstallArgs / toRustupTargetAddArgs / toRustupComponentAddArgs]
    end

    TOML --> PARSER
    PARSER -->|ToolchainTomlConfig| MERGE
    INPUTS -->|ToolchainInputs| MERGE

    MERGE -->|ResolvedToolchain| RESOLVER
    RESOLVER --> BUILDER
    BUILDER -->|fluent chaining| SPEC
    SPEC --> CMD

    PROCENV[process.env] --> ENV
    ENV -->|RUSTUP_HOME / CARGO_HOME| CMD

    CMD --> RUSTC
    RUSTC --> CACHEKEY
    CACHEKEY --> OUTS[buildActionOutputs]
    CACHEKEY --> SPECKEY
    SPEC --> SPECKEY
    SPECKEY --> OUTS

    SPEC -->|resolved config| OUTS
    PARSER -->|toml provenance| OUTS
    INPUTS -->|input provenance| OUTS
    OUTS -->|flat keys + json| OUT[Action outputs]

    CMD -->|exports RUSTUP_TOOLCHAIN| STEPS[Later workflow steps]
```

## Run Sequence

`run(deps)` in `src/action.ts`, in order. Everything below the dashed line
happens only after the toolchain is installed.

```mermaid
flowchart TD
    A[read rust-toolchain.toml] --> B[merge inputs, validate]
    B --> C[resolveChannel]
    C --> D[build ToolchainSpec]
    D --> E{rustup on PATH?}
    E -->|no| F[bootstrapRustup:<br/>curl rustup-init, run it, addPath]
    E -->|yes| G
    F --> G[rustup toolchain install<br/>--profile --target --component<br/>--allow-downgrade --no-self-update]
    G --> H[rustup target add --toolchain]
    H --> I[rustup component add --toolchain<br/>requested components]
    I --> P[rustup component add --toolchain<br/>profile components, failure tolerated]
    P --> J[rustup default<br/>failure tolerated]
    J --> K[export RUSTUP_TOOLCHAIN<br/>unless set-rustup-toolchain: false]
    K -.-> L[rustc --version --verbose]
    L --> M[applyCargoDefaults:<br/>CARGO_INCREMENTAL, CARGO_TERM_COLOR,<br/>registry protocol, http multiplexing]
    M --> N[buildActionOutputs + toOutputEntries:<br/>cachekey, cachekey-full, name,<br/>toolchain, targets, target, components,<br/>profile, set-rustup-toolchain, json]
```

Every `rustup` step is an argv array executed without a shell, bounded by a
timeout, and retried up to three times with 1s/2s backoff.

## Class Hierarchy

```mermaid
classDiagram
    class ToolchainTomlConfig {
        +string channel?
        +string[] targets?
        +string profile?
        +string[] components?
        +string path?
    }

    class ToolchainInputs {
        +string toolchain?
        +string targets?
        +string target?
        +string components?
        +string profile?
    }

    class RustupEnv {
        +string RUSTUP_HOME
        +string CARGO_HOME
    }

    class ResolvedToolchain {
        +string channel
        +string[] targets
        +string[] components
        +string profile?
    }

    class RustcVersionInfo {
        +string version
        +string commitHash
        +string commitDate
        +string cacheKey
    }

    class CacheKeySpec {
        +string channel
        +string[] targets
        +string[] components
        +string profile?
    }

    class ActionDeps {
        +exec(file, args, opts) ExecResult
        +readFile(path) string
        +core: getInput/setOutput/setFailed/exportVariable/addPath/info
        +env: Record~string, string~
        +platform: string
        +sleep(ms) void
    }

    class ToolchainSpec {
        +readonly channel: string
        +readonly targets: string[]
        +readonly components: string[]
        +readonly profile?: string
        +constructor(args: ResolvedToolchain)
        +toRustupInstallArgs(): string[]
        +toRustupTargetAddArgs(): string[] | null
        +toRustupComponentAddArgs(): string[] | null
        +toRustupProfileComponentAddArgs(): string[] | null
        +toRustupDefaultArgs(): string[]
        +toRustupInstallCommand(): string
    }

    class ToolchainSpecBuilder {
        -channel: string
        -targets: string[]
        -components: string[]
        -profile: string | undefined
        +constructor()
        +withChannel(channel): this
        +withTargets(...targets): this
        +withComponents(...components): this
        +withProfile(profile): this
        +build(): ToolchainSpec
    }

    ToolchainInputs --> ResolvedToolchain : merged into
    ToolchainSpec --> ResolvedToolchain : depends on
    ToolchainSpecBuilder --> ToolchainSpec : produces
    ToolchainSpecBuilder --> ToolchainTomlConfig : reads
    ToolchainSpec --> CacheKeySpec : satisfies
    ActionDeps --> ToolchainSpec : run() builds
```

## Source File Map

| File             | Type                            | Exports                                                                                                            | Responsibilities                                                                                                                                                                                           |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`   | Entry (node:child_process)      | none — side-effecting script                                                                                       | Dependency wiring only: hands real `spawnSync`, `readFileSync`, `@actions/core` and a synchronous `sleep` to `run()`                                                                                       |
| `src/action.ts`  | Module                          | `run`, `ActionDeps`, `ExecResult`, `ExecOptions`                                                                   | Orchestration behind injected dependencies — rustup bootstrap, install, targets, components, default, `RUSTUP_TOOLCHAIN`, cargo env defaults, cache keys, outputs; argv only, timeouts, retries            |
| `src/core.ts`    | Module (smol-toml, node:crypto) | `parseRustToolchainToml`, `resolveChannel`, `generateCacheKey`, `generateSpecCacheKey`, `parseRustcVersion`, types | TOML parsing, channel resolution/scaling/validation, cache key computation                                                                                                                                 |
| `src/config.ts`  | Module                          | `mergeConfig`, `resolveRustupEnv`, types                                                                           | Merge toml config with action inputs (scalars replaced by inputs; lists accumulate deduped, inputs leading) and validate identifiers; resolve `RUSTUP_HOME`/`CARGO_HOME`, honouring caller-supplied values |
| `src/builder.ts` | Classes                         | `ToolchainSpec`, `ToolchainSpecBuilder`                                                                            | Fluent builder pattern, rustup argv generation                                                                                                                                                             |
| `src/outputs.ts` | Module                          | `buildActionOutputs`, `toOutputEntries`, `ActionOutputs`, `ActionOutputsArgs`, `BooleanInput`, provenance types    | Maps the resolved spec plus its two sources onto the action's output surface; serialises lists as JSON arrays and the whole object as `json`                                                               |
| `src/lib.ts`     | Barrel                          | re-exports `action`, `builder`, `config`, `core`, `outputs` — never `index`                                        | The library surface under one specifier, for consumers that would rather import `@rust-toolchain` than five modules                                                                                        |

`src/lib.ts` is the barrel; individual modules can still be imported directly
and are cheaper, since the barrel loads all five.

### Why the barrel excludes `src/index.ts`

`src/index.ts` calls `run()` at the top level, so it is the one module in the
tree whose import has a side effect — it shells out to `rustup`. Keeping it out
of `src/lib.ts` is what makes that side effect unreachable to a consumer, and
`src/lib.test.ts` asserts the exclusion in source rather than trusting a comment
to survive.

### Why library source imports itself as `@rust-toolchain/*`

Every module under `src/` imports its siblings through the package specifier
(`import … from "@rust-toolchain/config"`), not through `./config` and not
through the short `@/` alias. A path alias is a _consumer-visible_ detail: when
a sibling project maps `@rust-toolchain/*` at its own root, the library's
internal imports resolve there too, because they use the very specifier the
consumer mapped. An internal-only alias breaks that — a package whose source
says `@/config` typechecks in its own repo and fails in every consumer with
`TS2307: Cannot find module '@/config'`.

`@/*` is mapped as a short form but confined to tests, which are never consumed.
It must not appear in library source: a consumer almost certainly has their own
`@/` pointing at their own `src`, so the import would resolve into their tree.

See
[README → Consuming from Another TypeScript Project](../README.md#consuming-from-another-typescript-project).

## Build Pipeline

```mermaid
flowchart LR
    SRC[src/*.ts]
    TSC[tsc --noEmit]
    BUN[bun build]
    DIST[dist/index.js]

    SRC --> TSC
    SRC --> BUN
    BUN --> DIST
    DIST --> ACTION[GitHub Action Node24 Runtime]

    subgraph Checks
        LINT[ESLint]
        FORMAT[Prettier]
        TEST[bun test --coverage]
    end

    SRC --> LINT
    SRC --> FORMAT
    SRC --> TEST
```

## Testing Strategy

All tests use Bun's built-in test runner with 100% coverage enforced by `bunfig.toml`.

| File                  | Tests                                                                                                                                                                                                 | Coverage Target                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/action.test.ts`  | `run` against injected fakes — argv shape, timeouts, retry/backoff, spawn errors, rustup bootstrap (POSIX + Windows), cargo env defaults, tolerated `rustup default`, `set-rustup-toolchain`, outputs | 100%                              |
| `src/core.test.ts`    | `parseRustToolchainToml`, `resolveChannel` (release-day table, bare-minor scaling, rejected names), `generateCacheKey`, `generateSpecCacheKey`, `parseRustcVersion`                                   | 100% lines, functions, statements |
| `src/config.test.ts`  | `mergeConfig` — toml vs input priority, target alias, default channel, identifier validation; `resolveRustupEnv` — env overrides, blank handling, `HOME` fallback, Windows paths                      | 100%                              |
| `src/builder.test.ts` | `ToolchainSpecBuilder` fluent chain, `ToolchainSpec` direct construction, argv generation and batching, install flags                                                                                 | 100%                              |
| `src/outputs.test.ts` | `buildActionOutputs` — resolved values, empty-list and absent-profile edges, `inputs`/`toml` provenance; `toOutputEntries` — JSON array serialisation, string booleans, `json` key order              | 100%                              |
| `src/lib.test.ts`     | Barrel surface pinned export by export, and the guard that `src/lib.ts` never re-exports `src/index.ts`; both path aliases resolve                                                                    | 100%                              |

The release-cycle cases are pinned against real rust-lang.org release dates
rather than against this codebase's own arithmetic, so a drifting epoch fails
the suite instead of being reflected by it.

## Key Design Decisions

### TOML-First, Override by Inputs

The action reads `rust-toolchain.toml` by default and merges it with action inputs. Inputs win on conflict. This mirrors the dtolnay/rust-toolchain behavior but adds explicit `profile` support.

### Fluent Builder Pattern

`ToolchainSpecBuilder` provides a fluent API with method chaining:

```ts
new ToolchainSpecBuilder()
  .withChannel("stable")
  .withTargets("wasm32-unknown-unknown")
  .withComponents("clippy", "rustfmt")
  .withProfile("minimal")
  .build();
```

### Channel Resolution

`resolveChannel` supports three expressive formats beyond literal channels:

- `stable N (year|month|week|day) ago` — compute minor from date arithmetic
- `stable minus N releases` — subtract from current stable
- `1.XX` — passed through unchanged; rustup resolves a `<major.minor>` channel to the newest patch in that series

### Cache Key

`generateCacheKey` produces a 12-character key from `date + commitHash` (first 12 chars), matching dtolnay/rust-toolchain's output format for cache compatibility. It is read through `RUSTUP_TOOLCHAIN`, so the key describes the toolchain that was requested rather than whatever a `rust-toolchain.toml` would have selected.

A `rustc` that cannot be run is fatal rather than silently yielding an empty key: every consumer keying a cache on an empty string would share one entry, with nothing in the log to explain it.

`generateSpecCacheKey` publishes a second output, `cachekey-full`, appending a
SHA-256 digest of the resolved channel, targets, components and profile. The
compatible key describes the compiler build alone, so two jobs on the same rustc
collide even when one installed `wasm32-unknown-unknown` and the other did not —
and the second restores artifacts produced without its target. Targets and
components are sorted before hashing, so the same set written in a different
order still hits the same key. See [COMPARISON.md](COMPARISON.md#cache-key).

### Toolchain Pinning

rustup resolves the active toolchain through an [override chain](https://rust-lang.github.io/rustup/overrides.html) — highest first: `+toolchain` shorthand, `RUSTUP_TOOLCHAIN`, directory override, `rust-toolchain.toml`, default. Three consequences shape this codebase:

- **`src/action.ts` exports `RUSTUP_TOOLCHAIN`** after installing. Setting `rustup default` alone is not enough: a workspace `rust-toolchain.toml` outranks the default, so later steps would run a different toolchain than the one installed.
- **`src/builder.ts` pins `--toolchain` on every `target add` / `component add`.** Without it those commands resolve through the same chain and attach targets or components to the toml's toolchain.
- **A `path` toolchain is rejected.** `path` selects a local directory and is mutually exclusive with `channel`, so there is nothing to install; `mergeConfig` throws rather than silently falling back to `stable`.

### Profiles Are Always Explicit

Omitting `--profile` makes rustup fall back to the globally configured profile (`rustup set profile`), not to `default`. The [rustup book](https://rust-lang.github.io/rustup/overrides.html) says so directly about the toolchain file's `profile` key:

> Note that if not specified, the `default` profile is not necessarily used, as a different default profile might have been set with `rustup set profile`.

Since `mergeConfig` resolves a profile for every run, `ToolchainSpec` always passes it explicitly so a runner-wide setting cannot change the result.

`mergeConfig` accepts only the three profiles rustup defines — `minimal`,
`default`, `complete` — narrowing the value to a `RustupProfile` union rather
than passing an arbitrary string through. A typo is reported with the valid
options listed instead of reaching rustup.

When neither the toml nor an input names one, the resolved value is
`DEFAULT_PROFILE`, which is **`default`** — the same profile rustup itself
defaults to (`minimal` plus `rust-docs`, `rustfmt` and `clippy`).

### The Profile Only Applies to a Fresh Toolchain

rustup silently ignores `--profile` when the toolchain is already installed.
Verified on a clean `rust:trixie` container:

```text
fresh  install --profile minimal   → installed   cargo, rust-std, rustc
re-install     --profile default   → unchanged   cargo, rust-std, rustc
re-install     --profile complete  → unchanged   cargo, rust-std, rustc
re-install     --profile default --force
                                   → unchanged   cargo, rust-std, rustc
remove, then fresh --profile default
                                   → installed   cargo, clippy, rust-docs,
                                                 rust-std, rustc, rustfmt
```

There is no rustup flag that applies a profile to an existing toolchain —
`--force` does not do it. Explicitly named components _do_ still install, which
is why the action adds `components` through separate `rustup component add`
calls rather than relying on the install flags.

### `complete` Is Not Installable on Release Channels

The `complete` profile pulls in `miri` and `rustc-codegen-cranelift`, which rustup
publishes only for nightly. On a fresh install against any release channel it
fails outright — verified for both a pinned version and `stable`:

```text
rustup toolchain install --profile complete 1.95
  error: some components are unavailable for download for channel '1.95':
         'miri' for target 'x86_64-unknown-linux-gnu',
         'rustc-codegen-cranelift' for target 'x86_64-unknown-linux-gnu'

rustup component list --toolchain 1.95    # what release channels actually offer
  llvm-tools, rust-analyzer, rust-src     # no miri, no cranelift
```

The failure is deterministic, so retrying cannot help. `assertProfileAvailable`
therefore rejects `complete` up front for any channel that is not nightly,
before a single rustup command runs — turning a slow, opaque network failure
into an immediate message naming the cause and the two ways out. The check runs
on the _resolved_ channel, so `stable 2 releases ago` is judged as the release
it becomes.

`beta` is rejected along with the release channels: a fresh container lists
neither component for it.

On an already-installed toolchain `complete` appears to succeed purely because
the profile is ignored (see above) — nothing is resolved, so nothing can be
missing. That is why the check is on the channel rather than on the outcome.

Because `complete` requests the widest set, `--allow-downgrade` is added for it
on `nightly` — the same latitude explicitly named components get, letting rustup
step back to the newest nightly that carries everything.

### Profiles Are Expanded Into Components

Because rustup will not apply a profile to an existing toolchain, the action
adds the profile's components by name after installing. `PROFILE_COMPONENTS` in
`src/config.ts` holds the mapping:

| Profile    | Added explicitly                                                  |
| ---------- | ----------------------------------------------------------------- |
| `minimal`  | nothing — rustc, cargo and rust-std are inherent to any toolchain |
| `default`  | `rust-docs`, `rustfmt`, `clippy`                                  |
| `complete` | the above plus `rust-src`, `rust-analyzer`, `llvm-tools`          |

`complete` deliberately omits `miri` and `rustc-codegen-cranelift`. rustup
publishes them for nightly only, so naming them would fail the add on every
release channel; they still arrive through `--profile complete` on a fresh
nightly install.

The two component invocations carry different weight:

- **Requested components** (`components:` input or toml) are a hard requirement.
  A failure fails the step.
- **Profile components** are best-effort. They were implied rather than asked
  for, so a channel that does not publish one is logged and the run continues.

Components the caller already listed are filtered out, so nothing is requested
twice.

Together with `default` as the default profile, this means a job on a runner
with Rust pre-installed still ends up with rustfmt and clippy — which is what
the profile promised and what rustup alone would not have delivered.

### Bootstrapping rustup

Self-hosted runners and slim container images frequently ship without rustup. If
`rustup --version` does not answer, `bootstrapRustup` downloads `rustup-init`
(`sh.rustup.rs`, or `win.rustup.rs/<arch>` on Windows) to `$RUNNER_TEMP`, runs it
with `--default-toolchain none`, and puts `$CARGO_HOME/bin` on `PATH`. The
installer is written to a file and executed directly rather than piped into a
shell.

### Cargo Environment Defaults

After the toolchain is installed, `applyCargoDefaults` sets what a Rust CI job
almost always wants, and never overwrites a value the workflow set itself:

| Variable                              | Value                                     | Why                                                                                                                                     |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CARGO_INCREMENTAL`                   | `0`                                       | Incremental artifacts never survive to the next run; producing them only costs time and cache space                                     |
| `CARGO_TERM_COLOR`                    | `always`                                  | Colour in the job log                                                                                                                   |
| `CARGO_REGISTRIES_CRATES_IO_PROTOCOL` | `sparse` on 1.68–1.69, `git` on 1.66–1.67 | The sparse registry was implemented in 1.66, stabilised in 1.68 and made default in 1.70, so only the versions in between need steering |
| `CARGO_HTTP_MULTIPLEXING`             | `false` on 1.70–1.71                      | Those toolchains bundle curl 8.0, which produced spurious network errors with multiplexing on                                           |

### Anchoring the Release Cycle

`stable N ago` and `stable minus N releases` count six-week cycles from
2015-05-14 — the same day dtolnay/rust-toolchain uses. The anchor is load-bearing
in both directions: a week late names a release that has been superseded, and a
week early names one that has not shipped, so `rustup toolchain install` fails
outright. `stableMinorAtDate` works purely in absolute epoch milliseconds and
`setUTC*` accessors, so the result never depends on the runner's timezone.

A bare `1.N` is scaled by `scaleBareMinor` while the scaled value names a release
that already exists: `1.9` reads as `1.90`, `1.62` is left alone. Without it,
writing `1.9` silently pins the 2015 release.

### Argv, Never a Shell

Channel, targets, components and profile can all originate in a
`rust-toolchain.toml` belonging to the checked-out workspace, which on
`pull_request_target` or any untrusted checkout is attacker-controlled. Every
command is therefore built as an argv array by `ToolchainSpec` and executed
without a shell, so a value like `stable; curl … | sh` reaches rustup as one
(invalid) toolchain name instead of a second command.

Two validation layers back this up: `resolveChannel` rejects anything that
cannot name a toolchain, and `mergeConfig` rejects targets, components and
profiles that are not plain rustup identifiers. Neither is load-bearing on its
own — they turn a confusing rustup error into a clear one.

### Timeouts and Retries

Every rustup verb used here downloads from `static.rust-lang.org`. Each call is
bounded by a timeout (10 minutes for rustup, 30 seconds for `rustc --version`)
so a stalled connection cannot hold the job until the workflow's own limit, and
network-bound commands are retried up to three times with 1s/2s backoff so a
single dropped connection does not fail the run.

### Relocatable `RUSTUP_HOME`

`resolveRustupEnv` honours a caller-supplied `RUSTUP_HOME`/`CARGO_HOME` and only falls back to `$HOME/…`. This matters on overlayfs-backed container runtimes (Docker, `act`, container jobs): rustup renames a component's _directory_ into `$RUSTUP_HOME/tmp` before replacing it, and overlayfs rejects renaming a directory that still lives in a lower image layer with `EXDEV`. Pointing `RUSTUP_HOME` at a directory created at run time keeps every rename inside one layer.

## Tooling Stack

```mermaid
flowchart LR
    subgraph Runtime
        BUN[Bun 1.3]
    end

    subgraph Lang
        TS[TypeScript]
    end

    subgraph Tooling
        MISE[mise]
        LINT[ESLint 10.x]
        FMT[Prettier 3.x]
        HK[hk]
        COMMITLINT[commitlint]
    end

    subgraph GitHub
        ACTION[actionlint]
        ACT[nektos/act]
    end

    BUN --> TS
    MISE --> BUN
    BUN --> LINT
    BUN --> FMT
    BUN --> COMMITLINT
    HK --> BUN
    ACT --> ACTION
```

### Runtime Dependencies

| Package           | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `@actions/core`   | Inputs, outputs, `exportVariable`, failures |
| `@actions/github` | Workflow context                            |
| `smol-toml`       | `rust-toolchain.toml` parsing               |
