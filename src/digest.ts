import type { BriefStore } from "./briefs";
import type { ChangeType } from "./kernel/types";

// ADR-0034: the daily digest is a deterministic report over what is already in
// D1 — no model call. It runs once per user-local day, at or after 07:00 in
// the configured timezone (settings.timezone, IANA, default
// "Australia/Melbourne"), and is skipped entirely (no brief written) when
// every section is empty.

export interface DueSoonRow {
  title: string;
  url: string | null;
  dueAt: string;
}

export interface ChangeRow {
  title: string;
  type: ChangeType;
  url: string | null;
}

export interface DigestSections {
  dueSoon: DueSoonRow[];
  notices: ChangeRow[];
  changes: ChangeRow[];
}

const CHANGE_TYPE_LABEL: Record<Exclude<ChangeType, "notice.posted">, string> = {
  "item.added": "new",
  "item.archived": "archived",
  "item.restored": "restored",
  "deadline.changed": "deadline changed",
  "state.changed": "status changed",
  "grade.changed": "grade released",
  "content.changed": "updated",
};

// Pure and unit-tested independently of the D1 query below: given the sections
// for the day, produce the brief's title/body, or null when there is nothing
// to report (the caller skips writing a brief entirely in that case).
export function renderDigest(
  sections: DigestSections,
  dateLabel: string,
  timeZone: string,
): { title: string; body: string } | null {
  const { dueSoon, notices, changes } = sections;
  if (dueSoon.length === 0 && notices.length === 0 && changes.length === 0) {
    return null;
  }

  const parts: string[] = [`# unicorn daily digest — ${dateLabel}`];

  if (dueSoon.length > 0) {
    parts.push(
      "## Due soon",
      ...dueSoon.map((row) => `- ${link(row.title, row.url)} — due ${formatDue(row.dueAt, timeZone)}`),
    );
  }
  if (notices.length > 0) {
    parts.push("## Notices", ...notices.map((row) => `- ${link(row.title, row.url)}`));
  }
  if (changes.length > 0) {
    parts.push(
      "## Changes",
      ...changes.map((row) => `- ${link(row.title, row.url)} (${CHANGE_TYPE_LABEL[row.type as Exclude<ChangeType, "notice.posted">] ?? row.type})`),
    );
  }

  return { title: `unicorn daily digest — ${dateLabel}`, body: parts.join("\n\n") };
}

// Deadlines in the user's own timezone: a Melbourne-midnight deadline is 13:00Z the
// previous day, so the UTC date would name the wrong day.
function formatDue(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function link(title: string, url: string | null): string {
  return url ? `[${title}](${url})` : title;
}

interface UpcomingDbRow {
  title: string;
  url: string | null;
  due_at: string;
}

interface ChangeDbRow {
  title: string;
  type: ChangeType;
  url: string | null;
}

// The D1-touching half, kept separate from renderDigest so the rendering logic
// above is tested with plain fixtures. `since` bounds notices/changes; dueSoon
// always looks 7 days ahead of `now` regardless of `since`.
//
// The 7-day window is computed from `now` (the caller's own clock — see
// runDailyDigest below) rather than SQLite's julianday('now'), the real wall
// clock, so a fixed `now` makes this deterministic and testable.
export async function loadDigestSections(db: D1Database, since: string, now: Date): Promise<DigestSections> {
  const dueSoonEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const [dueSoon, notices, changes] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT i.title, i.url,
           json_extract(f.data_json, '$.' || json_extract(binding.value, '$.field')) AS due_at
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id
         JOIN json_each(f.capabilities_json) binding
         WHERE i.archived_at IS NULL
           AND json_extract(binding.value, '$.primitive') = 'temporal'
           AND julianday(due_at) BETWEEN julianday(?) AND julianday(?)
         ORDER BY julianday(due_at)
         LIMIT 20`,
      )
      .bind(now.toISOString(), dueSoonEnd)
      .all<UpcomingDbRow>(),
    db
      .prepare(`SELECT title, type, url FROM changes WHERE type = 'notice.posted' AND created_at >= ? ORDER BY seq DESC LIMIT 20`)
      .bind(since)
      .all<ChangeDbRow>(),
    db
      .prepare(
        `SELECT title, type, url FROM changes
         WHERE type IN ('deadline.changed', 'grade.changed', 'content.changed') AND created_at >= ?
         ORDER BY seq DESC
         LIMIT 20`,
      )
      .bind(since)
      .all<ChangeDbRow>(),
  ]);

  return {
    dueSoon: dueSoon.results.map((row) => ({ title: row.title, url: row.url, dueAt: row.due_at })),
    notices: notices.results.map((row) => ({ title: row.title, type: row.type, url: row.url })),
    changes: changes.results.map((row) => ({ title: row.title, type: row.type, url: row.url })),
  };
}

// "YYYY-MM-DD" and the local hour for `now` in an IANA timezone, using Intl
// instead of a date library (Workers ships full ICU).
export function localDateParts(now: Date, timeZone: string): { date: string; hour: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    map[part.type] = part.value;
  }
  // hour12:false can render midnight as "24" in some ICU builds.
  const hour = Number(map.hour) % 24;
  return { date: `${map.year}-${map.month}-${map.day}`, hour };
}

export type DigestOutcome = { status: "written" } | { status: "skipped"; reason: "not_due" | "already_done" | "empty" };

// Runs once per user-local day at/after 07:00: writes an idempotent
// `digest:YYYY-MM-DD` brief, or writes nothing when it's not due yet, already
// ran today, or every section is empty.
export async function runDailyDigest(
  db: D1Database,
  briefs: BriefStore,
  timezone: string,
  now: Date,
): Promise<DigestOutcome> {
  const { date, hour } = localDateParts(now, timezone);
  if (hour < 7) {
    return { status: "skipped", reason: "not_due" };
  }
  const id = `digest:${date}`;
  if (await briefs.exists(id)) {
    return { status: "skipped", reason: "already_done" };
  }

  const previous = await briefs.latestByKind("digest");
  const since = previous?.createdAt ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sections = await loadDigestSections(db, since, now);
  const rendered = renderDigest(sections, date, timezone);
  if (!rendered) {
    return { status: "skipped", reason: "empty" };
  }

  await briefs.insert({
    id,
    kind: "digest",
    subject: date,
    title: rendered.title,
    body: rendered.body,
    createdAt: now.toISOString(),
  });
  return { status: "written" };
}
