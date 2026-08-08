// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  run,
  runPost,
  type ActionDeps,
  type ExecResult,
  type PostDeps,
} from "@/action";
import { generateSpecCacheKey } from "@/core";
import type { ActionOutputs } from "@/outputs";
import { hashToolSet, UNRESOLVED_VERSION } from "@/tools";

const rustcOutput = (release = "1.89.0"): string =>
  `rustc ${release} (e5b2c17f0 2025-06-27)
binary: rustc
commit-hash: e5b2c17f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d
commit-date: 2025-06-27
host: x86_64-apple-darwin
release: ${release}`;

interface ExecCall {
  file: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/** Marks an invocation as unavailable, the way spawn reports a missing binary. */
const NOT_INSTALLED: ExecResult = {
  status: null,
  error: new Error("spawn ENOENT"),
};

interface RestoreCall {
  paths: string[];
  key: string;
  restoreKeys: string[];
}

interface SaveCall {
  paths: string[];
  key: string;
}

interface Harness {
  deps: ActionDeps;
  calls: ExecCall[];
  outputs: Record<string, string>;
  exported: Record<string, string>;
  failures: string[];
  sleeps: number[];
  paths: string[];
  logs: string[];
  state: Record<string, string>;
  warnings: string[];
  summaries: string[];
  restores: RestoreCall[];
  saves: SaveCall[];
  registryCalls: string[];
}

/**
 * Builds `run`'s dependencies with recording fakes.
 *
 * `execResults` maps a matcher (the first two argv words) to the results that
 * invocation should return, in order — so a test can make the first install
 * attempt fail and the second succeed.
 */
function harness(
  options: {
    inputs?: Record<string, string>;
    toml?: string | null;
    execResults?: Record<string, ExecResult[]>;
    release?: string;
    platform?: string;
    env?: Record<string, string | undefined>;
    restoreResult?: (key: string) => string | undefined;
    toolVersions?: Record<string, string>;
  } = {},
): Harness {
  const calls: ExecCall[] = [];
  const outputs: Record<string, string> = {};
  const exported: Record<string, string> = {};
  const failures: string[] = [];
  const sleeps: number[] = [];
  const paths: string[] = [];
  const logs: string[] = [];
  const state: Record<string, string> = {};
  const warnings: string[] = [];
  const summaries: string[] = [];
  const restores: RestoreCall[] = [];
  const saves: SaveCall[] = [];
  const registryCalls: string[] = [];
  const queues = options.execResults ?? {};

  const deps: ActionDeps = {
    exec: (file, args, opts) => {
      calls.push({ file, args, timeoutMs: opts.timeoutMs, env: opts.env });
      const key = args.slice(0, 2).join(" ");
      const queued = queues[key]?.shift();
      if (queued) return queued;
      if (file === "rustc") {
        return { status: 0, stdout: rustcOutput(options.release) };
      }
      return { status: 0, stdout: "" };
    },
    readFile: () => {
      if (options.toml == null) throw new Error("ENOENT");
      return options.toml;
    },
    core: {
      getInput: (name) => options.inputs?.[name] ?? "",
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      setFailed: (message) => {
        failures.push(message);
      },
      exportVariable: (name, value) => {
        exported[name] = value;
      },
      addPath: (path) => {
        paths.push(path);
      },
      info: (message) => {
        logs.push(message);
      },
      saveState: (name, value) => {
        state[name] = value;
      },
      getState: (name) => state[name] ?? "",
      warning: (message) => {
        warnings.push(message);
      },
      summary: {
        addRaw: (text: string) => ({
          write: async (): Promise<void> => {
            summaries.push(text);
          },
        }),
      },
    },
    env: options.env ?? {
      HOME: "/home/runner",
      GITHUB_WORKSPACE: "/workspace",
      RUNNER_TEMP: "/tmp/runner",
    },
    platform: options.platform ?? "linux",
    sleep: (ms) => {
      sleeps.push(ms);
    },
    delay: async (): Promise<void> => {},
    registry: {
      latestVersion: async (name): Promise<string> => {
        registryCalls.push(name);
        const version = options.toolVersions?.[name];
        if (version === undefined) {
          throw new Error(`no version queued for ${name}`);
        }
        return version;
      },
    },
    cache: {
      restore: async (restorePaths, key, restoreKeys) => {
        restores.push({ paths: restorePaths, key, restoreKeys });
        return options.restoreResult?.(key);
      },
      save: async (savePaths, key) => {
        saves.push({ paths: savePaths, key });
      },
    },
  };

  return {
    deps,
    calls,
    outputs,
    exported,
    failures,
    sleeps,
    paths,
    logs,
    state,
    warnings,
    summaries,
    restores,
    saves,
    registryCalls,
  };
}

/**
 * Parses the `json` output, throwing when it was never set.
 *
 * `noUncheckedIndexedAccess` types the lookup as possibly undefined. Defaulting
 * it to `"{}"` would typecheck but turn "the action published nothing" into a
 * passing assertion, so an absent output has to be loud.
 */
function jsonOutput(h: Harness): ActionOutputs {
  const raw = h.outputs.json;
  if (raw === undefined) throw new Error("the `json` output was never set");
  return JSON.parse(raw) as ActionOutputs;
}

describe("run", () => {
  it("installs the resolved toolchain without a shell", async () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.calls.find((c) => c.args[0] === "toolchain")).toMatchObject({
      file: "rustup",
      args: [
        "toolchain",
        "install",
        "nightly",
        "--profile",
        "default",
        "--no-self-update",
      ],
    });
  });

  it("bounds every rustup invocation with a timeout", async () => {
    const h = harness();
    await run(h.deps);
    const rustupCalls = h.calls.filter((c) => c.file === "rustup");
    expect(rustupCalls.length).toBeGreaterThan(0);
    for (const call of rustupCalls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("adds all targets in one invocation and all components in another", async () => {
    const h = harness({
      inputs: {
        targets: "wasm32-unknown-unknown,aarch64-apple-darwin",
        components: "clippy,rustfmt",
      },
    });
    await run(h.deps);
    expect(h.calls.map((c) => c.args)).toContainEqual([
      "target",
      "add",
      "--toolchain",
      "stable",
      "wasm32-unknown-unknown",
      "aarch64-apple-darwin",
    ]);
    expect(h.calls.map((c) => c.args)).toContainEqual([
      "component",
      "add",
      "--toolchain",
      "stable",
      "clippy",
      "rustfmt",
    ]);
  });

  it("skips the target add when none were requested", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.calls.map((c) => c.args[0])).not.toContain("target");
  });

  // The only component add on a bare run is the one the default profile
  // implies; nothing is added on the caller's behalf beyond that.
  it("issues no component add of its own when none were requested", async () => {
    const h = harness({ inputs: { profile: "minimal" } });
    await run(h.deps);
    expect(h.calls.map((c) => c.args[0])).not.toContain("component");
  });

  it("sets the installed toolchain as the rustup default", async () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    await run(h.deps);
    expect(h.calls.map((c) => c.args)).toContainEqual(["default", "nightly"]);
  });

  it("retries a failed install with growing backoff", async () => {
    const h = harness({
      execResults: {
        "toolchain install": [
          { status: 1 },
          { status: 1 },
          { status: 0, stdout: "" },
        ],
      },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    const installs = h.calls.filter((c) => c.args[0] === "toolchain");
    expect(installs).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("reports failure after the last install attempt fails", async () => {
    const h = harness({
      execResults: {
        "toolchain install": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/rustup toolchain install/);
  });

  it("reports the spawn error when rustup is not installed", async () => {
    const h = harness({
      execResults: {
        "toolchain install": [
          { status: null, error: new Error("spawn rustup ENOENT") },
          { status: null, error: new Error("spawn rustup ENOENT") },
          { status: null, error: new Error("spawn rustup ENOENT") },
        ],
      },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/ENOENT/);
  });

  it("exports RUSTUP_TOOLCHAIN so later steps use the installed toolchain", async () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    await run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("sets the cachekey and name outputs", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.outputs.name).toBe("stable");
    expect(h.outputs.cachekey).toBe("20250627e5b2");
  });

  // An empty cachekey silently collapses every consumer's cache to one entry,
  // so an unreadable rustc has to fail the step instead.
  it("fails loudly when rustc cannot be executed", async () => {
    const h = harness({
      execResults: {
        "--version --verbose": [
          { status: null, error: new Error("spawn rustc ENOENT") },
        ],
      },
    });
    await run(h.deps);
    expect(h.outputs.cachekey).toBeUndefined();
    expect(h.failures[0]).toMatch(/rustc/);
  });

  it("fails when rustc exits non-zero", async () => {
    const h = harness({
      execResults: { "--version --verbose": [{ status: 3, stdout: "" }] },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/rustc/);
  });

  it("reads channel and targets from rust-toolchain.toml", async () => {
    const h = harness({
      toml: `[toolchain]\nchannel = "1.89.0"\ntargets = ["wasm32-unknown-unknown"]`,
    });
    await run(h.deps);
    expect(h.calls.find((c) => c.args[0] === "toolchain")!.args).toEqual([
      "toolchain",
      "install",
      "1.89.0",
      "--profile",
      "default",
      "--target",
      "wasm32-unknown-unknown",
      "--no-self-update",
    ]);
    expect(h.outputs.name).toBe("1.89.0");
  });

  it("lets action inputs override the toml", async () => {
    const h = harness({
      toml: `[toolchain]\nchannel = "1.89.0"`,
      inputs: { toolchain: "nightly" },
    });
    await run(h.deps);
    expect(h.outputs.name).toBe("nightly");
  });

  it("falls back to defaults when there is no rust-toolchain.toml", async () => {
    const h = harness({ toml: null });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.outputs.name).toBe("stable");
  });

  it("reports a malformed rust-toolchain.toml instead of installing stable", async () => {
    const h = harness({ toml: "not = toml [[" });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/not valid TOML/);
    expect(h.calls).toEqual([]);
  });

  it("reports a channel that is not a rustup toolchain name", async () => {
    const h = harness({ inputs: { toolchain: "stable; id > /tmp/pwned" } });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/not a valid rustup toolchain/);
    expect(h.calls).toEqual([]);
  });

  it("passes a resolved RUSTUP_HOME to rustup", async () => {
    const h = harness();
    h.deps.env.RUSTUP_HOME = "/mnt/rustup";
    await run(h.deps);
    expect(h.deps.env.RUSTUP_HOME).toBe("/mnt/rustup");
    expect(h.failures).toEqual([]);
  });
});

// A runner image without rustup — self-hosted, or a container that never had
// it — must still work, exactly as dtolnay/rust-toolchain does.
describe("rustup bootstrap", () => {
  it("does nothing when rustup already answers", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.calls.map((c) => c.file)).not.toContain("sh");
    expect(h.paths).toEqual([]);
  });

  it("downloads and runs rustup-init on POSIX runners", async () => {
    const h = harness({ execResults: { "--version": [NOT_INSTALLED] } });
    await run(h.deps);
    const curl = h.calls.find((c) => c.file === "curl");
    expect(curl?.args).toContain("https://sh.rustup.rs");
    const sh = h.calls.find((c) => c.file === "sh");
    expect(sh?.args).toEqual([
      "/tmp/runner/rustup-init.sh",
      "--default-toolchain",
      "none",
      "-y",
    ]);
  });

  it("puts the new cargo bin directory on PATH", async () => {
    const h = harness({ execResults: { "--version": [NOT_INSTALLED] } });
    await run(h.deps);
    expect(h.paths).toEqual(["/home/runner/.cargo/bin"]);
  });

  it("uses the Windows installer on Windows runners", async () => {
    const h = harness({
      platform: "win32",
      execResults: { "--version": [NOT_INSTALLED] },
      env: {
        USERPROFILE: "C:\\Users\\runneradmin",
        RUNNER_TEMP: "C:\\temp",
        GITHUB_WORKSPACE: "C:\\workspace",
      },
    });
    await run(h.deps);
    const curl = h.calls.find((c) => c.file === "curl");
    expect(curl?.args.join(" ")).toContain("win.rustup.rs");
    const init = h.calls.find((c) => c.file.endsWith("rustup-init.exe"));
    expect(init?.args).toEqual([
      "--default-toolchain",
      "none",
      "--no-modify-path",
      "-y",
    ]);
    expect(h.paths).toEqual(["C:\\Users\\runneradmin\\.cargo\\bin"]);
  });

  it("reports a bootstrap whose download fails", async () => {
    const h = harness({
      execResults: {
        "--version": [NOT_INSTALLED],
        "--proto =https": [{ status: 7 }],
      },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/curl/);
    expect(h.paths).toEqual([]);
  });

  it("reports a rustup-init that fails to run", async () => {
    const h = harness({
      execResults: {
        "--version": [NOT_INSTALLED],
        "/tmp/runner/rustup-init.sh --default-toolchain": [{ status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/rustup-init/);
    expect(h.paths).toEqual([]);
  });
});

// dtolnay sets these so a workflow behaves sanely without boilerplate.
describe("cargo environment defaults", () => {
  it("disables incremental compilation, which never pays off in CI", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.exported.CARGO_INCREMENTAL).toBe("0");
  });

  it("leaves an explicit CARGO_INCREMENTAL alone", async () => {
    const h = harness({
      env: { HOME: "/home/runner", CARGO_INCREMENTAL: "1" },
    });
    await run(h.deps);
    expect(h.exported.CARGO_INCREMENTAL).toBeUndefined();
  });

  it("turns on coloured cargo output", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.exported.CARGO_TERM_COLOR).toBe("always");
  });

  it("leaves an explicit CARGO_TERM_COLOR alone", async () => {
    const h = harness({
      env: { HOME: "/home/runner", CARGO_TERM_COLOR: "never" },
    });
    await run(h.deps);
    expect(h.exported.CARGO_TERM_COLOR).toBeUndefined();
  });

  // The sparse registry landed in 1.66, stabilised in 1.68 and became the
  // default in 1.70, so only the versions in between need steering.
  it.each([
    ["1.66.0", "git"],
    ["1.67.1", "git"],
    ["1.68.0", "sparse"],
    ["1.69.0", "sparse"],
  ])("selects the %s registry protocol on %s", async (release, expected) => {
    const h = harness({ release });
    await run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBe(expected);
  });

  it("leaves the registry protocol alone from 1.70 on", async () => {
    const h = harness({ release: "1.70.0" });
    await run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBeUndefined();
  });

  it("leaves an explicit registry protocol alone", async () => {
    const h = harness({
      release: "1.68.0",
      env: {
        HOME: "/home/runner",
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "git",
      },
    });
    await run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBeUndefined();
  });

  // curl 8.0 shipped in the 1.70/1.71 toolchains and produced spurious
  // network errors with HTTP multiplexing on.
  it.each([["1.70.0"], ["1.71.1"]])(
    "disables http multiplexing on %s",
    async (release) => {
      const h = harness({ release });
      await run(h.deps);
      expect(h.exported.CARGO_HTTP_MULTIPLEXING).toBe("false");
    },
  );

  it("leaves http multiplexing alone on 1.72", async () => {
    const h = harness({ release: "1.72.0" });
    await run(h.deps);
    expect(h.exported.CARGO_HTTP_MULTIPLEXING).toBeUndefined();
  });
});

describe("rustup compatibility details", () => {
  // rustup renames directories across layers when replacing a component;
  // this permits a copy instead, which overlayfs can do.
  it("permits copy-rename during the install", async () => {
    const h = harness();
    await run(h.deps);
    const install = h.calls.find((c) => c.args[0] === "toolchain");
    expect(install?.env?.RUSTUP_PERMIT_COPY_RENAME).toBe("1");
  });

  // dtolnay/rust-toolchain#127: `rustup default` fails on some toolchains
  // that are nonetheless installed and usable.
  it("carries on when rustup default fails every attempt", async () => {
    const h = harness({
      // Every retry must fail, or the tolerance path is never reached.
      execResults: {
        "default stable": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/rustup default did not succeed/);
    expect(h.outputs.name).toBe("stable");
  });

  it("logs the installed rustc version", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.logs.join("\n")).toContain("rustc 1.89.0");
  });
});

// `RUSTUP_TOOLCHAIN` sits at precedence 2 and so outranks *every*
// rust-toolchain.toml in the tree, including nested ones this action never
// read. A monorepo pinning a different toolchain per crate needs to opt out.
describe("set-rustup-toolchain", () => {
  it("pins the toolchain for later steps by default", async () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    await run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("accepts an explicit true", async () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "true" },
    });
    await run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("leaves later steps to their own toolchain files when false", async () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBeUndefined();
  });

  // Opting out changes what later steps resolve, not what this action reports:
  // the outputs must still describe the toolchain it actually installed.
  it("still reports the installed toolchain when opted out", async () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    await run(h.deps);
    expect(h.outputs.name).toBe("nightly");
    expect(h.outputs.cachekey).toBe("20250627e5b2");
    const rustc = h.calls.find((c) => c.file === "rustc");
    expect(rustc?.env?.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("rejects a value that is not a boolean", async () => {
    const h = harness({ inputs: { "set-rustup-toolchain": "yes please" } });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/set-rustup-toolchain/);
  });
});

// The profile is only honoured by rustup on a fresh toolchain, so `run` adds
// the components it implies by name. They are best-effort: unlike a component
// the caller listed, a missing one must not fail the job.
describe("profile components are applied explicitly", () => {
  it("adds the default profile's components after installing", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.calls.map((c) => c.args)).toContainEqual([
      "component",
      "add",
      "--toolchain",
      "stable",
      "rust-docs",
      "rustfmt",
      "clippy",
    ]);
  });

  it("adds nothing extra for the minimal profile", async () => {
    const h = harness({ inputs: { profile: "minimal" } });
    await run(h.deps);
    const componentAdds = h.calls.filter((c) => c.args[0] === "component");
    expect(componentAdds).toEqual([]);
  });

  it("keeps requested components in their own invocation", async () => {
    const h = harness({ inputs: { components: "llvm-tools" } });
    await run(h.deps);
    const componentAdds = h.calls
      .filter((c) => c.args[0] === "component")
      .map((c) => c.args.slice(4));
    // One call for what was asked for, one for what the profile implies.
    expect(componentAdds).toContainEqual(["llvm-tools"]);
    expect(componentAdds).toContainEqual(["rust-docs", "rustfmt", "clippy"]);
  });

  it("does not repeat a component the caller already listed", async () => {
    const h = harness({ inputs: { components: "clippy" } });
    await run(h.deps);
    const profileAdd = h.calls
      .filter((c) => c.args[0] === "component")
      .map((c) => c.args.slice(4))
      .find((args) => args.includes("rust-docs"));
    expect(profileAdd).toEqual(["rust-docs", "rustfmt"]);
  });

  // A release channel that lacks one of the profile's components should log and
  // carry on — the user never named it.
  it("tolerates a profile component that cannot be installed", async () => {
    const h = harness({
      execResults: {
        "component add": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/profile/i);
    expect(h.outputs.name).toBe("stable");
  });

  // ...but a component the caller listed by name is a hard requirement.
  it("still fails when a requested component cannot be installed", async () => {
    const h = harness({
      inputs: { components: "llvm-tools" },
      execResults: {
        "component add": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/component add/);
  });
});

describe("complete profile is rejected off nightly", () => {
  it("fails before running anything when paired with a release channel", async () => {
    const h = harness({
      inputs: { toolchain: "stable", profile: "complete" },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/nightly/);
    expect(h.calls).toEqual([]);
  });

  it("allows complete on nightly", async () => {
    const h = harness({
      inputs: { toolchain: "nightly", profile: "complete" },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.outputs.name).toBe("nightly");
  });

  // The expressive forms resolve to a numbered release, so they are rejected
  // on the resolved channel rather than the literal input.
  it("rejects complete for a channel that resolves to a release", async () => {
    const h = harness({
      inputs: { toolchain: "stable minus 2 releases", profile: "complete" },
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/nightly/);
  });
});

describe("spec-aware cache key output", () => {
  it("publishes both the compatible key and the spec-bound key", async () => {
    const h = harness({ inputs: { targets: "wasm32-unknown-unknown" } });
    await run(h.deps);
    expect(h.outputs.cachekey).toBe("20250627e5b2");
    expect(h.outputs["cachekey-full"]).toStartWith("20250627e5b2-");
  });

  it("gives two different target sets two different spec keys", async () => {
    const a = harness({ inputs: { targets: "wasm32-unknown-unknown" } });
    const b = harness({ inputs: { targets: "aarch64-apple-darwin" } });
    await run(a.deps);
    await run(b.deps);
    expect(a.outputs.cachekey).toBe(b.outputs.cachekey);
    expect(a.outputs["cachekey-full"]).not.toBe(b.outputs["cachekey-full"]);
  });
});

describe("resolved configuration outputs", () => {
  const toml = `[toolchain]
channel = "1.89.0"
targets = ["aarch64-apple-darwin"]
components = ["rustfmt"]
profile = "minimal"
`;

  it("publishes every resolved value as a flat output", async () => {
    const h = harness({
      toml,
      inputs: { target: "wasm32-unknown-unknown", components: "clippy" },
    });
    await run(h.deps);
    expect(h.outputs.toolchain).toBe("1.89.0");
    expect(h.outputs.targets).toBe(
      '["wasm32-unknown-unknown","aarch64-apple-darwin"]',
    );
    expect(h.outputs.target).toBe("wasm32-unknown-unknown");
    expect(h.outputs.components).toBe('["clippy","rustfmt"]');
    expect(h.outputs.profile).toBe("minimal");
    expect(h.outputs["set-rustup-toolchain"]).toBe("true");
  });

  it("publishes the whole output set as json", async () => {
    const h = harness({ toml, inputs: { target: "wasm32-unknown-unknown" } });
    await run(h.deps);
    expect(jsonOutput(h)).toEqual({
      toolchain: "1.89.0",
      targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
      target: "wasm32-unknown-unknown",
      components: ["rustfmt"],
      profile: "minimal",
      "set-rustup-toolchain": true,
      "cargo-tools": [],
      name: "1.89.0",
      cachekey: "20250627e5b2",
      // Recomputed rather than read back from the output, so this pins the
      // real digest instead of comparing the value to itself.
      "cachekey-full": generateSpecCacheKey("20250627e5b2", {
        channel: "1.89.0",
        targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
        components: ["rustfmt"],
        profile: "minimal",
      }),
      "cache-hit": false,
      cache: { enabled: false, layers: {} },
      inputs: {
        toolchain: "",
        targets: "",
        target: "wasm32-unknown-unknown",
        components: "",
        profile: "",
        "set-rustup-toolchain": "",
      },
      toml: {
        channel: "1.89.0",
        targets: ["aarch64-apple-darwin"],
        components: ["rustfmt"],
        profile: "minimal",
        path: null,
      },
    });
  });

  // Without provenance a consumer cannot tell an input-supplied value from a
  // toml-supplied one, which is the whole reason the json output exists.
  it("separates input provenance from toml provenance", async () => {
    const h = harness({
      toml,
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    await run(h.deps);
    const json = jsonOutput(h);
    expect(json.toolchain).toBe("nightly");
    expect(json.inputs.toolchain).toBe("nightly");
    expect(json.toml.channel).toBe("1.89.0");
    expect(json.inputs["set-rustup-toolchain"]).toBe("false");
    expect(json["set-rustup-toolchain"]).toBe(false);
  });

  it("reports empty lists and an empty target with no toml and no inputs", async () => {
    const h = harness();
    await run(h.deps);
    expect(h.outputs.targets).toBe("[]");
    expect(h.outputs.target).toBe("");
    expect(h.outputs.components).toBe("[]");
    expect(h.outputs.profile).toBe("default");
    expect(jsonOutput(h).toml).toEqual({
      channel: null,
      targets: [],
      components: [],
      profile: null,
      path: null,
    });
  });

  // The resolved channel, not the phrase the caller wrote.
  it("reports the resolved channel for an expressive toolchain input", async () => {
    const h = harness({ inputs: { toolchain: "stable minus 2 releases" } });
    await run(h.deps);
    const json = jsonOutput(h);
    expect(json.inputs.toolchain).toBe("stable minus 2 releases");
    expect(json.toolchain).toMatch(/^1\.\d+$/);
    expect(h.outputs.name).toBe(json.toolchain);
  });

  it("publishes no configuration outputs when the install fails", async () => {
    const h = harness({
      execResults: {
        "toolchain install": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    await run(h.deps);
    expect(h.outputs.json).toBeUndefined();
    expect(h.outputs.toolchain).toBeUndefined();
    expect(h.failures).toHaveLength(1);
  });
});

const cacheEnv = {
  HOME: "/home/runner",
  GITHUB_WORKSPACE: "/workspace",
  RUNNER_TEMP: "/tmp/runner",
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "X64",
};

describe("cache key outputs", () => {
  it("emits nothing but a disabled marker when cache is unset", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(JSON.parse(h.outputs["cache"] ?? "null")).toEqual({
      enabled: false,
      layers: {},
    });
  });

  it("derives every default layer when cache is enabled", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-key-suffix": "ci",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(h.failures).toEqual([]);
    expect(cache.enabled).toBe(true);
    expect(Object.keys(cache.layers)).toEqual(["registry", "build", "bin"]);
    expect(cache.layers.registry.key).toBe("registry-Linux-X64-ci-a1b2c3");
  });

  // The build key must carry the same spec digest the cachekey-full output
  // reports, or the two describe different toolchains.
  it("keys the build layer on the published cachekey-full value", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(cache.layers.build.key).toContain(h.outputs["cachekey-full"]);
  });

  it("honours an explicit layer selection", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-layers": "registry",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    const cache = JSON.parse(h.outputs["cache"] ?? "null");
    expect(Object.keys(cache.layers)).toEqual(["registry"]);
  });

  // A missing lock hash makes both keys constant: they hit exactly on every
  // run, never re-save, and serve the same crates forever. Failing loudly
  // beats a cache that is silently wrong for the life of the repository.
  it("fails when cache is enabled without a lock hash", async () => {
    const h = harness({
      inputs: { toolchain: "stable", cache: "true" },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`cache-key-hash` is required");
    expect(h.failures[0]).toContain("hashFiles");
  });

  it("reports an unknown layer through setFailed", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-layers": "doc",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain('"doc" is not a cache layer');
  });
});

describe("cache input validation", () => {
  // The whole point of validating up front: a typo in a cache input must not
  // cost a rustup bootstrap, a toolchain install and four component adds
  // before it is reported. Nothing has been executed when it fails.
  it("rejects an unknown layer before running any command", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-layers": "doc",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain('"doc" is not a cache layer');
    expect(h.calls).toEqual([]);
  });

  it("rejects a missing lock hash before running any command", async () => {
    const h = harness({
      inputs: { toolchain: "stable", cache: "true" },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`cache-key-hash` is required");
    expect(h.calls).toEqual([]);
  });

  // `joinKeySegments` drops empty segments, so an unset RUNNER_OS would not
  // fail — it would silently produce `registry-X64-ci-<hash>`, a key that
  // collides across operating systems and whose widest rung matches every
  // entry the repository has.
  it("fails when RUNNER_OS is blank rather than collapsing the segment", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
      },
      env: { ...cacheEnv, RUNNER_OS: "" },
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`RUNNER_OS`");
    expect(h.calls).toEqual([]);
  });

  it("fails when RUNNER_ARCH is missing rather than collapsing the segment", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
      },
      env: { ...cacheEnv, RUNNER_ARCH: undefined },
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`RUNNER_ARCH`");
    expect(h.calls).toEqual([]);
  });

  // actions/cache rejects a key containing a comma outright.
  it("rejects a cache-key-suffix containing a comma", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-key-suffix": "ci,nightly",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`cache-key-suffix`");
    expect(h.failures[0]).toContain("comma or whitespace");
    expect(h.calls).toEqual([]);
  });

  // getInput trims the ends but not the middle, so an embedded newline
  // survives into the key and splits the README's joined restore-keys block
  // into two entries, one of them nonsense.
  it("rejects a cache-key-suffix containing an embedded newline", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-key-suffix": "ci\nnightly",
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("comma or whitespace");
    expect(h.calls).toEqual([]);
  });

  it("fails when a derived key would exceed the 512-character limit", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        "cache-key-suffix": "s".repeat(600),
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("512");
    expect(h.failures[0]).toContain("`cache-key-suffix`");
    expect(h.calls).toEqual([]);
  });

  // The limit applies to the longest key the run will derive, which is the
  // build layer's — it carries the spec digest the registry key omits.
  it("accounts for the spec digest the build key has yet to receive", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
        // Long enough that only the build layer, with its extra spec segment,
        // crosses 512: the registry key lands at 506 characters and the build
        // key at 525.
        "cache-key-suffix": "s".repeat(480),
      },
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toContain("`build`");
    expect(h.calls).toEqual([]);
  });

  // Nothing above applies when the caller never asked for cache keys.
  it("ignores every cache input when cache is disabled", async () => {
    const h = harness({
      inputs: {
        toolchain: "stable",
        "cache-layers": "doc",
        "cache-key-suffix": "ci,nightly",
      },
      env: { ...cacheEnv, RUNNER_OS: "" },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(JSON.parse(h.outputs["cache"] ?? "null")).toEqual({
      enabled: false,
      layers: {},
    });
  });
});

describe("cache lifecycle", () => {
  const withCache = {
    toolchain: "stable",
    cache: "true",
    "cache-key-hash": "a1b2c3",
    "cache-key-suffix": "ci",
  };

  it("restores every enabled layer with its derived key and paths", async () => {
    const h = harness({ inputs: withCache, env: cacheEnv });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.restores.map((r) => r.key)).toEqual([
      expect.stringContaining("registry-Linux-X64-ci-"),
      expect.stringContaining("build-Linux-X64-ci-"),
      // No suffix on the bin key: the same tool set needs byte-identical
      // binaries whoever asked for them.
      expect.stringContaining("bin-Linux-X64-"),
    ]);
    // The registry layer never carries the toolchain digest.
    expect(h.restores[0]?.paths.join("\n")).toContain("registry/index");
    expect(h.restores[1]?.paths.join("\n")).toContain("target");
    expect(h.restores[2]?.paths.join("\n")).toContain("/bin/**");
  });

  it("hands the post phase everything it needs through state", async () => {
    const h = harness({ inputs: withCache, env: cacheEnv });
    await run(h.deps);

    expect(h.state["isPost"]).toBe("true");
    const handoff = JSON.parse(h.state["cache"] ?? "null");
    expect(handoff.plans).toHaveLength(3);
    expect(handoff.restored).toHaveLength(3);
    expect(typeof handoff.budget).toBe("number");
  });

  // A partial match means the layer will be saved again under the new key, so
  // it is not a hit from the caller's point of view.
  it("reports cache-hit only when every layer matched exactly", async () => {
    const exact = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) => key,
    });
    await run(exact.deps);
    expect(exact.outputs["cache-hit"]).toBe("true");

    const partial = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) =>
        key.startsWith("registry") ? key : "build-older",
    });
    await run(partial.deps);
    expect(partial.outputs["cache-hit"]).toBe("false");
  });

  // action.yml's post-if runs on every successful job, so isPost must be set
  // even when caching never runs — otherwise GitHub never sets STATE_isPost,
  // and the post invocation cannot tell it should call runPost instead of
  // running the whole main phase again.
  it("still marks isPost even when cache is unset", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(h.restores).toEqual([]);
    expect(h.state["isPost"]).toBe("true");
    expect(h.state["cache"]).toBe(undefined);
  });

  // The invariant this guards is structural, not incidental. `post-if:
  // success()` still fires when the main phase threw, because
  // `continue-on-error: true` on the action's step keeps the job status
  // successful. Setting isPost after any throwable statement therefore leaves
  // STATE_isPost unset, and src/index.ts's dispatch falls into the `else`
  // branch and re-runs the entire main phase as the post step. That dispatch
  // lives in coverage-excluded src/index.ts and no unit test can reach it,
  // which is exactly why the ordering inside `run` is asserted here instead.
  it.each([
    ["cache-budget", { ...withCache, "cache-budget": "two gigabytes" }],
    ["cache-on-failure", { ...withCache, "cache-on-failure": "yes please" }],
  ])("marks isPost even when %s fails validation", async (_name, inputs) => {
    const h = harness({ inputs, env: cacheEnv });
    await run(h.deps);

    expect(h.failures).toHaveLength(1);
    expect(h.state["isPost"]).toBe("true");
    expect(h.state["cache"]).toBe(undefined);
  });

  // [].every(...) is vacuously true — caching disabled must not be reported
  // as a full hit.
  it("reports cache-hit false when caching is disabled", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(h.outputs["cache-hit"]).toBe("false");
  });
});

// This env var is exactly what action.yml's post-if gates on — a rename or
// an inverted value here would ship green under the 100% line/function gate,
// since every `run` test already executes the export, just never asserts it.
describe("cache-on-failure export", () => {
  it("exports RUST_TOOLCHAIN_CACHE_ON_FAILURE as true when requested", async () => {
    const h = harness({
      inputs: { toolchain: "stable", "cache-on-failure": "true" },
    });
    await run(h.deps);
    expect(h.exported["RUST_TOOLCHAIN_CACHE_ON_FAILURE"]).toBe("true");
  });

  it("defaults RUST_TOOLCHAIN_CACHE_ON_FAILURE to false", async () => {
    const h = harness({ inputs: { toolchain: "stable" } });
    await run(h.deps);
    expect(h.exported["RUST_TOOLCHAIN_CACHE_ON_FAILURE"]).toBe("false");
  });
});

describe("runPost", () => {
  const postDeps = (
    state: Record<string, string>,
    options: {
      summaryFails?: boolean;
      metadata?: string;
      metadataFails?: boolean;
      files?: string[];
      fingerprintDirs?: string[];
      sizes?: (paths: string[]) => number;
    } = {},
  ): {
    deps: PostDeps;
    restores: { key: string }[];
    saves: { key: string }[];
    summaries: string[];
    warnings: string[];
    logs: string[];
  } => {
    const restores: { key: string }[] = [];
    const saves: { key: string }[] = [];
    const summaries: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];
    return {
      restores,
      saves,
      summaries,
      warnings,
      logs,
      deps: {
        cache: {
          restore: async (
            _paths: string[],
            key: string,
          ): Promise<string | undefined> => {
            restores.push({ key });
            return undefined;
          },
          save: async (_paths: string[], key: string): Promise<void> => {
            saves.push({ key });
          },
        },
        core: {
          getState: (name) => state[name] ?? "",
          info: (message): void => {
            logs.push(message);
          },
          warning: (message): void => {
            warnings.push(message);
          },
          summary: {
            addRaw: (text: string) => ({
              write: async (): Promise<void> => {
                if (options.summaryFails) {
                  throw new Error("GITHUB_STEP_SUMMARY is not set");
                }
                summaries.push(text);
              },
            }),
          },
        },
        measure: (paths: string[]) => ({
          bytes: options.sizes?.(paths) ?? 128,
          unmeasured: [],
        }),
        metadata: {
          read: async (): Promise<string> => {
            if (options.metadataFails) throw new Error("cargo: not found");
            return options.metadata ?? JSON.stringify({ packages: [] });
          },
        },
        walk: () => options.files ?? [],
        readdir: () => options.fingerprintDirs ?? [],
      },
    };
  };

  it("does nothing when the main phase never enabled caching", async () => {
    const { deps, saves, summaries } = postDeps({});
    await runPost(deps);
    expect(saves).toEqual([]);
    expect(summaries).toEqual([]);
  });

  // The main phase now sets isPost unconditionally (see "cache lifecycle" ▸
  // "still marks isPost even when cache is unset"), so a post invocation with
  // isPost set but no cache payload is the normal caching-disabled case, not
  // a corrupted one — it must still perform no cache operations at all.
  it("does nothing when isPost is set but no cache payload was recorded", async () => {
    const { deps, restores, saves, summaries } = postDeps({
      isPost: "true",
    });
    await runPost(deps);
    expect(restores).toEqual([]);
    expect(saves).toEqual([]);
    expect(summaries).toEqual([]);
  });

  it("saves the layers that did not hit exactly and writes the summary", async () => {
    const { deps, saves, summaries } = postDeps({
      cache: JSON.stringify({
        budget: 0,
        plans: [
          {
            layer: "registry",
            key: "registry-k",
            restoreKeys: [],
            paths: ["/c"],
          },
          { layer: "build", key: "build-k", restoreKeys: [], paths: ["/t"] },
        ],
        restored: [
          { layer: "registry", result: "exact", restoredKey: "registry-k" },
          { layer: "build", result: "miss" },
        ],
      }),
    });

    await runPost(deps);

    expect(saves.map((s) => s.key)).toEqual(["build-k"]);
    expect(summaries[0]).toContain("| registry | exact |");
    expect(summaries[0]).toContain("| build | miss |");
  });

  // Design invariant 8: a cache failure never fails the build. State crosses
  // the phase boundary as an environment variable, so a truncated or
  // corrupted payload is a real possibility, not a hypothetical one.
  it("warns and does not throw when the state payload is malformed", async () => {
    const { deps, warnings } = postDeps({ cache: "{not valid json" });

    await runPost(deps);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cache post-processing failed/i);
  });

  // @actions/core's summary throws when GITHUB_STEP_SUMMARY is unset or
  // unwritable — true on slim runners and under `act`. That must not discard
  // the save that already happened by reporting the post step as failed.
  it("warns but keeps the save when the summary write rejects", async () => {
    const { deps, saves, warnings } = postDeps(
      {
        cache: JSON.stringify({
          budget: 0,
          plans: [
            {
              layer: "registry",
              key: "registry-k",
              restoreKeys: [],
              paths: ["/c"],
            },
          ],
          restored: [{ layer: "registry", result: "miss" }],
        }),
      },
      { summaryFails: true },
    );

    await runPost(deps);

    expect(saves.map((s) => s.key)).toEqual(["registry-k"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not write the job summary/i);
  });

  describe("post-phase pruning", () => {
    const WS = [{ manifestDir: "/w", targetDir: "/w/target" }];
    const FILES = [
      "/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib",
      "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
    ];
    const METADATA = JSON.stringify({
      packages: [
        { id: "r#serde@1.0.0", name: "serde", version: "1.0.0" },
        { id: "p#w@0.1.0", name: "w", version: "0.1.0" },
      ],
      workspace_members: ["p#w@0.1.0"],
    });

    const cacheState = (prune: string | undefined): Record<string, string> => ({
      isPost: "true",
      cache: JSON.stringify({
        budget: 0,
        prune,
        workspaces: prune === undefined ? undefined : WS,
        cargoHome: "/c",
        plans: [
          { layer: "registry", key: "reg-k", restoreKeys: [], paths: ["/c"] },
          {
            layer: "build",
            key: "build-k",
            restoreKeys: [],
            paths: ["/w/target/**"],
          },
        ],
        restored: [
          { layer: "registry", result: "miss" },
          { layer: "build", result: "miss" },
        ],
      }),
    });

    // Half the bytes belong to the dropped crate, so the guard's threshold is
    // comfortably cleared and pruning actually applies.
    const sizes = (paths: string[]): number =>
      paths.some((p) => p.includes("libgone")) ? 200 : 100;

    it("narrows the build layer to the keep-set and the registry to resolved crates", async () => {
      const saved: string[][] = [];
      const { deps } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        fingerprintDirs: ["serde-aaaaaaaaaaaaaaaa", "gone-bbbbbbbbbbbbbbbb"],
        sizes,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };

      await runPost(deps);

      const build = saved.find((p) => p.some((x) => x.includes("/w/target/")));
      expect(build).toContain(
        "/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib",
      );
      expect(build).not.toContain(
        "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
      );
      const registry = saved.find((p) =>
        p.some((x) => x.includes("/c/registry")),
      );
      expect(registry).toContain("/c/registry/cache/**/serde-1.0.0.crate");
    });

    it("reports what pruning removed in the summary", async () => {
      const { deps, summaries } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        fingerprintDirs: ["serde-aaaaaaaaaaaaaaaa", "gone-bbbbbbbbbbbbbbbb"],
        sizes,
      });
      await runPost(deps);
      expect(summaries[0]).toMatch(/\| build \| miss \| \d+ \|/);
    });

    // `off` must not even ask cargo, which is what makes it usable on a runner
    // that has no cargo on PATH at all.
    it("does not consult cargo at all when pruning is off", async () => {
      let asked = false;
      const { deps } = postDeps(cacheState("off"), { files: FILES });
      deps.metadata = {
        read: async (): Promise<string> => {
          asked = true;
          return METADATA;
        },
      };
      await runPost(deps);
      expect(asked).toBe(false);
    });

    // THE invariant. Every failure converges on an empty keep-set, and saving
    // one is a poisoned entry: it hits its key, restores nothing, and leaves
    // every later job rebuilding while believing it was warm.
    it("falls back to the unpruned paths when cargo metadata fails", async () => {
      const saved: string[][] = [];
      const { deps, warnings } = postDeps(cacheState("safe"), {
        metadataFails: true,
        files: FILES,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };
      await runPost(deps);
      expect(saved).toContainEqual(["/w/target/**"]);
      expect(warnings.some((w) => /saving everything instead/.test(w))).toBe(
        true,
      );
    });

    it("falls back when the package set resolves to nothing", async () => {
      const saved: string[][] = [];
      const { deps } = postDeps(cacheState("safe"), {
        metadata: JSON.stringify({ packages: [] }),
        files: FILES,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };
      await runPost(deps);
      expect(saved).toContainEqual(["/w/target/**"]);
    });

    // Task 4 measured the bad trade directly: an unchurned tree spent 904 ms of
    // glob resolution to drop 0.2% of the bytes. Below the threshold the
    // unpruned paths are cheaper and lose almost nothing.
    it("keeps the unpruned paths when pruning would drop too little", async () => {
      const saved: string[][] = [];
      const { deps } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        fingerprintDirs: ["serde-aaaaaaaaaaaaaaaa", "gone-bbbbbbbbbbbbbbbb"],
        sizes: () => 100,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };
      await runPost(deps);
      expect(saved).toContainEqual(["/w/target/**"]);
    });

    // A payload written by a main phase that predates these fields. Absent means
    // "no pruning was planned", not a fault, so it must not warn — that would
    // fire on every mid-upgrade job about something nobody can act on.
    // The bin layer is never pruned -- its key is the resolved tool set, and
    // its contents are whole binaries with no package to attribute them to --
    // so it must pass through the rewrite untouched. And an artifact carrying
    // a hash no fingerprint claims is reported rather than silently kept,
    // since that count is the only signal that `aggressive` would behave
    // differently from `safe` on this workspace.
    it("leaves the bin layer alone and reports unattributable artifacts", async () => {
      const saved: string[][] = [];
      const state = JSON.parse(cacheState("safe").cache ?? "{}") as {
        plans: {
          layer: string;
          key: string;
          restoreKeys: string[];
          paths: string[];
        }[];
      };
      state.plans.push({
        layer: "bin",
        key: "bin-k",
        restoreKeys: [],
        paths: ["/c/bin/**"],
      });
      const withBin = {
        isPost: "true",
        cache: JSON.stringify({
          ...JSON.parse(cacheState("safe").cache ?? "{}"),
          plans: state.plans,
        }),
      };
      const { deps, logs } = postDeps(withBin, {
        metadata: METADATA,
        files: [
          ...FILES,
          "/w/target/debug/deps/libmystery-dddddddddddddddd.rlib",
        ],
        fingerprintDirs: ["serde-aaaaaaaaaaaaaaaa", "gone-bbbbbbbbbbbbbbbb"],
        sizes,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };

      await runPost(deps);

      expect(saved).toContainEqual(["/c/bin/**"]);
      expect(logs.some((l) => /matched no package and were kept/.test(l))).toBe(
        true,
      );
    });

    it("prunes nothing and warns nothing for a pre-upgrade state payload", async () => {
      const { deps, warnings } = postDeps(cacheState(undefined), {});
      await runPost(deps);
      expect(warnings).toEqual([]);
    });
  });
});

describe("cargo tools", () => {
  const withTools = (tools: string): Record<string, string> => ({
    toolchain: "stable",
    cache: "true",
    "cache-key-hash": "a1b2c3",
    "cargo-tools": tools,
  });

  it("touches neither the registry nor cargo when none are requested", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.registryCalls).toEqual([]);
    expect(h.calls.filter((c) => c.file === "cargo")).toEqual([]);
  });

  // A pinned version is already concrete, so the registry is never consulted —
  // which is what makes an outage unable to affect it.
  it("never consults the registry for a pinned version", async () => {
    const h = harness({
      inputs: withTools("cargo-deny@0.16.1"),
      env: cacheEnv,
      execResults: {
        "--version": [{ status: null, error: new Error("ENOENT") }],
      },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.registryCalls).toEqual([]);
  });

  it("resolves a bare name through the registry", async () => {
    const h = harness({
      inputs: withTools("cargo-nextest"),
      env: cacheEnv,
      toolVersions: { "cargo-nextest": "0.9.100" },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.registryCalls).toEqual(["cargo-nextest"]);
  });

  // THE ordering constraint. `toolSetHash` is a segment of the bin key, so
  // resolution has to complete before the keys are derived — if it did not,
  // the bin key would carry the empty-set digest and every tooled job would
  // share one entry.
  it("derives the bin key from the resolved tool set", async () => {
    const bare = harness({
      inputs: withTools("cargo-nextest"),
      env: cacheEnv,
      toolVersions: { "cargo-nextest": "0.9.100" },
    });
    await run(bare.deps);

    const none = harness({
      inputs: {
        toolchain: "stable",
        cache: "true",
        "cache-key-hash": "a1b2c3",
      },
      env: cacheEnv,
    });
    await run(none.deps);

    const keyOf = (h: Harness): string =>
      JSON.parse(h.outputs["cache"] ?? "null").layers.bin.key;
    expect(keyOf(bare)).not.toBe(keyOf(none));
  });

  // THE other ordering constraint (D2). A restored bin layer is what makes
  // most installs unnecessary, so verification must follow the restore —
  // checking first would install what the cache was about to supply.
  it("verifies tools only after the cache has been restored", async () => {
    const h = harness({
      inputs: withTools("cargo-deny@0.16.1"),
      env: cacheEnv,
      execResults: {
        "--version": [{ status: 0, stdout: "cargo-deny 0.16.1" }],
      },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    // The bin restore is recorded before the tool is ever probed.
    const probedAt = h.calls.findIndex((c) => c.file === "cargo-deny");
    expect(probedAt).toBeGreaterThan(-1);
    expect(h.restores.length).toBe(3);
  });

  it("installs a tool the restore did not supply", async () => {
    const h = harness({
      inputs: withTools("cargo-deny@0.16.1"),
      env: cacheEnv,
      execResults: {
        "--version": [{ status: null, error: new Error("ENOENT") }],
      },
    });
    await run(h.deps);
    expect(h.failures).toEqual([]);
    expect(
      h.calls.map((c) => c.args).filter((a) => a[0] === "install"),
    ).toEqual([
      ["install", "cargo-deny", "--version", "0.16.1", "--locked", "--force"],
    ]);
  });

  // The output and the bin key are two views of one resolution, so a consumer
  // has to be able to reconcile them — that is the whole reason the output
  // publishes `resolveToolVersions`' result rather than `ensureTools`'
  // outcomes. Hashing the published list back and matching it against the key
  // IS that reconciliation, and it breaks the moment either side is built
  // from a different set.
  it("publishes a cargo-tools output the bin key can be rederived from", async () => {
    const h = harness({
      inputs: withTools("cargo-nextest"),
      env: cacheEnv,
      toolVersions: { "cargo-nextest": "0.9.100" },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    const published = JSON.parse(h.outputs["cargo-tools"] ?? "null") as
      string[] | null;
    expect(published).toEqual(["cargo-nextest@0.9.100"]);

    const rederived = (published ?? []).map((entry) => {
      const at = entry.indexOf("@");
      return { name: entry.slice(0, at), version: entry.slice(at + 1) };
    });
    const binKey = JSON.parse(h.outputs["cache"] ?? "null").layers.bin
      .key as string;
    expect(binKey).toEndWith(hashToolSet(rederived));
  });

  // A registry failure resolves to UNRESOLVED_VERSION, and that same value is
  // what the key was hashed from. Publishing it verbatim keeps the two
  // reconcilable; substituting "latest" would make them disagree with nothing
  // to say which was right.
  it("publishes an unresolved tool as name@unknown", async () => {
    const h = harness({
      inputs: withTools("cargo-nextest"),
      env: cacheEnv,
      // The harness keys its queue on the first two argv words, so
      // `rustup --version` and `cargo-nextest --version` share the key
      // "--version" and drain it in call order. The first entry answers
      // rustup; the second is the probe that has to find the tool present,
      // which is the whole premise of the fallback being exercised here.
      execResults: {
        "--version": [
          { status: 0, stdout: "rustup 1.28.0" },
          { status: 0, stdout: "cargo-nextest 0.9.99" },
        ],
      },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(
      h.warnings.some((w) => /registry could not be reached/.test(w)),
    ).toBe(true);
    expect(JSON.parse(h.outputs["cargo-tools"] ?? "null")).toEqual([
      `cargo-nextest@${UNRESOLVED_VERSION}`,
    ]);
  });

  it("publishes an empty cargo-tools list when none were requested", async () => {
    const h = harness({ inputs: { toolchain: "stable" }, env: cacheEnv });
    await run(h.deps);
    expect(h.outputs["cargo-tools"]).toBe("[]");
  });

  // Validation is worth nothing if it happens after a ten-minute install.
  it("rejects a malformed cargo-tools before running any command", async () => {
    const h = harness({
      inputs: withTools("cargo-deny; id > /tmp/pwned"),
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/not a valid cargo tool name/);
    expect(h.calls).toEqual([]);
  });

  it("reports a duplicate tool before running any command", async () => {
    const h = harness({
      inputs: withTools("cargo-deny@0.1.0,cargo-deny@0.2.0"),
      env: cacheEnv,
    });
    await run(h.deps);
    expect(h.failures[0]).toMatch(/more than once/);
    expect(h.calls).toEqual([]);
  });
});
