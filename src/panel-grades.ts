// Grades from each unit's Moodle gradebook (moodle-cli reads them; the Moodle plugin stores one
// `grade` item per activity). The overview shows the latest marks; /panel/grades shows every unit.

import { BAND_STYLE, bandFor, percentOf, type GradeScaleId } from "./grade-scale";
import { icon } from "./marks";
import type { PanelRuntime } from "./panel";
import { empty, PANEL_SCRIPT, PANEL_STYLE } from "./panel-kit";
import { escapeHtml, renderPage } from "./ui";

export interface GradeRow {
  itemId: string;
  title: string;
  url: string | null;
  course: string | null;
  updatedAt: string;
  grade: string | null;
  range: string | null;
  status: string | null;
  feedback: string | null;
  order: number;
}

export async function loadGrades(db: D1Database): Promise<GradeRow[]> {
  const rows = await db
    .prepare(
      `SELECT i.item_id, i.title, i.url, i.course, i.updated_at, f.data_json
       FROM items i
       JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'grade'
       WHERE i.archived_at IS NULL AND i.kind = 'grade'`,
    )
    .all<{ item_id: string; title: string; url: string | null; course: string | null; updated_at: string; data_json: string }>();
  return rows.results.map((row) => {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return {
      itemId: row.item_id,
      title: row.title,
      url: row.url,
      course: row.course,
      updatedAt: row.updated_at,
      grade: text(data.grade),
      range: text(data.range),
      status: text(data.status),
      feedback: text(data.feedback),
      order: typeof data.order === "number" ? data.order : 0,
    };
  });
}

/** "27.50" of "0–28" reads "98%" and the band the scale gives it; the raw mark is the tooltip. */
export function scoreHtml(row: GradeRow, scale: GradeScaleId): string {
  if (!row.grade) return `<span class="faint">Not marked</span>`;
  const percent = percentOf(row.grade, row.range);
  if (percent === null) return `<span class="score">${escapeHtml(row.grade)}</span>`;
  const band = bandFor(percent, scale);
  const raw = `${row.grade.replace(/\s*\(.*\)$/, "")}${row.range ? ` of ${row.range}` : ""}`;
  return `<span class="score tabular" title="${escapeHtml(raw)}">${percent}%</span>${band ? ` <span class="band t${band.tier}">${escapeHtml(band.label)}</span>` : ""}`;
}

function titleHtml(row: GradeRow): string {
  return row.url
    ? `<a class="plain truncate" href="${escapeHtml(row.url)}" target="_blank" rel="noopener" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</a>`
    : `<span class="truncate" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</span>`;
}

/** The newest marks first; on a first sync, where every row is new at once, the gradebook's last rows. */
export function renderGradesWidget(rows: GradeRow[], scale: GradeScaleId): string {
  const marked = rows
    .filter((row) => row.grade)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.order - left.order);
  if (marked.length === 0) return empty("check", "No grades yet. They show up after Moodle's next sync.");
  return `<ul class="list">${marked
    .slice(0, 6)
    .map(
      (row) => `<li>
        <span class="grow due-row">${row.course ? `<a class="badge course" href="/panel/grades#unit-${encodeURIComponent(row.course)}">${escapeHtml(row.course)}</a>` : ""}${titleHtml(row)}</span>
        <span class="end">${scoreHtml(row, scale)}</span>
      </li>`,
    )
    .join("")}</ul>${GRADES_STYLE}${BAND_STYLE}`;
}

export async function renderGrades(runtime: PanelRuntime): Promise<string> {
  const rows = await loadGrades(runtime.db).catch((): GradeRow[] => []);
  const units = new Map<string, GradeRow[]>();
  for (const row of rows) {
    const key = row.course ?? "Other";
    units.set(key, [...(units.get(key) ?? []), row]);
  }
  const cards = [...units.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, list]) => {
      list.sort((left, right) => left.order - right.order);
      const marked = list.filter((row) => row.grade).length;
      return `<section class="card" id="unit-${escapeHtml(code)}">
        <div class="card-head row"><div class="card-title"><a class="badge course" href="/panel/units/${encodeURIComponent(code)}">${escapeHtml(code)}</a></div><span class="muted small tabular">${marked} of ${list.length} marked</span></div>
        <div class="card-body"><ul class="list grades">${list
          .map(
            (row) => `<li class="${row.grade ? "" : "unmarked"}">
              <span class="grow grade-text">${titleHtml(row)}${row.feedback ? `<span class="grade-feedback">${escapeHtml(row.feedback)}</span>` : ""}</span>
              <span class="end">${scoreHtml(row, runtime.gradeScale)}</span>
            </li>`,
          )
          .join("")}</ul></div>
      </section>`;
    })
    .join("");
  return renderPage({
    title: "unicorn — grades",
    active: "/panel/grades",
    heading: "Grades",
    body: `${cards || `<section class="card">${empty("check", "No grades yet. Connect Moodle on Sources; they show up after its next sync.")}</section>`}${PANEL_STYLE}${GRADES_STYLE}${BAND_STYLE}${PANEL_SCRIPT}`,
    actions: `<a class="button secondary" href="/panel/changes?type=grades">${icon("changes")}Grade changes</a>`,
  });
}

const GRADES_STYLE = `<style>
.score{font-weight:600;color:var(--fg)}
.score .faint,.end .faint{font-weight:400;color:var(--faint)}
.list.grades li.unmarked .grade-text{color:var(--fg-2)}
.grade-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.grade-feedback{font-size:12px;color:var(--fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
