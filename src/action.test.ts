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
import type { StageFs } from "@/cache/stage";
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
  metadataCalls: string[];
  stageFs: StageFs & { linked: string[]; moved: string[]; removed: string[] };
}

/**
 * A `StageFs` over a map, recording what staging linked and moved.
 *
 * Staging is filesystem work in the middle of both phases, so every harness
 * needs one; the recorded sets are what a test asserts the keep-set against.
 */
function fakeStageFs(
  removeFails = false,
  events: string[] = [],
): StageFs & { linked: string[]; moved: string[]; removed: string[] } {
  const linked: string[] = [];
  const moved: string[] = [];
  const removed: string[] = [];
  return {
    linked,
    moved,
    removed,
    mkdirp: (): void => {},
    link: (from): void => {
      linked.push(from);
    },
    walk: (): string[] => [],
    move: (from): void => {
      moved.push(from);
    },
    remove: (dir): void => {
      // Only the post-save cleanup fails. `stageFiles` also removes a stale
      // stage BEFORE filling it, and failing that one would break staging
      // itself — a different scenario, and one that would make this test pass
      // for the wrong reason.
      if (removeFails && events.some((event) => event.startsWith("save:"))) {
        throw new Error("EACCES");
      }
      removed.push(dir);
      events.push(`remove:${dir}`);
    },
  };
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
    files?: Record<string, string>;
    metadataJson?: string;
    metadataError?: Error;
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
  const metadataCalls: string[] = [];
  const queues = options.execResults ?? {};

  const stageFs = fakeStageFs();
  const deps: ActionDeps = {
    stageFs,
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
    readFile: (path: string) => {
      const name = path.split(/[\\/]/).pop() ?? "";
      if (name === "rust-toolchain.toml") {
        if (options.toml == null) throw new Error("ENOENT");
        return options.toml;
      }
      const extra = options.files?.[name];
      if (extra === undefined) throw new Error("ENOENT");
      return extra;
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
    metadata: {
      read: (manifestDir: string) => {
        metadataCalls.push(manifestDir);
        if (options.metadataError) return Promise.reject(options.metadataError);
        return Promise.resolve(options.metadataJson ?? "{}");
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
    metadataCalls,
    stageFs,
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

  // `rustup --version` does not just print rustup's version: it also reports
  // the *active* rustc, which makes rustup resolve the override chain. This
  // probe runs in the workspace before RUSTUP_TOOLCHAIN is exported, so a
  // `rust-toolchain.toml` wins there and rustup DOWNLOADS that toolchain —
  // six components — purely to print a line, then the action installs the
  // channel the caller actually asked for and uses that instead.
  //
  // Observed under act with toml 1.97 and `toolchain: 1.88`:
  //   info: syncing channel updates for 1.97-x86_64-unknown-linux-gnu
  //   info: downloading 6 components
  //   info: syncing channel updates for 1.88-x86_64-unknown-linux-gnu
  // and confirmed outside the action: `rustup --version` beside a toml
  // triggers the download while `rustup --help` does not.
  it("probes for rustup without resolving a toolchain", async () => {
    const h = harness({
      toml: '[toolchain]\nchannel = "1.97"\n',
      inputs: { toolchain: "1.88" },
    });
    await run(h.deps);
    const probe = h.calls.find((c) => c.file === "rustup");
    expect(probe?.args).toEqual(["--help"]);
  });

  it("downloads and runs rustup-init on POSIX runners", async () => {
    const h = harness({ execResults: { "--help": [NOT_INSTALLED] } });
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
    const h = harness({ execResults: { "--help": [NOT_INSTALLED] } });
    await run(h.deps);
    expect(h.paths).toEqual(["/home/runner/.cargo/bin"]);
  });

  it("uses the Windows installer on Windows runners", async () => {
    const h = harness({
      platform: "win32",
      execResults: { "--help": [NOT_INSTALLED] },
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
        "--help": [NOT_INSTALLED],
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
        "--help": [NOT_INSTALLED],
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
      msrv: "",
      "msrv-effective": "",
      "msrv-source": "none",
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

  // THE paths-array invariant, at the only place it is decided. `@actions/cache`
  // folds the paths array into a cache entry's version, so both phases must
  // derive the identical array — which is why staging switches on the
  // `cache-prune` INPUT and never on whether a keep-set turned out usable.
  // Mutation testing found `prune !== "off"` replaced by `true` left every
  // test green, meaning nothing pinned that `cache-prune: off` archives the
  // tree itself rather than a stage.
  it("archives the tree itself, not a stage, when pruning is off", async () => {
    const h = harness({
      inputs: { ...withCache, "cache-prune": "off" },
      env: cacheEnv,
    });
    await run(h.deps);

    const paths = h.restores.flatMap((restore) => restore.paths);
    expect(paths).toContain("/workspace/target/**");
    expect(paths).toContain("/home/runner/.cargo/registry/index");
    expect(paths.some((path) => path.includes(".rust-toolchain-stage"))).toBe(
      false,
    );

    // And no stage roots on the plans either. Roots with coarse paths would
    // fill a stage the archive never reads, then save the tree anyway.
    const plans = (
      JSON.parse(h.state.cache ?? "{}") as { plans: { stageRoots?: unknown }[] }
    ).plans;
    expect(plans.every((plan) => plan.stageRoots === undefined)).toBe(true);
  });

  // `bin` has nothing to prune, so it must carry no stage roots at all —
  // absent, not an empty array. An empty array is truthy, so `stageLayers`
  // would run it through the staging loop, find zero files staged, and drop
  // the layer as poisoned. The tools cache would silently stop being saved.
  it("gives the bin layer no stage roots even when pruning is on", async () => {
    const h = harness({ inputs: withCache, env: cacheEnv });
    await run(h.deps);

    const plans = (
      JSON.parse(h.state.cache ?? "{}") as {
        plans: { layer: string; stageRoots?: unknown }[];
      }
    ).plans;
    const bin = plans.find((plan) => plan.layer === "bin");
    expect(bin).toBeDefined();
    expect(bin).not.toHaveProperty("stageRoots");
    // The staged layers still have theirs, so this is not vacuous — and each
    // is checked, since a layer falling through to "no roots" would have its
    // paths point at a stage nothing ever fills.
    expect(plans.find((plan) => plan.layer === "build")).toHaveProperty(
      "stageRoots",
    );
    expect(plans.find((plan) => plan.layer === "registry")).toHaveProperty(
      "stageRoots",
    );
  });

  // A miss leaves no archive to unpack, so unstaging must not run for it.
  // Without the guard the restore would walk a stage directory that a previous
  // job left behind and move ITS contents into the tree — stale artifacts
  // presented as a fresh restore.
  it("does not unstage a layer that missed", async () => {
    const h = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: () => undefined,
    });
    h.stageFs.walk = (dir: string): string[] => [`${dir}/stale.rlib`];

    await run(h.deps);

    expect(h.stageFs.moved).toEqual([]);
  });

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
    // Staged by default (`cache-prune: safe`), so the layer is archived from
    // its stage directory rather than from the registry tree itself.
    expect(h.restores[0]?.paths).toEqual([
      "/home/runner/.cargo/.rust-toolchain-stage",
    ]);
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

  // A staged archive unpacks into `<tree>/.rust-toolchain-stage/…`, which
  // nothing reads from, so the restore is only half done until the files have
  // been moved back. This is the other half.
  it("moves a staged layer back into the tree it belongs to", async () => {
    const h = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) => key,
    });
    h.stageFs.walk = (dir: string): string[] => [`${dir}/debug/libfoo.rlib`];

    await run(h.deps);

    expect(h.stageFs.moved).toContain(
      "/workspace/target/.rust-toolchain-stage/debug/libfoo.rlib",
    );
  });

  // A cache failure never fails the build. A stage that cannot be unpacked
  // leaves the tree exactly as the job found it, which is a cold build and not
  // a broken one.
  it("warns rather than failing when a stage cannot be unpacked", async () => {
    const h = harness({
      inputs: withCache,
      env: cacheEnv,
      restoreResult: (key) => key,
    });
    h.stageFs.walk = (): string[] => {
      throw new Error("EACCES");
    };

    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.warnings.some((w) => /could not unpack/.test(w))).toBe(true);
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
      walkFails?: boolean;
      walkMissing?: string;
      walkUnreadable?: string;
      removeFails?: boolean;
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
    stageFs: StageFs & {
      linked: string[];
      moved: string[];
      removed: string[];
    };
    events: string[];
  } => {
    const restores: { key: string }[] = [];
    const saves: { key: string }[] = [];
    const summaries: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];
    const events: string[] = [];
    const stageFs = fakeStageFs(options.removeFails, events);
    return {
      events,
      restores,
      saves,
      summaries,
      warnings,
      logs,
      stageFs,
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
            events.push(`save:${key}`);
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
        walk: (dir: string): string[] => {
          // `code`, not a message that merely mentions ENOENT. `isMissing`
          // reads `error.code`, exactly as `readdirSync` sets it, so a fake
          // throwing a bare Error exercises the RETHROW path while looking
          // like it covers the swallow. That mismatch is the same class of
          // bug the swallow exists to fix, and it hid here once already.
          if (options.walkFails) {
            throw Object.assign(new Error("EACCES: permission denied"), {
              code: "EACCES",
            });
          }
          if (
            options.walkUnreadable !== undefined &&
            dir === options.walkUnreadable
          ) {
            throw Object.assign(new Error("EACCES: permission denied"), {
              code: "EACCES",
            });
          }
          if (
            options.walkMissing !== undefined &&
            dir === options.walkMissing
          ) {
            throw Object.assign(
              new Error(`ENOENT: no such file or directory, scandir '${dir}'`),
              { code: "ENOENT" },
            );
          }
          return (options.files ?? []).filter((file) =>
            file.startsWith(`${dir}/`),
          );
        },
        readdir: () => options.fingerprintDirs ?? [],
        stageFs,
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
      "/c/registry/cache/serde-1.0.0.crate",
      "/c/registry/cache/gone-9.9.9.crate",
      "/c/registry/index/serde",
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
          {
            layer: "registry",
            key: "reg-k",
            restoreKeys: [],
            paths: ["/c/.rust-toolchain-stage"],
            stageRoots: [
              { stageDir: "/c/.rust-toolchain-stage", sourceDir: "/c" },
            ],
          },
          {
            layer: "build",
            key: "build-k",
            restoreKeys: [],
            paths: ["/w/target/.rust-toolchain-stage"],
            stageRoots: [
              {
                stageDir: "/w/target/.rust-toolchain-stage",
                sourceDir: "/w/target",
              },
            ],
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
      const { deps, stageFs } = postDeps(cacheState("safe"), {
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

      // The keep-set decides what is *linked into* the stage...
      expect(stageFs.linked).toContain(
        "/w/target/debug/deps/libserde-aaaaaaaaaaaaaaaa.rlib",
      );
      expect(stageFs.linked).not.toContain(
        "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
      );

      // ...and never what is archived. This is the regression guard for the
      // bug that made every pruned entry unreadable: `@actions/cache` derives
      // an entry's version from its paths array, so a paths array that varies
      // with the keep-set writes entries no restore can ever find.
      expect(saved).toEqual([
        ["/c/.rust-toolchain-stage"],
        ["/w/target/.rust-toolchain-stage"],
      ]);
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
      const { deps, warnings, stageFs } = postDeps(cacheState("safe"), {
        metadataFails: true,
        files: FILES,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };
      await runPost(deps);
      // A fallback changes what the stage holds — everything, including the
      // artifact a usable keep-set would have dropped — and never the paths
      // array. Falling back therefore costs archive size, never readability.
      expect(saved).toContainEqual(["/w/target/.rust-toolchain-stage"]);
      expect(stageFs.linked).toContain(
        "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
      );
      expect(warnings.some((w) => /saving everything instead/.test(w))).toBe(
        true,
      );
    });

    it("falls back when the package set resolves to nothing", async () => {
      const saved: string[][] = [];
      const { deps, stageFs } = postDeps(cacheState("safe"), {
        metadata: JSON.stringify({ packages: [] }),
        files: FILES,
      });
      const original = deps.cache.save;
      deps.cache.save = async (paths, key): Promise<void> => {
        saved.push(paths);
        await original(paths, key);
      };
      await runPost(deps);
      // A fallback changes what the stage holds — everything, including the
      // artifact a usable keep-set would have dropped — and never the paths
      // array. Falling back therefore costs archive size, never readability.
      expect(saved).toContainEqual(["/w/target/.rust-toolchain-stage"]);
      expect(stageFs.linked).toContain(
        "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
      );
    });

    // Task 4 measured the bad trade directly: an unchurned tree spent 904 ms of
    // glob resolution to drop 0.2% of the bytes. Below the threshold the
    // unpruned paths are cheaper and lose almost nothing.
    it("keeps the unpruned paths when pruning would drop too little", async () => {
      const saved: string[][] = [];
      const { deps, stageFs } = postDeps(cacheState("safe"), {
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
      // A fallback changes what the stage holds — everything, including the
      // artifact a usable keep-set would have dropped — and never the paths
      // array. Falling back therefore costs archive size, never readability.
      expect(saved).toContainEqual(["/w/target/.rust-toolchain-stage"]);
      expect(stageFs.linked).toContain(
        "/w/target/debug/deps/libgone-bbbbbbbbbbbbbbbb.rlib",
      );
    });

    // The last guard, and the only one that sees what actually reached the
    // stage. An entry that exists, hits its key and restores nothing is worse
    // than no entry at all: it leaves every later job rebuilding while
    // believing it was warm.
    it("does not save a layer whose stage ended up empty", async () => {
      const { deps, saves, warnings } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: [],
      });

      await runPost(deps);

      expect(saves).toEqual([]);
      expect(warnings.some((w) => /nothing was staged/.test(w))).toBe(true);
    });

    // A stage is a hard-linked mirror of the tree it came from, so leaving it
    // costs no disk blocks but does leave target/ and $CARGO_HOME carrying a
    // duplicate of themselves. Removing links never touches the files they
    // point at, so this cannot lose work.
    it("clears every stage once its archive is written", async () => {
      const { deps, events } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
      });

      await runPost(deps);

      // Ordering is the assertion, not the mere fact of a removal:
      // `stageFiles` already clears a stale stage BEFORE filling it, so
      // "was removed at some point" is true even with no cleanup at all and
      // would pass with the cleanup in entirely the wrong place.
      for (const dir of [
        "/w/target/.rust-toolchain-stage",
        "/c/.rust-toolchain-stage",
      ]) {
        expect(events.lastIndexOf(`remove:${dir}`)).toBeGreaterThan(
          events.findIndex((event) => event.startsWith("save:")),
        );
      }
    });

    it("warns rather than failing when a stage cannot be cleared", async () => {
      const { deps, warnings, saves } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        removeFails: true,
      });

      await runPost(deps);

      expect(warnings.some((w) => /could not clear/.test(w))).toBe(true);
      // The archives were already written, so a cleanup failure costs nothing.
      expect(saves.length).toBeGreaterThan(0);
    });

    // The fallback stages the whole tree, but "whole" still excludes the
    // regenerable subtrees the coarse glob set excluded. Dropping that filter
    // survived mutation testing: nothing asserted that `incremental/` and
    // `examples/` stay out of a fallback archive, which is where the archive
    // is largest and the exclusion matters most.
    it("excludes the regenerable subtrees even when staging everything", async () => {
      const { deps, stageFs } = postDeps(cacheState("safe"), {
        metadataFails: true,
        files: [
          "/w/target/debug/keep.rlib",
          "/w/target/debug/incremental/skip.bin",
          "/w/target/debug/examples/skip.bin",
        ],
      });

      await runPost(deps);

      expect(stageFs.linked).toEqual(["/w/target/debug/keep.rlib"]);
    });

    // `prunedBytes` describes what a keep-set dropped from the BUILD tree. The
    // registry layer has its own selection and no such figure, so reporting one
    // there would put a number in the job summary that means nothing.
    it("reports pruned bytes for the build layer only", async () => {
      const { deps, summaries } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        fingerprintDirs: ["serde-aaaaaaaaaaaaaaaa", "gone-bbbbbbbbbbbbbbbb"],
        sizes,
      });

      await runPost(deps);

      expect(summaries[0]).toMatch(/\| build \| miss \| \d+ \|/);
      expect(summaries[0]).toMatch(/\| registry \| miss \| — \|/);
    });

    // Regression, found by .github/workflows/tests/act-cache.yml rather than
    // by any unit test. A workspace with no git dependencies has no
    // $CARGO_HOME/git/db, the registry file list walked it anyway, and the raw
    // readdirSync adapter threw ENOENT. That escaped the whole staging loop,
    // so NOTHING was staged -- registry and build alike -- both stage
    // directories went uncreated, and saveCache refused a path that does not
    // exist. One absent directory cost every pruned layer its save.
    it("stages a layer whose optional directory is simply absent", async () => {
      const { deps, saves, warnings } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        walkMissing: "/c/git/db",
      });

      await runPost(deps);

      // $CARGO_HOME/git/db does not exist until a workspace takes a git
      // dependency. Absent is nothing to archive, not a fault, so BOTH layers
      // still save — the whole point of `walkOptional`.
      expect(saves.map((save) => save.key).sort()).toEqual([
        "build-k",
        "reg-k",
      ]);
      expect(warnings).toEqual([]);
    });

    // The other side of the same guard, and the reason it swallows ENOENT
    // ONLY. A directory that exists and cannot be read is an unknown, not a
    // zero: archiving around it would ship a smaller entry than asked for, so
    // the layer is dropped loudly instead. The build layer is untouched by it.
    it("drops only the layer whose directory cannot be read", async () => {
      const { deps, saves, warnings } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        walkUnreadable: "/c/git/db",
      });

      await runPost(deps);

      expect(saves.map((save) => save.key)).toEqual(["build-k"]);
      expect(
        warnings.some((warning) =>
          /registry: could not be staged/.test(warning),
        ),
      ).toBe(true);
    });

    // A layer whose staging threw has no stage directory at all, so saving it
    // asks @actions/cache to archive a path that does not exist. Dropping the
    // plan is what turns that into a skipped layer rather than a warning from
    // deep inside the client.
    it("never saves a layer whose staging threw", async () => {
      const { deps, saves } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        files: FILES,
        walkFails: true,
      });

      await runPost(deps);

      expect(saves).toEqual([]);
    });

    // The outer backstop: `stageLayers` handles a keep-set it cannot resolve
    // itself, but staging is filesystem work and can fail on its own terms.
    it("warns rather than failing when staging itself throws", async () => {
      const { deps, warnings } = postDeps(cacheState("safe"), {
        metadata: METADATA,
        walkFails: true,
      });

      await runPost(deps);

      expect(warnings.some((w) => /saving everything instead/.test(w))).toBe(
        true,
      );
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
      // The harness keys its queue on the first two argv words, so "--version"
      // now belongs to the tool probes alone — rustup is detected with
      // `--help`, precisely so it cannot resolve a toolchain. This single entry
      // is that probe finding the tool present, which is the whole premise of
      // the fallback being exercised here.
      execResults: {
        "--version": [{ status: 0, stdout: "cargo-nextest 0.9.99" }],
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

describe("msrv-fallback", () => {
  it("installs the rust-version when the flag is on and nothing else names a channel", async () => {
    const h = harness({
      toml: null,
      inputs: { "msrv-fallback": "true" },
      files: { "Cargo.toml": '[package]\nrust-version = "1.88"\n' },
    });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("1.88");
    expect(h.outputs["msrv"]).toBe("1.88");
    expect(h.outputs["msrv-source"]).toBe("cargo-toml");
  });

  it("installs stable when the flag is off, whatever Cargo.toml says", async () => {
    const h = harness({
      toml: null,
      files: { "Cargo.toml": '[package]\nrust-version = "1.88"\n' },
    });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("stable");
    // The declared MSRV is still reported; only the channel is unaffected.
    expect(h.outputs["msrv"]).toBe("1.88");
  });

  it("falls through to stable when the flag is on but no Cargo.toml exists", async () => {
    const h = harness({ toml: null, inputs: { "msrv-fallback": "true" } });
    await run(h.deps);

    const install = h.calls.find(
      (c) => c.file === "rustup" && c.args[0] === "toolchain",
    );
    expect(install?.args).toContain("stable");
    expect(h.outputs["msrv-source"]).toBe("none");
  });
});

const GRAPH_JSON = JSON.stringify({
  packages: [
    {
      id: "a",
      name: "cargo-binstall",
      version: "1.21.1",
      rust_version: "1.79",
    },
    { id: "b", name: "vergen", version: "10.0.1", rust_version: "1.95.0" },
  ],
});

describe("msrv-check", () => {
  it("warns by default when the graph outruns the installed toolchain", async () => {
    const h = harness({ metadataJson: GRAPH_JSON, release: "1.88.0" });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(
      h.warnings.some((w) =>
        /vergen 10\.0\.1 requires rustc 1\.95\.0, but 1\.88\.0 is installed/.test(
          w,
        ),
      ),
    ).toBe(true);
    expect(h.outputs["msrv-effective"]).toBe("1.95.0");
  });

  it("fails the step under error", async () => {
    const h = harness({
      metadataJson: GRAPH_JSON,
      release: "1.88.0",
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures.some((f) => /vergen 10\.0\.1 requires/.test(f))).toBe(
      true,
    );
  });

  it("stays silent when the toolchain satisfies the graph", async () => {
    const h = harness({ metadataJson: GRAPH_JSON, release: "1.97.1" });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.warnings.some((w) => /requires rustc/.test(w))).toBe(false);
    expect(h.outputs["msrv-effective"]).toBe("1.95.0");
  });

  it("does not read metadata at all when off", async () => {
    const h = harness({
      metadataJson: GRAPH_JSON,
      release: "1.88.0",
      inputs: { "msrv-check": "off" },
    });
    await run(h.deps);

    expect(h.metadataCalls).toEqual([]);
    expect(h.outputs["msrv-effective"]).toBe("");
  });

  // Inability to verify is not a violation, so it warns even under `error`.
  it("warns and succeeds under error when metadata cannot run", async () => {
    const h = harness({
      metadataError: new Error("could not find `Cargo.toml`"),
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(h.warnings.some((w) => /MSRV check could not run/.test(w))).toBe(
      true,
    );
  });

  it("warns when the graph declares nothing", async () => {
    const h = harness({
      metadataJson: JSON.stringify({ packages: [] }),
      inputs: { "msrv-check": "error" },
    });
    await run(h.deps);

    expect(h.failures).toEqual([]);
    expect(
      h.warnings.some((w) => /no package in the graph declares/.test(w)),
    ).toBe(true);
  });
});
