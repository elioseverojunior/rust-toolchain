// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import useIsBrowser from "@docusaurus/useIsBrowser";
import { useEffect } from "react";

/**
 * Reveals every `[data-reveal]` element on the page as it scrolls into view by
 * flipping `data-revealed="true"`; the transition itself lives in custom.css.
 *
 * One page-level observer rather than one per component: the elements are known
 * at mount and never change, so N observers would buy nothing.
 *
 * Elements are unobserved once revealed — this is a one-way reveal, not a
 * scroll-linked effect that re-hides content the reader has already passed.
 */
export function useReveal(): void {
  const isBrowser = useIsBrowser();

  useEffect(() => {
    if (!isBrowser) {
      return;
    }

    const targets = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );

    // Without IntersectionObserver, or when the reader has asked for reduced
    // motion, everything is simply shown. Content is never gated on animation.
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      targets.forEach((element) => {
        element.dataset.revealed = "true";
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const element = entry.target as HTMLElement;
          element.dataset.revealed = "true";
          observer.unobserve(element);
        });
      },
      // Fires a little before the element's top edge arrives, so the motion
      // resolves as it enters rather than after it has already been read.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );

    targets.forEach((element) => observer.observe(element));
    return (): void => observer.disconnect();
  }, [isBrowser]);
}
