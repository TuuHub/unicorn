// How a mark reads: a percentage, plus the band the user's school calls it. Schools name bands
// differently (HD at Monash, H1 at Melbourne, a First in the UK), so the scale is a setting.
// Each band sits on one of five tiers, and the tier picks the colour: best is a filled green,
// a fail is red.

export type GradeScaleId = "monash" | "melbourne" | "uk" | "us" | "percent";
export type Tier = 1 | 2 | 3 | 4 | 5;

interface Band {
  label: string;
  // Lowest percentage, inclusive.
  min: number;
  tier: Tier;
}

export const GRADE_SCALES: Record<GradeScaleId, { name: string; bands: Band[] }> = {
  monash: {
    name: "Monash",
    bands: [
      { label: "HD", min: 80, tier: 1 },
      { label: "D", min: 70, tier: 2 },
      { label: "C", min: 60, tier: 3 },
      { label: "P", min: 50, tier: 4 },
      { label: "N", min: 0, tier: 5 },
    ],
  },
  melbourne: {
    name: "Melbourne",
    bands: [
      { label: "H1", min: 80, tier: 1 },
      { label: "H2A", min: 75, tier: 2 },
      { label: "H2B", min: 70, tier: 2 },
      { label: "H3", min: 65, tier: 3 },
      { label: "P", min: 50, tier: 4 },
      { label: "N", min: 0, tier: 5 },
    ],
  },
  uk: {
    name: "UK honours",
    bands: [
      { label: "First", min: 70, tier: 1 },
      { label: "2:1", min: 60, tier: 2 },
      { label: "2:2", min: 50, tier: 3 },
      { label: "Third", min: 40, tier: 4 },
      { label: "Fail", min: 0, tier: 5 },
    ],
  },
  us: {
    name: "US letters",
    bands: [
      { label: "A", min: 90, tier: 1 },
      { label: "B", min: 80, tier: 2 },
      { label: "C", min: 70, tier: 3 },
      { label: "D", min: 60, tier: 4 },
      { label: "F", min: 0, tier: 5 },
    ],
  },
  percent: { name: "Percentage only", bands: [] },
};

export function isGradeScale(value: unknown): value is GradeScaleId {
  return typeof value === "string" && Object.hasOwn(GRADE_SCALES, value);
}

/** 27.5 of "0–28" is 98. Null for a mark that isn't a number ("Satisfactory") or has no range. */
export function percentOf(grade: string, range: string | null): number | null {
  const value = Number(grade.match(/^-?[\d.]+/)?.[0]);
  const bounds = range?.split(/[–—]|(?<=\d)-(?=\d)/).map((part) => Number(part.trim()));
  if (!Number.isFinite(value) || !bounds || bounds.length !== 2 || bounds.some((bound) => !Number.isFinite(bound))) return null;
  const [low, high] = bounds as [number, number];
  return high > low ? Math.round(((value - low) / (high - low)) * 100) : null;
}

export function bandFor(percent: number, scale: GradeScaleId): Band | null {
  return GRADE_SCALES[scale].bands.find((band) => percent >= band.min) ?? null;
}

export const BAND_STYLE = `<style>
.band{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1;white-space:nowrap;vertical-align:middle}
.band.t1{background:var(--success);color:var(--surface)}
.band.t2{background:var(--success-soft);color:var(--success-text)}
.band.t3{background:var(--default);color:var(--fg)}
.band.t4{background:var(--warning-soft);color:var(--warning-text)}
.band.t5{background:var(--danger-soft);color:var(--danger-text)}
</style>`;
