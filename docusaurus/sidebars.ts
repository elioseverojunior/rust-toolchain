// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * Hand-authored sidebar transcribed from the VitePress site's
 * `docs/.vitepress/config.mts` (deleted in Task 4). The VitePress original
 * carried nine entries; this carries eleven, because the migration's own
 * design record and implementation plan were written after it and belong
 * here too.
 */
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: ["ARCHITECTURE", "COMPARISON", "RUNBOOKS"],
    },
    {
      type: "category",
      label: "Design records",
      items: [
        "design/2026-07-31-layered-cargo-cache",
        "design/2026-07-31-layered-cargo-cache-phase-b",
        "design/2026-08-10-docusaurus-migration",
      ],
    },
    {
      type: "category",
      label: "Implementation plans",
      items: [
        "plans/2026-07-31-layered-cargo-cache-phase-a",
        "plans/2026-07-31-layered-cargo-cache-phase-b",
        "plans/2026-08-07-layered-cargo-cache-phase-c",
        "plans/2026-08-08-layered-cargo-cache-phase-d",
        "plans/2026-08-11-docusaurus-migration",
      ],
    },
  ],
};

export default sidebars;
