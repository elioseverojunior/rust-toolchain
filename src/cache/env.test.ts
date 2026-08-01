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

  // `applyCargoDefaults` exports these through `core.exportVariable`, which
  // writes to GITHUB_ENV — so a second invocation of this action in the same
  // job reads back what the first one wrote. Hashing them would make the
  // build key depend on how many times the action had already run, and the
  // E2E job invokes it twice by design.
  it.each([
    ["CARGO_INCREMENTAL", "0"],
    ["CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "sparse"],
    ["CARGO_HTTP_MULTIPLEXING", "false"],
  ])("excludes %s, which the action exports itself", (name, value) => {
    expect(hashBuildEnv({ [name]: value })).toBe(hashBuildEnv({}));
  });

  // The whole set at once, which is what a second same-job invocation
  // actually sees: measured before this fix as e3b0c442 then dd704211.
  it("is unchanged by everything the action exports into GITHUB_ENV", () => {
    expect(
      hashBuildEnv({
        RUSTFLAGS: "-C target-cpu=native",
        CARGO_INCREMENTAL: "0",
        CARGO_TERM_COLOR: "always",
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
        CARGO_HTTP_MULTIPLEXING: "false",
        RUSTUP_TOOLCHAIN: "1.90",
      }),
    ).toBe(hashBuildEnv({ RUSTFLAGS: "-C target-cpu=native" }));
  });

  it("ignores undefined values", () => {
    expect(hashBuildEnv({ RUSTFLAGS: undefined })).toBe(hashBuildEnv({}));
  });
});
