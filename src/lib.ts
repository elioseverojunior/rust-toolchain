// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * The library surface, for consumers importing this package by name.
 *
 * `src/index.ts` is deliberately not re-exported. It is the GitHub Action
 * entry point: it exports nothing and calls `run()` at the top level, so
 * pulling it into this barrel would make merely importing the library shell
 * out to `rustup`. Everything below is free of import-time side effects.
 *
 * Importing a single module directly (`@rust-toolchain/core`, …) stays
 * supported and is cheaper — this barrel loads all twenty-two.
 *
 * The re-exports below use the package specifier rather than `./action`, so
 * they resolve identically here and in a consumer that maps
 * `@rust-toolchain/*` at its own root. A `@/`-style alias would resolve only
 * inside this repo and break the moment the source is consumed.
 */
export * from "@rust-toolchain/action";
export * from "@rust-toolchain/builder";
export * from "@rust-toolchain/cache/budget";
export * from "@rust-toolchain/cache/client";
export * from "@rust-toolchain/cache/env";
export * from "@rust-toolchain/cache/fs";
export * from "@rust-toolchain/cache/inputs";
export * from "@rust-toolchain/cache/keys";
export * from "@rust-toolchain/cache/layers";
export * from "@rust-toolchain/cache/lifecycle";
export * from "@rust-toolchain/cache/metadata";
export * from "@rust-toolchain/cache/paths";
export * from "@rust-toolchain/cache/prune";
export * from "@rust-toolchain/cache/stage";
export * from "@rust-toolchain/cache/summary";
export * from "@rust-toolchain/config";
export * from "@rust-toolchain/core";
export * from "@rust-toolchain/errors";
export * from "@rust-toolchain/inputs";
export * from "@rust-toolchain/msrv";
export * from "@rust-toolchain/outputs";
export * from "@rust-toolchain/tools";
