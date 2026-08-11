// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Counter } from "@site/src/components/portfolio/Counter";
import { Section } from "@site/src/components/portfolio/Section";
import type { SiteProfile, SiteRole, SiteTenure } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

/** The body of one title: prose from the curated source, figures and stack
 *  from the structured record. A tenure has one or the other, never both. */
function TenureBody({ tenure }: { readonly tenure: SiteTenure }): ReactNode {
  return (
    <>
      {tenure.bullets.length > 0 && (
        <ul className={styles.bullets}>
          {tenure.bullets.map((bullet) => (
            <li className={styles.bullet} key={bullet.slice(0, 48)}>
              {bullet}
            </li>
          ))}
        </ul>
      )}

      {tenure.metrics.length > 0 && (
        <ul className={styles.outcomes}>
          {tenure.metrics.map((metric) => (
            <li className={styles.outcome} key={metric.id}>
              <Counter className={styles.outcomeValue} metric={metric} />
              <span className={styles.outcomeClaim}>
                {metric.detail ?? metric.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tenure.tech.length > 0 && (
        <ul className={styles.chips}>
          {tenure.tech.map((skill) => (
            <li
              className={clsx(styles.chip, skill.core && styles.chipCore)}
              key={skill.name}
            >
              {skill.name}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Entry({ role }: { readonly role: SiteRole }): ReactNode {
  const promoted = role.tenures.length > 1;
  const sole = role.tenures[0];

  return (
    <li className={styles.entry} data-reveal>
      <span
        className={clsx(styles.node, role.current && styles.nodeLive)}
        aria-hidden="true"
      />
      <div className={styles.body}>
        <p className={clsx("els-label", styles.period)}>
          {role.period}
          <span className={styles.sep}>/</span>
          {role.duration}
          {promoted && (
            <>
              <span className={styles.sep}>/</span>
              <span className={styles.progression}>
                {role.tenures.length} roles
              </span>
            </>
          )}
        </p>

        <h3 className={styles.employer}>{role.company}</h3>
        {role.industry !== undefined && (
          <p className={styles.industry}>{role.industry}</p>
        )}

        {promoted ? (
          // Several titles at one employer: each gets its own sub-block on a
          // shared rail, so the progression reads as one tenure with
          // promotions rather than three unrelated jobs.
          <ol className={styles.tenures}>
            {role.tenures.map((tenure) => (
              <li className={styles.tenure} key={tenure.id}>
                <div className={styles.tenureHead}>
                  <h4 className={styles.tenureTitle}>{tenure.title}</h4>
                  <p className={clsx("els-label", styles.tenureMeta)}>
                    {tenure.period}
                    <span className={styles.sep}>/</span>
                    {tenure.duration}
                  </p>
                </div>
                <TenureBody tenure={tenure} />
              </li>
            ))}
          </ol>
        ) : (
          sole !== undefined && (
            <>
              <p className={styles.titles}>{sole.title}</p>
              <TenureBody tenure={sole} />
            </>
          )
        )}
      </div>
    </li>
  );
}

export interface HistoryProps {
  readonly profile: SiteProfile;
  /** `/cv` expands every role; the landing page expands only featured ones. */
  readonly expandAll?: boolean;
}

/**
 * Reverse-chronological history on a single rail.
 *
 * Which roles get expanded is an editorial decision that belongs in the data,
 * not here: the curated source flags them with `featured`, and this component
 * honours it. Everything else is condensed to one line — a recruiter needs the
 * recent work in depth and the early work only as proof of continuity.
 */
export function History({
  profile,
  expandAll = false,
}: HistoryProps): ReactNode {
  const recent = expandAll
    ? profile.roles
    : profile.roles.filter((role) => role.featured);
  const earlier = expandAll
    ? []
    : profile.roles.filter((role) => !role.featured);

  return (
    <Section
      id="history"
      index="03"
      label="History"
      title={
        <>
          Where the work <em>happened</em>
        </>
      }
      intro="Retail banking, telecom, quick-service restaurant e-commerce, EdTech, agribusiness and B2B SaaS — the constant is production systems other people depend on."
    >
      <ol className={styles.rail}>
        {recent.map((role) => (
          <Entry key={role.id} role={role} />
        ))}
      </ol>

      {earlier.length > 0 && (
        <div className={styles.earlier} data-reveal>
          <p className={clsx("els-label", styles.earlierLabel)}>
            Earlier · {earlier.length} roles
          </p>
          <ol className={styles.earlierList}>
            {earlier.map((role) => (
              <li className={styles.earlierRow} key={role.id}>
                <span className={styles.earlierPeriod}>{role.period}</span>
                <span className={styles.earlierEmployer}>{role.company}</span>
                <span className={styles.earlierTitle}>{role.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
}
