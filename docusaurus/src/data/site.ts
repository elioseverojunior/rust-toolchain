// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

import type { SiteData, SiteProfile } from "@site/src/types/site";

/**
 * Reads the view model that docusaurus.config.ts built at config time.
 *
 * The cast is the one unavoidable seam: Docusaurus types `customFields` as
 * `Record<string, unknown>`, so the shape is asserted here, once, rather than
 * at every call site.
 */
export function useSite(): SiteData {
  const { siteConfig } = useDocusaurusContext();
  return siteConfig.customFields?.site as SiteData;
}

/** The curated pitch that drives the landing page. */
export function useLanding(): SiteProfile {
  return useSite().landing;
}

/** The complete structured record that drives /cv. */
export function useRecord(): SiteProfile {
  return useSite().cv;
}
