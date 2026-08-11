// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

export interface SectionProps {
  /** Anchor target, referenced by the navbar. */
  readonly id: string;
  /** Two-digit console index, e.g. "01". */
  readonly index: string;
  readonly label: string;
  readonly title: ReactNode;
  readonly intro?: ReactNode;
  readonly children: ReactNode;
}

/**
 * The repeating section frame: index, tracked label, a rule that runs to the
 * edge, then an editorial title. Every section on the site uses it, so the
 * page reads as one instrument rather than a stack of unrelated blocks.
 */
export function Section({
  id,
  index,
  label,
  title,
  intro,
  children,
}: SectionProps): ReactNode {
  return (
    <section className={styles.section} id={id}>
      <div className="els-shell">
        <header className={styles.header} data-reveal>
          <div className={styles.marker}>
            <span className={styles.index}>{index}</span>
            <span className={clsx("els-label", styles.label)}>{label}</span>
            <span className={styles.rule} aria-hidden="true" />
          </div>
          <h2 className={styles.title}>{title}</h2>
          {intro !== undefined && <p className={styles.intro}>{intro}</p>}
        </header>
        {children}
      </div>
    </section>
  );
}
