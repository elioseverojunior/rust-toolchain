import type { ResolvedToolchain } from "./config";
import type { ToolchainTomlConfig } from "./core";

export class ToolchainSpec {
  readonly channel: string;
  readonly targets: string[];
  readonly components: string[];
  readonly profile?: string;

  constructor(args: ResolvedToolchain) {
    this.channel = args.channel;
    this.targets = args.targets.filter(Boolean);
    this.components = args.components.filter(Boolean);
    this.profile = args.profile;
  }

  toRustupArgs(): string {
    const parts: string[] = [this.channel];
    // Targets and components are added via separate rustup target add /
    // rustup component add commands (see toRustupTargetAddCommands /
    // toRustupComponentAddCommands) because --target/--component flags on
    // rustup toolchain install are ignored for already-installed toolchains.
    // Any requested profile is passed explicitly. Omitting --profile makes
    // rustup fall back to the globally configured profile (`rustup set
    // profile`), so a requested "default" would silently become "minimal" on a
    // runner where that global was changed.
    if (this.profile) {
      parts.push("--profile", this.profile);
    }
    return parts.join(" ");
  }

  toRustupInstallCommand(): string {
    return `rustup toolchain install ${this.toRustupArgs()}`;
  }

  // `--toolchain` is pinned explicitly: without it rustup resolves the target
  // through its override chain, so a `rust-toolchain.toml` in the working
  // directory would attach targets and components to *that* toolchain instead
  // of the one this spec just installed.
  toRustupTargetAddCommands(): string[] {
    return this.targets.map(
      (t) => `rustup target add --toolchain ${this.channel} ${t}`,
    );
  }

  toRustupComponentAddCommands(): string[] {
    return this.components.map(
      (c) => `rustup component add --toolchain ${this.channel} ${c}`,
    );
  }
}

export class ToolchainSpecBuilder {
  private channel: string;
  private targets: string[];
  private components: string[];
  private profile: string | undefined;

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

  withProfile(profile: string): this {
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

  static fromPartial(
    partial: ToolchainTomlConfig & { channel?: string },
  ): ToolchainSpec {
    return new ToolchainSpecBuilder()
      .withChannel(partial.channel ?? "stable")
      .withTargets(...(partial.targets ?? []))
      .withComponents(...(partial.components ?? []))
      .withProfile(partial.profile ?? "")
      .build();
  }
}
