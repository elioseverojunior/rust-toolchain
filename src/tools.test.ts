// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type {
  EnsureDeps,
  RegistryClient,
  ResolveDeps,
  ResolvedTool,
  ToolExecResult,
  ToolSpec,
} from "@/tools";
import {
  ensureTools,
  hashToolSet,
  parseToolSpecs,
  parseToolVersion,
  resolveToolVersions,
  UNRESOLVED_VERSION,
} from "@/tools";

describe("parseToolSpecs", () => {
  // `cargo-tools` is optional, so an unset input is not an error.
  it("reads an empty input as no tools", () => {
    expect(parseToolSpecs("")).toEqual([]);
    expect(parseToolSpecs("   ")).toEqual([]);
  });

  // A bare name means "whatever is current", which only becomes a concrete
  // version once the registry has answered — see Task 2.
  it("defaults a bare name to latest", () => {
    expect(parseToolSpecs("cargo-nextest")).toEqual([
      { name: "cargo-nextest", version: "latest" },
    ]);
  });

  it("keeps an explicitly pinned version", () => {
    expect(parseToolSpecs("cargo-deny@0.16.1")).toEqual([
      { name: "cargo-deny", version: "0.16.1" },
    ]);
  });

  it("accepts an explicit latest", () => {
    expect(parseToolSpecs("cargo-nextest@latest")).toEqual([
      { name: "cargo-nextest", version: "latest" },
    ]);
  });

  // `ignorefile-cli` installs binaries named `ign` and `ignorefile`, so probing
  // the crate name finds nothing, reads as absent, and rebuilds from source on
  // every run — even on top of an exact `bin` hit that had just put both
  // binaries on disk. Measured at 10.9s of a 33.7s action on
  // rustup-toolchain-tests run 31744249910. Declaring the binary is what lets
  // the probe see what the cache restored.
  it("reads a declared binary name", () => {
    expect(parseToolSpecs("ignorefile-cli@0.1.0:ign")).toEqual([
      { name: "ignorefile-cli", version: "0.1.0", bin: "ign" },
    ]);
  });

  // Every part is independently optional, so the suffix does not force a pin.
  it("accepts a declared binary without a version", () => {
    expect(parseToolSpecs("ignorefile-cli:ign")).toEqual([
      { name: "ignorefile-cli", version: "latest", bin: "ign" },
    ]);
  });

  // The probe target defaults to the crate name, which is right for the
  // overwhelming majority of crates and is why the suffix is optional at all.
  //
  // `toStrictEqual`, not `toEqual`: the key must be ABSENT, not present and
  // undefined. `toEqual` reads those as the same object, and mutation testing
  // found the gap — deleting `toSpec`'s early return survives, because the
  // fallthrough then validates the string "undefined" (which matches the
  // identifier class) and returns `bin: undefined`. Nothing downstream can
  // currently tell the difference, so this is the only place that can.
  it("leaves the binary unset when none is declared", () => {
    expect(parseToolSpecs("cargo-deny@0.16.1")).toStrictEqual([
      { name: "cargo-deny", version: "0.16.1" },
    ]);
  });

  // The same separator grammar as `targets` and `components`, so a workflow
  // can write the list however reads best.
  it.each([
    ["a comma", "cargo-deny,cargo-nextest"],
    ["a space", "cargo-deny cargo-nextest"],
    ["a newline", "cargo-deny\ncargo-nextest"],
    ["mixed separators", "cargo-deny, \n cargo-nextest"],
  ])("splits on %s", (_label, input) => {
    expect(parseToolSpecs(input).map((tool) => tool.name)).toEqual([
      "cargo-deny",
      "cargo-nextest",
    ]);
  });

  it("preserves the order the caller wrote", () => {
    expect(parseToolSpecs("z-tool,a-tool").map((t) => t.name)).toEqual([
      "z-tool",
      "a-tool",
    ]);
  });

  // Every name and version reaches `cargo install` as argv. Commands run
  // without a shell, so this is a second line of defence rather than the only
  // one — but a value that cannot name a crate is a configuration error worth
  // reporting before cargo fails obscurely.
  describe("rejects values that are not plain identifiers", () => {
    it("rejects a name carrying shell syntax", () => {
      expect(() => parseToolSpecs("cargo-deny; id > /tmp/pwned")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a name carrying command substitution", () => {
      expect(() => parseToolSpecs("cargo-deny$(id)")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a version carrying shell syntax", () => {
      expect(() => parseToolSpecs("cargo-deny@0.16.1`id`")).toThrow(
        /not a valid cargo tool version/,
      );
    });

    // Splitting on the first `@` leaves the rest in the version, where the
    // identifier class rejects the second one.
    it("rejects an entry with more than one @", () => {
      expect(() => parseToolSpecs("cargo-deny@0.16.1@2.0")).toThrow(
        /not a valid cargo tool version/,
      );
    });

    it("rejects a missing name", () => {
      expect(() => parseToolSpecs("@0.16.1")).toThrow(
        /not a valid cargo tool name/,
      );
    });

    it("rejects a trailing @ with no version", () => {
      expect(() => parseToolSpecs("cargo-deny@")).toThrow(
        /not a valid cargo tool version/,
      );
    });

    it("rejects a trailing : with no binary", () => {
      expect(() => parseToolSpecs("cargo-deny@0.16.1:")).toThrow(
        /not a valid cargo tool binary/,
      );
    });

    // Split on the FIRST `:`, the same rule the `@` split follows, so a second
    // one stays in the binary where the identifier class rejects it.
    it("rejects an entry with more than one :", () => {
      expect(() => parseToolSpecs("ignorefile-cli@0.1.0:ign:extra")).toThrow(
        /not a valid cargo tool binary/,
      );
    });

    // The version binds to the crate, never to the binary, so the suffix comes
    // last. Writing it the other way round is a mistake worth naming precisely.
    it("rejects a binary written before the version", () => {
      expect(() => parseToolSpecs("ignorefile-cli:ign@0.1.0")).toThrow(
        /not a valid cargo tool binary/,
      );
    });

    // The binary reaches the probe as argv, so it earns the same guard the
    // name and version get rather than being trusted for being a hint.
    it("rejects a binary carrying shell syntax", () => {
      expect(() => parseToolSpecs("ignorefile-cli@0.1.0:ign;id")).toThrow(
        /not a valid cargo tool binary/,
      );
    });
  });

  // Two pinned versions of one tool cannot both be installed, and picking one
  // would be a guess. Naming the tool in the message is what makes it fixable.
  it("rejects a duplicate tool name", () => {
    expect(() => parseToolSpecs("cargo-deny@0.16.1,cargo-deny@0.17.0")).toThrow(
      /cargo-deny/,
    );
  });

  it("rejects a duplicate even when the versions agree", () => {
    expect(() => parseToolSpecs("cargo-deny,cargo-deny")).toThrow(
      /more than once/,
    );
  });

  // Deduplication keys on the crate, not on the whole entry. Two `:` suffixes
  // no more make two installs possible than two versions do — cargo installs a
  // crate once, whichever of its binaries you name.
  it("rejects a duplicate crate even when the binaries differ", () => {
    expect(() =>
      parseToolSpecs("ignorefile-cli:ign,ignorefile-cli:ignorefile"),
    ).toThrow(/more than once/);
  });
});

/**
 * A client whose answers are queued per tool name.
 *
 * An entry may be a version or an Error; errors are thrown in order, so a test
 * can make the first attempt fail and the second succeed. Running out of
 * queued answers is itself a failure, so a test cannot pass by accident on a
 * call it never set up.
 */
const registry = (
  answers: Record<string, (string | Error)[]>,
): RegistryClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    latestVersion: async (name): Promise<string> => {
      calls.push(name);
      const next = answers[name]?.shift();
      if (next === undefined) throw new Error(`no answer queued for ${name}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

const deps = (
  client: RegistryClient,
  pauses: number[] = [],
): ResolveDeps & { pauses: number[] } => ({
  client,
  attempts: 3,
  backoffMs: 1_000,
  delay: async (ms): Promise<void> => {
    pauses.push(ms);
  },
  pauses,
});

const spec = (name: string, version = "latest"): ToolSpec => ({
  name,
  version,
});

describe("resolveToolVersions", () => {
  it("resolves nothing when no tools were requested", async () => {
    const client = registry({});
    expect(await resolveToolVersions([], deps(client))).toEqual({
      tools: [],
      unresolved: [],
    });
    expect(client.calls).toEqual([]);
  });

  // A pinned version is already concrete, so the registry is never consulted.
  // This is what makes an outage unable to touch a pinned tool at all.
  it("never calls the registry for an explicitly pinned version", async () => {
    const client = registry({});
    const result = await resolveToolVersions(
      [spec("cargo-deny", "0.16.1")],
      deps(client),
    );
    expect(result.tools).toEqual([{ name: "cargo-deny", version: "0.16.1" }]);
    expect(result.unresolved).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  // The binary is a probe hint, not a resolution input, so it has to survive
  // both ways out of `resolveOne` — the pinned early return as well as the
  // lookup. Dropping it on either path silently restores the rebuild-every-run
  // behaviour the suffix exists to remove.
  it("carries a declared binary through a registry lookup", async () => {
    const client = registry({ "ignorefile-cli": ["0.1.0"] });
    const result = await resolveToolVersions(
      [{ name: "ignorefile-cli", version: "latest", bin: "ign" }],
      deps(client),
    );
    expect(result.tools).toEqual([
      { name: "ignorefile-cli", version: "0.1.0", bin: "ign" },
    ]);
  });

  it("carries a declared binary through a pinned version", async () => {
    const client = registry({});
    const result = await resolveToolVersions(
      [{ name: "ignorefile-cli", version: "0.1.0", bin: "ign" }],
      deps(client),
    );
    expect(result.tools).toEqual([
      { name: "ignorefile-cli", version: "0.1.0", bin: "ign" },
    ]);
    expect(client.calls).toEqual([]);
  });

  it("resolves latest through the registry", async () => {
    const client = registry({ "cargo-nextest": ["0.9.100"] });
    const result = await resolveToolVersions(
      [spec("cargo-nextest")],
      deps(client),
    );
    expect(result.tools).toEqual([
      { name: "cargo-nextest", version: "0.9.100" },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  // Resolution is network-bound, so one dropped connection must not decide the
  // outcome — the same latitude every rustup call gets.
  it("retries a transient failure and then succeeds", async () => {
    const client = registry({
      "cargo-nextest": [new Error("ETIMEDOUT"), "0.9.100"],
    });
    const pauses: number[] = [];
    const result = await resolveToolVersions(
      [spec("cargo-nextest")],
      deps(client, pauses),
    );
    expect(result.tools).toEqual([
      { name: "cargo-nextest", version: "0.9.100" },
    ]);
    expect(client.calls).toEqual(["cargo-nextest", "cargo-nextest"]);
    expect(pauses).toEqual([1_000]);
  });

  // Three failures then a success: the pause grows between each pair of
  // attempts, and there is no pause after the attempt that succeeded.
  it("backs off exponentially between attempts", async () => {
    const client = registry({
      "cargo-deny": [new Error("a"), new Error("b"), new Error("c"), "0.16.1"],
    });
    const pauses: number[] = [];
    await resolveToolVersions([spec("cargo-deny")], {
      ...deps(client, pauses),
      attempts: 4,
    });
    expect(pauses).toEqual([1_000, 2_000, 4_000]);
  });

  // No pause after the final attempt: the job is not made slower by waiting
  // for a retry that will never happen.
  it("does not pause after the last attempt", async () => {
    const client = registry({ "cargo-deny": [new Error("a"), new Error("b")] });
    const pauses: number[] = [];
    await resolveToolVersions([spec("cargo-deny")], {
      ...deps(client, pauses),
      attempts: 2,
    });
    expect(pauses).toEqual([1_000]);
  });

  // The resolver does not decide what an outage means — it reports, and the
  // caller applies the fallback. Throwing here would take the whole job down
  // over a registry that may not even be needed.
  it("reports a tool it could not resolve rather than throwing", async () => {
    const client = registry({
      "cargo-deny": [
        new Error("a"),
        new Error("b"),
        new Error("503 from crates.io"),
      ],
    });
    const result = await resolveToolVersions(
      [spec("cargo-deny")],
      deps(client),
    );
    expect(result.tools).toEqual([
      { name: "cargo-deny", version: UNRESOLVED_VERSION },
    ]);
    expect(result.unresolved).toEqual([
      { name: "cargo-deny", reason: "503 from crates.io" },
    ]);
  });

  it("reports the last failure, not the first", async () => {
    const client = registry({
      "cargo-deny": [
        new Error("first"),
        new Error("second"),
        new Error("last"),
      ],
    });
    const result = await resolveToolVersions(
      [spec("cargo-deny")],
      deps(client),
    );
    expect(result.unresolved[0]?.reason).toBe("last");
  });

  // Each tool is caught at its own boundary, so one unreachable lookup cannot
  // lose the answers the others already produced.
  it("leaves the other tools resolved when one fails", async () => {
    const client = registry({
      "cargo-deny": [new Error("x"), new Error("x"), new Error("x")],
      "cargo-nextest": ["0.9.100"],
    });
    const result = await resolveToolVersions(
      [spec("cargo-deny"), spec("cargo-nextest"), spec("cargo-udeps", "0.1.0")],
      deps(client),
    );
    expect(result.tools).toEqual([
      { name: "cargo-deny", version: UNRESOLVED_VERSION },
      { name: "cargo-nextest", version: "0.9.100" },
      { name: "cargo-udeps", version: "0.1.0" },
    ]);
    expect(result.unresolved.map((u) => u.name)).toEqual(["cargo-deny"]);
  });

  // The key digest sorts before hashing, but the output reports what the
  // caller asked for, so order is preserved here rather than normalised.
  it("preserves the order the caller wrote", async () => {
    const client = registry({ "z-tool": ["1.0.0"], "a-tool": ["2.0.0"] });
    const result = await resolveToolVersions(
      [spec("z-tool"), spec("a-tool")],
      deps(client),
    );
    expect(result.tools.map((t) => t.name)).toEqual(["z-tool", "a-tool"]);
  });

  // A rejection carrying something that is not an Error still has to produce a
  // readable reason rather than "[object Object]".
  it("describes a non-Error rejection", async () => {
    const client: RegistryClient = {
      latestVersion: async (): Promise<string> => {
        throw "connection reset";
      },
    };
    const result = await resolveToolVersions([spec("cargo-deny")], {
      ...deps(client),
      attempts: 1,
    });
    expect(result.unresolved).toEqual([
      { name: "cargo-deny", reason: "connection reset" },
    ]);
  });
});

describe("hashToolSet", () => {
  const tool = (name: string, version: string): ResolvedTool => ({
    name,
    version,
  });

  it("is stable for the same set", () => {
    const set = [tool("cargo-deny", "0.16.1")];
    expect(hashToolSet(set)).toBe(hashToolSet([...set]));
  });

  // The same width as `generateSpecCacheKey` and `hashBuildEnv`, so every
  // segment of a derived key reads uniformly.
  it("is eight lowercase hex characters", () => {
    expect(hashToolSet([tool("cargo-deny", "0.16.1")])).toMatch(
      /^[0-9a-f]{8}$/,
    );
  });

  // Declaring the same tools in a different order is the same request, so it
  // must not be a different cache entry.
  it("ignores the order the tools were written in", () => {
    expect(
      hashToolSet([tool("a-tool", "1.0.0"), tool("z-tool", "2.0.0")]),
    ).toBe(hashToolSet([tool("z-tool", "2.0.0"), tool("a-tool", "1.0.0")]));
  });

  it.each([
    ["the version", [tool("cargo-deny", "0.17.0")]],
    ["the name", [tool("cargo-udeps", "0.16.1")]],
    ["the number of tools", [tool("cargo-deny", "0.16.1"), tool("x", "1.0.0")]],
  ])("changes when %s differs", (_label, other) => {
    expect(hashToolSet(other)).not.toBe(
      hashToolSet([tool("cargo-deny", "0.16.1")]),
    );
  });

  // A declared binary changes nothing about what gets installed, so it must not
  // change the key. If it did, adding `:ign` to an existing workflow would miss
  // the very entry the suffix exists to make usable — paying one full rebuild
  // to stop paying full rebuilds, and splitting the cache between the two
  // spellings of one request forever after.
  it("ignores a declared binary", () => {
    expect(
      hashToolSet([{ name: "ignorefile-cli", version: "0.1.0", bin: "ign" }]),
    ).toBe(hashToolSet([tool("ignorefile-cli", "0.1.0")]));
  });

  // Never special-cased to the empty string. `joinKeySegments` drops an empty
  // segment, so a tools-less job's `bin` key would collapse to
  // `bin-<os>-<arch>` while its widest restore rung stayed `bin-<os>-<arch>-` —
  // which matches a *tooled* job's entry, and the tools-less job would restore
  // binaries it never asked for.
  it("gives an empty set a real digest rather than an empty segment", () => {
    expect(hashToolSet([])).toMatch(/^[0-9a-f]{8}$/);
    expect(hashToolSet([])).toBe(hashToolSet([]));
    expect(hashToolSet([])).not.toBe(hashToolSet([tool("x", "1.0.0")]));
  });
});

describe("parseToolVersion", () => {
  it.each([
    ["cargo-deny 0.16.1", "0.16.1"],
    ["cargo-nextest-cargo-nextest 0.9.100", "0.9.100"],
    ["something 1.0.0-beta.2", "1.0.0-beta.2"],
  ])("reads %s", (banner, expected) => {
    expect(parseToolVersion(banner)).toBe(expected);
  });

  it("returns undefined when there is no version to read", () => {
    expect(parseToolVersion("command not found")).toBeUndefined();
  });
});

interface ExecCall {
  file: string;
  args: string[];
}

/**
 * Records every invocation and answers from a queue keyed on the first argv
 * word, so a test can make one `cargo install` attempt fail and the next
 * succeed. An unqueued call answers success with no stdout, which is what a
 * `--version` probe for an absent tool must NOT look like — those queue an
 * explicit spawn error instead.
 */
const runner = (
  answers: Record<string, ToolExecResult[]> = {},
): EnsureDeps & { calls: ExecCall[]; pauses: number[] } => {
  const calls: ExecCall[] = [];
  const pauses: number[] = [];
  return {
    calls,
    pauses,
    env: {},
    attempts: 3,
    backoffMs: 1_000,
    timeoutMs: 600_000,
    sleep: (ms): void => {
      pauses.push(ms);
    },
    log: { info: (): void => {}, warning: (): void => {} },
    binRestoredExactly: false,
    exec: (file, args): ToolExecResult => {
      calls.push({ file, args });
      return answers[file]?.shift() ?? { status: 0, stdout: "" };
    },
  };
};

const absent: ToolExecResult = { status: null, error: new Error("ENOENT") };

const resolution = (
  tools: ResolvedTool[],
  unresolved: { name: string; reason: string }[] = [],
): {
  tools: ResolvedTool[];
  unresolved: { name: string; reason: string }[];
} => ({
  tools,
  unresolved,
});

describe("ensureTools", () => {
  it("keeps a tool already at the resolved version", () => {
    const deps = runner({
      "cargo-deny": [{ status: 0, stdout: "cargo-deny 0.16.1" }],
    });
    const outcomes = ensureTools(
      resolution([{ name: "cargo-deny", version: "0.16.1" }]),
      deps,
    );
    expect(outcomes).toEqual([
      { name: "cargo-deny", version: "0.16.1", action: "kept" },
    ]);
    // The argv, not just the binary. `--version` is the whole probe, and the
    // distinction between "absent" and "present but mute" that this module
    // exists to draw is a statement about how that exact flag behaves.
    expect(deps.calls).toEqual([{ file: "cargo-deny", args: ["--version"] }]);
  });

  // The whole point of the suffix. `ignorefile-cli` ships `ign` and
  // `ignorefile`, so probing the crate name spawn-errors, reads as absent, and
  // reinstalls from source on top of an exact `bin` hit that had already put
  // both binaries on disk. Note this needs no `binRestoredExactly`: a binary
  // that names its version is kept on that evidence alone.
  it("probes the declared binary rather than the crate name", () => {
    const deps = runner({ ign: [{ status: 0, stdout: "ign 0.1.0" }] });

    const outcomes = ensureTools(
      resolution([{ name: "ignorefile-cli", version: "0.1.0", bin: "ign" }]),
      deps,
    );

    expect(outcomes).toEqual([
      { name: "ignorefile-cli", version: "0.1.0", action: "kept" },
    ]);
    expect(deps.calls).toEqual([{ file: "ign", args: ["--version"] }]);
  });

  // The suffix redirects the probe and nothing else: cargo installs a crate,
  // and there is no `cargo install ign` to be had.
  it("installs the crate name when the declared binary is absent", () => {
    const deps = runner({ ign: [absent] });

    const outcomes = ensureTools(
      resolution([{ name: "ignorefile-cli", version: "0.1.0", bin: "ign" }]),
      deps,
    );

    expect(outcomes[0]?.action).toBe("installed");
    expect(deps.calls).toEqual([
      { file: "ign", args: ["--version"] },
      {
        file: "cargo",
        args: [
          "install",
          "ignorefile-cli",
          "--version",
          "0.1.0",
          "--locked",
          "--force",
        ],
      },
    ]);
  });

  // Exact comparison, not containment: 0.16.1 is a substring of 0.16.10, and
  // treating that as a match would leave the wrong binary in place.
  it("reinstalls when the installed version merely looks similar", () => {
    const deps = runner({
      "cargo-deny": [{ status: 0, stdout: "cargo-deny 0.16.10" }],
    });
    const outcomes = ensureTools(
      resolution([{ name: "cargo-deny", version: "0.16.1" }]),
      deps,
    );
    expect(outcomes[0]?.action).toBe("installed");
  });

  // The real case this distinction exists for. `cargo-binstall`'s clap parser
  // defines `--version <VERSION>` as the crate version to install, shadowing
  // the conventional flag, so the probe exits non-zero with
  // "a value is required for '--version <VERSION>'". Read as "absent", that
  // rebuilds it from source on every job and discards the `bin` layer that had
  // just restored it — three minutes of `cargo install` per run.
  it("keeps a mute binary when the bin layer hit exactly", () => {
    const deps = runner({
      "cargo-binstall": [
        { status: 2, stdout: "" },
        { status: 0, stdout: "" },
      ],
    });
    deps.binRestoredExactly = true;

    const outcomes = ensureTools(
      resolution([{ name: "cargo-binstall", version: "1.21.1" }]),
      deps,
    );

    expect(outcomes).toEqual([
      { name: "cargo-binstall", version: "1.21.1", action: "kept" },
    ]);
    // Nothing but the probe ran: no `cargo install` at all.
    expect(deps.calls.map((c) => c.file)).toEqual(["cargo-binstall"]);
  });

  // Without an exact hit the ladder may have restored an older tool set, so a
  // binary that will not name its version proves nothing and a pinned version
  // would be silently wrong.
  it("installs a mute binary when the bin layer did not hit exactly", () => {
    const deps = runner({ "cargo-binstall": [{ status: 2, stdout: "" }] });

    const outcomes = ensureTools(
      resolution([{ name: "cargo-binstall", version: "1.21.1" }]),
      deps,
    );

    expect(outcomes[0]?.action).toBe("installed");
    expect(deps.calls.map((c) => c.file)).toEqual(["cargo-binstall", "cargo"]);
  });

  // The `version === undefined` conjunct, the other half nothing pinned. An
  // exact bin hit is not a licence to keep whatever is on disk: a binary that
  // reports a version and reports the WRONG one must still be replaced. Only
  // a binary that will not name its version at all rides on the hit.
  it("reinstalls a wrong-version tool even when the bin layer hit exactly", () => {
    const deps = runner({
      "cargo-deny": [{ status: 0, stdout: "cargo-deny 0.16.0" }],
    });
    deps.binRestoredExactly = true;

    const outcomes = ensureTools(
      resolution([{ name: "cargo-deny", version: "0.16.1" }]),
      deps,
    );

    expect(outcomes[0]?.action).toBe("installed");
  });

  // The `probe.present` conjunct, which mutation testing showed nothing
  // pinned: replacing `probe.present && version === undefined` with `true`
  // survived. An ABSENT tool must still be installed even on an exact bin
  // hit — the hit proves the archive matched this tool set, not that this
  // particular binary made it onto disk.
  it("installs an absent tool even when the bin layer hit exactly", () => {
    const deps = runner({ "cargo-deny": [absent] });
    deps.binRestoredExactly = true;

    const outcomes = ensureTools(
      resolution([{ name: "cargo-deny", version: "0.16.1" }]),
      deps,
    );

    expect(outcomes[0]?.action).toBe("installed");
    expect(deps.calls.map((call) => call.file)).toEqual([
      "cargo-deny",
      "cargo",
    ]);
  });

  it("installs an absent tool with a locked, forced, pinned argv", () => {
    const deps = runner({ "cargo-nextest": [absent] });
    ensureTools(
      resolution([{ name: "cargo-nextest", version: "0.9.100" }]),
      deps,
    );
    expect(deps.calls[1]).toEqual({
      file: "cargo",
      args: [
        "install",
        "cargo-nextest",
        "--version",
        "0.9.100",
        "--locked",
        "--force",
      ],
    });
  });

  it("retries a failed install with growing backoff", () => {
    const deps = runner({
      "cargo-deny": [absent],
      cargo: [{ status: 1 }, { status: 0 }],
    });
    const outcomes = ensureTools(
      resolution([{ name: "cargo-deny", version: "0.16.1" }]),
      deps,
    );
    expect(outcomes[0]?.action).toBe("installed");
    expect(deps.pauses).toEqual([1_000]);
  });

  // Two failures, not one, and that is the entire point. `2 ** 0` is 1, so a
  // single pause is 1000 ms whether the backoff multiplies or DIVIDES by the
  // power — the test above passes either way, which is how an inverted backoff
  // survived mutation testing. The second pause is the first value that can
  // tell them apart: 2000 when it grows, 500 when it shrinks.
  it("doubles the pause on each successive attempt", () => {
    const deps = runner({
      "cargo-deny": [absent],
      cargo: [{ status: 1 }, { status: 1 }, { status: 0 }],
    });
    ensureTools(resolution([{ name: "cargo-deny", version: "0.16.1" }]), deps);
    expect(deps.pauses).toEqual([1_000, 2_000]);
  });

  // Pins the attempt COUNT, which nothing else did: `attempt <= attempts`
  // mutated to `<` runs two installs instead of three and every other test
  // here still passes, because none of them counts the calls.
  //
  // The pause list is the second half of the same assertion. Three attempts
  // means two pauses — a job that has already failed is not made slower by
  // waiting for a retry that will never happen.
  it("makes exactly `attempts` install attempts, pausing between them only", () => {
    const deps = runner({
      "cargo-deny": [absent],
      cargo: [{ status: 1 }, { status: 1 }, { status: 1 }],
    });
    expect(() =>
      ensureTools(
        resolution([{ name: "cargo-deny", version: "0.16.1" }]),
        deps,
      ),
    ).toThrow();

    expect(deps.calls.filter((call) => call.file === "cargo")).toHaveLength(3);
    expect(deps.pauses).toEqual([1_000, 2_000]);
  });

  it("fails once the install attempts are exhausted", () => {
    const deps = runner({
      "cargo-deny": [absent],
      cargo: [{ status: 1 }, { status: 1 }, { status: 1 }],
    });
    expect(() =>
      ensureTools(
        resolution([{ name: "cargo-deny", version: "0.16.1" }]),
        deps,
      ),
    ).toThrow(/cargo install cargo-deny/);
  });

  it("names a spawn failure rather than an exit code", () => {
    const deps = runner({
      "cargo-deny": [absent],
      cargo: [absent, absent, absent],
    });
    expect(() =>
      ensureTools(
        resolution([{ name: "cargo-deny", version: "0.16.1" }]),
        deps,
      ),
    ).toThrow(/could not run/);
  });

  // D1: a registry outage must not fail a job whose tool is already present.
  it("accepts an unresolved tool that is already installed, and warns", () => {
    const warnings: string[] = [];
    const deps = runner({
      "cargo-deny": [{ status: 0, stdout: "cargo-deny 0.15.0" }],
    });
    deps.log.warning = (message): void => {
      warnings.push(message);
    };
    const outcomes = ensureTools(
      resolution(
        [{ name: "cargo-deny", version: UNRESOLVED_VERSION }],
        [{ name: "cargo-deny", reason: "503" }],
      ),
      deps,
    );
    expect(outcomes).toEqual([
      { name: "cargo-deny", version: UNRESOLVED_VERSION, action: "unverified" },
    ]);
    expect(deps.calls.map((c) => c.file)).toEqual(["cargo-deny"]);
    expect(warnings.join("\n")).toMatch(/registry could not be reached/);
  });

  // ...but with nothing to fall back to there is no honest way to continue.
  it("fails an unresolved tool that is not installed", () => {
    const deps = runner({ "cargo-deny": [absent] });
    expect(() =>
      ensureTools(
        resolution(
          [{ name: "cargo-deny", version: UNRESOLVED_VERSION }],
          [{ name: "cargo-deny", reason: "503" }],
        ),
        deps,
      ),
    ).toThrow(/nothing to fall back to/);
  });

  it("handles a mixed set in the order requested", () => {
    const deps = runner({
      "a-tool": [{ status: 0, stdout: "a-tool 1.0.0" }],
      "b-tool": [absent],
    });
    expect(
      ensureTools(
        resolution([
          { name: "a-tool", version: "1.0.0" },
          { name: "b-tool", version: "2.0.0" },
        ]),
        deps,
      ).map((o) => `${o.name}:${o.action}`),
    ).toEqual(["a-tool:kept", "b-tool:installed"]);
  });

  it("does nothing when no tools were requested", () => {
    const deps = runner();
    expect(ensureTools(resolution([]), deps)).toEqual([]);
    expect(deps.calls).toEqual([]);
  });
});
