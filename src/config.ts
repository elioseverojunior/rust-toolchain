// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { join } from "node:path";

import type { ToolchainTomlConfig } from "@rust-toolchain/core";

export interface ToolchainInputs {
  toolchain?: string;
  targets?: string;
  target?: string;
  components?: string;
  profile?: string;
}

/**
 * The only profiles rustup accepts.
 *
 * See the [rustup book](https://rust-lang.github.io/rustup/concepts/profiles.html):
 * `minimal` is rustc, cargo and rust-std; `default` adds rust-docs, rustfmt and
 * clippy; `complete` adds everything else.
 */
export const RUSTUP_PROFILES = ["minimal", "default", "complete"] as const;

export type RustupProfile = (typeof RUSTUP_PROFILES)[number];

/**
 * Used when neither `rust-toolchain.toml` nor an action input names a profile.
 *
 * `default` — the same profile rustup itself defaults to. Defaulting to
 * `minimal` would be actively unsafe here: rustup ignores `--profile` entirely
 * when the toolchain is already installed, which is the normal case on hosted
 * runners, so a workflow that later needed rustfmt or clippy would have no way
 * to get them back from the profile. `default` errs toward the components a
 * Rust CI job usually wants; pass `profile: minimal` explicitly to opt out.
 */
export const DEFAULT_PROFILE: RustupProfile = "default";

/**
 * Components each profile implies, named so they can be added explicitly.
 *
 * rustup applies `--profile` only when it installs a toolchain for the first
 * time; on an already-installed one — the normal case on hosted runners — the
 * flag is silently ignored. Adding these by name afterwards is what makes the
 * profile take effect either way.
 *
 * `minimal` is empty because rustc, cargo and rust-std are inherent to any
 * toolchain. `complete` deliberately omits `miri` and `rustc-codegen-cranelift`:
 * rustup publishes them for nightly only, so naming them would fail the add on
 * every release channel. They still arrive via `--profile complete` on a fresh
 * nightly install.
 */
export const PROFILE_COMPONENTS: Record<RustupProfile, readonly string[]> = {
  minimal: [],
  default: ["rust-docs", "rustfmt", "clippy"],
  complete: [
    "rust-docs",
    "rustfmt",
    "clippy",
    "rust-src",
    "rust-analyzer",
    "llvm-tools",
  ],
};

export interface ResolvedToolchain {
  channel: string;
  targets: string[];
  components: string[];
  profile?: RustupProfile;
}

/** Absolute locations rustup reads its state from. */
export interface RustupEnv {
  RUSTUP_HOME: string;
  CARGO_HOME: string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

const DEFAULT_HOME = "/root";
const DEFAULT_WINDOWS_HOME = "C:\\Users\\Default";

function trimmedOrUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves where rustup keeps its toolchains and cargo keeps its state.
 *
 * A caller-supplied `RUSTUP_HOME`/`CARGO_HOME` always wins, so callers can
 * relocate rustup onto a writable filesystem. This matters on container
 * runtimes backed by overlayfs (Docker, `act`, container jobs): rustup renames
 * a component's *directory* into `$RUSTUP_HOME/tmp` before replacing it, and
 * overlayfs rejects renaming a directory that still lives in a lower image
 * layer with `EXDEV` ("Invalid cross-device link"). Pointing `RUSTUP_HOME` at a
 * directory created at run time keeps every rename inside a single layer.
 *
 * Windows runners have no `$HOME`, so both homes derive from `%USERPROFILE%`
 * there and are joined with a backslash regardless of the host running this
 * code.
 */
export function resolveRustupEnv(
  env: EnvLike,
  platform: string = process.platform,
): RustupEnv {
  const windows = platform === "win32";
  const home = windows
    ? (trimmedOrUndefined(env.USERPROFILE) ??
      trimmedOrUndefined(env.HOME) ??
      DEFAULT_WINDOWS_HOME)
    : (trimmedOrUndefined(env.HOME) ?? DEFAULT_HOME);
  const under = (leaf: string): string =>
    windows ? `${home}\\${leaf}` : join(home, leaf);

  return {
    RUSTUP_HOME: trimmedOrUndefined(env.RUSTUP_HOME) ?? under(".rustup"),
    CARGO_HOME: trimmedOrUndefined(env.CARGO_HOME) ?? under(".cargo"),
  };
}

/**
 * Splits a comma-, whitespace- or newline-separated input into entries.
 *
 * `\s` already covers `\n`, so the class needs no separate newline alternative.
 * Shared with `parseCacheLayers` so the separator grammar has one definition.
 */
export function parseCommaList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Target triples, component names and profile names are plain identifiers. */
const RUSTUP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Rejects values rustup could not accept as an identifier.
 *
 * These may come from a `rust-toolchain.toml` in an untrusted checkout.
 * Commands run without a shell, so this guards against a confusing rustup
 * failure rather than against injection alone.
 */
/** Narrows an arbitrary string to one of rustup's three profiles. */
function assertProfile(value: string): RustupProfile {
  if (!(RUSTUP_PROFILES as readonly string[]).includes(value)) {
    throw new Error(
      `"${value}" is not a valid rustup profile. Valid options are: ` +
        `${RUSTUP_PROFILES.join(", ")}.`,
    );
  }
  return value as RustupProfile;
}

/** `nightly`, optionally with a date and/or host triple suffix. */
const NIGHTLY_CHANNEL = /^nightly(-|$)/;

/**
 * Rejects a profile the channel cannot supply.
 *
 * `complete` requires `miri` and `rustc-codegen-cranelift`, which rustup
 * publishes for nightly only — confirmed against a fresh container, where
 * neither is listed for `stable`, `beta` or a pinned release. rustup discovers
 * this the slow way, failing after contacting the server with
 * "some components are unavailable for download"; since the outcome is
 * deterministic, saying so up front is both faster and clearer.
 *
 * Called with the *resolved* channel, so `stable 2 releases ago` is judged on
 * the `1.NN` it becomes rather than on the phrase.
 */
export function assertProfileAvailable(
  channel: string,
  profile?: RustupProfile,
): void {
  if (profile !== "complete" || NIGHTLY_CHANNEL.test(channel)) return;
  throw new Error(
    `The "complete" profile requires a nightly toolchain, but the channel ` +
      `resolved to "${channel}". It includes miri and rustc-codegen-cranelift, ` +
      `which rustup publishes for nightly only. Use "toolchain: nightly", or ` +
      `pick "profile: default" and name any extra components you need.`,
  );
}

function assertIdentifiers(kind: string, values: string[]): string[] {
  for (const value of values) {
    if (!RUSTUP_IDENTIFIER.test(value)) {
      throw new Error(`"${value}" is not a valid rustup ${kind} name.`);
    }
  }
  return values;
}

export function mergeConfig(
  tomlConfig: ToolchainTomlConfig,
  inputs: ToolchainInputs,
): ResolvedToolchain {
  // A `path` toolchain names a local directory and is mutually exclusive with
  // `channel`, so there is nothing to install. Fail loudly rather than silently
  // falling back to "stable" and running a toolchain nobody asked for.
  if (!inputs.toolchain && !tomlConfig.channel && tomlConfig.path) {
    throw new Error(
      "rust-toolchain.toml sets `path`, which selects a local custom toolchain " +
        "that rustup cannot install. Set the `toolchain` input to choose a channel.",
    );
  }

  const channel = inputs.toolchain ?? tomlConfig.channel ?? "stable";

  // Inputs lead, then the toml, deduped by first occurrence. rustup treats
  // both as sets — argv order changes nothing it does, and `generateSpecCacheKey`
  // sorts before hashing, so cache keys are unaffected. What the order does
  // decide is which target `targets[0]` names, and "inputs override the toml"
  // is the action's headline contract: a caller who passed `target:` must not
  // read back one the toml supplied.
  const inputTargets = parseCommaList(inputs.targets || inputs.target);
  const tomlTargets = tomlConfig.targets ?? [];
  const targets = assertIdentifiers("target", [
    ...new Set([...inputTargets, ...tomlTargets]),
  ]);

  const inputComponents = parseCommaList(inputs.components);
  const tomlComponents = tomlConfig.components ?? [];
  const components = assertIdentifiers("component", [
    ...new Set([...inputComponents, ...tomlComponents]),
  ]);

  const profile = assertProfile(
    inputs.profile ?? tomlConfig.profile ?? DEFAULT_PROFILE,
  );

  return { channel, targets, components, profile };
}
