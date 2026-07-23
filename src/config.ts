import { join } from "node:path";

import type { ToolchainTomlConfig } from "./core";

export interface ToolchainInputs {
  toolchain?: string;
  targets?: string;
  target?: string;
  components?: string;
  profile?: string;
}

export interface ResolvedToolchain {
  channel: string;
  targets: string[];
  components: string[];
  profile?: string;
}

/** Absolute locations rustup reads its state from. */
export interface RustupEnv {
  RUSTUP_HOME: string;
  CARGO_HOME: string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

const DEFAULT_HOME = "/root";

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
 */
export function resolveRustupEnv(env: EnvLike): RustupEnv {
  const home = trimmedOrUndefined(env.HOME) ?? DEFAULT_HOME;

  return {
    RUSTUP_HOME: trimmedOrUndefined(env.RUSTUP_HOME) ?? join(home, ".rustup"),
    CARGO_HOME: trimmedOrUndefined(env.CARGO_HOME) ?? join(home, ".cargo"),
  };
}

function parseCommaList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\s\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

  const inputTargets = parseCommaList(inputs.targets || inputs.target);
  const tomlTargets = tomlConfig.targets ?? [];
  const targets = [...new Set([...tomlTargets, ...inputTargets])];

  const inputComponents = parseCommaList(inputs.components);
  const tomlComponents = tomlConfig.components ?? [];
  const components = [...new Set([...tomlComponents, ...inputComponents])];

  const profile = inputs.profile ?? tomlConfig.profile ?? "default";

  return { channel, targets, components, profile };
}
