// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { ToolchainInputs } from "@/config";
import {
  assertProfileAvailable,
  mergeConfig,
  resolveRustupEnv,
} from "@/config";

describe("mergeConfig", () => {
  it("uses toml channel when no input provided", () => {
    const toml = { channel: "stable" };
    const inputs: ToolchainInputs = {};
    const result = mergeConfig(toml, inputs);
    expect(result.channel).toBe("stable");
  });

  it("uses input channel over toml", () => {
    const toml = { channel: "stable" };
    const inputs: ToolchainInputs = { toolchain: "nightly" };
    const result = mergeConfig(toml, inputs);
    expect(result.channel).toBe("nightly");
  });

  // Inputs lead the merged list. "Inputs override the toml" is the action's
  // headline contract, and the `target` output names targets[0]; ordering the
  // toml first would hand back a target the caller never asked for.
  it("merges targets from toml and inputs, inputs first", () => {
    const toml = { targets: ["wasm32-unknown-unknown"] };
    const inputs: ToolchainInputs = { targets: "aarch64-apple-darwin" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual([
      "aarch64-apple-darwin",
      "wasm32-unknown-unknown",
    ]);
  });

  it("uses `target` as alias for targets input", () => {
    const toml = {};
    const inputs: ToolchainInputs = { target: "x86_64-pc-windows-gnu" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual(["x86_64-pc-windows-gnu"]);
  });

  it("merges components from toml and inputs, inputs first", () => {
    const toml = { components: ["clippy"] };
    const inputs: ToolchainInputs = { components: "rustfmt" };
    const result = mergeConfig(toml, inputs);
    expect(result.components).toEqual(["rustfmt", "clippy"]);
  });

  // Targets accumulate rather than replace: unlike channel and profile, an
  // input adds to whatever the toml already declared.
  it("keeps toml targets alongside input targets rather than replacing them", () => {
    const toml = { targets: ["wasm32-unknown-unknown"] };
    const inputs: ToolchainInputs = { targets: "x86_64-unknown-linux-gnu" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual([
      "x86_64-unknown-linux-gnu",
      "wasm32-unknown-unknown",
    ]);
  });

  // Deduping keeps the first occurrence, so a target named in both places
  // still lands at the input's position rather than the toml's.
  it("dedupes a target named by both the toml and an input", () => {
    const result = mergeConfig(
      { targets: ["aarch64-apple-darwin", "wasm32-unknown-unknown"] },
      { targets: "wasm32-unknown-unknown" },
    );
    expect(result.targets).toEqual([
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
  });

  it("defaults channel to 'stable' when nothing specified", () => {
    const result = mergeConfig({}, {});
    expect(result.channel).toBe("stable");
  });

  it("uses toml profile when no input", () => {
    const toml = { profile: "minimal" };
    const result = mergeConfig(toml, {});
    expect(result.profile).toBe("minimal");
  });

  it("uses input profile over toml", () => {
    const toml = { profile: "minimal" };
    const inputs: ToolchainInputs = { profile: "default" };
    const result = mergeConfig(toml, inputs);
    expect(result.profile).toBe("default");
  });

  // rustup's own default, and the safe one here: `--profile` is silently
  // ignored when the toolchain is already installed (as it is on hosted
  // runners), so defaulting to `minimal` would leave a workflow without
  // rustfmt or clippy and no way for the profile to add them back.
  it("defaults profile to 'default' when neither toml nor input specifies", () => {
    const result = mergeConfig({}, {});
    expect(result.profile).toBe("default");
  });

  // rustup accepts exactly three profiles. Anything else is a typo that would
  // otherwise reach rustup and fail there with less context.
  describe("profile is one of rustup's three", () => {
    it.each([["minimal"], ["default"], ["complete"]] as const)(
      "accepts %s",
      (name) => {
        expect(mergeConfig({}, { profile: name }).profile).toBe(name);
      },
    );

    it("rejects an unknown profile and lists the valid ones", () => {
      expect(() => mergeConfig({}, { profile: "tiny" })).toThrow(
        /minimal.*default.*complete/,
      );
    });

    it("rejects an unknown profile coming from the toml", () => {
      expect(() => mergeConfig({ profile: "full" }, {})).toThrow(/full/);
    });
  });

  it("parses comma-separated components", () => {
    const result = mergeConfig({}, { components: "clippy,rustfmt" });
    expect(result.components).toEqual(["clippy", "rustfmt"]);
  });

  it("parses space-separated components", () => {
    const result = mergeConfig({}, { components: "clippy rustfmt" });
    expect(result.components).toEqual(["clippy", "rustfmt"]);
  });

  it("parses newline-separated components", () => {
    const result = mergeConfig(
      {},
      { components: "clippy\nrustfmt\nllvm-tools" },
    );
    expect(result.components).toEqual(["clippy", "rustfmt", "llvm-tools"]);
  });

  it("parses mixed separators in components", () => {
    const result = mergeConfig(
      {},
      { components: "clippy, rustfmt\nllvm-tools" },
    );
    expect(result.components).toEqual(["clippy", "rustfmt", "llvm-tools"]);
  });

  // Targets, components and profiles are plain rustup identifiers. Rejecting
  // anything else here stops a hostile rust-toolchain.toml at the config
  // boundary, before any value reaches the process layer.
  describe("rejects values that are not rustup identifiers", () => {
    it("rejects a target carrying shell syntax", () => {
      expect(() =>
        mergeConfig({ targets: ["wasm32; id > /tmp/pwned"] }, {}),
      ).toThrow(/target/);
    });

    it("rejects a component carrying shell syntax", () => {
      expect(() => mergeConfig({}, { components: "clippy`id`" })).toThrow(
        /component/,
      );
    });

    it("rejects a profile carrying shell syntax", () => {
      expect(() => mergeConfig({}, { profile: "minimal && id" })).toThrow(
        /profile/,
      );
    });

    it("accepts ordinary triples, components and profiles", () => {
      const result = mergeConfig(
        { targets: ["wasm32-unknown-unknown"] },
        { components: "rust-analyzer,llvm-tools", profile: "minimal" },
      );
      expect(result.targets).toEqual(["wasm32-unknown-unknown"]);
      expect(result.components).toEqual(["rust-analyzer", "llvm-tools"]);
      expect(result.profile).toBe("minimal");
    });
  });
});

describe("resolveRustupEnv", () => {
  it("honours a caller-provided RUSTUP_HOME", () => {
    const result = resolveRustupEnv({
      HOME: "/home/runner",
      RUSTUP_HOME: "/opt/rustup",
    });
    expect(result.RUSTUP_HOME).toBe("/opt/rustup");
  });

  it("honours a caller-provided CARGO_HOME", () => {
    const result = resolveRustupEnv({
      HOME: "/home/runner",
      CARGO_HOME: "/opt/cargo",
    });
    expect(result.CARGO_HOME).toBe("/opt/cargo");
  });

  it("derives both homes from HOME when neither is set", () => {
    const result = resolveRustupEnv({ HOME: "/home/runner" });
    expect(result).toEqual({
      RUSTUP_HOME: "/home/runner/.rustup",
      CARGO_HOME: "/home/runner/.cargo",
    });
  });

  it("falls back to /root when HOME is absent", () => {
    const result = resolveRustupEnv({});
    expect(result).toEqual({
      RUSTUP_HOME: "/root/.rustup",
      CARGO_HOME: "/root/.cargo",
    });
  });

  it("treats blank overrides as unset", () => {
    const result = resolveRustupEnv({
      HOME: "/home/runner",
      RUSTUP_HOME: "",
      CARGO_HOME: "   ",
    });
    expect(result).toEqual({
      RUSTUP_HOME: "/home/runner/.rustup",
      CARGO_HOME: "/home/runner/.cargo",
    });
  });

  it("trims surrounding whitespace from overrides", () => {
    const result = resolveRustupEnv({ RUSTUP_HOME: "  /opt/rustup  " });
    expect(result.RUSTUP_HOME).toBe("/opt/rustup");
  });

  it("treats a blank HOME as absent", () => {
    const result = resolveRustupEnv({ HOME: "  " });
    expect(result.RUSTUP_HOME).toBe("/root/.rustup");
  });
});

// Windows has no $HOME; rustup and cargo live under the user profile there.
// `complete` pulls in miri and rustc-codegen-cranelift, which rustup publishes
// for nightly only — verified against a fresh container: beta lists neither.
// Installing it elsewhere fails after a download attempt, so reject it up front.
describe("assertProfileAvailable", () => {
  it.each([
    ["nightly"],
    ["nightly-2025-01-01"],
    ["nightly-2025-01-01-x86_64-unknown-linux-gnu"],
  ])("allows complete on %s", (channel) => {
    expect(() => assertProfileAvailable(channel, "complete")).not.toThrow();
  });

  it.each([["stable"], ["beta"], ["1.85.0"], ["1.97"]])(
    "rejects complete on %s",
    (channel) => {
      expect(() => assertProfileAvailable(channel, "complete")).toThrow(
        /nightly/,
      );
    },
  );

  it("names the components responsible", () => {
    expect(() => assertProfileAvailable("stable", "complete")).toThrow(/miri/);
  });

  it.each([["minimal"], ["default"]] as const)(
    "allows %s on any channel",
    (profile) => {
      expect(() => assertProfileAvailable("stable", profile)).not.toThrow();
    },
  );

  it("allows an unresolved profile", () => {
    expect(() => assertProfileAvailable("stable", undefined)).not.toThrow();
  });
});

describe("resolveRustupEnv on Windows", () => {
  it("derives both homes from USERPROFILE", () => {
    const result = resolveRustupEnv(
      { USERPROFILE: "C:\\Users\\runneradmin" },
      "win32",
    );
    expect(result).toEqual({
      RUSTUP_HOME: "C:\\Users\\runneradmin\\.rustup",
      CARGO_HOME: "C:\\Users\\runneradmin\\.cargo",
    });
  });

  it("still honours an explicit CARGO_HOME", () => {
    const result = resolveRustupEnv(
      { USERPROFILE: "C:\\Users\\runneradmin", CARGO_HOME: "D:\\cargo" },
      "win32",
    );
    expect(result.CARGO_HOME).toBe("D:\\cargo");
  });

  it("falls back to HOME when USERPROFILE is absent", () => {
    const result = resolveRustupEnv({ HOME: "C:\\Users\\other" }, "win32");
    expect(result.RUSTUP_HOME).toBe("C:\\Users\\other\\.rustup");
  });

  it("leaves POSIX platforms on HOME", () => {
    const result = resolveRustupEnv(
      { HOME: "/home/runner", USERPROFILE: "C:\\ignored" },
      "linux",
    );
    expect(result.RUSTUP_HOME).toBe("/home/runner/.rustup");
  });
});

describe("mergeConfig with a path toolchain", () => {
  it("rejects a path-only toml when no channel is available", () => {
    expect(() => mergeConfig({ path: "/opt/custom" }, {})).toThrow(/path/);
  });

  it("lets an input toolchain override a path toolchain", () => {
    const result = mergeConfig({ path: "/opt/custom" }, { toolchain: "beta" });
    expect(result.channel).toBe("beta");
  });

  it("prefers an explicit toml channel over path", () => {
    const result = mergeConfig({ path: "/opt/custom", channel: "nightly" }, {});
    expect(result.channel).toBe("nightly");
  });
});

describe("mergeConfig msrv fallback", () => {
  it("uses the fallback when neither input nor toml names a channel", () => {
    expect(mergeConfig({}, {}, "1.88").channel).toBe("1.88");
  });

  it("loses to the toml channel", () => {
    expect(mergeConfig({ channel: "1.97" }, {}, "1.88").channel).toBe("1.97");
  });

  it("loses to the toolchain input", () => {
    expect(mergeConfig({}, { toolchain: "nightly" }, "1.88").channel).toBe(
      "nightly",
    );
  });

  it("falls through to stable when no fallback is supplied", () => {
    expect(mergeConfig({}, {}).channel).toBe("stable");
  });
});
