// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import { run, type ActionDeps, type ExecResult } from "@/action";
import { generateSpecCacheKey } from "@/core";
import type { ActionOutputs } from "@/outputs";

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

interface Harness {
  deps: ActionDeps;
  calls: ExecCall[];
  outputs: Record<string, string>;
  exported: Record<string, string>;
  failures: string[];
  sleeps: number[];
  paths: string[];
  logs: string[];
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
  } = {},
): Harness {
  const calls: ExecCall[] = [];
  const outputs: Record<string, string> = {};
  const exported: Record<string, string> = {};
  const failures: string[] = [];
  const sleeps: number[] = [];
  const paths: string[] = [];
  const logs: string[] = [];
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
  };

  return { deps, calls, outputs, exported, failures, sleeps, paths, logs };
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
  it("installs the resolved toolchain without a shell", () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    run(h.deps);
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

  it("bounds every rustup invocation with a timeout", () => {
    const h = harness();
    run(h.deps);
    const rustupCalls = h.calls.filter((c) => c.file === "rustup");
    expect(rustupCalls.length).toBeGreaterThan(0);
    for (const call of rustupCalls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("adds all targets in one invocation and all components in another", () => {
    const h = harness({
      inputs: {
        targets: "wasm32-unknown-unknown,aarch64-apple-darwin",
        components: "clippy,rustfmt",
      },
    });
    run(h.deps);
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

  it("skips the target add when none were requested", () => {
    const h = harness();
    run(h.deps);
    expect(h.calls.map((c) => c.args[0])).not.toContain("target");
  });

  // The only component add on a bare run is the one the default profile
  // implies; nothing is added on the caller's behalf beyond that.
  it("issues no component add of its own when none were requested", () => {
    const h = harness({ inputs: { profile: "minimal" } });
    run(h.deps);
    expect(h.calls.map((c) => c.args[0])).not.toContain("component");
  });

  it("sets the installed toolchain as the rustup default", () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    run(h.deps);
    expect(h.calls.map((c) => c.args)).toContainEqual(["default", "nightly"]);
  });

  it("retries a failed install with growing backoff", () => {
    const h = harness({
      execResults: {
        "toolchain install": [
          { status: 1 },
          { status: 1 },
          { status: 0, stdout: "" },
        ],
      },
    });
    run(h.deps);
    expect(h.failures).toEqual([]);
    const installs = h.calls.filter((c) => c.args[0] === "toolchain");
    expect(installs).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("reports failure after the last install attempt fails", () => {
    const h = harness({
      execResults: {
        "toolchain install": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    run(h.deps);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/rustup toolchain install/);
  });

  it("reports the spawn error when rustup is not installed", () => {
    const h = harness({
      execResults: {
        "toolchain install": [
          { status: null, error: new Error("spawn rustup ENOENT") },
          { status: null, error: new Error("spawn rustup ENOENT") },
          { status: null, error: new Error("spawn rustup ENOENT") },
        ],
      },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/ENOENT/);
  });

  it("exports RUSTUP_TOOLCHAIN so later steps use the installed toolchain", () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("sets the cachekey and name outputs", () => {
    const h = harness();
    run(h.deps);
    expect(h.outputs.name).toBe("stable");
    expect(h.outputs.cachekey).toBe("20250627e5b2");
  });

  // An empty cachekey silently collapses every consumer's cache to one entry,
  // so an unreadable rustc has to fail the step instead.
  it("fails loudly when rustc cannot be executed", () => {
    const h = harness({
      execResults: {
        "--version --verbose": [
          { status: null, error: new Error("spawn rustc ENOENT") },
        ],
      },
    });
    run(h.deps);
    expect(h.outputs.cachekey).toBeUndefined();
    expect(h.failures[0]).toMatch(/rustc/);
  });

  it("fails when rustc exits non-zero", () => {
    const h = harness({
      execResults: { "--version --verbose": [{ status: 3, stdout: "" }] },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/rustc/);
  });

  it("reads channel and targets from rust-toolchain.toml", () => {
    const h = harness({
      toml: `[toolchain]\nchannel = "1.89.0"\ntargets = ["wasm32-unknown-unknown"]`,
    });
    run(h.deps);
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

  it("lets action inputs override the toml", () => {
    const h = harness({
      toml: `[toolchain]\nchannel = "1.89.0"`,
      inputs: { toolchain: "nightly" },
    });
    run(h.deps);
    expect(h.outputs.name).toBe("nightly");
  });

  it("falls back to defaults when there is no rust-toolchain.toml", () => {
    const h = harness({ toml: null });
    run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.outputs.name).toBe("stable");
  });

  it("reports a malformed rust-toolchain.toml instead of installing stable", () => {
    const h = harness({ toml: "not = toml [[" });
    run(h.deps);
    expect(h.failures[0]).toMatch(/not valid TOML/);
    expect(h.calls).toEqual([]);
  });

  it("reports a channel that is not a rustup toolchain name", () => {
    const h = harness({ inputs: { toolchain: "stable; id > /tmp/pwned" } });
    run(h.deps);
    expect(h.failures[0]).toMatch(/not a valid rustup toolchain/);
    expect(h.calls).toEqual([]);
  });

  it("passes a resolved RUSTUP_HOME to rustup", () => {
    const h = harness();
    h.deps.env.RUSTUP_HOME = "/mnt/rustup";
    run(h.deps);
    expect(h.deps.env.RUSTUP_HOME).toBe("/mnt/rustup");
    expect(h.failures).toEqual([]);
  });
});

// A runner image without rustup — self-hosted, or a container that never had
// it — must still work, exactly as dtolnay/rust-toolchain does.
describe("rustup bootstrap", () => {
  it("does nothing when rustup already answers", () => {
    const h = harness();
    run(h.deps);
    expect(h.calls.map((c) => c.file)).not.toContain("sh");
    expect(h.paths).toEqual([]);
  });

  it("downloads and runs rustup-init on POSIX runners", () => {
    const h = harness({ execResults: { "--version": [NOT_INSTALLED] } });
    run(h.deps);
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

  it("puts the new cargo bin directory on PATH", () => {
    const h = harness({ execResults: { "--version": [NOT_INSTALLED] } });
    run(h.deps);
    expect(h.paths).toEqual(["/home/runner/.cargo/bin"]);
  });

  it("uses the Windows installer on Windows runners", () => {
    const h = harness({
      platform: "win32",
      execResults: { "--version": [NOT_INSTALLED] },
      env: {
        USERPROFILE: "C:\\Users\\runneradmin",
        RUNNER_TEMP: "C:\\temp",
        GITHUB_WORKSPACE: "C:\\workspace",
      },
    });
    run(h.deps);
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

  it("reports a bootstrap whose download fails", () => {
    const h = harness({
      execResults: {
        "--version": [NOT_INSTALLED],
        "--proto =https": [{ status: 7 }],
      },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/curl/);
    expect(h.paths).toEqual([]);
  });

  it("reports a rustup-init that fails to run", () => {
    const h = harness({
      execResults: {
        "--version": [NOT_INSTALLED],
        "/tmp/runner/rustup-init.sh --default-toolchain": [{ status: 1 }],
      },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/rustup-init/);
    expect(h.paths).toEqual([]);
  });
});

// dtolnay sets these so a workflow behaves sanely without boilerplate.
describe("cargo environment defaults", () => {
  it("disables incremental compilation, which never pays off in CI", () => {
    const h = harness();
    run(h.deps);
    expect(h.exported.CARGO_INCREMENTAL).toBe("0");
  });

  it("leaves an explicit CARGO_INCREMENTAL alone", () => {
    const h = harness({
      env: { HOME: "/home/runner", CARGO_INCREMENTAL: "1" },
    });
    run(h.deps);
    expect(h.exported.CARGO_INCREMENTAL).toBeUndefined();
  });

  it("turns on coloured cargo output", () => {
    const h = harness();
    run(h.deps);
    expect(h.exported.CARGO_TERM_COLOR).toBe("always");
  });

  it("leaves an explicit CARGO_TERM_COLOR alone", () => {
    const h = harness({
      env: { HOME: "/home/runner", CARGO_TERM_COLOR: "never" },
    });
    run(h.deps);
    expect(h.exported.CARGO_TERM_COLOR).toBeUndefined();
  });

  // The sparse registry landed in 1.66, stabilised in 1.68 and became the
  // default in 1.70, so only the versions in between need steering.
  it.each([
    ["1.66.0", "git"],
    ["1.67.1", "git"],
    ["1.68.0", "sparse"],
    ["1.69.0", "sparse"],
  ])("selects the %s registry protocol on %s", (release, expected) => {
    const h = harness({ release });
    run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBe(expected);
  });

  it("leaves the registry protocol alone from 1.70 on", () => {
    const h = harness({ release: "1.70.0" });
    run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBeUndefined();
  });

  it("leaves an explicit registry protocol alone", () => {
    const h = harness({
      release: "1.68.0",
      env: {
        HOME: "/home/runner",
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "git",
      },
    });
    run(h.deps);
    expect(h.exported.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBeUndefined();
  });

  // curl 8.0 shipped in the 1.70/1.71 toolchains and produced spurious
  // network errors with HTTP multiplexing on.
  it.each([["1.70.0"], ["1.71.1"]])(
    "disables http multiplexing on %s",
    (release) => {
      const h = harness({ release });
      run(h.deps);
      expect(h.exported.CARGO_HTTP_MULTIPLEXING).toBe("false");
    },
  );

  it("leaves http multiplexing alone on 1.72", () => {
    const h = harness({ release: "1.72.0" });
    run(h.deps);
    expect(h.exported.CARGO_HTTP_MULTIPLEXING).toBeUndefined();
  });
});

describe("rustup compatibility details", () => {
  // rustup renames directories across layers when replacing a component;
  // this permits a copy instead, which overlayfs can do.
  it("permits copy-rename during the install", () => {
    const h = harness();
    run(h.deps);
    const install = h.calls.find((c) => c.args[0] === "toolchain");
    expect(install?.env?.RUSTUP_PERMIT_COPY_RENAME).toBe("1");
  });

  // dtolnay/rust-toolchain#127: `rustup default` fails on some toolchains
  // that are nonetheless installed and usable.
  it("carries on when rustup default fails every attempt", () => {
    const h = harness({
      // Every retry must fail, or the tolerance path is never reached.
      execResults: {
        "default stable": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/rustup default did not succeed/);
    expect(h.outputs.name).toBe("stable");
  });

  it("logs the installed rustc version", () => {
    const h = harness();
    run(h.deps);
    expect(h.logs.join("\n")).toContain("rustc 1.89.0");
  });
});

// `RUSTUP_TOOLCHAIN` sits at precedence 2 and so outranks *every*
// rust-toolchain.toml in the tree, including nested ones this action never
// read. A monorepo pinning a different toolchain per crate needs to opt out.
describe("set-rustup-toolchain", () => {
  it("pins the toolchain for later steps by default", () => {
    const h = harness({ inputs: { toolchain: "nightly" } });
    run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("accepts an explicit true", () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "true" },
    });
    run(h.deps);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("leaves later steps to their own toolchain files when false", () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.exported.RUSTUP_TOOLCHAIN).toBeUndefined();
  });

  // Opting out changes what later steps resolve, not what this action reports:
  // the outputs must still describe the toolchain it actually installed.
  it("still reports the installed toolchain when opted out", () => {
    const h = harness({
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    run(h.deps);
    expect(h.outputs.name).toBe("nightly");
    expect(h.outputs.cachekey).toBe("20250627e5b2");
    const rustc = h.calls.find((c) => c.file === "rustc");
    expect(rustc?.env?.RUSTUP_TOOLCHAIN).toBe("nightly");
  });

  it("rejects a value that is not a boolean", () => {
    const h = harness({ inputs: { "set-rustup-toolchain": "yes please" } });
    run(h.deps);
    expect(h.failures[0]).toMatch(/set-rustup-toolchain/);
  });
});

// The profile is only honoured by rustup on a fresh toolchain, so `run` adds
// the components it implies by name. They are best-effort: unlike a component
// the caller listed, a missing one must not fail the job.
describe("profile components are applied explicitly", () => {
  it("adds the default profile's components after installing", () => {
    const h = harness();
    run(h.deps);
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

  it("adds nothing extra for the minimal profile", () => {
    const h = harness({ inputs: { profile: "minimal" } });
    run(h.deps);
    const componentAdds = h.calls.filter((c) => c.args[0] === "component");
    expect(componentAdds).toEqual([]);
  });

  it("keeps requested components in their own invocation", () => {
    const h = harness({ inputs: { components: "llvm-tools" } });
    run(h.deps);
    const componentAdds = h.calls
      .filter((c) => c.args[0] === "component")
      .map((c) => c.args.slice(4));
    // One call for what was asked for, one for what the profile implies.
    expect(componentAdds).toContainEqual(["llvm-tools"]);
    expect(componentAdds).toContainEqual(["rust-docs", "rustfmt", "clippy"]);
  });

  it("does not repeat a component the caller already listed", () => {
    const h = harness({ inputs: { components: "clippy" } });
    run(h.deps);
    const profileAdd = h.calls
      .filter((c) => c.args[0] === "component")
      .map((c) => c.args.slice(4))
      .find((args) => args.includes("rust-docs"));
    expect(profileAdd).toEqual(["rust-docs", "rustfmt"]);
  });

  // A release channel that lacks one of the profile's components should log and
  // carry on — the user never named it.
  it("tolerates a profile component that cannot be installed", () => {
    const h = harness({
      execResults: {
        "component add": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/profile/i);
    expect(h.outputs.name).toBe("stable");
  });

  // ...but a component the caller listed by name is a hard requirement.
  it("still fails when a requested component cannot be installed", () => {
    const h = harness({
      inputs: { components: "llvm-tools" },
      execResults: {
        "component add": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    run(h.deps);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatch(/component add/);
  });
});

describe("complete profile is rejected off nightly", () => {
  it("fails before running anything when paired with a release channel", () => {
    const h = harness({
      inputs: { toolchain: "stable", profile: "complete" },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/nightly/);
    expect(h.calls).toEqual([]);
  });

  it("allows complete on nightly", () => {
    const h = harness({
      inputs: { toolchain: "nightly", profile: "complete" },
    });
    run(h.deps);
    expect(h.failures).toEqual([]);
    expect(h.outputs.name).toBe("nightly");
  });

  // The expressive forms resolve to a numbered release, so they are rejected
  // on the resolved channel rather than the literal input.
  it("rejects complete for a channel that resolves to a release", () => {
    const h = harness({
      inputs: { toolchain: "stable minus 2 releases", profile: "complete" },
    });
    run(h.deps);
    expect(h.failures[0]).toMatch(/nightly/);
  });
});

describe("spec-aware cache key output", () => {
  it("publishes both the compatible key and the spec-bound key", () => {
    const h = harness({ inputs: { targets: "wasm32-unknown-unknown" } });
    run(h.deps);
    expect(h.outputs.cachekey).toBe("20250627e5b2");
    expect(h.outputs["cachekey-full"]).toStartWith("20250627e5b2-");
  });

  it("gives two different target sets two different spec keys", () => {
    const a = harness({ inputs: { targets: "wasm32-unknown-unknown" } });
    const b = harness({ inputs: { targets: "aarch64-apple-darwin" } });
    run(a.deps);
    run(b.deps);
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

  it("publishes every resolved value as a flat output", () => {
    const h = harness({
      toml,
      inputs: { target: "wasm32-unknown-unknown", components: "clippy" },
    });
    run(h.deps);
    expect(h.outputs.toolchain).toBe("1.89.0");
    expect(h.outputs.targets).toBe(
      '["wasm32-unknown-unknown","aarch64-apple-darwin"]',
    );
    expect(h.outputs.target).toBe("wasm32-unknown-unknown");
    expect(h.outputs.components).toBe('["clippy","rustfmt"]');
    expect(h.outputs.profile).toBe("minimal");
    expect(h.outputs["set-rustup-toolchain"]).toBe("true");
  });

  it("publishes the whole output set as json", () => {
    const h = harness({ toml, inputs: { target: "wasm32-unknown-unknown" } });
    run(h.deps);
    expect(jsonOutput(h)).toEqual({
      toolchain: "1.89.0",
      targets: ["wasm32-unknown-unknown", "aarch64-apple-darwin"],
      target: "wasm32-unknown-unknown",
      components: ["rustfmt"],
      profile: "minimal",
      "set-rustup-toolchain": true,
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
  it("separates input provenance from toml provenance", () => {
    const h = harness({
      toml,
      inputs: { toolchain: "nightly", "set-rustup-toolchain": "false" },
    });
    run(h.deps);
    const json = jsonOutput(h);
    expect(json.toolchain).toBe("nightly");
    expect(json.inputs.toolchain).toBe("nightly");
    expect(json.toml.channel).toBe("1.89.0");
    expect(json.inputs["set-rustup-toolchain"]).toBe("false");
    expect(json["set-rustup-toolchain"]).toBe(false);
  });

  it("reports empty lists and an empty target with no toml and no inputs", () => {
    const h = harness();
    run(h.deps);
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
  it("reports the resolved channel for an expressive toolchain input", () => {
    const h = harness({ inputs: { toolchain: "stable minus 2 releases" } });
    run(h.deps);
    const json = jsonOutput(h);
    expect(json.inputs.toolchain).toBe("stable minus 2 releases");
    expect(json.toolchain).toMatch(/^1\.\d+$/);
    expect(h.outputs.name).toBe(json.toolchain);
  });

  it("publishes no configuration outputs when the install fails", () => {
    const h = harness({
      execResults: {
        "toolchain install": [{ status: 1 }, { status: 1 }, { status: 1 }],
      },
    });
    run(h.deps);
    expect(h.outputs.json).toBeUndefined();
    expect(h.outputs.toolchain).toBeUndefined();
    expect(h.failures).toHaveLength(1);
  });
});
