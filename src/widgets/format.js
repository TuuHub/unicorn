// Date/time and change-phrasing helpers shared by every widget (ADR-0037).
// Formatting goes through Intl so it respects the payload's own timezone
// (StatusView.timezone) when the caller passes one, falling back to the
// browser's when it doesn't.
//
// Dual-mode module: see markdown.js for why this file also runs as a plain
// inlined script.

export function formatDateTime(iso, timezone, options) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone || undefined, ...options }).format(date);
}

const RELATIVE_UNITS = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

export function formatRelativeTime(iso, now, timezone) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const reference = now instanceof Date ? now : new Date();
  const diffSeconds = (then.getTime() - reference.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return rtf.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return rtf.format(Math.round(diffSeconds / 60), "minute") || rtf.format(0, "second");
}

// A stable, locale-independent calendar-day key ("2026-09-26"), for grouping
// and comparing dates without a timezone-sensitive Date subtraction.
function dayKey(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

// Today / Tomorrow / weekday name (within the next week) / calendar date —
// the order a student actually scans a deadline list in.
export function dayLabel(iso, now, timezone) {
  const date = new Date(iso);
  const reference = now instanceof Date ? now : new Date();
  const today = dayKey(reference, timezone);
  const key = dayKey(date, timezone);
  if (key === today) return "Today";
  const diffDays = daysBetween(today, key);
  if (diffDays === 1) return "Tomorrow";
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone || undefined, weekday: "long" }).format(date);
  }
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return formatDateTime(iso, timezone, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

// Groups items carrying a dueAt into ordered day buckets: an "Overdue" group
// first (danger colour, in the widget's CSS, not here), then Today, Tomorrow,
// weekday names, then calendar dates in order. Items without a dueAt are
// dropped — the caller decides what to do with those separately.
export function groupByDay(items, now, timezone) {
  const reference = now instanceof Date ? now : new Date();
  const today = dayKey(reference, timezone);
  const overdue = [];
  const buckets = new Map();

  for (const item of items) {
    if (!item.dueAt) continue;
    const due = new Date(item.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    const key = dayKey(due, timezone);
    if (daysBetween(today, key) < 0) {
      overdue.push(item);
      continue;
    }
    if (!buckets.has(key)) buckets.set(key, { key, label: dayLabel(item.dueAt, reference, timezone), items: [] });
    buckets.get(key).items.push(item);
  }

  const ordered = [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups = [];
  if (overdue.length > 0) {
    overdue.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    groups.push({ key: "overdue", label: "Overdue", items: overdue, overdue: true });
  }
  groups.push(...ordered);
  return groups;
}

// Human phrasing for a ChangeEvent (door-contracts.ts), matching ADR-0037's
// own examples ("Deadline moved Fri 3 Oct 23:55 -> Mon 6 Oct 09:00").
export function phraseChange(event, timezone) {
  const fmt = (iso) =>
    formatDateTime(iso, timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  switch (event.type) {
    case "deadline.changed":
      return `Deadline moved ${fmt(event.before) ?? "unknown"} → ${fmt(event.after) ?? "unknown"}`;
    case "grade.changed":
      return `Grade ${event.before ?? "—"} → ${event.after ?? "—"}`;
    case "state.changed":
      return `Status ${event.before ?? "—"} → ${event.after ?? "—"}`;
    case "content.changed":
      return "Content changed";
    case "notice.posted":
      return event.title ? `New staff notice: ${event.title}` : "New staff notice";
    case "item.added":
      return `New: ${event.title}`;
    case "item.archived":
      return `Archived: ${event.title}`;
    case "item.restored":
      return `Restored: ${event.title}`;
    default:
      return event.title || event.type;
  }
}

if (typeof window !== "undefined") {
  window.Unicorn = window.Unicorn || {};
  window.Unicorn.format = { formatDateTime, formatRelativeTime, dayLabel, groupByDay, phraseChange };
}
