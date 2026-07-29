// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { ToolchainSpec, ToolchainSpecBuilder } from "@/builder";

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
});

// Every rustup invocation is produced as an argv array and executed without a
// shell. A channel carrying shell metacharacters must therefore survive as one
// opaque argument rather than becoming a second command.
describe("argv generation", () => {
  it("builds install argv for a bare channel", () => {
    const spec = new ToolchainSpecBuilder().withChannel("nightly").build();
    expect(spec.toRustupInstallArgs()).toEqual([
      "toolchain",
      "install",
      "nightly",
      "--no-self-update",
    ]);
  });

  it("includes an explicitly requested profile in install argv", () => {
    const spec = new ToolchainSpecBuilder()
      .withChannel("stable")
      .withProfile("default")
      .build();
    expect(spec.toRustupInstallArgs()).toEqual([
      "toolchain",
      "install",
      "stable",
      "--profile",
      "default",
      "--no-self-update",
    ]);
  });

  it("omits --profile when none was requested", () => {
    const spec = new ToolchainSpecBuilder().withChannel("stable").build();
    expect(spec.toRustupInstallArgs()).not.toContain("--profile");
  });

  it("keeps a shell-metacharacter channel as a single argument", () => {
    const spec = new ToolchainSpec({
      channel: "stable; id > /tmp/pwned",
      targets: [],
      components: [],
    });
    expect(spec.toRustupInstallArgs()).toEqual([
      "toolchain",
      "install",
      "stable; id > /tmp/pwned",
      "--no-self-update",
    ]);
  });

  // One invocation, not one per target: rustup accepts several, and each extra
  // spawn is another process plus another network round trip.
  it("batches every target into one pinned target-add argv", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
      components: [],
    });
    expect(spec.toRustupTargetAddArgs()).toEqual([
      "target",
      "add",
      "--toolchain",
      "stable",
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
  });

  it("batches every component into one pinned component-add argv", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: ["clippy", "rustfmt"],
    });
    expect(spec.toRustupComponentAddArgs()).toEqual([
      "component",
      "add",
      "--toolchain",
      "stable",
      "clippy",
      "rustfmt",
    ]);
  });

  it("returns null when there is nothing to add", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
    });
    expect(spec.toRustupTargetAddArgs()).toBeNull();
    expect(spec.toRustupComponentAddArgs()).toBeNull();
  });

  it("builds default-toolchain argv", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: [],
    });
    expect(spec.toRustupDefaultArgs()).toEqual(["default", "nightly"]);
  });
});

// Parity with dtolnay/rust-toolchain's install flags.
describe("install flags", () => {
  it("never lets rustup update itself mid-install", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
    });
    expect(spec.toRustupInstallArgs()).toContain("--no-self-update");
  });

  it("passes targets and components on the install too", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: ["wasm32-unknown-unknown"],
      components: ["clippy"],
    });
    const args = spec.toRustupInstallArgs();
    expect(args).toContain("--target");
    expect(args).toContain("wasm32-unknown-unknown");
    expect(args).toContain("--component");
    expect(args).toContain("clippy");
  });

  // The newest nightly often lacks a component. Without --allow-downgrade
  // rustup refuses; with it, rustup picks the newest nightly that has them.
  it("allows a downgrade for nightly with components", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: ["rustfmt"],
    });
    expect(spec.toRustupInstallArgs()).toContain("--allow-downgrade");
  });

  it("does not allow a downgrade for nightly without components", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: [],
    });
    expect(spec.toRustupInstallArgs()).not.toContain("--allow-downgrade");
  });

  // `complete` asks for the widest component set, and the newest nightly often
  // lacks one of them — the same reason --allow-downgrade exists for explicitly
  // named components.
  it("allows a downgrade for nightly with the complete profile", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: [],
      profile: "complete",
    });
    expect(spec.toRustupInstallArgs()).toContain("--allow-downgrade");
  });

  it("does not allow a downgrade for nightly with the default profile", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: [],
      profile: "default",
    });
    expect(spec.toRustupInstallArgs()).not.toContain("--allow-downgrade");
  });

  it("does not allow a downgrade on a released channel", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: ["rustfmt"],
    });
    expect(spec.toRustupInstallArgs()).not.toContain("--allow-downgrade");
  });
});

// rustup ignores --profile when the toolchain is already installed, which is
// the normal case on hosted runners. Adding the profile's components explicitly
// is the only way to make the profile mean anything there.
describe("profile components", () => {
  it("adds nothing for minimal — its components are inherent to a toolchain", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
      profile: "minimal",
    });
    expect(spec.toRustupProfileComponentAddArgs()).toBeNull();
  });

  it("adds rust-docs, rustfmt and clippy for default", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
      profile: "default",
    });
    expect(spec.toRustupProfileComponentAddArgs()).toEqual([
      "component",
      "add",
      "--toolchain",
      "stable",
      "rust-docs",
      "rustfmt",
      "clippy",
    ]);
  });

  it("adds the wider set for complete", () => {
    const spec = new ToolchainSpec({
      channel: "nightly",
      targets: [],
      components: [],
      profile: "complete",
    });
    const args = spec.toRustupProfileComponentAddArgs();
    expect(args).toContain("rust-src");
    expect(args).toContain("rust-analyzer");
    expect(args).toContain("llvm-tools");
    expect(args).toContain("clippy");
  });

  // miri and rustc-codegen-cranelift are published for nightly only; naming
  // them explicitly would fail the add on every release channel.
  it("never names the nightly-only components", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
      profile: "complete",
    });
    const args = spec.toRustupProfileComponentAddArgs() ?? [];
    expect(args).not.toContain("miri");
    expect(args).not.toContain("rustc-codegen-cranelift");
  });

  it("does not repeat a component the user already requested", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: ["clippy"],
      profile: "default",
    });
    expect(spec.toRustupProfileComponentAddArgs()).toEqual([
      "component",
      "add",
      "--toolchain",
      "stable",
      "rust-docs",
      "rustfmt",
    ]);
  });

  it("adds nothing when no profile was resolved", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: [],
      components: [],
    });
    expect(spec.toRustupProfileComponentAddArgs()).toBeNull();
  });
});

describe("toRustupInstallCommand", () => {
  // Display only — derived from the argv so the two can never drift.
  it("renders the install argv as a readable command", () => {
    const spec = new ToolchainSpec({
      channel: "stable",
      targets: ["wasm32-unknown-unknown"],
      components: [],
      profile: "minimal",
    });
    expect(spec.toRustupInstallCommand()).toBe(
      "rustup toolchain install stable --profile minimal " +
        "--target wasm32-unknown-unknown --no-self-update",
    );
  });
});
