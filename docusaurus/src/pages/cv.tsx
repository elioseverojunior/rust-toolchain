// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Contact } from "@site/src/components/portfolio/Contact";
import { Credentials } from "@site/src/components/portfolio/Credentials";
import { History } from "@site/src/components/portfolio/History";
import { Impact } from "@site/src/components/portfolio/Impact";
import { Shipped } from "@site/src/components/portfolio/Shipped";
import { Stack } from "@site/src/components/portfolio/Stack";
import { useRecord } from "@site/src/data/site";
import { useReveal } from "@site/src/hooks/useReveal";
import Layout from "@theme/Layout";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./cv.module.css";

/**
 * The long form of the same career.
 *
 * Driven by `profile.yaml` — the complete structured record — where the
 * landing page is driven by the curated pitch. Same components, same design
 * language, deeper data: every role expanded, all 72 rated skills, every
 * certification.
 */
export default function Cv(): ReactNode {
  const profile = useRecord();
  useReveal();

  const role = profile.currentRole;

  return (
    <Layout
      description={`Full curriculum vitae of ${profile.name} — ${profile.headline}. Complete role history, capability matrix, published packages and credentials.`}
      title="Full CV"
    >
      <header className={styles.masthead}>
        <div className="els-shell">
          <p className={clsx("els-label", styles.label)}>
            Curriculum vitae · {profile.startYear}–present
          </p>
          <h1 className={styles.name}>{profile.name}</h1>
          <p className={styles.role}>
            {role?.title ?? profile.headline}
            {role !== undefined && ` · ${role.company}`}
          </p>

          <dl className={styles.meta}>
            <div className={styles.metaItem}>
              <dt className="els-label">Email</dt>
              <dd className={styles.metaValue}>
                <a href={`mailto:${profile.email}`}>{profile.email}</a>
              </dd>
            </div>
            <div className={styles.metaItem}>
              <dt className="els-label">Location</dt>
              <dd className={styles.metaValue}>{profile.location}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt className="els-label">Experience</dt>
              <dd className={styles.metaValue}>{profile.years} years</dd>
            </div>
            <div className={styles.metaItem}>
              <dt className="els-label">Languages</dt>
              <dd className={styles.metaValue}>
                {profile.languages.join(" · ")}
              </dd>
            </div>
          </dl>

          <ul className={styles.links}>
            {profile.links.map((link) => (
              <li key={link.url}>
                <a
                  className={styles.link}
                  href={link.url}
                  rel="noopener noreferrer me"
                  target="_blank"
                >
                  {link.name} {link.handle} ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      </header>

      <main>
        <Impact profile={profile} />
        <History expandAll profile={profile} />
        <Stack profile={profile} />
        <Shipped profile={profile} />
        <Credentials profile={profile} />
      </main>
      <Contact profile={profile} />
    </Layout>
  );
}
