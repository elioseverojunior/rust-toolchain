// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { SiteProfile } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

/**
 * Closing block. It deliberately breaks the numbered-section rhythm used above
 * — full-bleed and unindexed — so the page has an ending rather than simply
 * stopping.
 *
 * The phone number in profile.yaml never reaches this component: the adapters
 * drop it before the view model is built. This page is public and permanently
 * indexed, and email plus LinkedIn is the reachable surface a recruiter needs.
 */
export function Contact({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  return (
    <section className={styles.contact} id="contact">
      <div className={clsx("els-shell", styles.shell)}>
        <div className={styles.inner} data-reveal>
          <p className={clsx("els-label", styles.label)}>Contact</p>

          <h2 className={styles.headline}>
            Let&apos;s build something that <em>stays up</em>
          </h2>

          <a className={styles.email} href={`mailto:${profile.email}`}>
            {profile.email}
            <span aria-hidden="true">→</span>
          </a>

          <ul className={styles.links}>
            {profile.links.map((link) => (
              <li className={styles.linkItem} key={link.url}>
                <a
                  className={styles.link}
                  href={link.url}
                  rel="noopener noreferrer me"
                  target="_blank"
                >
                  <span className={clsx("els-label", styles.linkName)}>
                    {link.name}
                  </span>
                  <span className={styles.linkHandle}>{link.handle}</span>
                  <span className={styles.linkArrow} aria-hidden="true">
                    ↗
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className="els-label">Based in</dt>
              <dd className={styles.factValue}>{profile.location}</dd>
            </div>
            <div className={styles.fact}>
              <dt className="els-label">Languages</dt>
              <dd className={styles.factValue}>
                {profile.languages.join(" · ")}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
