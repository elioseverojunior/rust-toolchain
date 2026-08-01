// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Renders a caught value as a message, whatever it turns out to be.
 *
 * `catch` binds `unknown` under `useUnknownInCatchVariables`, and everything
 * this action catches crosses a boundary it does not own — `spawnSync`,
 * `@actions/cache`, `smol-toml`, a JSON payload handed over by the main phase.
 * Any of those may reject with a non-`Error`, so `error.message` is not
 * available without a check.
 *
 * Extracted because the check was written out nine times across three modules,
 * and a ternary repeated nine times is nine chances to write `String(error)`
 * where `error.message` was meant — which reads as `[object Object]` in a job
 * log, at exactly the moment someone is trying to work out what failed.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
