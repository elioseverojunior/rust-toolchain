// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Section } from "@site/src/components/portfolio/Section";
import type { SiteProfile, SiteSkill } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

const SEGMENTS = [1, 2, 3, 4, 5] as const;

function Depth({ skill }: { readonly skill: SiteSkill }): ReactNode {
  const level = skill.level;
  if (level === undefined) {
    return null;
  }
  return (
    <span
      className={styles.depth}
      role="img"
      aria-label={`Depth ${level} of 5`}
    >
      {SEGMENTS.map((segment) => (
        <span
          className={clsx(
            styles.segment,
            segment <= level && styles.segmentOn,
            segment <= level && skill.core && styles.segmentCore,
          )}
          key={segment}
        />
      ))}
    </span>
  );
}

/**
 * The capability matrix, grouped by discipline.
 *
 * Depth is shown honestly, shallow entries included: a matrix where everything
 * reads 5/5 tells a reader nothing. The scale is printed in the legend so the
 * bars mean something specific rather than implying a ranking the record never
 * claimed. Tools the record carries no rating for simply show no bar.
 */
export function Stack({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  return (
    <Section
      id="stack"
      index="02"
      label="Stack"
      title={
        <>
          What I <em>actually</em> run
        </>
      }
      intro={`${profile.skillCount} tools, rated for depth rather than exposure. Amber marks the ones this career is built around.`}
    >
      <p className={clsx("els-label", styles.legend)}>
        <span className={styles.legendKey} aria-hidden="true">
          <span className={clsx(styles.segment, styles.segmentOn)} />
          <span className={clsx(styles.segment, styles.segmentOn)} />
          <span className={clsx(styles.segment, styles.segmentOn)} />
          <span className={styles.segment} />
          <span className={styles.segment} />
        </span>
        Depth 1–5 · 5 = designs, owns and debugs it unaided in production
      </p>

      <div className={styles.groups}>
        {profile.skillGroups.map((group) => (
          <section
            className={clsx("els-panel", styles.group)}
            data-reveal
            key={group.id}
          >
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>{group.label}</h3>
              <span className={styles.groupCount}>{group.skills.length}</span>
            </header>
            <ul className={styles.skills}>
              {group.skills.map((skill) => (
                <li
                  className={clsx(styles.skill, skill.core && styles.skillCore)}
                  key={skill.name}
                >
                  <span className={styles.skillName}>{skill.name}</span>
                  <Depth skill={skill} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Section>
  );
}
