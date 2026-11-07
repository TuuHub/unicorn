// Term memory (ADR-0047): unicorn's kernel, not the agent, keeps the TERM memory store current.
//
// Every cycle it reads the units the user is enrolled in right now — the course-identity facets of
// non-archived items, exactly what v_courses exposes — and rewrites TERM as one line per unit.
// When the set of units changes it files a brief, so the next session's get_briefs tells the agent
// "a new term started / a new unit appeared" and the agent asks the user about it (SOUL.md, the
// onboard playbook). The very first time it finds units is the cold start: the brief says so.
//
// Zero-LLM and deterministic, like the rest of the cycle (ADR-0034).

import type { BriefStore } from "./briefs";
import { MEMORY_TARGETS } from "./agent-memory";
import type { MemoryStore } from "./memory";

export interface TermCourse {
  code: string;
  title: string | null;
  term: string | null;
  sources: string[];
}

const SOURCE_LABELS: Record<string, string> = {
  "campus-moodle": "Moodle",
  "campus-ed": "Ed",
  "campus-canvas": "Canvas",
  gmail: "Gmail",
};

export async function loadTermCourses(db: D1Database): Promise<TermCourse[]> {
  const rows = await db
    .prepare(
      `SELECT code, term, title, source FROM v_courses
       WHERE code IS NOT NULL AND code <> ''
       ORDER BY code, term`,
    )
    .all<{ code: string; term: string | null; title: string | null; source: string }>();
  const byCode = new Map<string, TermCourse>();
  for (const row of rows.results) {
    const code = String(row.code).toUpperCase();
    const entry = byCode.get(code) ?? { code, title: null, term: null, sources: [] };
    entry.title ??= cleanTitle(row.title, code);
    // Prefer the latest-looking term label when sources disagree (e.g. "2026 S1" vs "2026 S2").
    if (row.term && (!entry.term || row.term > entry.term)) {
      entry.term = row.term;
    }
    const label = SOURCE_LABELS[row.source] ?? row.source;
    if (!entry.sources.includes(label)) {
      entry.sources.push(label);
    }
    byCode.set(code, entry);
  }
  const courses = [...byCode.values()];
  // When terms are known, keep only the most recent term's units: an archived-but-not-yet-retained
  // offering from last semester should not read as "enrolled now".
  const terms = courses.map((course) => course.term).filter((term): term is string => Boolean(term));
  if (terms.length > 0) {
    const latest = terms.sort().at(-1)!;
    return courses.filter((course) => !course.term || course.term === latest);
  }
  return courses;
}

function cleanTitle(title: string | null, code: string): string | null {
  if (!title) return null;
  const stripped = title.replace(new RegExp(`^\\s*${code}\\s*[-–—:]?\\s*`, "i"), "").trim();
  return stripped || null;
}

export function renderTermLines(courses: TermCourse[], today: string): string[] {
  const header = `- (auto, ${today}) ${courses.length} unit${courses.length === 1 ? "" : "s"} this term${courses[0]?.term ? ` — ${courses[0].term}` : ""}`;
  const lines = [header];
  for (const course of courses) {
    const parts = [course.code];
    if (course.title) parts.push(course.title);
    lines.push(`- ${parts.join(" — ")} (${course.sources.join(", ")})`);
  }
  // Keep inside the TERM store's limit: drop trailing units, say how many were left out.
  const limit = MEMORY_TARGETS.term.limit;
  while (lines.join("\n").length > limit && lines.length > 2) {
    lines.pop();
  }
  const omitted = courses.length - (lines.length - 1);
  if (omitted > 0) {
    lines.push(`- …and ${omitted} more (see course())`);
  }
  return lines;
}

function codesIn(content: string): string[] {
  return content
    .split("\n")
    .slice(1)
    .map((line) => line.match(/^- ([A-Z]{2,5}\d{3,5}[A-Z]?)\b/)?.[1])
    .filter((code): code is string => Boolean(code))
    .sort();
}

export interface TermRefreshResult {
  status: "unchanged" | "initialized" | "changed" | "empty";
  added: string[];
  removed: string[];
}

export async function refreshTermMemory(db: D1Database, memory: MemoryStore, briefs: BriefStore, now: Date): Promise<TermRefreshResult> {
  const courses = await loadTermCourses(db);
  if (courses.length === 0) {
    return { status: "empty", added: [], removed: [] };
  }
  const today = now.toISOString().slice(0, 10);
  const note = await memory.get(MEMORY_TARGETS.term.domain);
  const previous = codesIn(note.content);
  const current = courses.map((course) => course.code).sort();
  const added = current.filter((code) => !previous.includes(code));
  const removed = previous.filter((code) => !current.includes(code));
  if (note.content && added.length === 0 && removed.length === 0) {
    return { status: "unchanged", added, removed };
  }
  const content = renderTermLines(courses, today).join("\n");
  await memory.save(MEMORY_TARGETS.term.domain, content, note.content ? note.updatedAt : undefined);

  const first = !note.content;
  const listing = courses.map((course) => `- **${course.code}**${course.title ? ` — ${course.title}` : ""} (${course.sources.join(", ")})`).join("\n");
  const body = first
    ? [
        "unicorn finished its first sync and found these units:",
        listing,
        "",
        "Agent: this is a cold start. Run the onboard playbook (run_playbook({name:\"onboard\"})) to get to know the user and fill their USER PROFILE in memory.",
      ].join("\n")
    : [
        added.length ? `New this term: ${added.join(", ")}.` : null,
        removed.length ? `No longer active: ${removed.join(", ")}.` : null,
        "",
        listing,
        "",
        "Agent: ask the user one or two questions about the new units (goals, how heavy they look) and save the answers with memory({target:\"notes\"}); retire notes about units that ended.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
  await briefs.insert({
    id: `term:${today}:${current.join(",")}`.slice(0, 200),
    kind: "term",
    subject: courses[0]?.term ?? today,
    title: first ? `Your units this term (${courses.length})` : `Your units changed: ${[...added.map((c) => `+${c}`), ...removed.map((c) => `−${c}`)].join(" ")}`,
    body,
  });
  return { status: first ? "initialized" : "changed", added, removed };
}
