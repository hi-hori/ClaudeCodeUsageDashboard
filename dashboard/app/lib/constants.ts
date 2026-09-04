// --- Period filter ---
export const PERIOD_OPTIONS = [
  { days: 1, label: "1d" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 0, label: "All" },
] as const;

export const DEFAULT_DAYS = 7;

// --- Chart dimensions ---
export const CHART_HEIGHT = 300;
export const CHART_HEIGHT_LARGE = 350;

// --- Cost provenance ---
/** Shown wherever a cost figure is not the one Claude Code reported for the
 *  session, but was derived from token counts via app/lib/cost.ts. Such
 *  figures are rendered dimmed. */
export const ESTIMATED_COST_HINT =
  "Estimated from token counts using the built-in pricing table, because Claude Code reported no cost for these sessions.";

// --- Date formatting ---
/** Slice index to extract "MM-DD" from "YYYY-MM-DD" */
export const DATE_MM_DD_SLICE_START = 5;
