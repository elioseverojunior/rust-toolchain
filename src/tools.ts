// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { isRustupIdentifier, parseCommaList } from "@rust-toolchain/config";

/**
 * One entry of the `cargo-tools` input, before any version resolution.
 *
 * `version` is `"latest"` for a bare name, which is a request rather than a
 * value: it does not become concrete until the registry has answered. Anything
 * else is what the caller pinned, and a pinned version never needs the network
 * at all — which is what keeps a registry outage from touching it.
 */
export interface ToolSpec {
  name: string;
  version: string;
}

/** What a bare name resolves to, and the only non-version `version` value. */
const LATEST = "latest";

/**
 * Reads the `cargo-tools` input into one spec per tool.
 *
 * Accepts the same comma, whitespace and newline separators as `targets` and
 * `components`, through the same `parseCommaList`, so the separator grammar
 * keeps one definition rather than three that agree by intention.
 *
 * Both halves of an entry are validated, not just the name. They reach
 * `cargo install` as argv and commands run without a shell, so this is a
 * second line of defence rather than the only one — but a value that cannot
 * name a crate or a version is a configuration error worth reporting before
 * cargo fails obscurely on it.
 */
export function parseToolSpecs(value: string): ToolSpec[] {
  const specs = parseCommaList(value).map(toSpec);

  // Exact-name matching. crates.io treats `foo-bar` and `foo_bar` as one
  // crate, so that pair slips through here; encoding the registry's
  // normalisation is a bigger claim than this function should make, and the
  // failure mode is a duplicate install rather than a wrong one.
  const seen = new Set<string>();
  for (const { name } of specs) {
    if (seen.has(name)) {
      throw new Error(
        `\`cargo-tools\` lists ${name} more than once. Two versions of one ` +
          "tool cannot both be installed, so pick the one you want rather " +
          "than leaving the choice to the order they were written in.",
      );
    }
    seen.add(name);
  }

  return specs;
}

/**
 * Splits one `<name>[@<version>]` entry.
 *
 * Split on the FIRST `@`, so a second one stays in the version where the
 * identifier check rejects it. Splitting on the last would read
 * `cargo-deny@0.16.1@2.0` as the plausible-looking name `cargo-deny@0.16.1`.
 */
function toSpec(entry: string): ToolSpec {
  const at = entry.indexOf("@");
  const name = at === -1 ? entry : entry.slice(0, at);
  const version = at === -1 ? LATEST : entry.slice(at + 1);

  assertIdentifier("name", name, entry);
  assertIdentifier("version", version, entry);

  return { name, version };
}

function assertIdentifier(
  kind: "name" | "version",
  value: string,
  entry: string,
): void {
  if (isRustupIdentifier(value)) return;
  throw new Error(
    `"${value}" is not a valid cargo tool ${kind}, in \`cargo-tools\` entry ` +
      `"${entry}". Entries look like \`<name>\` or \`<name>@<version>\`, ` +
      "where both halves are letters, digits, dots, underscores and dashes.",
  );
}
