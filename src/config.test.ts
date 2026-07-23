import { describe, expect, it } from "bun:test";

import type { ToolchainInputs } from "./config";
import { mergeConfig, resolveRustupEnv } from "./config";

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

  it("merges targets from toml and inputs", () => {
    const toml = { targets: ["wasm32-unknown-unknown"] };
    const inputs: ToolchainInputs = { targets: "aarch64-apple-darwin" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual([
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
  });

  it("uses `target` as alias for targets input", () => {
    const toml = {};
    const inputs: ToolchainInputs = { target: "x86_64-pc-windows-gnu" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual(["x86_64-pc-windows-gnu"]);
  });

  it("merges components from toml and inputs", () => {
    const toml = { components: ["clippy"] };
    const inputs: ToolchainInputs = { components: "rustfmt" };
    const result = mergeConfig(toml, inputs);
    expect(result.components).toEqual(["clippy", "rustfmt"]);
  });

  it("input targets overrides toml targets when input is provided", () => {
    const toml = { targets: ["wasm32-unknown-unknown"] };
    const inputs: ToolchainInputs = { targets: "x86_64-unknown-linux-gnu" };
    const result = mergeConfig(toml, inputs);
    expect(result.targets).toEqual([
      "wasm32-unknown-unknown",
      "x86_64-unknown-linux-gnu",
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

  it("defaults profile to 'default' when neither toml nor input specifies", () => {
    const result = mergeConfig({}, {});
    expect(result.profile).toBe("default");
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
