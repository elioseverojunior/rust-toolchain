// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Types for `data/profile.yml`.
 *
 * That file is the single source of truth for every fact on this site. It is
 * supplied by the `profile-data` submodule mounted at `data/`, which is shared
 * with the other consumers of this career record — so a field is added there
 * once and every consumer sees it. These declarations describe its shape so the
 * rest of the site can consume it under `strict` mode rather than passing
 * `unknown` around.
 *
 * A former second file, `github-profile.yaml`, carried the positioning copy and
 * the per-role bullets. It is gone: everything it held now lives in
 * `profile.yml`, because two files describing one career is two files to keep
 * in agreement.
 *
 * Dates arrive as strings, not `Date`. `start: 2024-10` is not a YAML 1.2
 * timestamp (that requires a full yyyy-mm-dd), so the parser leaves it as the
 * string "2024-10" — verified against the real file rather than assumed.
 */

/** Skill category, as used by the `kind` key. */
export type SkillKind =
  | "cloud"
  | "container"
  | "iac"
  | "cicd"
  | "observability"
  | "language"
  | "framework"
  | "database"
  | "storage"
  | "methodology";

/**
 * Self-assessed depth, 1-5. Per profile.yaml: 5 = daily working tool, owned
 * and debugged unaided in production; 1 = aware only.
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * How central a skill is to how this career is presented — deliberately
 * independent of `level`. 1 = lead with this, 3 = include if there is room.
 * Absent means "do not feature".
 */
export type Prominence = 1 | 2 | 3;

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly kind: SkillKind;
  readonly level: SkillLevel;
  readonly prominence?: Prominence;
}

/** A quantified outcome attached to a role. */
export interface Metric {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly claim: string;
}

export interface Role {
  readonly id: string;
  readonly employer: string;
  readonly industry?: string;
  /** `YYYY-MM`. */
  readonly start: string;
  /** `YYYY-MM`, or `null` for the current role. */
  readonly end: string | null;
  readonly titles: readonly string[];
  /** Skill `id`s, resolved against `Profile.skills`. */
  readonly tech: readonly string[];
  readonly metrics: readonly Metric[];
  /**
   * Whether the landing page leads with this role. Optional: the record runs
   * back to 2003, and the early entries are carried for the CV rather than the
   * pitch.
   */
  readonly featured?: boolean;
  /**
   * Authored prose for the landing page. Optional for the same reason as
   * `featured` — a role with none is simply not shown there. Distinct from
   * `metrics`, which is the measured record; these are the sentences chosen to
   * describe the work.
   */
  readonly bullets?: readonly string[];
}

export interface ProfileLink {
  readonly name: string;
  readonly handle: string;
  readonly url: string;
}

export interface SpokenLanguage {
  readonly name: string;
  readonly level: string;
}

export interface Person {
  readonly name: string;
  readonly acronym: string;
  readonly email: string;
  readonly location: string;
  /** Role title shown under the name. */
  readonly headline: string;
  /**
   * One-line positioning. May contain the `{{years}}` token, substituted at
   * build time from the earliest `start` in `experience` so the figure cannot
   * drift out of date.
   */
  readonly tagline: string;
  /** Opening paragraph. Also `{{years}}`-aware. */
  readonly summary: string;
  /**
   * Optional because it is stripped before the profile reaches the browser —
   * see docusaurus.config.ts. It exists in data/profile.yaml, never in the
   * shipped bundle.
   */
  readonly phone?: string;
  readonly links: readonly ProfileLink[];
  readonly languages: readonly SpokenLanguage[];
}

export interface Education {
  readonly degree: string;
  readonly field: string;
  readonly institution: string;
  /**
   * Year of completion. Absent while `state` is `in-progress` — there is no
   * completion year yet, and inventing one would be a claim the record cannot
   * support. Optional here because the data really is optional: nothing
   * validates this file at runtime (it is cast, not parsed), so a type that
   * overstates it just moves the failure to render time.
   */
  readonly year?: number;
  /** `finished` or `in-progress`. */
  readonly state: string;
}

export interface Certification {
  readonly name: string;
  readonly issuer: string;
  readonly year?: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url: string;
  readonly summary: string;
}

/**
 * A headline figure.
 *
 * Curated in selection, derived in value: `metrics` names ids from
 * `Role.metrics` rather than restating a number, so each figure is written
 * down once in the role that earned it. More than one id sums them — that is
 * how 216 non-production and 27 production migrations are shown as 243.
 * `label` and `detail` remain authored, because which mechanism is worth
 * naming is a judgement rather than a measurement.
 */
export interface Impact {
  readonly metrics: readonly string[];
  readonly label: string;
  readonly detail?: string;
}

/** Registry download totals, keyed `crate:<name>` / `provider:<ns>/<name>`. */
export type DownloadCache = Readonly<Record<string, number>>;

export interface Profile {
  readonly person: Person;
  readonly impact: readonly Impact[];
  /** Group labels for the Stack section, in display order. */
  readonly skill_order: readonly string[];
  /** Group label to skill names. Presentation only; `skills` is the record. */
  readonly skill_groups: Readonly<Record<string, readonly string[]>>;
  readonly skills: readonly Skill[];
  readonly experience: readonly Role[];
  readonly education: readonly Education[];
  readonly certifications: readonly Certification[];
  readonly projects: readonly Project[];
}

/** A metric paired with the role it was achieved in, for flat rendering. */
export interface AttributedMetric extends Metric {
  readonly employer: string;
  readonly roleId: string;
}
