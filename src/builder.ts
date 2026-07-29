// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  PROFILE_COMPONENTS,
  type ResolvedToolchain,
  type RustupProfile,
} from "@rust-toolchain/config";

export class ToolchainSpec {
  readonly channel: string;
  readonly targets: string[];
  readonly components: string[];
  readonly profile?: RustupProfile;

  constructor(args: ResolvedToolchain) {
    this.channel = args.channel;
    this.targets = args.targets.filter(Boolean);
    this.components = args.components.filter(Boolean);
    this.profile = args.profile;
  }

  /**
   * Argv for `rustup toolchain install`.
   *
   * Argv rather than a command string: these values originate in action inputs
   * and in a `rust-toolchain.toml` that may come from an untrusted checkout, so
   * they must reach rustup as opaque arguments and never as shell syntax.
   *
   * Targets and components are added afterwards rather than via
   * `--target`/`--component` here, because those flags are ignored when the
   * toolchain is already installed. Any requested profile is passed explicitly:
   * omitting `--profile` makes rustup fall back to the globally configured
   * profile (`rustup set profile`), so a requested "default" would silently
   * become "minimal" on a runner where that global was changed.
   */
  toRustupInstallArgs(): string[] {
    const args = ["toolchain", "install", this.channel];
    if (this.profile) {
      args.push("--profile", this.profile);
    }
    // Also requested on the install itself, not only through the `target add`
    // and `component add` below: on a fresh toolchain this is what lets
    // --allow-downgrade pick a nightly that actually carries them.
    for (const target of this.targets) {
      args.push("--target", target);
    }
    for (const component of this.components) {
      args.push("--component", component);
    }
    // The newest nightly frequently ships without rustfmt or clippy. Without
    // this rustup refuses the install outright; with it, it steps back to the
    // newest nightly that has every requested component. `complete` asks for
    // the widest set of all, so it needs the same latitude.
    const wantsEverything = this.profile === "complete";
    if (
      this.channel === "nightly" &&
      (this.components.length > 0 || wantsEverything)
    ) {
      args.push("--allow-downgrade");
    }
    // A rustup that updates itself mid-job changes the tool under the running
    // workflow and has raced with concurrent steps.
    args.push("--no-self-update");
    return args;
  }

  /**
   * Argv adding every requested target in one invocation, or `null` when none
   * were requested.
   *
   * `--toolchain` is pinned explicitly: without it rustup resolves the target
   * through its override chain, so a `rust-toolchain.toml` in the working
   * directory would attach targets to *that* toolchain instead of the one this
   * spec just installed.
   */
  toRustupTargetAddArgs(): string[] | null {
    if (this.targets.length === 0) return null;
    return ["target", "add", "--toolchain", this.channel, ...this.targets];
  }

  /** Argv adding every requested component in one invocation, or `null`. */
  toRustupComponentAddArgs(): string[] | null {
    if (this.components.length === 0) return null;
    return [
      "component",
      "add",
      "--toolchain",
      this.channel,
      ...this.components,
    ];
  }

  /**
   * Argv adding the components this spec's profile implies, or `null` when the
   * profile adds nothing beyond what was already requested.
   *
   * Separate from `toRustupComponentAddArgs` because the two carry different
   * weight: a component the caller named must install, whereas these are
   * best-effort — `--profile` is advisory once a toolchain exists, and a
   * channel that lacks one of them should not fail the build.
   */
  toRustupProfileComponentAddArgs(): string[] | null {
    if (!this.profile) return null;
    const implied = PROFILE_COMPONENTS[this.profile].filter(
      (component) => !this.components.includes(component),
    );
    if (implied.length === 0) return null;
    return ["component", "add", "--toolchain", this.channel, ...implied];
  }

  /** Argv for `rustup default <channel>`. */
  toRustupDefaultArgs(): string[] {
    return ["default", this.channel];
  }

  /** Human-readable rendering of the install command, for logs and docs. */
  toRustupInstallCommand(): string {
    return ["rustup", ...this.toRustupInstallArgs()].join(" ");
  }
}

export class ToolchainSpecBuilder {
  private channel: string;
  private targets: string[];
  private components: string[];
  private profile: RustupProfile | undefined;

  constructor() {
    this.channel = "stable";
    this.targets = [];
    this.components = [];
  }

  withChannel(channel: string): this {
    this.channel = channel;
    return this;
  }

  withTargets(...targets: string[]): this {
    this.targets = targets.filter(Boolean);
    return this;
  }

  withComponents(...components: string[]): this {
    this.components = components.filter(Boolean);
    return this;
  }

  withProfile(profile: RustupProfile): this {
    this.profile = profile;
    return this;
  }

  build(): ToolchainSpec {
    return new ToolchainSpec({
      channel: this.channel,
      targets: this.targets,
      components: this.components,
      profile: this.profile,
    });
  }
}
