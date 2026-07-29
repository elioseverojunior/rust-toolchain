<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Comparison with dtolnay/rust-toolchain

This action is a superset of
[dtolnay/rust-toolchain](https://github.com/dtolnay/rust-toolchain). It carries
every behaviour of the upstream action, adds `rust-toolchain.toml` support, a
`profile` input, a spec-aware cache key, and a set of correctness and hardening
fixes.

Compared against `dtolnay/rust-toolchain@master` (composite action,
`action.yml`) as of 2026-07-24.

## Summary

|                                   | dtolnay                | this action                                                           |
| --------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Implementation                    | Composite action, bash | TypeScript bundled to `dist/index.js` (`node24`)                      |
| Configuration source              | Action inputs only     | `rust-toolchain.toml` first, inputs override                          |
| Profile                           | Hardcoded `minimal`    | `profile` input, toml, or `minimal`; validated against rustup's three |
| Command execution                 | Shell interpolation    | argv arrays, no shell                                                 |
| Toolchain pinning for later steps | `rustup default`       | `rustup default` **and** `RUSTUP_TOOLCHAIN`                           |
| Cache key                         | rustc version only     | rustc version, plus an optional spec-bound key                        |
| Tests                             | Workflow matrix        | 150 unit tests at 100% coverage, plus an `act` matrix                 |

## Legacy parity

Every upstream behaviour, and where it lives here.

| #   | Upstream behaviour                            | Status | Implementation                                         |
| --- | --------------------------------------------- | ------ | ------------------------------------------------------ |
| 1   | `toolchain` input                             | ✅     | `ToolchainInputs.toolchain`                            |
| 2   | `targets` input (comma-separated)             | ✅     | also accepts space and newline separators              |
| 3   | `target` input as an alias                    | ✅     | `mergeConfig`                                          |
| 4   | `components` input                            | ✅     | also accepts space and newline separators              |
| 5   | `cachekey` output                             | ✅     | byte-compatible — `date + commit-hash`, first 12 chars |
| 6   | `name` output                                 | ✅     | resolved channel                                       |
| 7   | `stable N (year\|month\|week\|day)s ago`      | ✅     | `resolveChannel`                                       |
| 8   | `stable minus N releases`                     | ✅     | `resolveChannel`                                       |
| 9   | Bare `1.N` scaled to a real release           | ✅     | `scaleBareMinor` — `1.9` reads as `1.90`               |
| 10  | Install rustup when absent                    | ✅     | `bootstrapRustup`, POSIX and Windows                   |
| 11  | `CARGO_HOME` default, Windows-aware           | ✅     | `resolveRustupEnv(env, platform)`                      |
| 12  | `--profile minimal`                           | ✅     | configurable and validated; defaults to `default`      |
| 13  | `--allow-downgrade` for nightly + components  | ✅     | `toRustupInstallArgs`                                  |
| 14  | `--no-self-update`                            | ✅     | `toRustupInstallArgs`                                  |
| 15  | `RUSTUP_PERMIT_COPY_RENAME=1`                 | ✅     | set on the install environment                         |
| 16  | `rustup default`, tolerating failure (#127)   | ✅     | logged and continued                                   |
| 17  | `CARGO_INCREMENTAL=0` when unset              | ✅     | `applyCargoDefaults`                                   |
| 18  | `CARGO_TERM_COLOR=always` when unset          | ✅     | `applyCargoDefaults`                                   |
| 19  | Sparse/git registry protocol for 1.66–1.69    | ✅     | `applyCargoDefaults`                                   |
| 20  | `CARGO_HTTP_MULTIPLEXING=false` for 1.70–1.71 | ✅     | `applyCargoDefaults`                                   |
| 21  | Log `rustc --version --verbose`               | ✅     | logged from the version already read                   |

## Enhancements

### Configuration

- **`rust-toolchain.toml` is read by default.** Upstream ignores the file
  entirely; the channel comes from the action `@rev` or the `toolchain` input.
  Here the file is the default source for channel, targets, components and
  profile, and any action input overrides it.
- **`profile` input.** Upstream hardcodes `--profile minimal` with no way to
  change it. Here `default` is the default — matching rustup — but the toml or
  an input can select `minimal` or `complete`, and an unrecognised name is
  rejected. Note that rustup ignores the profile when the toolchain is already
  installed, so `components` is the only guarantee; see
  [ARCHITECTURE.md](ARCHITECTURE.md#the-profile-only-applies-to-a-fresh-toolchain).
  A profile is
  always passed explicitly here, because omitting `--profile` makes rustup fall
  back to whatever `rustup set profile` left behind on the runner.
- **`path` toolchains are rejected loudly.** A `rust-toolchain.toml` with
  `path` cannot be installed by rustup; it fails with an explanation instead of
  silently installing `stable`.
- **Malformed TOML fails.** A syntax error is reported rather than being
  swallowed into a `stable` install.
- **The resolved configuration is published back.** Upstream emits `cachekey`
  and `name` only, so a later step cannot find out which targets, components or
  profile were actually installed without re-deriving the merge itself. Here
  `toolchain`, `targets`, `target`, `components`, `profile` and
  `set-rustup-toolchain` are outputs too, and `json` carries all of them
  natively typed — real arrays and a real boolean, so
  `fromJSON(steps.rust.outputs.json).targets` feeds a matrix directly. `json`
  additionally reports where each value came from, under `inputs` (the action
  inputs verbatim) and `toml` (the parsed file before merging): a merged list
  alone cannot say whether a target was named by the workflow or by the
  workspace.

### Correctness

- **`RUSTUP_TOOLCHAIN` is exported.** Upstream relies on `rustup default`, which
  is the _last_ entry in rustup's override chain — a `rust-toolchain.toml` in
  the workspace outranks it, so later steps can silently run a different
  toolchain than the one installed. Exporting `RUSTUP_TOOLCHAIN` (precedence 2)
  makes the installed toolchain the effective one. See
  [Override precedence](#override-precedence) for the full chain and the
  monorepo opt-out.
- **Targets and components are pinned with `--toolchain`.** They are also added
  after the install, so they still land when the toolchain was already present
  in the runner image — upstream's `--target`/`--component` flags are ignored by
  rustup in that case.
- **Release-cycle arithmetic is anchored to the same day as upstream**
  (2015-05-14), and is timezone-independent. Both properties are pinned by tests
  against real rust-lang.org release dates.
- **Relocatable `RUSTUP_HOME`.** A caller-supplied `RUSTUP_HOME`/`CARGO_HOME` is
  honoured, which is what makes the action work on overlayfs-backed container
  runtimes where rustup's directory renames fail with `EXDEV`.

### Hardening

- **No shell.** Every command is an argv array. Upstream interpolates the
  toolchain, targets and components into shell command lines; those values can
  come from a `rust-toolchain.toml` in an untrusted checkout.
- **Input validation.** Channels, targets, components and profiles must be
  plain rustup identifiers.
- **Timeouts.** 10 minutes per rustup command, 30 seconds for
  `rustc --version`, so a stalled download cannot hold the job for the
  workflow's full limit.
- **Retries.** Network-bound commands are retried three times with 1s/2s
  backoff.
- **No silent empty outputs.** An unreadable `rustc` fails the step instead of
  emitting an empty `cachekey`.

## Override precedence

`rust-toolchain.toml` does **not** take precedence over rustup's other override
mechanisms — it is fourth of five, beating only the global default. From
[the rustup book](https://rust-lang.github.io/rustup/overrides.html), highest
first:

| Priority | Mechanism                                    |
| -------- | -------------------------------------------- |
| 1        | `+toolchain` shorthand (`cargo +beta build`) |
| 2        | `RUSTUP_TOOLCHAIN` environment variable      |
| 3        | Directory override (`rustup override set`)   |
| 4        | `rust-toolchain.toml`                        |
| 5        | Default toolchain (`rustup default`)         |

Between 3 and 4 the book adds a proximity rule: "directory overrides and the
`rust-toolchain.toml` file are also preferred by their proximity to the current
directory", so a nearer toolchain file outranks a directory override registered
further up the tree.

This is why the action exports `RUSTUP_TOOLCHAIN`. Given:

```yaml
# rust-toolchain.toml pins channel = "1.89.0"
- uses: elioseverojunior/rust-toolchain@v1
  with:
    toolchain: nightly
- run: cargo build
```

`rustup default nightly` lands at priority 5 and loses to the toml at 4, so
`cargo build` would run 1.89.0 — the input would be honoured at install time and
ignored at use time. Exporting `RUSTUP_TOOLCHAIN` puts the resolved channel at
priority 2, above the file.

### Monorepo opt-out

Priority 2 outranks _every_ toolchain file in the tree, including nested ones
this action never read. A repository whose crates pin different toolchains would
see all of them flattened to the root's resolution. Set
`set-rustup-toolchain: false` to install without pinning globally, leaving each
nested `rust-toolchain.toml` to win in its own directory:

```yaml
- uses: elioseverojunior/rust-toolchain@v1
  with:
    toolchain: stable
    set-rustup-toolchain: false # crates/*/rust-toolchain.toml keep applying
```

Every output — the cache keys, the resolved configuration and `json` — still
describes the toolchain this action installed, whichever toolchain a later step
in a nested crate ends up resolving.

## Cache key

Upstream computes:

```sh
DATE=$(rustc --version --verbose | sed -ne 's/^commit-date: ...//p')
HASH=$(rustc --version --verbose | sed -ne 's/^commit-hash: //p')
cachekey=$(echo $DATE$HASH | head -c12)
```

The key describes **the compiler build and nothing else**. Two jobs on the same
rustc collide even when their toolchains differ in ways that change what gets
built:

```yaml
# Job A                              # Job B
with:                                with:
  toolchain: stable                    toolchain: stable
  targets: wasm32-unknown-unknown      # host target only
# cachekey: 20250627e5b2             # cachekey: 20250627e5b2   ← identical
```

Job B restores a cache populated by Job A, whose contents were produced with a
target Job B never installed — and vice versa.

### What this action does

`cachekey` is unchanged and byte-compatible, so existing workflows and caches
shared with upstream keep working. A second output, `cachekey-full`, appends a
digest of the whole resolved spec:

| Output          | Example                 | Covers                                                |
| --------------- | ----------------------- | ----------------------------------------------------- |
| `cachekey`      | `20250627e5b2`          | rustc commit date + hash                              |
| `cachekey-full` | `20250627e5b2-3f9a1c04` | the above, plus channel, targets, components, profile |

The digest is the first 8 hex characters of a SHA-256 over a canonical spec
string. Targets and components are sorted first, so declaring the same set in a
different order still produces the same key.

```yaml
- id: rust
  uses: elioseverojunior/rust-toolchain@v1
  with:
    toolchain: stable
    targets: wasm32-unknown-unknown

- uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry
      ~/.cargo/git
      target
    # Distinguishes toolchains that differ only in targets or components.
    key: ${{ runner.os }}-cargo-${{ steps.rust.outputs.cachekey-full }}
```

Use `cachekey` when sharing a cache with jobs that use the upstream action; use
`cachekey-full` otherwise.

## Deliberate divergences

| Behaviour                         | dtolnay                                 | this action                                           | Why                                                                                                 |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Missing `toolchain`               | Hard error                              | Falls back to `rust-toolchain.toml`, then `stable`    | The toml is the intended source here, so an absent input is normal rather than a mistake            |
| Toolchain selected by `@rev`      | `@stable`, `@1.89.0`, … pin the channel | Not supported — use the `toolchain` input or the toml | Requires one git tag per channel, kept in sync forever; the toml already expresses this per project |
| Unknown profile name              | Passed through to rustup                | Rejected, listing `minimal`, `default`, `complete`    | A typo fails with the valid options rather than an opaque rustup error                              |
| Malformed `rust-toolchain.toml`   | Not read at all                         | Fails the step                                        | Guessing a channel runs a toolchain nobody asked for                                                |
| `rustc` unavailable after install | `cachekey` ends up empty                | Fails the step                                        | An empty key silently collapses every consumer's cache to one entry                                 |

The `@rev` difference is the one to be aware of when migrating:

```yaml
# dtolnay
- uses: dtolnay/rust-toolchain@1.89.0

# here — pick either
- uses: elioseverojunior/rust-toolchain@v1
  with:
    toolchain: 1.89.0
# ...or drop the input entirely and commit rust-toolchain.toml
```

## Verification

Parity claims in this document are covered by tests:

| Claim                                  | Test                                              |
| -------------------------------------- | ------------------------------------------------- |
| Cycle arithmetic matches real releases | `core.test.ts` — release-day table                |
| Bare minor scaling                     | `core.test.ts` — "scales a truncated bare minor"  |
| Install flags                          | `builder.test.ts` — "install flags"               |
| Windows paths                          | `config.test.ts` — "resolveRustupEnv on Windows"  |
| rustup bootstrap                       | `action.test.ts` — "rustup bootstrap"             |
| Cargo env defaults                     | `action.test.ts` — "cargo environment defaults"   |
| Tolerated `rustup default`             | `action.test.ts` — "rustup compatibility details" |
| Spec-bound cache key                   | `core.test.ts` + `action.test.ts`                 |
| Resolved-configuration outputs         | `outputs.test.ts` + `action.test.ts`              |

End-to-end coverage runs the real action against real rustup via
`mise run act` and `mise run act:matrix`.
