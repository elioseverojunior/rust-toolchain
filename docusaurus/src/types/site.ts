// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * The view model every component renders.
 *
 * Two source files feed this site and they were authored for different jobs:
 * `github-profile.yaml` is a curated pitch (headline, tagline, per-role
 * accomplishment bullets), `profile.yaml` is the complete structured record
 * (72 skills carrying depth ratings, 14 dated roles). Neither shape is imposed
 * on the components — both are adapted into the types below, so the landing
 * page and /cv share one set of components while being driven by the file each
 * was written for.
 *
 * Adaptation happens in Node at config time. That is also the privacy boundary:
 * `customFields` is serialised into the client bundle, so only what appears
 * here ever reaches a browser.
 */

export interface SiteLink {
  readonly name: string;
  readonly handle: string;
  readonly url: string;
}

/**
 * A quantified outcome. `display` is the figure exactly as written in the
 * source ("243", "~60%"), while `value`/`prefix`/`suffix` are the parsed parts
 * the count-up animation needs. `value` is null when no number could be read,
 * in which case the display string is rendered verbatim and never animated.
 */
export interface SiteMetric {
  readonly id: string;
  readonly display: string;
  readonly value: number | null;
  readonly prefix: string;
  readonly suffix: string;
  /** What the figure measures. */
  readonly label: string;
  /** How it was achieved. */
  readonly detail?: string;
  /** Employer, when the metric is attributed to one. */
  readonly source?: string;
}

export interface SiteSkill {
  readonly name: string;
  /** Self-assessed depth 1-5, when the record carries one. */
  readonly level?: number;
  /** Flagged `prominence: 1` — the work this career is presented around. */
  readonly core: boolean;
}

export interface SiteSkillGroup {
  readonly id: string;
  readonly label: string;
  readonly skills: readonly SiteSkill[];
}

/**
 * One title held at an employer. A promotion within the same company is a new
 * tenure, not a new employer — see `SiteRole`.
 */
export interface SiteTenure {
  readonly id: string;
  readonly title: string;
  /** Preformatted, e.g. `Mar 2020 — Nov 2021`. */
  readonly period: string;
  /** Preformatted, e.g. `1 yr 8 mos`. */
  readonly duration: string;
  /** Accomplishment prose, present only in the curated source. */
  readonly bullets: readonly string[];
  /** Technology names, present only in the structured record. */
  readonly tech: readonly SiteSkill[];
  readonly metrics: readonly SiteMetric[];
}

/**
 * A continuous stretch at one employer, covering every title held there.
 *
 * Both sources record a promotion as a separate entry — three consecutive Rdi
 * Software rows, for instance. Rendering those as three sibling blocks repeats
 * the employer name three times and reads as three jobs rather than one
 * four-year tenure with two promotions. Consecutive same-employer entries are
 * therefore folded into a single role carrying several `tenures`.
 */
export interface SiteRole {
  readonly id: string;
  readonly company: string;
  /** Most recent title held, for compact single-line rendering. */
  readonly title: string;
  /** Spans every tenure, e.g. `Jul 2017 — Nov 2021`. */
  readonly period: string;
  /** Total across every tenure. */
  readonly duration: string;
  readonly industry?: string;
  readonly current: boolean;
  /**
   * Whether this role is expanded on the landing page. Taken from the curated
   * source's own `featured` flag rather than a "most recent N" cutoff, so the
   * editorial decision stays in the data file. A role is featured when any of
   * its tenures is.
   */
  readonly featured: boolean;
  /** Newest first. Always at least one. */
  readonly tenures: readonly SiteTenure[];
}

export interface SiteProject {
  readonly id: string;
  readonly name: string;
  /** Display label, e.g. `Rust crate`, `Terraform provider`. */
  readonly kind: string;
  readonly summary: string;
  readonly url: string;
  /** Source repository, when known. */
  readonly repo?: string;
  /** Lifetime downloads from the registry, when a figure has been fetched. */
  readonly downloads?: number;
}

/** A package published too recently for a download figure to carry meaning. */
export interface SiteRecentProject {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly shipped: string;
}

export interface SiteEducation {
  readonly degree: string;
  readonly field: string;
  readonly institution: string;
  /**
   * Year of completion, carried as the number the record states. Nothing
   * computes with it — the component renders it directly — so it is never
   * stringified at the adapter: `String(undefined)` is the one conversion that
   * would put the text "undefined" on the page instead of failing.
   *
   * Optional because a course still in progress has no completion year.
   */
  readonly year?: number;
  /** `finished` or `in-progress`, so the view can say which. */
  readonly state: string;
}

export interface SiteCertification {
  readonly name: string;
  readonly issuer: string;
  readonly year?: number;
}

export interface SiteProfile {
  readonly name: string;
  readonly acronym: string;
  readonly headline: string;
  readonly tagline: string;
  readonly summary: string;
  readonly location: string;
  readonly email: string;
  readonly startYear: number;
  readonly years: number;
  readonly links: readonly SiteLink[];
  readonly languages: readonly string[];
  readonly currentRole?: SiteRole;
  readonly metrics: readonly SiteMetric[];
  readonly roles: readonly SiteRole[];
  readonly skillGroups: readonly SiteSkillGroup[];
  readonly skillCount: number;
  readonly projects: readonly SiteProject[];
  readonly recentProjects: readonly SiteRecentProject[];
  /** Sum of every known per-project download figure. */
  readonly downloadsTotal: number;
  readonly education: readonly SiteEducation[];
  readonly certifications: readonly SiteCertification[];
}

/** Both views, built at config time and handed to the client together. */
export interface SiteData {
  /** Curated pitch — drives `/`. */
  readonly landing: SiteProfile;
  /** Complete record — drives `/cv`. */
  readonly cv: SiteProfile;
}
