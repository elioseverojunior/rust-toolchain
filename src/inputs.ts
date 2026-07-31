// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { BooleanInput } from "@rust-toolchain/outputs";

/**
 * The slice of `@actions/core` that reading an input needs.
 *
 * Deliberately narrower than `ActionDeps`: a module that only reads inputs has
 * no business executing commands or writing outputs, and taking the whole
 * surface would force `src/cache/inputs.ts` to import `src/action.ts` for the
 * type while `action.ts` imports it back — a cycle existing purely to satisfy a
 * type annotation. `ActionDeps["core"]` satisfies this structurally, so the
 * narrowing costs the caller nothing.
 */
export interface InputReader {
  getInput: (name: string) => string;
}

/**
 * Reads a YAML 1.2 boolean input, defaulting to `fallback` when unset.
 *
 * Matches `@actions/core`'s `getBooleanInput` grammar, and rejects anything
 * else rather than quietly reading a typo as `false`. The raw text is returned
 * alongside the value because the outputs report it: only the raw form
 * distinguishes an explicit `true` from an omitted input that defaulted to it.
 */
export function readBooleanInput(
  reader: InputReader,
  name: string,
  fallback: boolean,
): BooleanInput {
  const raw = reader.getInput(name).trim();
  if (raw === "") return { raw, value: fallback };
  if (["true", "True", "TRUE"].includes(raw)) return { raw, value: true };
  if (["false", "False", "FALSE"].includes(raw)) return { raw, value: false };
  throw new Error(`Input \`${name}\` must be "true" or "false", got "${raw}".`);
}
