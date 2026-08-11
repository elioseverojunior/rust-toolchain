// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import useIsBrowser from "@docusaurus/useIsBrowser";
import { useEffect, useRef, useState } from "react";

/** Decelerating curve — fast start, long settle, so the final digits land softly. */
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - 2 ** (-10 * t);
}

export interface CountUp {
  readonly ref: React.RefObject<HTMLSpanElement | null>;
  readonly value: number;
}

/**
 * Counts from zero to `target` the first time the element enters the viewport.
 *
 * State starts at `target`, not zero, on purpose: the server-rendered HTML then
 * contains the real figure, so search crawlers and any reader without JS see
 * "243", not "0". `useIsBrowser` stays false through the first client render, so
 * hydration matches the server exactly; only afterwards does the value drop to
 * zero and animate up.
 */
export function useCountUp(target: number, durationMs = 1500): CountUp {
  const isBrowser = useIsBrowser();
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(target);

  useEffect(() => {
    const element = ref.current;
    if (!isBrowser || element === null) {
      return;
    }

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      setValue(target);
      return;
    }

    setValue(0);
    let frame = 0;
    let start: number | null = null;

    const step = (now: number): void => {
      start ??= now;
      const progress = Math.min(1, (now - start) / durationMs);
      setValue(Math.round(easeOutExpo(progress) * target));
      if (progress < 1) {
        frame = window.requestAnimationFrame(step);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting !== true) {
          return;
        }
        observer.disconnect();
        frame = window.requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );

    observer.observe(element);

    return (): void => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [isBrowser, target, durationMs]);

  return { ref, value };
}
