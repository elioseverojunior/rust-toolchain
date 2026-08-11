// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

import { formatCount } from "@site/src/data/format";
import { useCountUp } from "@site/src/hooks/useCountUp";
import type { SiteMetric } from "@site/src/types/site";
import type { ReactNode } from "react";

export interface CounterProps {
  readonly metric: SiteMetric;
  readonly className?: string;
  /** Group thousands. For download totals, where 32505 is hard to read. */
  readonly grouped?: boolean;
}

/**
 * Renders a figure, animating it up from zero when it scrolls into view.
 *
 * Prefix and suffix are printed but never animated, so an approximation stays
 * an approximation: "~60%" counts the 60 and keeps the tilde throughout rather
 * than resolving to a figure the record does not claim. A metric with no
 * numeric part is printed verbatim.
 */
export function Counter({
  metric,
  className,
  grouped = false,
}: CounterProps): ReactNode {
  // Called unconditionally — the early return below must not sit above a hook.
  const { ref, value } = useCountUp(metric.value ?? 0);

  if (metric.value === null) {
    return <span className={className}>{metric.display}</span>;
  }

  return (
    <span className={className}>
      {metric.prefix}
      <span ref={ref}>{grouped ? formatCount(value) : value}</span>
      {metric.suffix}
    </span>
  );
}
