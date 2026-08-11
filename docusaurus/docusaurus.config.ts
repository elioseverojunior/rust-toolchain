// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Path prefix the site is served under.
 *
 * GitHub project pages serve under /<repo>/, so baseUrl must match or every
 * asset 404s. DOCS_BASE=/ builds for root-domain hosting. Docusaurus asserts
 * both leading and trailing slash.
 */
const baseUrl = process.env.DOCS_BASE ?? "/rust-toolchain/";

const config: Config = {
  title: "rust-toolchain",
  tagline: "Install Rust and cache cargo in one action",
  favicon: "img/favicon.svg",

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: "https://elioseverojunior.github.io",
  baseUrl,
  organizationName: "elioseverojunior",
  projectName: "rust-toolchain",
  // Read only by `docusaurus deploy`, which is not how this site ships: the
  // publishing workflow uploads the built directory straight to Pages, so no
  // gh-pages branch is ever created by Docusaurus itself.
  deploymentBranch: "gh-pages",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  // `onBrokenMarkdownLinks` lives here rather than as a top-level key: the
  // top-level form is deprecated in 3.10 and removed in Docusaurus v4, and it
  // warns on every build until moved. Task 4 adds `mermaid: true` to this same
  // block.
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

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
    // instrumentation. custom.css still uses all three.
    //
    // Fraunces requests its `opsz` axis (9..144) rather than a fixed optical
    // size, so the same face stays sturdy across every size it is set at.
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
        // No docs/ content exists yet - enabling the docs plugin against an
        // empty content directory fails the build. A later task in this
        // migration supplies docs/ and flips this on. Blog stays off; this
        // site has no blog.
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
    colorMode: {
      // The design commits to a single dark control-room palette. A light
      // variant would be a different design, not a tint of this one.
      defaultMode: "dark",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "rust-toolchain",
    },
    footer: {
      style: "dark",
      copyright: `Copyright © ${new Date().getFullYear()} elioseverojunior. Built with Docusaurus.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
