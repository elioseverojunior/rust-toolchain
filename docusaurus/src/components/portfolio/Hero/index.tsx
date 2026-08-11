// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import Link from "@docusaurus/Link";
import { Counter } from "@site/src/components/portfolio/Counter";
import type { SiteProfile } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

/** `Elio Severo Junior` -> `["Elio Severo", "Junior"]`. */
function splitName(name: string): readonly [string, string] {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop();
  return last === undefined ? [name, ""] : [parts.join(" "), last];
}

export function Hero({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  const [firstNames, lastName] = splitName(profile.name);
  const role = profile.currentRole;
  // Two readouts: enough to prove the claim, few enough to stay a hero.
  const readouts = profile.metrics.slice(0, 2);
  const core = profile.skillGroups
    .flatMap((group) => group.skills)
    .filter((skill) => skill.core);
  const ticker =
    core.length > 0 ? core : (profile.skillGroups[0]?.skills ?? []);

  return (
    <header className={styles.hero}>
      {/* Slow horizontal sweep, like a console refreshing its panels. */}
      <span className={styles.sweep} aria-hidden="true" />
      <span className={styles.monogram} aria-hidden="true">
        {profile.acronym}
      </span>

      <div className={clsx("els-shell", styles.shell)}>
        <div className={styles.grid}>
          <div className={styles.lead}>
            <p className={clsx("els-label", styles.status)}>
              <span className={styles.beacon} aria-hidden="true" />
              In production since {profile.startYear}
              <span className={styles.divider}>/</span>
              {profile.location}
              <span className={styles.divider}>/</span>
              {profile.languages.join(" · ")}
            </p>

            <h1 className={styles.name}>
              <span className={styles.nameLine}>{firstNames}</span>
              <span className={clsx(styles.nameLine, styles.nameAccent)}>
                {lastName}
              </span>
            </h1>

            <p className={styles.role}>
              {profile.headline}
              {role !== undefined && (
                <>
                  <span className={styles.at}>at</span>
                  {role.company}
                </>
              )}
            </p>

            <p className={styles.lede}>{profile.summary}</p>

            <div className={styles.actions}>
              <a className={styles.primary} href={`mailto:${profile.email}`}>
                Start a conversation
                <span aria-hidden="true">→</span>
              </a>
              <Link className={styles.secondary} to="/cv">
                Read the full CV
              </Link>
            </div>
          </div>

          <aside className={clsx("els-panel", styles.panel)}>
            <p className={clsx("els-label", styles.panelLabel)}>
              Current deployment
            </p>
            <p className={styles.panelEmployer}>
              {role?.company ?? profile.name}
            </p>
            <p className={styles.panelTitle}>
              {role?.title ?? profile.headline}
            </p>
            {role !== undefined && (
              <p className={styles.panelMeta}>
                {role.period}
                <span className={styles.divider}>/</span>
                {role.duration}
              </p>
            )}

            <ul className={styles.readouts}>
              {readouts.map((metric) => (
                <li className={styles.readout} key={metric.id}>
                  <Counter className={styles.readoutValue} metric={metric} />
                  <p className={styles.readoutClaim}>{metric.label}</p>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>

      {/*
        Status ticker. Duplicated once and translated by exactly -50% so the
        loop is seamless; aria-hidden because the same tools are listed
        properly, and readably, in the Stack section.
      */}
      <div className={styles.ticker} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {[0, 1].map((copy) => (
            <span className={styles.tickerRun} key={copy}>
              {ticker.map((skill) => (
                <span
                  className={styles.tickerItem}
                  key={`${copy}-${skill.name}`}
                >
                  {skill.name}
                  <span className={styles.tickerDot}>●</span>
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}
