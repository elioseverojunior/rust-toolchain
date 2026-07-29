#!/usr/bin/env bun

// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Validates every ```mermaid block in the given Markdown files.
 *
 * markdownlint checks the fence, not the diagram inside it, so a syntax error
 * only shows up as a broken render on GitHub. mermaid's own parser is the only
 * authority on its grammar; it needs a DOM, which `@happy-dom/global-registrator`
 * supplies far more cheaply than the Chromium that mermaid-cli would pull in.
 *
 * Usage: bun scripts/lint-mermaid.ts [file.md ...]
 * With no arguments every tracked Markdown file is checked.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

interface Block {
  file: string;
  /** 1-based line of the opening fence, so editors can jump to it. */
  line: number;
  source: string;
}

const IGNORED = [
  "node_modules",
  "dist",
  "coverage",
  ".remember",
  ".rumdl_cache",
  ".act",
];

/** Matches a fenced mermaid block, tolerating indentation inside lists. */
const FENCE = /^([ \t]*)```mermaid[^\n]*\n([\s\S]*?)^\1```/gm;

function extractBlocks(file: string, text: string): Block[] {
  const blocks: Block[] = [];
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(0, match.index);
    blocks.push({
      file,
      line: before.split("\n").length,
      source: match[2] ?? "",
    });
  }
  return blocks;
}

async function collectFiles(args: string[]): Promise<string[]> {
  const explicit = args.filter((arg) => arg.endsWith(".md"));
  if (explicit.length > 0) return explicit;

  const found: string[] = [];
  for await (const file of new Bun.Glob("**/*.md").scan(".")) {
    if (!IGNORED.some((dir) => file.split("/").includes(dir))) found.push(file);
  }
  return found.sort();
}

async function main(): Promise<number> {
  const files = await collectFiles(Bun.argv.slice(2));

  const blocks: Block[] = [];
  for (const file of files) {
    const text = await Bun.file(file).text();
    blocks.push(...extractBlocks(file, text));
  }

  if (blocks.length === 0) {
    console.log("No mermaid diagrams found.");
    return 0;
  }

  // Registered before mermaid loads: DOMPurify installs hooks at import time
  // and throws without a document.
  GlobalRegistrator.register();
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, logLevel: "fatal" });

  let failed = 0;
  for (const block of blocks) {
    try {
      await mermaid.parse(block.source);
    } catch (error) {
      failed++;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${block.file}:${block.line} invalid mermaid diagram`);
      for (const line of detail.split("\n").slice(0, 4)) {
        console.error(`  ${line}`);
      }
    }
  }

  const scope = `${blocks.length} diagram${blocks.length === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}`;
  if (failed > 0) {
    console.error(`\n${failed} of ${scope} failed to parse.`);
    return 1;
  }
  console.log(`Success: ${scope} parsed.`);
  return 0;
}

process.exit(await main());
