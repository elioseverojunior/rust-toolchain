// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Section } from "@site/src/components/portfolio/Section";
import type { SiteCertification, SiteProfile } from "@site/src/types/site";
import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

/** Certifications keyed by issuer, preserving first-seen issuer order. */
function byIssuer(
  certifications: readonly SiteCertification[],
): Array<[string, SiteCertification[]]> {
  const grouped = new Map<string, SiteCertification[]>();
  certifications.forEach((certification) => {
    const bucket = grouped.get(certification.issuer);
    if (bucket === undefined) {
      grouped.set(certification.issuer, [certification]);
    } else {
      bucket.push(certification);
    }
  });
  return Array.from(grouped.entries());
}

export function Credentials({
  profile,
}: {
  readonly profile: SiteProfile;
}): ReactNode {
  const issuers = byIssuer(profile.certifications);

  return (
    <Section
      id="credentials"
      index="05"
      label="Credentials"
      title={
        <>
          Formal <em>record</em>
        </>
      }
    >
      <div className={styles.layout}>
        <div className={styles.education} data-reveal>
          <p className={clsx("els-label", styles.blockLabel)}>Education</p>
          {profile.education.map((entry) => (
            <div
              className={styles.degree}
              key={`${entry.institution}-${entry.field}`}
            >
              <h3 className={styles.degreeTitle}>
                {entry.degree} · {entry.field}
              </h3>
              <p className={styles.institution}>{entry.institution}</p>
              {/*
                A course in progress has no completion year, so the year slot
                says what is true instead of rendering an empty styled line —
                which is what a bare {entry.year} produced for the PUC-SP
                specialization.
              */}
              <p className={clsx("els-label", styles.year)}>
                {entry.year ?? "In progress"}
              </p>
            </div>
          ))}
        </div>

        <div className={styles.certifications} data-reveal>
          <p className={clsx("els-label", styles.blockLabel)}>
            Certifications · {profile.certifications.length}
          </p>
          <div className={styles.issuers}>
            {issuers.map(([issuer, items]) => (
              <div className={styles.issuer} key={issuer}>
                <h3 className={styles.issuerName}>{issuer}</h3>
                <ul className={styles.certList}>
                  {items.map((certification) => (
                    <li className={styles.cert} key={certification.name}>
                      <span>{certification.name}</span>
                      {certification.year !== undefined && (
                        <span className={styles.certYear}>
                          {certification.year}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
