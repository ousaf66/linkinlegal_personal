import type { SourceCategory, WorkStatus } from "@/comparison/types";

/**
 * The two sides keep one colour each everywhere on the page: blue for the live
 * sanctions data our search reads, orange for our scrapers. Validated as a pair (CVD and contrast) in
 * light and dark; text never wears these colours, only marks do.
 */
export const SIDES = {
  baseline: {
    label: "Live sanctions data",
    short: "Live",
    parties: "Live parties",
    swatch: "bg-[#2a78d6] dark:bg-[#3987e5]",
  },
  independent: {
    label: "Our scrapers",
    short: "Ours",
    parties: "Our parties",
    swatch: "bg-[#eb6834] dark:bg-[#d95926]",
  },
} as const;

export const STATUS_LABEL: Record<WorkStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  delivered: "Delivered",
  validated: "Validated",
  searchable: "Searchable",
};

export const STATUS_TONE: Record<WorkStatus, "neutral" | "amber" | "red" | "green"> = {
  not_started: "neutral",
  in_progress: "amber",
  blocked: "red",
  delivered: "amber",
  validated: "green",
  searchable: "green",
};

export const CATEGORY_LABEL: Record<SourceCategory, string> = {
  sanctions: "Sanctions",
  pep: "PEP",
  crime: "Crime & wanted",
  debarment: "Debarment",
  regulatory: "Regulatory & export",
  other: "Other",
};

export const LINK_CHECK_LABEL: Record<string, string> = {
  reachable_sampled: "Reachable",
  http_error: "HTTP error",
  request_error: "Network or TLS error",
  reachable_challenge_or_denial: "Bot challenge or denial",
  empty_response: "Empty response",
  no_url: "No data URL",
};

const intFormat = new Intl.NumberFormat("en");

export const fmtInt = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : intFormat.format(value);

export function fmtBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 || size >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Ours minus live. A percentage only when live has a non-zero count;
 * "—" when we have no data for the source at all (unknown, not zero).
 */
export function fmtDelta(ours: number | null | undefined, feed: number | null | undefined) {
  if (ours === null || ours === undefined) return { text: "—", sign: 0 };
  const base = feed ?? 0;
  const diff = ours - base;
  const signed = `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${intFormat.format(Math.abs(diff))}`;
  if (!base) return { text: `${signed} (live has none)`, sign: Math.sign(diff) };
  const pct = (diff / base) * 100;
  // One decimal below 10%; between 99% and 100% truncated, so −99.98% never reads "−100%".
  const abs = Math.abs(pct);
  const shown =
    abs > 99 && abs < 100 ? (Math.floor(abs * 10) / 10).toFixed(1) : abs.toFixed(abs < 10 ? 1 : 0);
  const pctSign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return { text: `${signed} (${pctSign}${shown}%)`, sign: Math.sign(diff) };
}

/** Ours as a share of live, for the coverage bars; null when there is nothing to compare. */
export function coverage(ours: number | null | undefined, feed: number | null | undefined) {
  if (ours === null || ours === undefined || !feed) return null;
  return ours / feed;
}

/** A share as a whole percent, without rounding a sliver to "0%" or a near-miss to "100%". */
export function fmtShare(value: number | null) {
  if (value === null) return "—";
  if (value > 0 && value < 0.005) return "<1%";
  if (value < 1 && value > 0.995) return ">99%";
  return `${Math.round(value * 100)}%`;
}

let regionNames: Intl.DisplayNames | undefined;

/** "ir" → "Iran". Codes the browser does not know ("suhh", "ge-ab") show as written. */
export function countryName(code: string) {
  if (code === "unknown") return "Unknown";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    if (/^[a-z]{2}$/.test(code)) return regionNames.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    // Fall through to the raw code.
  }
  return code.toUpperCase();
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function fmtAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

export const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

/** FtM dates are often zone-less (`2026-09-19T02:01:29`) or date-only; show the day. */
export const fmtDay = (value: string | null | undefined) => (value ? value.slice(0, 10) : "—");
