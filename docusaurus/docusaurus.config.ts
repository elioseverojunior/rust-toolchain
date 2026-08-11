// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { parse as parseYaml } from "yaml";

import { adaptLanding, adaptRecord } from "./src/data/adapt";
import type { DownloadCache, Profile } from "./src/types/profile";
import type { SiteData } from "./src/types/site";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Content pipeline.
 *
 * Two files under data/ feed this site, both supplied by the `profile-data`
 * submodule mounted there:
 *
 *   profile.yml           the whole record — positioning copy, dated history,
 *                         per-role bullets, skill depth ratings, impact
 *   .download-cache.json  registry download totals, refreshed by
 *                         `bun run fetch:downloads`
 *
 * There was a second YAML file, github-profile.yaml, holding a curated pitch.
 * It is gone: one career described by two files is two files to keep in
 * agreement, and they had already drifted — the site was publishing an 83%
 * figure the record put at 75%.
 *
 * They are parsed and adapted into a view model here, in Node, rather than
 * through a bundler loader rule: @docusaurus/faster swaps webpack for Rspack,
 * and hand-written loader rules do not reliably survive that swap.
 *
 * This is also the privacy boundary. `customFields` is serialised verbatim into
 * the client JavaScript bundle, so anything reachable from it ships to every
 * visitor whether or not a component renders it — the phone number in
 * profile.yml is dropped by the adapters and never reaches the browser.
 */
const dataDir = path.join(__dirname, "data");

function readYaml<T>(file: string): T {
  return parseYaml(fs.readFileSync(path.join(dataDir, file), "utf8")) as T;
}

/**
 * The download cache is generated, not authored. A fresh clone that has not run
 * the fetch script yet must still build — projects simply render without a
 * download figure.
 */
function readDownloads(): DownloadCache {
  const file = path.join(dataDir, ".download-cache.json");
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DownloadCache;
}

const now = new Date();
// Read once and shared by both adapters: parsing the same 20 KB of YAML twice
// per build bought nothing, and two parses could not disagree usefully anyway.
const record = readYaml<Profile>("profile.yml");
const downloads = readDownloads();
const site: SiteData = {
  landing: adaptLanding(record, downloads, now),
  cv: adaptRecord(record, downloads, now),
};

const { landing } = site;
const primaryGithub = landing.links.find((link) => link.name === "GitHub");

/**
 * Path prefix the site is served under.
 *
 * This repository publishes its own GitHub Pages site, so the site sits on a
 * subpath of the user domain rather than at its root — the root belongs to the
 * separate elioseverojunior.github.io repository.
 *
 * Declared as a constant because Docusaurus only prefixes the paths it owns:
 * `<Link to>`, navbar `to:` entries and the relative `favicon` / `image` fields
 * are rewritten for you, but a `headTags` href is emitted verbatim and has to
 * carry the prefix itself. Anything root-absolute that skips this constant is a
 * 404 in production and a working link in local development, which is the worst
 * combination available.
 */
const baseUrl = "/";

const config: Config = {
  title: landing.name,
  tagline: landing.headline,
  favicon: "img/favicon.svg",

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: "https://elioseverojunior.github.io",
  baseUrl,
  organizationName: "elioseverojunior",
  // The GitHub Pages user site: this repository IS elioseverojunior.github.io,
  // which is why baseUrl is "/" rather than a project subpath.
  projectName: "rust-toolchain-and-cache",
  // Read only by `docusaurus deploy`, which is not how this site ships:
  // .github/workflows/publish.yml uploads the built directory straight to
  // Pages, so no gh-pages branch is ever created.
  deploymentBranch: "gh-pages",
  trailingSlash: false,

  onBrokenLinks: "throw",
  // The navbar links to #impact, #history, #stack and #shipped. Those ids are
  // emitted by React section components, and Docusaurus' anchor checker only
  // collects anchors it can extract statically from Markdown headings — so it
  // reports every one of them as broken. The ids are asserted against the
  // built HTML instead, in the build verification.
  onBrokenAnchors: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  customFields: { site },

  headTags: [
    {
      tagName: "link",
      attributes: { rel: "preconnect", href: "https://fonts.googleapis.com" },
    },
    {
      tagName: "link",
      attributes: {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "anonymous",
      },
    },
    {
      tagName: "link",
      attributes: {
        rel: "apple-touch-icon",
        href: `${baseUrl}img/apple-touch-icon.png`,
      },
    },
  ],

  stylesheets: [
    // Fraunces carries the display voice, Archivo the prose, IBM Plex Mono the
    // instrumentation.
    //
    // Fraunces requests its `opsz` axis (9..144) rather than a fixed optical
    // size: the same face sets a 7rem hero name and a 1.75rem employer name,
    // and without optical sizing the small end goes spindly on a dark ground —
    // the exact failure that made the previous didone the weak link.
    //
    // Archivo's `wdth` axis is deliberately not requested. Only the default
    // width is used, and asking for the range would ship a larger file for a
    // capability nothing calls.
    //
    // Weights are enumerated rather than requested as ranges to keep the
    // payload small.
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,600;1,9..144,700&family=Archivo:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
  ],

  presets: [
    [
      "classic",
      {
        // This is a portfolio, not a documentation site. Both content plugins
        // are off so no empty /docs or /blog route can ship; the template
        // folders remain on disk, inert, if either is ever wanted back.
        docs: false,
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: {
          lastmod: "date",
          changefreq: "monthly",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    metadata: [
      { name: "description", content: landing.summary },
      {
        name: "keywords",
        content:
          "SRE, Site Reliability Engineer, Platform Engineer, AWS, Kubernetes, EKS, Terraform, OpenTofu, Istio, Karpenter, ArgoCD, Observability, FinOps, Rust",
      },
      { name: "author", content: landing.name },
    ],
    colorMode: {
      // The design commits to a single dark control-room palette. A light
      // variant would be a different design, not a tint of this one.
      defaultMode: "dark",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: landing.acronym,
      // Pinned, not hide-on-scroll. This page is one long scroll through five
      // numbered sections and the navbar is how a reader jumps between them —
      // a bar that disappears the moment you scroll down is missing exactly
      // when it is wanted. custom.css already assumed this: its
      // `scroll-padding-top` reserves the navbar height so anchor targets are
      // not hidden underneath, which only makes sense for a bar that stays.
      hideOnScroll: false,
      items: [
        { to: "/#impact", label: "Impact", position: "left" },
        // Navbar order tracks the page order, so a reader scanning the bar and
        // a reader scrolling the page meet the sections in the same sequence.
        { to: "/#stack", label: "Stack", position: "left" },
        { to: "/#history", label: "Experience", position: "left" },
        { to: "/#shipped", label: "Open Source", position: "left" },
        { to: "/cv", label: "Full CV", position: "right" },
        ...(primaryGithub
          ? [
              {
                href: primaryGithub.url,
                label: "GitHub",
                position: "right" as const,
              },
            ]
          : []),
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Contact",
          items: [{ label: landing.email, href: `mailto:${landing.email}` }],
        },
        {
          title: "Elsewhere",
          items: landing.links.map((link) => ({
            label: `${link.name} ${link.handle}`,
            href: link.url,
          })),
        },
        {
          title: "This site",
          items: [
            { label: "Full CV", to: "/cv" },
            {
              label: "Source",
              href: "https://github.com/elioseverojunior/elioseverojunior.github.io",
            },
          ],
        },
      ],
      copyright: `${landing.name} · ${landing.location} · built with Docusaurus`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
