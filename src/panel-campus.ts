// The panel's campus pages (ADR-0048): what the door gives an agent, laid out for the person.
//
//   /panel/changes          every change unicorn recorded, newest first, by type and unit
//   /panel/due              deadlines for the next weeks, overdue first; /panel/due.ics exports them
//   /panel/units            this term's units; /panel/units/<code> one unit across every system
//   /panel/briefs           what scheduled playbooks and the digest filed; mark them read
//   /panel/plans            weekly and assignment plans; tick items off
//   /panel/search           full-text search over every synced item
//
// Read-only on the sources like everything else. The two writes here (marking briefs read,
// ticking a plan item) touch unicorn's own tables and are CSRF-checked by the router.

import type { ItemSummary, BucketGroup } from "./mcp/door-contracts";
import { EVENT_LABELS, eventIcon, icon, sourceDot, sourceMark, sourceTile } from "./marks";
import type { PanelRuntime } from "./panel";
import { dayKey, empty, formatIn, PANEL_SCRIPT, PANEL_STYLE, relative, safeZone, shortAgo, SOURCE_NAMES } from "./panel-kit";
import { computeCsrfToken } from "./settings";
import { loadTermCourses, type TermCourse } from "./term";
import { escapeHtml, renderPage } from "./ui";
import { listChecklistItems, checklistProgress, toggleChecklistLine } from "./widgets/checklist.js";
import { renderMarkdown } from "./widgets/markdown.js";

const now = (runtime: PanelRuntime) => (runtime.now ? runtime.now() : new Date());

// --- changes ------------------------------------------------------------------------------------

interface ChangeRow {
  seq: number;
  type: string;
  source: string;
  item_id: string;
  kind: string;
  title: string;
  url: string | null;
  field: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
  course: string | null;
}

const CHANGE_FILTERS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "", label: "All", types: [] },
  { key: "new", label: "New", types: ["item.added"] },
  { key: "deadlines", label: "Deadlines", types: ["deadline.changed"] },
  { key: "grades", label: "Grades", types: ["grade.changed"] },
  { key: "notices", label: "Notices", types: ["notice.posted"] },
  { key: "edits", label: "Edits", types: ["content.changed", "state.changed"] },
];

export async function recentChanges(
  db: D1Database,
  options: { before?: number; course?: string; types?: string[]; limit: number },
): Promise<ChangeRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (options.before) {
    conditions.push("c.seq < ?");
    values.push(options.before);
  }
  if (options.course) {
    conditions.push("i.course = ?");
    values.push(options.course.toUpperCase());
  }
  if (options.types?.length) {
    conditions.push(`c.type IN (${options.types.map(() => "?").join(", ")})`);
    values.push(...options.types);
  }
  const rows = await db
    .prepare(
      `SELECT c.seq, c.type, c.source, c.item_id, c.kind, c.title, c.url, c.field, c.before_json, c.after_json, c.created_at, i.course
       FROM changes c LEFT JOIN items i ON i.source = c.source AND i.item_id = c.item_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY c.seq DESC LIMIT ?`,
    )
    .bind(...values, options.limit)
    .all<ChangeRow>();
  return rows.results;
}

export async function renderChanges(runtime: PanelRuntime, url: URL): Promise<string> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const filter = CHANGE_FILTERS.find((entry) => entry.key === (url.searchParams.get("type") ?? "")) ?? CHANGE_FILTERS[0];
  const course = (url.searchParams.get("course") ?? "").trim().toUpperCase() || undefined;
  const before = Number(url.searchParams.get("before")) || undefined;
  const [rows, courses] = await Promise.all([
    recentChanges(runtime.db, { before, course, types: filter.types, limit: 61 }).catch((): ChangeRow[] => []),
    loadTermCourses(runtime.db).catch((): TermCourse[] => []),
  ]);
  const page = rows.slice(0, 60);
  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = { type: filter.key || undefined, course, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const text = params.toString();
    return `/panel/changes${text ? `?${text}` : ""}`;
  };
  const typeChips = CHANGE_FILTERS.map((entry) => `<a href="${query({ type: entry.key || undefined, before: undefined })}" aria-current="${entry.key === filter.key}">${entry.label}</a>`).join("");
  const unitChips = courses.length
    ? `<div class="filters">${[`<a href="${query({ course: undefined, before: undefined })}" aria-current="${!course}">All units</a>`, ...courses.map((entry) => `<a href="${query({ course: entry.code, before: undefined })}" aria-current="${entry.code === course}">${escapeHtml(entry.code)}</a>`)].join("")}</div>`
    : "";
  const older = rows.length > 60 ? `<div class="pager"><a class="button secondary" href="${query({ before: String(page.at(-1)!.seq) })}">Older${icon("arrow")}</a></div>` : "";

  const body = `
    <div class="toolbar"><div class="filters">${typeChips}</div>${unitChips}</div>
    <section class="card"><div class="card-body" style="padding-top:14px">${page.length ? renderChangeDays(page, zone, at) : empty("changes", course || filter.key ? "Nothing matches." : "No changes yet. They appear after the first sync.")}${older}</div></section>
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — changes",
    active: "/panel/changes",
    heading: "Changes",
    subtitle: "Everything unicorn noticed across your sources: new items, moved deadlines, grades, notices and edits. Your agents read the same feed.",
    body,
    wide: true,
  });
}

export function renderChangeDays(rows: ChangeRow[], zone: string, at: Date): string {
  const groups = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const key = dayKey(row.created_at, zone);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const today = dayKey(at.toISOString(), zone);
  const yesterday = dayKey(new Date(at.getTime() - 86_400_000).toISOString(), zone);
  return [...groups.entries()]
    .map(([key, group]) => {
      const label = key === today ? "Today" : key === yesterday ? "Yesterday" : formatIn(group[0].created_at, zone, { weekday: "long", day: "numeric", month: "long" });
      return `<div class="feed-day"><h3>${escapeHtml(label)}</h3><ul class="list changes">${group.map((row) => renderChangeRow(row, zone)).join("")}</ul></div>`;
    })
    .join("");
}

function renderChangeRow(row: ChangeRow, zone: string): string {
  const title = row.url ? `<a class="plain" href="${escapeHtml(row.url)}" target="_blank" rel="noopener">${escapeHtml(row.title)}</a>` : escapeHtml(row.title);
  const detail = changeDetail(row, zone);
  return `<li>
    <span class="grow change-row">${eventIcon(row.type)}<span class="change-text">
      <span class="change-title">${row.course ? `<a class="badge course" href="/panel/units/${encodeURIComponent(row.course)}">${escapeHtml(row.course)}</a>` : ""}<span class="truncate">${title}</span></span>
      <span class="change-meta">${escapeHtml(EVENT_LABELS[row.type] ?? row.type)} · ${sourceDot(row.source)} ${escapeHtml(SOURCE_NAMES[row.source] ?? sourceMark(row.source)?.name ?? row.source)} · ${escapeHtml(row.kind)}${detail ? ` · ${detail}` : ""}</span>
    </span></span>
    <span class="end">${escapeHtml(formatIn(row.created_at, zone, { hour: "2-digit", minute: "2-digit", hour12: false }))}</span>
  </li>`;
}

function changeDetail(row: ChangeRow, zone: string): string {
  const parse = (json: string | null): unknown => {
    if (json === null) return null;
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  };
  const show = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "none";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatIn(value, zone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const pick = record.score ?? record.grade ?? record.value ?? record.state ?? record.status ?? record.dueAt;
      return pick !== undefined ? show(pick) : JSON.stringify(value).slice(0, 40);
    }
    return String(value).slice(0, 40);
  };
  if (row.type === "deadline.changed" || row.type === "grade.changed" || row.type === "state.changed") {
    return `<span class="delta"><s>${escapeHtml(show(parse(row.before_json)))}</s> → <strong>${escapeHtml(show(parse(row.after_json)))}</strong></span>`;
  }
  if (row.type === "content.changed" && row.field) return `${escapeHtml(row.field)} edited`;
  return "";
}

// --- deadlines ----------------------------------------------------------------------------------

export async function renderDeadlines(runtime: PanelRuntime, url: URL): Promise<string> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const days = [14, 30, 60].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const course = (url.searchParams.get("course") ?? "").trim().toUpperCase() || undefined;
  const [items, courses] = await Promise.all([
    runtime.repo.upcoming({ days, course, includeOverdue: true, now: at }).catch((): ItemSummary[] => []),
    loadTermCourses(runtime.db).catch((): TermCourse[] => []),
  ]);
  const overdue = items.filter((item) => item.dueAt && Date.parse(item.dueAt) < at.getTime());
  const ahead = items.filter((item) => !item.dueAt || Date.parse(item.dueAt) >= at.getTime());
  const weeks = new Map<string, ItemSummary[]>();
  for (const item of ahead) {
    const key = item.dueAt ? isoWeek(item.dueAt, zone) : "";
    weeks.set(key, [...(weeks.get(key) ?? []), item]);
  }
  const thisWeek = isoWeek(at.toISOString(), zone);
  const nextWeek = isoWeek(new Date(at.getTime() + 7 * 86_400_000).toISOString(), zone);
  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = { days: days === 30 ? undefined : String(days), course, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const text = params.toString();
    return `?${text}`;
  };
  const rangeChips = [14, 30, 60].map((value) => `<a href="/panel/due${query({ days: value === 30 ? undefined : String(value) })}" aria-current="${value === days}">${value} days</a>`).join("");
  const unitChips = courses.length
    ? `<div class="filters">${[`<a href="/panel/due${query({ course: undefined })}" aria-current="${!course}">All units</a>`, ...courses.map((entry) => `<a href="/panel/due${query({ course: entry.code })}" aria-current="${entry.code === course}">${escapeHtml(entry.code)}</a>`)].join("")}</div>`
    : "";

  // a board, as HeroUI's tracker: one lane per horizon, each with its dot and count
  const lanes: Array<{ key: string; label: string; dot: string; items: ItemSummary[] }> = [
    { key: "overdue", label: "Overdue", dot: "var(--danger)", items: overdue },
    { key: "this", label: "This week", dot: "var(--warning)", items: ahead.filter((item) => item.dueAt && isoWeek(item.dueAt, zone) === thisWeek) },
    { key: "next", label: "Next week", dot: "var(--accent)", items: ahead.filter((item) => item.dueAt && isoWeek(item.dueAt, zone) === nextWeek) },
    { key: "later", label: "Later", dot: "var(--faint)", items: ahead.filter((item) => !item.dueAt || (isoWeek(item.dueAt, zone) !== thisWeek && isoWeek(item.dueAt, zone) !== nextWeek)) },
  ];
  const board = lanes
    .filter((lane) => lane.key !== "overdue" || lane.items.length)
    .map(
      (lane) => `<section class="lane ${lane.key === "overdue" ? "overdue" : ""}" aria-label="${lane.label}">
        <div class="lane-head"><span class="dot" style="background:${lane.dot}"></span>${lane.label}<span class="count tabular">${lane.items.length}</span></div>
        <div class="lane-cards">${lane.items.length ? lane.items.map((item) => taskCard(item, zone, at)).join("") : `<p class="lane-empty">Nothing ${lane.key === "later" ? "further out" : "here"}.</p>`}</div>
      </section>`,
    )
    .join("");

  const body = `
    <div class="toolbar"><div class="filters">${rangeChips}</div>${unitChips}</div>
    ${items.length ? `<div class="board">${board}</div>` : `<section class="card">${empty("check", `Nothing due in the next ${days} days.`)}</section>`}
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — deadlines",
    active: "/panel/due",
    heading: "Deadlines",
    subtitle: `Every dated item from Moodle, Canvas and Ed, in ${escapeHtml(zone)}. Overdue items stay listed until their source marks them done.`,
    body,
    wide: true,
    actions: `<a class="button secondary" href="/panel/due.ics${course ? `?course=${encodeURIComponent(course)}` : ""}" download>${icon("download")}Calendar (.ics)</a>`,
  });
}

function dueAgenda(items: ItemSummary[], zone: string, at: Date, inUnit = false): string {
  const groups = new Map<string, ItemSummary[]>();
  for (const item of items) {
    const key = item.dueAt ? dayKey(item.dueAt, zone) : "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const today = dayKey(at.toISOString(), zone);
  return `<div class="agenda">${[...groups.entries()]
    .map(([key, group]) => {
      const first = group[0].dueAt ?? at.toISOString();
      return `<div class="day${key === today ? " today" : ""}">
        <div class="day-label"><span class="dow">${escapeHtml(key === today ? "Today" : formatIn(first, zone, { weekday: "short" }))}</span><span class="dom tabular">${escapeHtml(formatIn(first, zone, { day: "numeric" }))}</span><span class="mon">${escapeHtml(formatIn(first, zone, { month: "short" }))}</span></div>
        <ul class="list">${group.map((item) => itemRow(item, zone, at, true, inUnit)).join("")}</ul>
      </div>`;
    })
    .join("")}</div>`;
}

function taskCard(item: ItemSummary, zone: string, at: Date): string {
  const when = item.dueAt ? `${formatIn(item.dueAt, zone, { weekday: "short", day: "numeric", month: "short" })}, ${formatIn(item.dueAt, zone, { hour: "2-digit", minute: "2-digit", hour12: false })}` : "no date";
  const state = item.state ? `<span class="chip${/submit|done|complete|graded/i.test(item.state) ? " success" : ""}">${escapeHtml(item.state)}</span>` : "";
  const tag = item.url ? "a" : "div";
  return `<${tag} class="task-card plain"${item.url ? ` href="${escapeHtml(item.url)}" target="_blank" rel="noopener"` : ""}>
    <div class="task-top">${item.course ? `<span class="badge course">${escapeHtml(item.course)}</span>` : "<span></span>"}<span class="task-when">${icon("clock")}${escapeHtml(when)}</span></div>
    <p class="task-title">${escapeHtml(item.title)}</p>
    <div class="task-meta">${sourceDot(item.source)}${escapeHtml(SOURCE_NAMES[item.source] ?? sourceMark(item.source)?.name ?? item.source)} · ${escapeHtml(item.kind)}${item.dueAt ? ` · ${escapeHtml(relative(item.dueAt, at))}` : ""}${state ? ` ${state}` : ""}</div>
  </${tag}>`;
}

function itemRow(item: ItemSummary, zone: string, at: Date, withTime: boolean, inUnit = false): string {
  const title = item.url ? `<a class="plain" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title);
  const state = item.state ? `<span class="badge${/submit|done|complete|graded/i.test(item.state) ? " ok" : ""}">${escapeHtml(item.state)}</span>` : "";
  const end = withTime && item.dueAt ? formatIn(item.dueAt, zone, { hour: "2-digit", minute: "2-digit", hour12: false }) : shortAgo(item.timestamp, at);
  return `<li>
    <span class="grow due-row">${sourceDot(item.source)}${item.course && !inUnit ? `<a class="badge course" href="/panel/units/${encodeURIComponent(item.course)}">${escapeHtml(item.course)}</a>` : ""}<span class="truncate" title="${escapeHtml(item.title)}">${title}</span>${item.staff ? '<span class="badge">staff</span>' : ""}${state}</span>
    <span class="end">${escapeHtml(end)}</span>
  </li>`;
}

export async function renderDeadlinesIcs(runtime: PanelRuntime, url: URL): Promise<Response> {
  const at = now(runtime);
  const course = (url.searchParams.get("course") ?? "").trim().toUpperCase() || undefined;
  const items = await runtime.repo.upcoming({ days: 120, course, includeOverdue: false, now: at }).catch((): ItemSummary[] => []);
  const stamp = icsTime(at.toISOString());
  const text = (value: string) => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const events = items
    .filter((item) => item.dueAt)
    .map((item) =>
      [
        "BEGIN:VEVENT",
        `UID:${text(`${item.source}:${item.itemId}`)}@unicorn`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsTime(item.dueAt!)}`,
        `DTEND:${icsTime(item.dueAt!)}`,
        `SUMMARY:${text(`${item.course ? `[${item.course}] ` : ""}${item.title}`)}`,
        ...(item.url ? [`URL:${text(item.url)}`] : []),
        `DESCRIPTION:${text(`${SOURCE_NAMES[item.source] ?? item.source} · ${item.kind}${item.url ? `\n${item.url}` : ""}`)}`,
        "END:VEVENT",
      ].join("\r\n"),
    );
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//unicorn//deadlines//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:unicorn deadlines", ...events, "END:VCALENDAR", ""].join("\r\n");
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="unicorn-deadlines${course ? `-${course}` : ""}.ics"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function icsTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// --- units --------------------------------------------------------------------------------------

export async function renderUnits(runtime: PanelRuntime): Promise<string> {
  const at = now(runtime);
  const week = new Date(at.getTime() - 7 * 86_400_000).toISOString();
  const [courses, items, changes, upcoming] = await Promise.all([
    loadTermCourses(runtime.db).catch((): TermCourse[] => []),
    countBy(runtime.db, "SELECT course AS key, COUNT(*) AS n FROM items WHERE archived_at IS NULL AND course IS NOT NULL GROUP BY course"),
    countBy(runtime.db, "SELECT i.course AS key, COUNT(*) AS n FROM changes c JOIN items i ON i.source = c.source AND i.item_id = c.item_id WHERE c.created_at >= ? AND i.course IS NOT NULL GROUP BY i.course", week),
    runtime.repo.upcoming({ days: 30, includeOverdue: false, now: at }).catch((): ItemSummary[] => []),
  ]);
  const zone = safeZone(runtime.timezone);
  const rows = courses
    .map((course) => {
      const next = upcoming.find((item) => item.course === course.code && item.dueAt);
      const due = upcoming.filter((item) => item.course === course.code).length;
      const href = `/panel/units/${encodeURIComponent(course.code)}`;
      return `<tr>
        <td><a class="plain u-name" href="${href}"><span class="u-code">${escapeHtml(course.code)}</span><span class="u-title">${escapeHtml(course.title ?? "")}</span></a></td>
        <td><span class="u-src">${course.sources.map((name) => `<span class="src-chip">${sourceDot(name)}${escapeHtml(sourceMark(name)?.name ?? name)}</span>`).join("")}</span></td>
        <td class="num tabular">${items.get(course.code) ?? 0}</td>
        <td class="num tabular">${changes.get(course.code) ?? 0}</td>
        <td class="num tabular">${due ? `<span class="chip accent">${due}</span>` : "0"}</td>
        <td>${next ? `<span class="u-next"><span class="truncate">${escapeHtml(next.title)}</span><span class="muted">${escapeHtml(formatIn(next.dueAt!, zone, { weekday: "short", day: "numeric", month: "short" }))} · ${escapeHtml(relative(next.dueAt!, at))}</span></span>` : '<span class="muted">—</span>'}</td>
        <td class="num"><a class="icon-btn" href="${href}" aria-label="Open ${escapeHtml(course.code)}">${icon("chevron")}</a></td>
      </tr>`;
    })
    .join("");
  const term = courses.find((course) => course.term)?.term;
  const body = `
    ${
      rows
        ? `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Sources</th><th class="num">Items</th><th class="num">Changed · 7d</th><th class="num">Due · 30d</th><th>Next deadline</th><th class="num"></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<section class="card">${empty("units", "Units appear after the first sync.")}</section>`
    }
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — units",
    active: "/panel/units",
    heading: "Units",
    subtitle: `${term ? `${escapeHtml(term)}. ` : ""}Each unit joined across Moodle, Canvas and Ed. Open one to see it grouped by assignment.`,
    body,
    wide: true,
  });
}

async function countBy(db: D1Database, sql: string, ...binds: unknown[]): Promise<Map<string, number>> {
  try {
    const rows = await db.prepare(sql).bind(...binds).all<{ key: string; n: number }>();
    return new Map(rows.results.map((row) => [String(row.key).toUpperCase(), Number(row.n)]));
  } catch {
    return new Map();
  }
}

export async function renderUnit(runtime: PanelRuntime, code: string): Promise<string | null> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const view = await runtime.repo.course(code).catch(() => null);
  if (!view || !view.code) return null;
  const [upcoming, changes] = await Promise.all([
    runtime.repo.upcoming({ days: 60, course: view.code, includeOverdue: true, now: at }).catch((): ItemSummary[] => []),
    recentChanges(runtime.db, { course: view.code, limit: 12 }).catch((): ChangeRow[] => []),
  ]);
  const buckets = view.buckets.filter((bucket) => bucket.items.length).map((bucket) => renderBucket(bucket, zone, at)).join("");
  const unlabeled = view.unlabeled.length
    ? `<section class="card"><div class="card-head row"><div class="card-title">${icon("spark")}<h2>Not grouped yet</h2></div><span class="muted small tabular">${view.unlabeled.length}</span></div><div class="card-body"><p class="small muted" style="margin:0 0 8px">Your agent's triage playbook files these under an assignment or General.</p><ul class="list">${view.unlabeled
        .slice(0, 12)
        .map((item) => itemRow(item, zone, at, false, true))
        .join("")}</ul></div></section>`
    : "";
  const sources = view.sources
    .map((source) => `<span class="src-chip">${sourceTile(source, "sm")}${escapeHtml(SOURCE_NAMES[source] ?? sourceMark(source)?.name ?? source)}</span>`)
    .join("");
  const body = `
    <div class="unit-sources-row">${sources}</div>
    <div class="split">
      <div class="col">${buckets || `<section class="card"><div class="card-body" style="padding-top:18px">${empty("units", "No items in this unit yet.")}</div></section>`}${unlabeled}</div>
      <div class="col">
        <section class="card"><div class="card-head row"><div class="card-title">${icon("calendar")}<h2>Due</h2></div><a class="more" href="/panel/due?course=${encodeURIComponent(view.code)}">All${icon("arrow")}</a></div><div class="card-body">${upcoming.length ? dueAgenda(upcoming.slice(0, 8), zone, at, true) : empty("check", "Nothing due in 60 days.")}</div></section>
        <section class="card"><div class="card-head row"><div class="card-title">${icon("changes")}<h2>Latest changes</h2></div><a class="more" href="/panel/changes?course=${encodeURIComponent(view.code)}">All${icon("arrow")}</a></div><div class="card-body">${changes.length ? `<ul class="list changes compact">${changes.map((row) => renderChangeRow(row, zone)).join("")}</ul>` : empty("changes", "No changes yet.")}</div></section>
      </div>
    </div>
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: `unicorn — ${view.code}`,
    active: "/panel/units",
    heading: `${escapeHtml(view.code)} <span class="muted-h">${escapeHtml(view.title ?? "")}</span>`,
    subtitle: `${escapeHtml(view.term ?? "")}${view.term ? " · " : ""}Grouped by assignment, the way your agent sees it with <code>course("${escapeHtml(view.code)}")</code>.`,
    body,
    wide: true,
    actions: `<a class="button secondary" href="/panel/units">${icon("units")}All units</a>`,
  });
}

function renderBucket(bucket: BucketGroup, zone: string, at: Date): string {
  const due = bucket.dueAt
    ? `<span class="muted small">due ${escapeHtml(formatIn(bucket.dueAt, zone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }))} · ${escapeHtml(relative(bucket.dueAt, at))}</span>`
    : "";
  const state = bucket.state ? `<span class="badge${/submit|done|complete|graded/i.test(bucket.state) ? " ok" : ""}">${escapeHtml(bucket.state)}</span>` : "";
  const shown = bucket.items.slice(0, 8);
  return `<section class="card"><div class="card-head row"><div><h2>${escapeHtml(bucket.label)}</h2>${due}</div><span class="bucket-end">${state}<span class="muted small tabular">${bucket.items.length}</span></span></div>
    <div class="card-body"><ul class="list">${shown.map((item) => itemRow(item, zone, at, false, true)).join("")}</ul>${bucket.items.length > shown.length ? `<p class="muted small" style="margin:8px 0 0">${bucket.items.length - shown.length} more — ask your agent for the full bucket.</p>` : ""}</div></section>`;
}

// --- briefs -------------------------------------------------------------------------------------

export async function renderBriefs(runtime: PanelRuntime, url: URL): Promise<string> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const csrf = await computeCsrfToken(runtime.adminToken);
  const briefs = await runtime.briefs.list({ limit: 60 }).catch(() => []);
  const unread = briefs.filter((brief) => !brief.readAt);
  const read = briefs.filter((brief) => brief.readAt);
  const card = (brief: (typeof briefs)[number], open: boolean) => {
    const meta = `<span class="badge">${escapeHtml(brief.kind)}</span><span class="muted small">${escapeHtml(formatIn(brief.createdAt, zone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }))} · ${escapeHtml(relative(brief.createdAt, at))}</span>`;
    const markRead = brief.readAt
      ? ""
      : `<form method="post" action="/panel/briefs/read" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="id" value="${escapeHtml(brief.id)}"><button type="submit" class="secondary sm">${icon("check")}Mark read</button></form>`;
    return `<article class="card brief${brief.readAt ? " is-read" : ""}">
      <details${open ? " open" : ""}><summary class="brief-head"><span class="brief-title"><h2>${escapeHtml(brief.title)}</h2><span class="brief-meta">${meta}</span></span></summary>
      <div class="card-body"><div class="prose">${renderMarkdown(brief.body)}</div><div class="brief-actions">${markRead}</div></div></details>
    </article>`;
  };
  const notice = url.searchParams.get("marked");
  const body = `
    ${notice ? `<p class="notice" role="status">Marked ${escapeHtml(notice)} read. Your agents skip read briefs.</p>` : ""}
    ${unread.length ? `<div class="section-label"><h2>Unread · ${unread.length}</h2><form method="post" action="/panel/briefs/read" style="margin:0"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="all" value="1"><button type="submit" class="secondary sm">${icon("check")}Mark all read</button></form></div>${unread.map((brief) => card(brief, true)).join("")}` : ""}
    ${read.length ? `<div class="section-label"><h2>Read</h2></div>${read.map((brief) => card(brief, false)).join("")}` : ""}
    ${briefs.length ? "" : `<section class="card"><div class="card-body" style="padding-top:18px">${empty("brief", "No briefs yet. The daily digest and scheduled playbooks file them here.")}</div></section>`}
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — briefs",
    active: "/panel/briefs",
    heading: "Briefs",
    subtitle: "What the daily digest and scheduled playbooks filed. An agent reads unread briefs at the start of a session, then marks them read.",
    body,
    wide: false,
  });
}

export async function markBriefsRead(runtime: PanelRuntime, form: FormData, url: URL): Promise<Response> {
  let ids = form.getAll("id").map(String).filter(Boolean);
  if (form.get("all")) {
    ids = (await runtime.briefs.list({ unreadOnly: true, limit: 1000 })).map((brief) => brief.id);
  }
  const marked = ids.length ? await runtime.briefs.markRead(ids) : 0;
  return new Response(null, { status: 303, headers: { location: new URL(`/panel/briefs?marked=${marked}`, url).toString() } });
}

// --- plans --------------------------------------------------------------------------------------

interface PlanRow {
  kind: "weekly" | "assignment";
  subject: string;
  content: string;
  updated_at: string;
}

export async function renderPlans(runtime: PanelRuntime, url: URL): Promise<string> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const csrf = await computeCsrfToken(runtime.adminToken);
  const current = isoWeek(at.toISOString(), zone);
  const week = /^\d{4}-W\d{2}$/.test(url.searchParams.get("week") ?? "") ? url.searchParams.get("week")! : current;
  const assignment = url.searchParams.get("assignment");
  const all = await runtime.db
    .prepare("SELECT kind, subject, content, updated_at FROM plans ORDER BY updated_at DESC LIMIT 60")
    .all<PlanRow>()
    .then((rows) => rows.results)
    .catch((): PlanRow[] => []);
  const titles = await assignmentTitles(runtime.db, all.filter((plan) => plan.kind === "assignment").map((plan) => plan.subject));

  const selected = assignment ? all.find((plan) => plan.kind === "assignment" && plan.subject === assignment) : all.find((plan) => plan.kind === "weekly" && plan.subject === week);
  const back = assignment ? `/panel/plans?assignment=${encodeURIComponent(assignment)}` : `/panel/plans?week=${week}`;
  const prev = shiftWeek(week, -1);
  const next = shiftWeek(week, 1);
  const weekLabel = week === current ? "This week" : week === shiftWeek(current, 1) ? "Next week" : week === shiftWeek(current, -1) ? "Last week" : week;
  const heading = assignment ? escapeHtml(titles.get(assignment)?.title ?? assignment) : `${weekLabel} <span class="muted-h">${escapeHtml(weekRange(week))}</span>`;

  const progress = selected ? checklistProgress(selected.content) : { done: 0, total: 0 };
  const planCard = selected
    ? `<section class="card"><div class="card-head row"><div><h2>${progress.total ? `${progress.done} of ${progress.total} done` : "Plan"}</h2><p class="card-sub">Updated ${escapeHtml(relative(selected.updated_at, at))}. Ticking here saves straight to the plan your agents read.</p></div>${progress.total ? `<div class="progress"><span style="width:${(progress.done / progress.total) * 100}%"></span></div>` : ""}</div>
        <div class="card-body">${renderPlanBody(selected, csrf, back)}</div></section>`
    : `<section class="card"><div class="card-body" style="padding-top:18px">${empty("plan", assignment ? "This plan no longer exists." : `No plan for ${escapeHtml(week)}. Ask your agent “plan my week”.`)}</div></section>`;

  const list = all
    .map((plan) => {
      const isWeekly = plan.kind === "weekly";
      const href = isWeekly ? `/panel/plans?week=${plan.subject}` : `/panel/plans?assignment=${encodeURIComponent(plan.subject)}`;
      const named = plan.subject === current ? "This week" : plan.subject === shiftWeek(current, 1) ? "Next week" : plan.subject === shiftWeek(current, -1) ? "Last week" : null;
      const label = isWeekly ? (named ? `${named} · ${weekRange(plan.subject)}` : weekRange(plan.subject)) : titles.get(plan.subject)?.title ?? plan.subject;
      const course = isWeekly ? "" : titles.get(plan.subject)?.course ?? "";
      const p = checklistProgress(plan.content);
      const active = (isWeekly && !assignment && plan.subject === week) || (!isWeekly && plan.subject === assignment);
      return `<li${active ? ' class="active"' : ""}><a class="grow plain plan-link" href="${href}">${icon(isWeekly ? "calendar" : "plan")}${course ? `<span class="badge course">${escapeHtml(course)}</span>` : ""}<span class="truncate">${escapeHtml(label)}</span></a><span class="end tabular">${p.total ? `${p.done}/${p.total}` : ""}</span></li>`;
    })
    .join("");

  const body = `
    <div class="split">
      <div class="col">${planCard}</div>
      <div class="col"><section class="card"><div class="card-head"><div class="card-title">${icon("plan")}<h2>All plans</h2></div></div><div class="card-body">${list ? `<ul class="list plans">${list}</ul>` : empty("plan", "None yet.")}</div></section></div>
    </div>
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: "unicorn — plans",
    active: "/panel/plans",
    heading,
    subtitle: assignment ? "An assignment plan your agent saved with save_plan." : "The week's checklist your agent saved. Same plan on every device and app.",
    body,
    wide: true,
    actions: assignment
      ? `<a class="button secondary" href="/panel/plans">${icon("calendar")}This week</a>`
      : `<a class="button secondary" href="/panel/plans?week=${prev}" aria-label="Previous week">←</a><a class="button secondary" href="/panel/plans?week=${current}">This week</a><a class="button secondary" href="/panel/plans?week=${next}" aria-label="Next week">→</a>`,
  });
}

function renderPlanBody(plan: PlanRow, csrf: string, back: string): string {
  const lines = plan.content.split("\n");
  const tasks = new Map(listChecklistItems(plan.content).map((item) => [item.line, item]));
  const out: string[] = [];
  let buffer: string[] = [];
  let taskBuffer: string[] = [];
  const flushText = () => {
    if (buffer.length) out.push(`<div class="prose">${renderMarkdown(buffer.join("\n"))}</div>`);
    buffer = [];
  };
  const flushTasks = () => {
    if (taskBuffer.length) out.push(`<ul class="tasks">${taskBuffer.join("")}</ul>`);
    taskBuffer = [];
  };
  lines.forEach((line, index) => {
    const task = tasks.get(index);
    if (task) {
      flushText();
      taskBuffer.push(`<li class="${task.checked ? "done" : ""}"><form method="post" action="/panel/plans/toggle">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="kind" value="${plan.kind}"><input type="hidden" name="subject" value="${escapeHtml(plan.subject)}">
        <input type="hidden" name="line" value="${index}"><input type="hidden" name="text" value="${escapeHtml(task.text)}"><input type="hidden" name="back" value="${escapeHtml(back)}">
        <button type="submit" class="tick" aria-pressed="${task.checked}" aria-label="${task.checked ? "Untick" : "Tick"}: ${escapeHtml(task.text)}">${task.checked ? icon("check") : ""}</button>
        <span class="task-text">${renderMarkdown(task.text).replace(/^<p>|<\/p>$/g, "")}</span></form></li>`);
    } else {
      flushTasks();
      buffer.push(line);
    }
  });
  flushText();
  flushTasks();
  return out.join("");
}

export async function togglePlanItem(runtime: PanelRuntime, form: FormData, url: URL): Promise<Response> {
  const kind = String(form.get("kind")) === "assignment" ? "assignment" : "weekly";
  const subject = String(form.get("subject") ?? "");
  const line = Number(form.get("line"));
  const text = String(form.get("text") ?? "");
  const back = String(form.get("back") ?? "/panel/plans");
  const target = back.startsWith("/panel/plans") ? back : "/panel/plans";
  const plan = await runtime.repo.getPlan(kind, subject);
  if (plan) {
    const item = listChecklistItems(plan.content).find((entry) => entry.line === line);
    // only flip the line the person saw; an agent may have rewritten the plan since
    if (item && item.text === text) {
      await runtime.repo.savePlan(kind, subject, toggleChecklistLine(plan.content, line));
      await runtime.activity.record({ kind: "memory", name: "plan", status: "ok", via: "panel", detail: { status: item.checked ? "unticked" : "ticked", subject } }).catch(() => undefined);
    }
  }
  return new Response(null, { status: 303, headers: { location: new URL(target, url).toString() } });
}

async function assignmentTitles(db: D1Database, subjects: string[]): Promise<Map<string, { title: string; course: string | null }>> {
  const out = new Map<string, { title: string; course: string | null }>();
  await Promise.all(
    subjects.map(async (subject) => {
      const split = subject.indexOf(":");
      if (split < 0) return;
      const row = await db
        .prepare("SELECT title, course FROM items WHERE source = ? AND item_id = ?")
        .bind(subject.slice(0, split), subject.slice(split + 1))
        .first<{ title: string; course: string | null }>()
        .catch(() => null);
      if (row) out.set(subject, row);
    }),
  );
  return out;
}

// --- search -------------------------------------------------------------------------------------

export async function renderSearch(runtime: PanelRuntime, url: URL): Promise<string> {
  const at = now(runtime);
  const zone = safeZone(runtime.timezone);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const course = (url.searchParams.get("course") ?? "").trim().toUpperCase() || undefined;
  let results: ItemSummary[] = [];
  let failed = false;
  if (q) {
    try {
      results = await runtime.repo.searchItems({ query: q, course, limit: 50 });
    } catch {
      failed = true;
    }
  }
  const rows = results
    .map((item) => {
      const title = item.url ? `<a class="plain" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title);
      return `<li class="result">${sourceTile(item.source, "sm")}<div class="grow">
        <div class="result-title">${item.course ? `<a class="badge course" href="/panel/units/${encodeURIComponent(item.course)}">${escapeHtml(item.course)}</a>` : ""}<span>${title}</span>${item.staff ? '<span class="badge">staff</span>' : ""}</div>
        ${item.snippet ? `<p class="snippet">${escapeHtml(item.snippet)}</p>` : ""}
        <p class="result-meta">${escapeHtml(SOURCE_NAMES[item.source] ?? item.source)} · ${escapeHtml(item.kind)} · ${escapeHtml(formatIn(item.timestamp, zone, { day: "numeric", month: "short", year: "numeric" }))}${item.dueAt ? ` · due ${escapeHtml(relative(item.dueAt, at))}` : ""}</p>
      </div></li>`;
    })
    .join("");
  const body = `
    <form class="search-big" method="get" action="/panel/search" role="search">
      ${icon("search")}<input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search posts, assignments, announcements, emails…" aria-label="Search" autofocus>
      ${course ? `<input type="hidden" name="course" value="${escapeHtml(course)}">` : ""}<button type="submit">Search</button>
    </form>
    ${
      !q
        ? `<p class="muted small">Matches titles and bodies across every source. Add a unit code (e.g. <code>FIT2004 exam</code>) to narrow it down.</p>`
        : failed
          ? `<p class="notice error" role="alert">That search couldn't run. Try plain words without quotes or symbols.</p>`
          : `<section class="card"><div class="card-head row"><h2>${results.length} result${results.length === 1 ? "" : "s"}${course ? ` in ${escapeHtml(course)}` : ""}</h2></div><div class="card-body">${rows ? `<ul class="list results">${rows}</ul>` : empty("search", "No matches.")}</div></section>`
    }
    ${PANEL_STYLE}${CAMPUS_STYLE}${PANEL_SCRIPT}`;
  return renderPage({
    title: q ? `unicorn — ${escapeHtml(q)}` : "unicorn — search",
    active: "/panel/search",
    heading: "Search",
    subtitle: "The same full-text index your agents query with search_items.",
    body,
    wide: false,
  });
}

// --- dates --------------------------------------------------------------------------------------

/** ISO week ("2026-W45") of an instant, in the user's timezone. */
export function isoWeek(iso: string, zone: string): string {
  const [y, m, d] = dayKey(iso, zone).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday of an ISO week, as a UTC midnight ISO string. */
function mondayOf(week: string): Date {
  const [year, w] = week.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000);
  return new Date(monday.getTime() + (w - 1) * 7 * 86_400_000);
}

function shiftWeek(week: string, delta: number): string {
  return isoWeek(new Date(mondayOf(week).getTime() + delta * 7 * 86_400_000 + 12 * 3_600_000).toISOString(), "UTC");
}

function weekRange(week: string): string {
  const monday = mondayOf(week);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const fmt = (date: Date) => formatIn(date.toISOString(), "UTC", { day: "numeric", month: "short" });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function weekStart(iso: string, zone: string): string {
  return mondayOf(isoWeek(iso, zone)).toISOString();
}

export const CAMPUS_STYLE = `<style>
.muted-h{color:var(--muted);font-weight:500}
.toolbar .filters a{white-space:nowrap}
.feed-day+.feed-day{margin-top:16px}
.feed-day h3{font-size:12px;font-weight:500;color:var(--muted);margin:0 0 2px}
.changes>li{align-items:flex-start}
.change-row{display:flex;gap:12px;align-items:flex-start;min-width:0}
.change-text{display:flex;flex-direction:column;min-width:0;gap:3px}
.change-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px}
.change-meta{color:var(--muted);font-size:12.5px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.change-meta .src-dot{width:6px;height:6px}
.delta s{color:var(--faint)}
.delta strong{color:var(--fg);font-weight:500}
.tile-mark.ev{background:var(--default);color:var(--muted)}
.tile-mark.ev-deadline-changed{background:var(--warning-soft);color:var(--warning-text)}
.tile-mark.ev-grade-changed{background:var(--success-soft);color:var(--success-text)}
.tile-mark.ev-notice-posted{background:var(--accent-soft);color:var(--accent-text)}
.tile-mark.ev-item-added{background:var(--default);color:var(--fg)}
.tile-mark.ev-item-archived{background:var(--danger-soft);color:var(--danger-text)}
/* units: HeroUI data grid */
.u-name{display:flex;flex-direction:column;min-width:0}
.u-code{font-weight:600}
.u-title{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.u-src{display:flex;gap:6px;flex-wrap:wrap}
.u-next{display:flex;flex-direction:column;min-width:0;max-width:260px}
.u-next .muted{font-size:12.5px}
td .icon-btn .i{width:16px;height:16px}
tr.linked{cursor:pointer}
.unit-sources-row{display:flex;gap:8px;flex-wrap:wrap;margin:-8px 0 16px}
.bucket-end{display:inline-flex;gap:8px;align-items:center}
/* deadlines: a status board */
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px;align-items:start}
.lane{background:var(--surface-2);border-radius:20px;padding:12px 6px 6px}
.lane-head{display:flex;align-items:center;gap:8px;padding:0 10px 10px;font-size:14px;font-weight:600}
.lane-head .count{color:var(--muted);font-weight:500;font-size:13px}
.lane-cards{display:flex;flex-direction:column;gap:6px}
.task-card{display:block;background:var(--surface);border-radius:14px;box-shadow:var(--shadow);padding:12px 14px;transition:box-shadow .15s}
a.task-card:hover{box-shadow:var(--shadow-lg)}
.task-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.task-when{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);white-space:nowrap}
.task-when .i{width:13px;height:13px}
.task-title{margin:8px 0 6px;font-size:14px;font-weight:500;line-height:1.4}
.task-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.lane.overdue .task-when{color:var(--danger-text)}
.lane-empty{padding:16px 10px 18px;text-align:center;font-size:13px;color:var(--muted)}
/* briefs */
.brief{padding:0}
.brief details>summary{list-style:none;display:block;cursor:pointer;max-width:none;color:inherit;font-size:inherit}
.brief details>summary::before{display:none}
.brief-head{padding:16px}
.brief-title{display:flex;flex-direction:column;gap:6px}
.brief-title h2{font-size:16px;font-weight:600}
.brief-meta{display:flex;gap:8px;align-items:center}
.brief .card-body{border-top:1px solid var(--separator);margin:0 16px;padding:14px 0 16px}
.brief.is-read{background:transparent;box-shadow:inset 0 0 0 1px var(--separator)}
.brief.is-read h2{color:var(--muted);font-weight:500}
.brief-actions{display:flex;justify-content:flex-end;margin-top:10px}
.brief-actions:empty{display:none}
.prose{font-size:14px;line-height:1.65;color:var(--fg)}
.prose h1,.prose h2,.prose h3,.prose h4{font-size:14px;font-weight:600;margin:16px 0 6px}
.prose p{margin:0 0 10px}
.prose ul,.prose ol{margin:0 0 10px;padding-left:20px}
.prose li{margin:3px 0}
.prose a{color:var(--accent-text)}
.prose>:first-child{margin-top:0}
/* plans */
.tasks{list-style:none;margin:4px 0 12px;padding:0}
.tasks li{border-top:1px solid var(--separator)}
.tasks li:first-child{border-top:0}
.tasks form{display:flex;align-items:flex-start;gap:12px;padding:10px 0;margin:0}
.tick{flex:none;width:20px;height:20px;padding:0;margin-top:0;border-radius:7px;background:var(--surface);box-shadow:inset 0 0 0 2px var(--border);color:#fff}
.tick:hover{background:var(--surface);box-shadow:inset 0 0 0 2px var(--faint)}
.tick .i{width:13px;height:13px}
.tasks li.done .tick{background:var(--accent);box-shadow:none}
.tasks li.done .task-text{color:var(--muted);text-decoration:line-through}
.task-text{font-size:14px}
.plans li.active .plan-link{font-weight:600}
.plans li.active{color:var(--accent-text)}
.plan-link{display:flex;align-items:center;gap:8px;min-width:0}
.plan-link .i{width:16px;height:16px;color:var(--muted)}
/* search */
.search-big{display:flex;align-items:center;gap:10px;padding:4px 4px 4px 14px;background:var(--surface);border-radius:999px;box-shadow:var(--shadow);margin-bottom:16px}
.search-big:focus-within{box-shadow:0 0 0 2px var(--accent)}
.search-big .i{color:var(--muted)}
.search-big input::-webkit-search-cancel-button{display:none}
.search-big input[type=search]{flex:1;border:0;background:transparent;height:40px;font:inherit;font-size:15px;color:var(--fg);outline:none;box-shadow:none;padding:0}
.results>li{align-items:flex-start;gap:12px;justify-content:flex-start}
.result-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:500}
.snippet{margin:4px 0 0;color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.result-meta{margin:4px 0 0;color:var(--faint);font-size:12px}
</style>`;
