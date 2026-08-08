// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "bun:test";

import type { RegistryClient, ResolveDeps, ToolSpec } from "@/tools";
import {
  parseToolSpecs,
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
