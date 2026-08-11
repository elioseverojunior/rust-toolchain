// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

// Relative, not `@site/*`: this module is imported by docusaurus.config.ts and
// evaluated in plain Node, where the `@site` alias does not exist.
import type {
  DownloadCache,
  Profile,
  Skill,
  SkillKind,
} from "../types/profile";
import type {
  SiteCertification,
  SiteLink,
  SiteMetric,
  SiteProfile,
  SiteProject,
  SiteRole,
  SiteSkill,
  SiteSkillGroup,
} from "../types/site";

import {
  formatDuration,
  formatPeriod,
  parseMetric,
  parseYearMonth,
  prose,
} from "./format";

/* ==========================================================================
   Shared helpers
   ========================================================================== */

/**
 * The two sources name the same tool differently — the record writes
 * "AWS Athena" and "HashiCorp Consul" where the curated file writes "Athena"
 * and "Consul". Stripping the vendor prefix lets depth ratings from the record
 * attach to the curated groups instead of silently failing to match.
 */
function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(aws|amazon|hashicorp|apache)\s+/, "")
    .replace(/[^a-z0-9+#]/g, "");
}

function toSiteSkill(skill: Skill): SiteSkill {
  // Highlighted on `level`, not `prominence` — see the skill-group mapping in
  // adaptLanding for why depth is the signal a reader is actually scanning for.
  // Highlighted from level 4 up — see the skill-group mapping in adaptLanding
  // for why the threshold sits there rather than at 5.
  return { name: skill.name, level: skill.level, core: skill.level >= 4 };
}

/**
 * Deepest first, then alphabetical.
 *
 * The source order is authored per group, which put a level-2 tool above a
 * level-5 one wherever the list happened to be written that way. Sorting by
 * depth makes each group lead with what is actually owned; the name tiebreak
 * keeps equal-depth runs stable and scannable rather than dependent on how the
 * YAML was typed.
 *
 * `localeCompare` rather than `<`, so "C#" and ".NET Framework" sort where a
 * reader expects rather than by code point.
 */
function sortByDepthThenName(skills: readonly SiteSkill[]): SiteSkill[] {
  return [...skills].sort(
    (a, b) =>
      (b.level ?? 0) - (a.level ?? 0) || a.name.localeCompare(b.name, "en"),
  );
}

function sumDownloads(projects: readonly SiteProject[]): number {
  return projects.reduce(
    (total, project) => total + (project.downloads ?? 0),
    0,
  );
}

function earliestYear(starts: readonly string[], fallback: number): number {
  const years = starts
    .map((start) => parseYearMonth(start)?.year)
    .filter((year): year is number => year !== undefined);
  return years.length === 0 ? fallback : Math.min(...years);
}

/**
 * Substitutes `{{years}}` in prose with the years computed from the record.
 *
 * The tagline and summary state a length of career, which is the one claim on
 * the page that silently rots — "20+ years" was written once and would have to
 * be remembered every January. Writing `{{years}}` instead keeps the sentence
 * in the data file while deriving the number from the earliest start date, so
 * it is correct on its own.
 */
function applyTokens(text: string, years: number): string {
  return text.replace(/\{\{\s*years\s*\}\}/g, String(years));
}

/* ==========================================================================
   Employer grouping
   ========================================================================== */

/** One title at one employer, before grouping. */
interface RawTenure {
  readonly id: string;
  readonly company: string;
  readonly industry?: string;
  readonly title: string;
  readonly start: string;
  /** `null` (record) or the string `present` (curated file) means open. */
  readonly end: string | null;
  readonly featured: boolean;
  readonly bullets: readonly string[];
  readonly tech: readonly SiteSkill[];
  readonly metrics: readonly SiteMetric[];
}

function isOpen(end: string | null): boolean {
  return end === null || end === "present";
}

/**
 * Folds consecutive entries at the same employer into one role.
 *
 * Both sources record a promotion as a separate entry — Rdi Software appears
 * three times, as developer, senior, then lead. Rendered as three sibling
 * blocks that repeats the employer name three times and reads as three
 * separate jobs rather than one four-year tenure with two promotions, which
 * undersells exactly the roles that show progression.
 *
 * Only *consecutive* entries are folded, so a genuine return to a former
 * employer years later would still stand as its own role.
 */
function groupByEmployer(raw: readonly RawTenure[], now: Date): SiteRole[] {
  const groups: RawTenure[][] = [];

  raw.forEach((tenure) => {
    const current = groups.at(-1);
    const head = current?.[0];
    if (current !== undefined && head?.company === tenure.company) {
      current.push(tenure);
    } else {
      groups.push([tenure]);
    }
  });

  return groups.flatMap((members): SiteRole[] => {
    // Entries arrive newest-first, so the span runs from the last member's
    // start to the first member's end.
    const newest = members[0];
    const oldest = members[members.length - 1];
    if (newest === undefined || oldest === undefined) {
      return [];
    }

    return [
      {
        id: newest.id,
        company: newest.company,
        title: newest.title,
        period: formatPeriod(oldest.start, newest.end),
        duration: formatDuration(oldest.start, newest.end, now),
        industry: members.find((member) => member.industry !== undefined)
          ?.industry,
        current: isOpen(newest.end),
        featured: members.some((member) => member.featured),
        tenures: members.map((member) => ({
          id: member.id,
          title: member.title,
          period: formatPeriod(member.start, member.end),
          duration: formatDuration(member.start, member.end, now),
          bullets: member.bullets,
          tech: member.tech,
          metrics: member.metrics,
        })),
      },
    ];
  });
}

/* ==========================================================================
   Landing view — driven by the curated pitch
   ========================================================================== */

/**
 * Builds the landing view from the profile record.
 *
 * Everything comes from `data/profile.yml`. A second curated file used to
 * supply the positioning copy and the per-role bullets; it is gone, and the
 * fields it held now live on `person` and `Role` respectively.
 */
export function adaptLanding(
  record: Profile,
  downloads: DownloadCache,
  now: Date,
): SiteProfile {
  const depthByName = new Map(
    record.skills.map((skill) => [normalizeSkillName(skill.name), skill]),
  );

  // Only roles carrying authored prose reach the landing page. The record runs
  // back to 2003 and the early entries exist for the CV, where the full history
  // is the point; leading with all fourteen would bury the recent four.
  const roles = groupByEmployer(
    record.experience
      .filter((entry) => (entry.bullets ?? []).length > 0)
      .map((entry, index): RawTenure => ({
        id: `${entry.employer}-${entry.start}-${index}`,
        company: entry.employer,
        industry: entry.industry,
        // `titles` is a list because one continuous tenure can carry several;
        // the landing page shows the one held longest, which is the first.
        title: entry.titles[0] ?? "",
        start: entry.start,
        end: entry.end ?? "present",
        featured: entry.featured ?? false,
        bullets: (entry.bullets ?? []).map(prose),
        tech: [],
        metrics: [],
      })),
    now,
  );

  // Every measured figure, by id, so `impact` can name one instead of
  // restating it.
  const metricsById = new Map(
    record.experience.flatMap((role) =>
      role.metrics.map((metric) => [metric.id, metric] as const),
    ),
  );

  const metrics: SiteMetric[] = record.impact.map((entry, index) => {
    const referenced = entry.metrics.map((id) => {
      const metric = metricsById.get(id);
      if (metric === undefined) {
        // Loud on purpose. A silent skip would drop a headline figure from the
        // page and leave the remaining tiles looking deliberate.
        throw new Error(
          `impact[${index}] references unknown metric id "${id}". ` +
            `Valid ids: ${[...metricsById.keys()].join(", ")}`,
        );
      }
      return metric;
    });

    // Summing is what turns 216 non-production and 27 production migrations
    // into the single 243 they were. Percentages are never summed, so a
    // multi-id percentage entry is a data error rather than a rounding one.
    const unit = referenced[0]?.unit ?? "";
    if (referenced.length > 1 && unit === "percent") {
      throw new Error(
        `impact[${index}] sums ${referenced.length} percentages, which is not a meaningful figure.`,
      );
    }
    const total = referenced.reduce((sum, metric) => sum + metric.value, 0);
    const display = unit === "percent" ? `${total}%` : String(total);
    const parsed = parseMetric(display);

    return {
      id: `impact-${index}`,
      display,
      value: parsed.value,
      prefix: parsed.prefix,
      suffix: parsed.suffix,
      label: prose(entry.label),
      detail: entry.detail === undefined ? undefined : prose(entry.detail),
    };
  });

  // `skill_groups` is presentation and `skills` is the record; this is the join
  // between them, and a name present in one but not the other is a data error
  // rather than a rendering choice. Collected across every group before
  // throwing, so one build reports all of them instead of one per run.
  //
  // It fails loudly because the alternative is what shipped: an unmatched name
  // renders its label with an empty depth rail, which reads as a broken
  // component rather than a missing entry. Java, Alloy, Jaeger and Kiali sat
  // on the live page that way until someone looked closely at a screenshot.
  const unmatched: string[] = [];

  const skillGroups: SiteSkillGroup[] = record.skill_order
    .map((label) => ({
      id: label.toLowerCase().replace(/\s+/g, "-"),
      label,
      skills: (record.skill_groups[label] ?? []).map((name) => {
        const known = depthByName.get(normalizeSkillName(name));
        if (known === undefined) {
          unmatched.push(`${label}/${name}`);
        }
        // Highlighted on depth, not on `prominence`, and from level 4 rather
        // than 5. The record draws its line there too: 4 is "delivered to
        // production unaided", 3 is "delivered with support, or in an earlier
        // role" — so 4 is the first level that says the work was owned. A
        // threshold of 5 dimmed tools carried to production single-handed,
        // which is the opposite of what the highlight is for.
        //
        // `prominence` answers a different question (which direction the
        // career is heading) and is left to the consumers that ask it.
        return { name, level: known?.level, core: (known?.level ?? 0) >= 4 };
      }),
    }))
    .map((group) => ({ ...group, skills: sortByDepthThenName(group.skills) }))
    .filter((group) => group.skills.length > 0);

  if (unmatched.length > 0) {
    // The normalized form is what actually failed to match, so it is worth
    // printing: "Grafana Cloud" and "grafanacloud" look like different
    // problems until you know the join strips punctuation and vendor prefixes.
    throw new Error(
      `skill_groups names with no entry in skills[]: ${unmatched.join(", ")}. ` +
        `Add each to skills[] in data/profile.yml, or remove it from its group. ` +
        `Names are matched after normalisation (lowercased, punctuation removed, ` +
        `a leading aws/amazon/hashicorp/apache dropped), so "AWS Athena" matches "Athena".`,
    );
  }

  const crates: SiteProject[] = record.projects
    .filter((project) => project.kind === "crate")
    .map((crate) => ({
      id: `crate-${crate.id}`,
      name: crate.name,
      kind: "Rust crate",
      summary: crate.summary,
      url: crate.url,
      downloads: downloads[`crate:${crate.name}`],
    }));

  const providers: SiteProject[] = record.projects
    .filter((project) => project.kind === "terraform-provider")
    .map((provider) => {
      // The record stores the registry URL, not the namespace and name as
      // separate fields, so the download-cache key is read back out of it:
      //   https://registry.terraform.io/providers/<ns>/<name>/latest/docs
      // A URL that does not match yields no key, and the entry simply renders
      // without a figure rather than reporting someone else's downloads.
      const parts = /\/providers\/([^/]+)\/([^/]+)/.exec(provider.url);
      const namespace = parts?.[1];
      const registryName = parts?.[2];
      return {
        id: `provider-${provider.id}`,
        name: provider.name,
        kind: "Terraform provider",
        summary: provider.summary,
        url: provider.url,
        downloads:
          namespace === undefined || registryName === undefined
            ? undefined
            : downloads[`provider:${namespace}/${registryName}`],
      };
    });

  // Highest usage first: the table doubles as evidence, so the strongest
  // figures should not be buried behind alphabetical accident.
  const projects = [...crates, ...providers].sort(
    (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
  );

  // The record already stores links as name/handle/url, so nothing is derived
  // here. Entries pointing at this site are dropped: sending a visitor back to
  // the page they are on is noise.
  const links: SiteLink[] = record.person.links.filter(
    (link) => !link.url.includes("elioseverojunior.github.io"),
  );

  const startYear = earliestYear(
    record.experience.map((role) => role.start),
    now.getFullYear(),
  );

  return {
    name: record.person.name,
    acronym: record.person.acronym,
    headline: record.person.headline,
    tagline: applyTokens(record.person.tagline, now.getFullYear() - startYear),
    summary: applyTokens(record.person.summary, now.getFullYear() - startYear),
    location: record.person.location,
    email: record.person.email,
    startYear,
    years: now.getFullYear() - startYear,
    links,
    languages: record.person.languages.map(
      (language) => `${language.name} (${language.level})`,
    ),
    currentRole: roles.find((role) => role.current),
    metrics,
    roles,
    skillGroups,
    skillCount: skillGroups.reduce(
      (total, group) => total + group.skills.length,
      0,
    ),
    projects,
    // The record has no "recently shipped" concept — every published project
    // is in `projects` with its registry figures, which is the stronger
    // evidence anyway. Kept as an empty list so the section renders nothing
    // rather than the view model gaining an optional field for one consumer.
    recentProjects: [],
    downloadsTotal: sumDownloads(projects),
    education: record.education.map((entry) => ({
      degree: entry.degree,
      field: entry.field,
      institution: entry.institution,
      year: entry.year,
      state: entry.state,
    })),
    certifications: record.certifications.map((entry): SiteCertification => ({
      name: entry.name,
      // The source leaves one issuer blank; rendering an empty heading would
      // look like a bug, so it is labelled honestly instead.
      issuer: entry.issuer === "" ? "Independent" : entry.issuer,
    })),
  };
}

/* ==========================================================================
   CV view — driven by the complete structured record
   ========================================================================== */

const KIND_ORDER: readonly SkillKind[] = [
  "cloud",
  "container",
  "iac",
  "cicd",
  "observability",
  "language",
  "database",
  "storage",
  "framework",
  "methodology",
];

const KIND_LABELS: Readonly<Record<SkillKind, string>> = {
  cloud: "Cloud Platforms",
  container: "Containers & Orchestration",
  iac: "Infrastructure as Code",
  cicd: "Delivery & CI/CD",
  observability: "Observability",
  language: "Languages",
  database: "Data & Databases",
  storage: "Storage & Messaging",
  framework: "Frameworks",
  methodology: "Ways of Working",
};

/** Builds the long-form view from `profile.yaml` — every role, every skill. */
export function adaptRecord(
  record: Profile,
  downloads: DownloadCache,
  now: Date,
): SiteProfile {
  const byId = new Map(record.skills.map((skill) => [skill.id, skill]));

  const roles = groupByEmployer(
    record.experience.map((role): RawTenure => ({
      id: role.id,
      company: role.employer,
      industry: role.industry,
      title: role.titles.join(" · "),
      start: role.start,
      end: role.end,
      // The record carries no editorial flag; /cv expands everything anyway.
      featured: true,
      bullets: [],
      tech: role.tech
        .map((id) => byId.get(id))
        .filter((skill): skill is Skill => skill !== undefined)
        .map(toSiteSkill),
      metrics: role.metrics.map((metric) => {
        const display = `${metric.value}${metric.unit === "percent" ? "%" : ""}`;
        const parsed = parseMetric(display);
        return {
          id: `${role.id}-${metric.id}`,
          display,
          value: parsed.value,
          prefix: parsed.prefix,
          suffix: parsed.suffix,
          label: metric.unit === "percent" ? "" : metric.unit,
          detail: prose(metric.claim),
          source: role.employer,
        };
      }),
    })),
    now,
  );

  const skillGroups: SiteSkillGroup[] = KIND_ORDER.map((kind) => ({
    id: kind,
    label: KIND_LABELS[kind],
    // Same ordering as the landing page: depth first, then name. This used to
    // lead with `prominence`, which sorted by where the career is heading
    // rather than by what is owned — and put an unrated tool above a level-5
    // one, since absent prominence sorts last.
    skills: sortByDepthThenName(
      record.skills.filter((skill) => skill.kind === kind).map(toSiteSkill),
    ),
  })).filter((group) => group.skills.length > 0);

  const projects: SiteProject[] = record.projects
    .map((project) => {
      const isCrate = project.kind === "crate";
      // Registry namespace is not a field in the record; it is recoverable
      // from the published URL, which is transcribed there verbatim.
      const namespace = /providers\/([^/]+)\//.exec(project.url)?.[1];
      const registryName = /providers\/[^/]+\/([^/]+)/.exec(project.url)?.[1];
      const key = isCrate
        ? `crate:${project.name}`
        : `provider:${namespace ?? ""}/${registryName ?? ""}`;
      return {
        id: project.id,
        name: project.name,
        kind: isCrate ? "Rust crate" : "Terraform provider",
        summary: prose(project.summary),
        url: project.url,
        downloads: downloads[key],
      };
    })
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));

  const startYear = earliestYear(
    record.experience.map((role) => role.start),
    now.getFullYear(),
  );

  return {
    name: record.person.name,
    acronym: record.person.acronym,
    headline: "Senior SRE & Cloud Engineer",
    tagline: "",
    summary: "",
    location: record.person.location,
    email: record.person.email,
    startYear,
    years: now.getFullYear() - startYear,
    links: record.person.links.map((link) => ({
      name: link.name,
      handle: link.handle,
      url: link.url,
    })),
    languages: record.person.languages.map(
      (language) => `${language.name} (${language.level})`,
    ),
    currentRole: roles.find((role) => role.current),
    metrics: roles.flatMap((role) =>
      role.tenures.flatMap((tenure) => tenure.metrics),
    ),
    roles,
    skillGroups,
    skillCount: record.skills.length,
    projects,
    recentProjects: [],
    downloadsTotal: sumDownloads(projects),
    education: record.education.map((entry) => ({
      degree: entry.degree,
      field: entry.field,
      institution: entry.institution,
      year: entry.year,
      state: entry.state,
    })),
    certifications: record.certifications.map((entry) => ({
      name: entry.name,
      issuer: entry.issuer,
      year: entry.year,
    })),
  };
}
