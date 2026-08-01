// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { ToolchainSpec } from "@rust-toolchain/builder";
import type { CacheLayerKey } from "@rust-toolchain/cache/keys";
import type { CacheLayerId } from "@rust-toolchain/cache/layers";
import type { LayerResult } from "@rust-toolchain/cache/lifecycle";
import type { ToolchainInputs } from "@rust-toolchain/config";
import type { ToolchainTomlConfig } from "@rust-toolchain/core";

/**
 * A boolean action input, kept alongside the text it was parsed from.
 *
 * The resolved value is what the action acted on; the raw text is what the
 * workflow actually wrote, which is the only way a consumer can tell an
 * explicit `true` from an unset input that defaulted to `true`.
 */
export interface BooleanInput {
  /** Exactly what the workflow supplied; `""` when the input was omitted. */
  raw: string;
  /** The value after applying the action's default. */
  value: boolean;
}

/**
 * The toolchain inputs verbatim, before any parsing or merging.
 *
 * Every field is a string, `""` when unset, mirroring `core.getInput`. Keyed by
 * input name rather than by a TypeScript-friendly alias so the JSON reads the
 * same as the `with:` block that produced it.
 *
 * Not every input: this block exists to say whether a resolved value came from
 * the workflow or from `rust-toolchain.toml`, so it carries only the inputs
 * that question applies to, plus `set-rustup-toolchain`. The `cache-*` inputs
 * have no toml counterpart and are reported through `CacheOutputs` instead.
 */
export interface InputProvenance {
  toolchain: string;
  targets: string;
  target: string;
  components: string;
  profile: string;
  "set-rustup-toolchain": string;
}

/**
 * What `rust-toolchain.toml` declared, before merging with the inputs.
 *
 * Absent scalars are `null` rather than `""` so a consumer can distinguish "the
 * file did not set this" from "the file set it to an empty value"; absent lists
 * are `[]` because rustup treats a missing list and an empty one alike.
 */
export interface TomlProvenance {
  channel: string | null;
  targets: string[];
  components: string[];
  profile: string | null;
  path: string | null;
}

/**
 * A layer's key and restore ladder, plus what actually happened to it.
 *
 * `result` and `bytes` are optional rather than required: Phase A emitted keys
 * with no lifecycle behind them, and a consumer reading last week's output —
 * before restore/save existed — must not break because these fields are now
 * mandatory.
 */
export interface CacheLayerOutput extends CacheLayerKey {
  /** Absent until the layer has been restored — Phase A emitted keys only. */
  result?: LayerResult;
  /** Bytes measured for the save decision; `0` when nothing was measured. */
  bytes?: number;
}

/**
 * The cache keys this action derived, per layer.
 *
 * `layers` is partial because `cache-layers` selects which exist; a consumer
 * reads only the ones it enabled. Nothing here is restored or saved yet — these
 * are keys for the workflow's own `actions/cache` steps to use.
 */
export interface CacheOutputs {
  enabled: boolean;
  layers: Partial<Record<CacheLayerId, CacheLayerOutput>>;
}

/**
 * Every value the action publishes, natively typed.
 *
 * Serialised whole into the `json` output, so the declaration order below is
 * the key order consumers see: effective values first, then the compatibility
 * keys, then the provenance blocks that explain where each value came from.
 */
export interface ActionOutputs {
  toolchain: string;
  targets: string[];
  target: string;
  components: string[];
  profile: string;
  "set-rustup-toolchain": boolean;
  name: string;
  cachekey: string;
  "cachekey-full": string;
  "cache-hit": boolean;
  cache: CacheOutputs;
  inputs: InputProvenance;
  toml: TomlProvenance;
}

export interface ActionOutputsArgs {
  /** The merged, validated toolchain the action installed. */
  spec: ToolchainSpec;
  /** Action inputs as read, before merging. */
  inputs: ToolchainInputs;
  /** `rust-toolchain.toml` as parsed, before merging. */
  toml: ToolchainTomlConfig;
  setRustupToolchain: BooleanInput;
  /** dtolnay-compatible key describing the compiler alone. */
  cacheKey: string;
  /** The above, extended with a digest of the whole spec. */
  specCacheKey: string;
  /** Per-layer cache keys, or a disabled marker when `cache` is false. */
  cache: CacheOutputs;
  /**
   * `true` only when every enabled layer matched its exact key.
   *
   * A partial match through a restore key counts as false: the layer will be
   * saved again under the new key, so it was not a full hit. Required rather
   * than optional: an optional field is one a caller can forget, and
   * forgetting it here means the action silently publishes `cache-hit: false`
   * forever — including on a genuine full hit — with no compile-time signal.
   */
  cacheHit: boolean;
}

/**
 * Maps the resolved configuration onto the action's output surface.
 *
 * Pure, and deliberately separate from `run`: the mapping is the part worth
 * asserting exhaustively, and keeping it out of the orchestration lets the
 * tests cover it without standing up an exec harness.
 */
export function buildActionOutputs(args: ActionOutputsArgs): ActionOutputs {
  const { spec, inputs, toml } = args;

  return {
    toolchain: spec.channel,
    targets: [...spec.targets],
    // `targets` is a merged list and `mergeConfig` orders inputs ahead of the
    // toml, so the first entry is the caller's own target whenever they named
    // one. Empty rather than absent when nothing was requested.
    target: spec.targets[0] ?? "",
    components: [...spec.components],
    // mergeConfig always resolves a profile, but ToolchainSpec permits none;
    // the fallback keeps `undefined` out of a string-typed output.
    profile: spec.profile ?? "",
    "set-rustup-toolchain": args.setRustupToolchain.value,
    // Same value as `toolchain`, kept because dtolnay/rust-toolchain publishes
    // it under this name and workflows migrating from it read `name`.
    name: spec.channel,
    cachekey: args.cacheKey,
    "cachekey-full": args.specCacheKey,
    "cache-hit": args.cacheHit,
    cache: args.cache,
    inputs: {
      toolchain: inputs.toolchain ?? "",
      targets: inputs.targets ?? "",
      target: inputs.target ?? "",
      components: inputs.components ?? "",
      profile: inputs.profile ?? "",
      "set-rustup-toolchain": args.setRustupToolchain.raw,
    },
    toml: {
      channel: toml.channel ?? null,
      targets: toml.targets ?? [],
      components: toml.components ?? [],
      profile: toml.profile ?? null,
      path: toml.path ?? null,
    },
  };
}

/**
 * Flattens the outputs into the `name, value` pairs GitHub Actions accepts.
 *
 * Action outputs are strings, so lists are emitted as JSON arrays rather than
 * as a delimiter-joined string: `fromJSON` then reads them directly, and no
 * consumer has to guess whether the separator was a comma, a space or both.
 * The whole object goes out under `json` for consumers that would rather read
 * one key than ten.
 */
export function toOutputEntries(outputs: ActionOutputs): [string, string][] {
  return [
    ["cachekey", outputs.cachekey],
    ["cachekey-full", outputs["cachekey-full"]],
    ["name", outputs.name],
    ["toolchain", outputs.toolchain],
    ["targets", JSON.stringify(outputs.targets)],
    ["target", outputs.target],
    ["components", JSON.stringify(outputs.components)],
    ["profile", outputs.profile],
    ["set-rustup-toolchain", String(outputs["set-rustup-toolchain"])],
    ["cache-hit", String(outputs["cache-hit"])],
    ["cache", JSON.stringify(outputs.cache)],
    ["json", JSON.stringify(outputs)],
  ];
}
