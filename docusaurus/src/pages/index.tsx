// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import styles from "./index.module.css";

const FEATURES: readonly { title: string; details: string }[] = [
  {
    title: "rust-toolchain.toml by default",
    details:
      "The channel, targets, components and profile come from the file already in your repository. Action inputs override it — scalars are replaced, lists merge deduped with your inputs leading.",
  },
  {
    title: "Layered cargo cache",
    details:
      "The registry and target directories are keyed separately, so a compiler bump no longer re-downloads the crates it never touched. The build key folds in the resolved toolchain and the CARGO_/RUST* environment.",
  },
  {
    title: "Saves what is worth saving",
    details:
      "An exact hit is never re-saved, a layer over cache-budget is skipped with a warning, and every layer's real outcome is reported in the job summary rather than behind one cache-hit boolean.",
  },
  {
    title: "RUSTUP_TOOLCHAIN wins later steps",
    details:
      "rustup default alone loses to a workspace rust-toolchain.toml. The resolved channel is exported so it applies to every later step, with set-rustup-toolchain false for monorepos that pin per crate.",
  },
  {
    title: "Typed outputs with provenance",
    details:
      "Every resolved value is published, lists as JSON arrays, plus a json output carrying all of them natively typed alongside inputs and toml blocks saying where each value came from.",
  },
  {
    title: "A drop-in superset",
    details:
      "The cachekey output matches dtolnay/rust-toolchain byte for byte, and cache-workspaces takes the same syntax as Swatinem/rust-cache, so an existing value transfers unchanged.",
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <header className={styles.hero}>
        <h1>{siteConfig.title}</h1>
        <p className={styles.text}>
          Install Rust and cache cargo in one action
        </p>
        <p className={styles.tagline}>
          Reads the rust-toolchain.toml you already committed, installs it with
          rustup, and restores and saves the cargo cache in layers — no second
          action required.
        </p>
        <div className={styles.actions}>
          <Link
            className="button button--primary button--lg"
            to="/ARCHITECTURE"
          >
            Architecture
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/COMPARISON"
          >
            What this replaces
          </Link>
          <Link
            className="button button--secondary button--lg"
            href="https://github.com/elioseverojunior/rust-toolchain"
          >
            View on GitHub
          </Link>
        </div>
      </header>
      <main className={styles.features}>
        {FEATURES.map((f) => (
          <section key={f.title} className={styles.feature}>
            <h2>{f.title}</h2>
            <p>{f.details}</p>
          </section>
        ))}
      </main>
    </Layout>
  );
}
