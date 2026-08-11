// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Counter } from "@site/src/components/portfolio/Counter";
import { Section } from "@site/src/components/portfolio/Section";
import { formatCount } from "@site/src/data/format";
import type { SiteMetric, SiteProfile } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

/** `https://crates.io/crates/rust-yaml` -> `crates.io`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Published packages, each on a public registry.
 *
 * This is the only section a reader can verify without asking anyone — a
 * registry page either exists or it does not, and the download figure either
 * matches or it does not.
 *
 * Rows are anchors in a list rather than a `<table>`: every row is a link to
 * its registry page, and link rows inside table cells are both awkward to
 * operate with a keyboard and hard to reflow on a narrow screen. The columns
 * are aligned with grid so it still reads as a table.
 */
export function Shipped({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  const measured = profile.projects.filter(
    (project) => project.downloads !== undefined,
  );

  const total: SiteMetric = {
    id: "downloads-total",
    display: formatCount(profile.downloadsTotal),
    value: profile.downloadsTotal,
    prefix: "",
    suffix: "",
    label: "registry downloads",
  };

  return (
    <Section
      id="shipped"
      index="04"
      label="Open Source"
      title={
        <>
          Published, and <em>checkable</em>
        </>
      }
      intro="Infrastructure tooling on crates.io and the Terraform Registry, authored and maintained across two accounts. Every row below links to a public package page."
    >
      {profile.downloadsTotal > 0 && (
        <div className={clsx("els-panel", styles.total)} data-reveal>
          <Counter className={styles.totalValue} grouped metric={total} />
          <p className={styles.totalLabel}>
            registry downloads across {measured.length} published packages
          </p>
        </div>
      )}

      <ul className={styles.table} data-reveal>
        <li className={clsx("els-label", styles.head)} aria-hidden="true">
          <span>Package</span>
          <span>Kind</span>
          <span className={styles.numeric}>Downloads</span>
        </li>

        {profile.projects.map((project) => (
          <li className={styles.row} key={project.id}>
            <a
              className={styles.rowLink}
              href={project.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className={styles.cellName}>
                <span className={styles.name}>{project.name}</span>
                <span className={styles.summary}>{project.summary}</span>
              </span>
              <span className={styles.cellKind}>
                <span className={styles.kind}>{project.kind}</span>
                <span className={styles.host}>{hostOf(project.url)}</span>
              </span>
              <span className={clsx(styles.cellCount, styles.numeric)}>
                {project.downloads === undefined ? (
                  <span className={styles.noCount}>—</span>
                ) : (
                  formatCount(project.downloads)
                )}
                <span className={styles.arrow} aria-hidden="true">
                  ↗
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>

      {/*
        Announced beneath the table, never as a row in it. Everything in the
        table is also a term in the combined total above, so a just-published
        package would sit as a near-zero row directly under the strongest claim
        on the page — counted, but not measured on a number that has had no
        time to mean anything.
      */}
      {profile.recentProjects.length > 0 && (
        <div className={styles.recent} data-reveal>
          <p className={clsx("els-label", styles.recentLabel)}>
            Recently shipped · too new to measure
          </p>
          <ul className={styles.recentList}>
            {profile.recentProjects.map((project) => (
              <li key={project.id}>
                <a
                  className={styles.recentItem}
                  href={project.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <span className={styles.recentName}>{project.name}</span>
                  <span className={styles.recentSummary}>
                    {project.summary}
                  </span>
                  <span className={styles.recentShipped}>
                    {project.shipped} ↗
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
