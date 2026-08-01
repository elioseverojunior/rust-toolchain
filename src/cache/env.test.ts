// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { hashBuildEnv } from "@/cache/env";

describe("hashBuildEnv", () => {
  it("is stable for an empty environment", () => {
    expect(hashBuildEnv({})).toBe(hashBuildEnv({}));
    expect(hashBuildEnv({})).toMatch(/^[0-9a-f]{8}$/);
  });

  it("ignores variables outside the prefix set", () => {
    expect(hashBuildEnv({ PATH: "/usr/bin", HOME: "/root" })).toBe(
      hashBuildEnv({}),
    );
  });

  // The whole reason this exists: two jobs differing only in RUSTFLAGS must
  // not derive the same build key.
  it("changes when RUSTFLAGS changes", () => {
    expect(hashBuildEnv({ RUSTFLAGS: "-C target-cpu=native" })).not.toBe(
      hashBuildEnv({ RUSTFLAGS: "" }),
    );
  });

  it("covers every prefix in the set", () => {
    const base = hashBuildEnv({});
    for (const name of [
      "CARGO_BUILD_JOBS",
      "CC",
      "CFLAGS",
      "CXX",
      "CMAKE_C_COMPILER",
      "RUSTDOCFLAGS",
    ]) {
      expect(hashBuildEnv({ [name]: "x" })).not.toBe(base);
    }
  });

  // Order must not matter: an environment is a set, and object key order is
  // an implementation detail of whoever built it.
  it("is independent of insertion order", () => {
    expect(hashBuildEnv({ RUSTFLAGS: "-O", CC: "clang" })).toBe(
      hashBuildEnv({ CC: "clang", RUSTFLAGS: "-O" }),
    );
  });

  // These match the prefix set but describe where or how, not what gets
  // built. Hashing them would churn the key on self-hosted runners without
  // changing a single artifact.
  it.each([
    "CARGO_HOME",
    "RUSTUP_HOME",
    "CARGO_TERM_COLOR",
    "RUSTUP_TOOLCHAIN",
  ])("excludes %s", (name) => {
    expect(hashBuildEnv({ [name]: "/some/path" })).toBe(hashBuildEnv({}));
  });

  // The action passes every one of these to `core.exportVariable`, which
  // writes to GITHUB_ENV — so a second invocation in the same job reads back
  // what the first one wrote. Hashing them would make the build key depend on
  // how many times the action had already run, and the E2E job invokes it
  // twice by design.
  //
  // Two call sites, not one. `applyCargoDefaults` sets the four `CARGO_*`
  // ones; `run` itself exports RUST_TOOLCHAIN_CACHE_ON_FAILURE, which matched
  // the `RUST` prefix and was missed for exactly that reason — the sync rule
  // had been written around `applyCargoDefaults` rather than around the
  // category "anything this action exports".
  it.each([
    ["CARGO_INCREMENTAL", "0"],
    ["CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "sparse"],
    ["CARGO_HTTP_MULTIPLEXING", "false"],
    ["RUST_TOOLCHAIN_CACHE_ON_FAILURE", "false"],
  ])("excludes %s, which the action exports itself", (name, value) => {
    expect(hashBuildEnv({ [name]: value })).toBe(hashBuildEnv({}));
  });

  // The whole set at once, which is what a second same-job invocation
  // actually sees. This is the test that catches a missed export: each
  // variable in isolation can pass while the set as a whole still drifts,
  // because it only takes one leak to move the digest. Measured before the
  // first fix as e3b0c442 then dd704211, and after it — with
  // RUST_TOOLCHAIN_CACHE_ON_FAILURE still leaking — as e3b0c442 then d839dac7.
  //
  // Every name below must appear in `EXCLUDED`. Adding a `core.exportVariable`
  // call anywhere in `src/action.ts` means adding it here too.
  it("is unchanged by everything the action exports into GITHUB_ENV", () => {
    const caller = { RUSTFLAGS: "-C target-cpu=native" };
    expect(
      hashBuildEnv({
        ...caller,
        // applyCargoDefaults
        CARGO_INCREMENTAL: "0",
        CARGO_TERM_COLOR: "always",
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
        CARGO_HTTP_MULTIPLEXING: "false",
        // run
        RUSTUP_TOOLCHAIN: "1.90",
        RUST_TOOLCHAIN_CACHE_ON_FAILURE: "false",
      }),
    ).toBe(hashBuildEnv(caller));
  });

  it("ignores undefined values", () => {
    expect(hashBuildEnv({ RUSTFLAGS: undefined })).toBe(hashBuildEnv({}));
  });
});
