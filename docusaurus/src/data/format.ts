// SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
//
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Pure formatting helpers, shared by the Node-side adapters and the browser.
 *
 * Deliberately free of React imports: docusaurus.config.ts pulls this module in
 * while building the view model, and dragging the React runtime into the config
 * evaluation would be both slow and pointless.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/** Parses `YYYY-MM`. Returns null for anything else, including `present`. */
export function parseYearMonth(value: string): YearMonth | null {
  const [rawYear, rawMonth] = value.split("-");
  if (rawYear === undefined || rawMonth === undefined) {
    return null;
  }
  const year = Number.parseInt(rawYear, 10);
  const month = Number.parseInt(rawMonth, 10);
  return Number.isNaN(year) || Number.isNaN(month) ? null : { year, month };
}

/** `2024-10` -> `Oct 2024`; unparseable input is passed through untouched. */
export function formatMonth(value: string): string {
  const parsed = parseYearMonth(value);
  if (parsed === null) {
    return value;
  }
  // The index derives from arbitrary input, so under noUncheckedIndexedAccess
  // this lookup is genuinely `string | undefined`.
  const name = MONTHS[parsed.month - 1];
  return name === undefined ? value : `${name} ${parsed.year}`;
}

/**
 * `Oct 2024 — Present` when open-ended. The two sources spell "still here"
 * differently — profile.yaml uses `null`, github-profile.yaml the string
 * `present` — so both are treated as open.
 */
export function formatPeriod(start: string, end: string | null): string {
  const from = formatMonth(start);
  if (end === null || end === "present") {
    return `${from} — Present`;
  }
  return `${from} — ${formatMonth(end)}`;
}

function monthsBetween(start: string, end: string | null, now: Date): number {
  const from = parseYearMonth(start);
  if (from === null) {
    return 0;
  }
  const to =
    end === null || end === "present"
      ? { year: now.getFullYear(), month: now.getMonth() + 1 }
      : parseYearMonth(end);
  if (to === null) {
    return 0;
  }
  return Math.max(1, (to.year - from.year) * 12 + (to.month - from.month));
}

/** `3 yrs 2 mos`, `8 mos`. */
export function formatDuration(
  start: string,
  end: string | null,
  now: Date,
): string {
  const total = monthsBetween(start, end, now);
  const years = Math.floor(total / 12);
  const months = total % 12;
  const parts: string[] = [];
  if (years > 0) {
    parts.push(`${years} yr${years === 1 ? "" : "s"}`);
  }
  if (months > 0) {
    parts.push(`${months} mo${months === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? "1 mo" : parts.join(" ");
}

export interface ParsedMetric {
  readonly value: number | null;
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Splits a display figure into the parts the counter needs.
 *
 *   "243"  -> {value: 243, prefix: "",  suffix: ""}
 *   "35%"  -> {value: 35,  prefix: "",  suffix: "%"}
 *   "~60%" -> {value: 60,  prefix: "~", suffix: "%"}
 *
 * A figure with no digits yields `value: null`, and the caller renders the
 * string verbatim rather than animating it. Approximations keep their tilde:
 * dropping it to make the number animate cleanly would overstate the claim.
 */
export function parseMetric(display: string): ParsedMetric {
  const match = /^(\D*)(\d+(?:[.,]\d+)?)(.*)$/.exec(display.trim());
  if (match === null) {
    return { value: null, prefix: "", suffix: "" };
  }
  const [, prefix = "", digits = "", suffix = ""] = match;
  const value = Number.parseFloat(digits.replace(",", "."));
  return {
    value: Number.isNaN(value) ? null : value,
    prefix,
    suffix,
  };
}

/**
 * The records are written in plain ASCII, where an aside is marked with a
 * double hyphen. On screen that should be an em dash — presentation, so it is
 * applied at render time rather than edited into the sources.
 */
export function prose(text: string): string {
  return text.replace(/\s--\s/g, " — ");
}

/** `26343` -> `26,343`. Fixed locale so SSR and client agree exactly. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
