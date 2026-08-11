// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Counter } from "@site/src/components/portfolio/Counter";
import { Section } from "@site/src/components/portfolio/Section";
import type { SiteMetric, SiteProfile } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

function Tile({ metric }: { readonly metric: SiteMetric }): ReactNode {
  return (
    <li className={clsx("els-panel", styles.tile)} data-reveal>
      {metric.source !== undefined && (
        <p className={clsx("els-label", styles.employer)}>{metric.source}</p>
      )}
      <Counter className={styles.value} metric={metric} />
      <p className={styles.label}>{metric.label}</p>
      {metric.detail !== undefined && (
        <p className={styles.detail}>{metric.detail}</p>
      )}
    </li>
  );
}

/**
 * Every quantified outcome in one place — the section a recruiter scans first,
 * so it leads the page. Each figure is the one written in the source; nothing
 * is rounded up or restated.
 */
export function Impact({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  return (
    <Section
      id="impact"
      index="01"
      label="Impact"
      title={
        <>
          Outcomes, <em>measured</em>
        </>
      }
      intro="Figures carried over from the record, with the mechanism that produced each one. Nothing here is an estimate."
    >
      <ul className={styles.grid}>
        {profile.metrics.map((metric) => (
          <Tile key={metric.id} metric={metric} />
        ))}
      </ul>
    </Section>
  );
}
