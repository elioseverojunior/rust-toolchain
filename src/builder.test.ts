import { describe, expect, it } from "bun:test";

import { ToolchainSpec, ToolchainSpecBuilder } from "./builder";

describe("ToolchainSpecBuilder", () => {
  it("creates a builder", () => {
    const builder = new ToolchainSpecBuilder();
    expect(builder).toBeInstanceOf(ToolchainSpecBuilder);
  });

  it("builds with default channel", () => {
    const spec = new ToolchainSpecBuilder().build();
    expect(spec.channel).toBe("stable");
  });

  it("sets channel via builder", () => {
    const spec = new ToolchainSpecBuilder().withChannel("nightly").build();
    expect(spec.channel).toBe("nightly");
  });

  it("supports method chaining", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("stable")
      .withTargets("wasm32-unknown-unknown", "aarch64-apple-darwin")
      .withComponents("clippy", "rustfmt")
      .withProfile("minimal")
      .build();
    expect(spec.channel).toBe("stable");
    expect(spec.targets).toEqual([
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
    expect(spec.components).toEqual(["clippy", "rustfmt"]);
    expect(spec.profile).toBe("minimal");
  });

  it("builds rustup install args (without targets/components)", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("nightly")
      .withTargets("wasm32-unknown-unknown")
      .withComponents("clippy")
      .build();
    const args = spec.toRustupArgs();
    expect(args).toBe("nightly");
  });

  it("includes targets in target-add commands", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("nightly")
      .withTargets("wasm32-unknown-unknown")
      .withComponents("clippy")
      .build();
    const addCmds = spec.toRustupTargetAddCommands();
    expect(addCmds).toEqual([
      "rustup target add --toolchain nightly wasm32-unknown-unknown",
    ]);
  });

  it("includes components in component-add commands", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("nightly")
      .withTargets("wasm32-unknown-unknown")
      .withComponents("clippy")
      .build();
    const addCmds = spec.toRustupComponentAddCommands();
    expect(addCmds).toEqual([
      "rustup component add --toolchain nightly clippy",
    ]);
  });

  it("includes profile in rustup args when set to non-default", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("stable")
      .withProfile("minimal")
      .build();
    const args = spec.toRustupArgs();
    expect(args).toContain("--profile");
    expect(args).toContain("minimal");
  });

  // Omitting --profile makes rustup fall back to the globally configured
  // profile (`rustup set profile`), which may be "minimal". An explicitly
  // requested "default" must therefore be passed through.
  it("includes --profile when set to default", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("stable")
      .withProfile("default")
      .build();
    const args = spec.toRustupArgs();
    expect(args).toBe("stable --profile default");
  });

  it("omits --profile when no profile was requested", () => {
    const spec = new ToolchainSpecBuilder().withChannel("stable").build();
    expect(spec.toRustupArgs()).toBe("stable");
  });

  it("builds from partial input and toml", () => {
    const spec = ToolchainSpecBuilder.fromPartial({
      channel: "stable",
      targets: ["wasm32-unknown-unknown"],
      components: ["clippy"],
    });
    expect(spec.channel).toBe("stable");
    expect(spec.targets).toEqual(["wasm32-unknown-unknown"]);
    expect(spec.components).toEqual(["clippy"]);
  });

  it("toRustupInstallCommand returns bash command", () => {
    const spec = new ToolchainSpecBuilder().withChannel("stable").build();
    const cmd = spec.toRustupInstallCommand();
    expect(cmd).toContain("rustup toolchain install");
    expect(cmd).toContain("stable");
  });
});

describe("ToolchainSpec", () => {
  it("constructs directly", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: ["wasm32-unknown-unknown"],
      components: ["clippy"],
      profile: "default",
    });
    expect(spec.channel).toBe("nightly");
    expect(spec.targets).toEqual(["wasm32-unknown-unknown"]);
    expect(spec.components).toEqual(["clippy"]);
    expect(spec.profile).toBe("default");
  });

  it("handles empty targets and components", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
    });
    expect(spec.toRustupArgs()).toBe("stable");
  });

  it("toRustupInstallCommand builds correct command", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: ["wasm32-unknown-unknown"],
      components: [],
    });
    const cmd = spec.toRustupInstallCommand();
    expect(cmd).toBe("rustup toolchain install stable");
  });

  it("toRustupInstallCommand includes profile when not default", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
      profile: "minimal",
    });
    const cmd = spec.toRustupInstallCommand();
    expect(cmd).toBe("rustup toolchain install stable --profile minimal");
  });

  it("toRustupTargetAddCommands returns per-target commands", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
      components: [],
    });
    const cmds = spec.toRustupTargetAddCommands();
    expect(cmds).toEqual([
      "rustup target add --toolchain stable wasm32-unknown-unknown",
      "rustup target add --toolchain stable aarch64-apple-darwin",
    ]);
  });

  it("toRustupComponentAddCommands returns per-component commands", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: ["clippy", "rustfmt"],
    });
    const cmds = spec.toRustupComponentAddCommands();
    expect(cmds).toEqual([
      "rustup component add --toolchain stable clippy",
      "rustup component add --toolchain stable rustfmt",
    ]);
  });

  it("returns empty arrays when no targets or components", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
    });
    expect(spec.toRustupTargetAddCommands()).toEqual([]);
    expect(spec.toRustupComponentAddCommands()).toEqual([]);
  });
});
