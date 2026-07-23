import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exportVariable, getInput, setFailed, setOutput } from "@actions/core";

import { ToolchainSpecBuilder } from "./builder";
import { type ToolchainInputs, mergeConfig, resolveRustupEnv } from "./config";
import {
  parseRustToolchainToml,
  parseRustcVersion,
  resolveChannel,
} from "./core";

try {
  const workspace = process.env.GITHUB_WORKSPACE ?? ".";
  const tomlPath = join(workspace, "rust-toolchain.toml");

  let tomlConfig = {};
  try {
    const toml = readFileSync(tomlPath, "utf-8");
    tomlConfig = parseRustToolchainToml(toml);
  } catch {
    // No rust-toolchain.toml — use defaults and inputs only
  }

  const inputs: ToolchainInputs = {
    toolchain: getInput("toolchain") || undefined,
    targets: getInput("targets") || undefined,
    target: getInput("target") || undefined,
    components: getInput("components") || undefined,
    profile: getInput("profile") || undefined,
  };

  const resolved = mergeConfig(tomlConfig, inputs);
  resolved.channel = resolveChannel(resolved.channel);

  const spec = new ToolchainSpecBuilder()
    .withChannel(resolved.channel)
    .withTargets(...resolved.targets)
    .withComponents(...resolved.components)
    .withProfile(resolved.profile ?? "")
    .build();

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...resolveRustupEnv(process.env),
  };

  const installResult = spawnSync(spec.toRustupInstallCommand(), {
    shell: true,
    stdio: "inherit",
    env,
  });
  if (installResult.status !== 0) {
    setFailed(`rustup install failed with code ${installResult.status}`);
    process.exit(installResult.status ?? 1);
  }

  for (const cmd of spec.toRustupTargetAddCommands()) {
    const result = spawnSync(cmd, { shell: true, stdio: "inherit", env });
    if (result.status !== 0) {
      setFailed(`rustup target add failed for ${cmd}`);
      process.exit(result.status ?? 1);
    }
  }

  for (const cmd of spec.toRustupComponentAddCommands()) {
    const result = spawnSync(cmd, { shell: true, stdio: "inherit", env });
    if (result.status !== 0) {
      setFailed(`rustup component add failed for ${cmd}`);
      process.exit(result.status ?? 1);
    }
  }

  const setDefault = spawnSync(`rustup default ${spec.channel}`, {
    shell: true,
    stdio: "inherit",
    env,
  });
  if (setDefault.status !== 0) {
    setFailed(`rustup default failed with code ${setDefault.status}`);
    process.exit(setDefault.status ?? 1);
  }

  // Pin the toolchain for every later step. `RUSTUP_TOOLCHAIN` outranks a
  // `rust-toolchain.toml` in rustup's override chain, so this is what makes
  // "inputs override the toml" hold at *use* time and not merely at install
  // time. Exported after the install so it never names a missing toolchain.
  exportVariable("RUSTUP_TOOLCHAIN", spec.channel);
  env.RUSTUP_TOOLCHAIN = spec.channel;

  const name = spec.channel;

  let cachekey = "";
  try {
    // Reads through RUSTUP_TOOLCHAIN, so the cachekey describes the toolchain
    // that was requested rather than whatever the toml would have selected.
    const rustcOut = spawnSync("rustc", ["--version", "--verbose"], {
      encoding: "utf-8",
      env,
    });
    if (rustcOut.status === 0) {
      const info = parseRustcVersion(rustcOut.stdout);
      cachekey = info.cacheKey;
    }
  } catch {
    // cachekey stays empty string
  }

  setOutput("cachekey", cachekey);
  setOutput("name", name);
} catch (error) {
  setFailed(error instanceof Error ? error.message : String(error));
}
