// Seeds the local wrangler D1 with a believable semester so the panel can be
// worked on without production data. Items go through the real Kernel, so
// facets, changes and course labels are exactly what a sync would produce.
//
//   npm run seed:local            (after `wrangler d1 migrations apply unicorn --local`)

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapSqliteD1 } from "../server/sqlite-d1";
import { labelStructure } from "../src/kernel/courses";
import { D1ItemStore } from "../src/kernel/d1-item-store";
import { Kernel } from "../src/kernel/kernel";
import type { Facet, ItemInput } from "../src/kernel/types";

const DAY = 86_400_000;
const NOW = Date.now();
const at = (days: number, hour = 23, minute = 55) => {
  const date = new Date(NOW + days * DAY);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

const UNITS = [
  { code: "FIT2004", name: "Algorithms and data structures", moodle: 31001, ed: 21001 },
  { code: "FIT2086", name: "Modelling for data analysis", moodle: 31002, ed: 21002 },
  { code: "FIT3171", name: "Databases", moodle: 31003, ed: 21003 },
  { code: "MAT1830", name: "Discrete mathematics for computer science", moodle: 31004, ed: 21004 },
];

interface Assessment {
  id: number;
  unit: number;
  name: string;
  due: number;
  status: string;
  grade?: number;
}

const ASSESSMENTS: Assessment[] = [
  { id: 501, unit: 0, name: "Assignment 1: Graph search", due: -24, status: "submitted", grade: 18.5 },
  { id: 502, unit: 0, name: "Assignment 2: Dynamic programming", due: 2, status: "new" },
  { id: 503, unit: 0, name: "Quiz 9", due: 5, status: "new" },
  { id: 511, unit: 1, name: "Assignment 3 (Weight: 20%)", due: -13, status: "submitted", grade: 35.5 },
  { id: 512, unit: 1, name: "Final assessment (eExam)", due: 9, status: "new" },
  { id: 521, unit: 2, name: "Assignment 2: Creating, populating and querying", due: -5, status: "submitted" },
  { id: 522, unit: 2, name: "Lab 10 exercises", due: 1, status: "new" },
  { id: 523, unit: 2, name: "Assignment 3: Transactions", due: 16, status: "new" },
  { id: 531, unit: 3, name: "Problem set 8", due: -1, status: "new" },
  { id: 532, unit: 3, name: "Problem set 9", due: 6, status: "new" },
  { id: 533, unit: 3, name: "Final exam", due: 23, status: "new" },
];

interface Thread {
  id: number;
  unit: number;
  title: string;
  daysAgo: number;
  role: "student" | "tutor" | "admin";
  category: string;
  body: string;
  pinned?: boolean;
  answered?: boolean;
  replies: number;
}

const THREADS: Thread[] = [
  { id: 9001, unit: 0, title: "A2 clarification: memoisation table size", daysAgo: 1, role: "tutor", category: "Assignments", body: "The table may be O(nW). Anything larger loses marks for space.", pinned: true, replies: 14, answered: true },
  { id: 9002, unit: 0, title: "Is Dijkstra allowed for Q3?", daysAgo: 3, role: "student", category: "Assignments", body: "The spec says shortest path but weights can be negative.", replies: 6, answered: true },
  { id: 9003, unit: 1, title: "eExam: permitted materials", daysAgo: 2, role: "admin", category: "Exams", body: "One double-sided A4 sheet. Calculators must be on the approved list.", pinned: true, replies: 22 },
  { id: 9004, unit: 1, title: "Week 11 tutorial solutions released", daysAgo: 4, role: "tutor", category: "Tutorials", body: "Solutions for the bootstrap questions are on Moodle.", replies: 3 },
  { id: 9005, unit: 2, title: "Lab 10: ORA-00942 on the shared schema", daysAgo: 0, role: "student", category: "Labs", body: "Getting table or view does not exist when querying the shared schema.", replies: 2 },
  { id: 9006, unit: 2, title: "A3 spec published", daysAgo: 1, role: "admin", category: "Assignments", body: "Assignment 3 on transactions is live. Due in week 12.", pinned: true, replies: 9 },
  { id: 9007, unit: 3, title: "Problem set 8 Q4: induction base case", daysAgo: 2, role: "student", category: "Problem sets", body: "Do we need n = 0 and n = 1 as base cases?", replies: 5, answered: true },
  { id: 9008, unit: 3, title: "Consultation hours this week", daysAgo: 5, role: "tutor", category: "General", body: "Extra consultations Thursday 2–4pm in the Woodside building.", replies: 1 },
];

function moodleCourse(unit: (typeof UNITS)[number]): ItemInput {
  return {
    id: `course:${unit.moodle}`,
    source: "campus-moodle",
    kind: "course",
    title: `${unit.code} ${unit.name} - S2 2026`,
    timestamp: "2026-07-27T00:00:00.000Z",
    url: `https://learning.monash.edu/course/view.php?id=${unit.moodle}`,
    raw: { id: unit.moodle, shortname: `${unit.code}_S2_2026` },
    facets: [
      {
        type: "course-identity",
        data: { platform: "moodle", platformId: String(unit.moodle), code: `${unit.code}_S2_2026`, status: "active", term: "S2 2026" },
        capabilities: [{ name: "has-visibility", primitive: "state", field: "status" }],
      },
    ],
  };
}

function edCourse(unit: (typeof UNITS)[number]): ItemInput {
  return {
    id: `course:${unit.ed}`,
    source: "campus-ed",
    kind: "course",
    title: `${unit.code} ${unit.name}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    url: `https://edstem.org/au/courses/${unit.ed}/discussion/`,
    raw: { id: unit.ed, code: unit.code },
    facets: [
      {
        type: "course-identity",
        data: { platform: "ed", platformId: String(unit.ed), code: unit.code, status: "active", term: "S2 2026" },
        capabilities: [{ name: "has-course-status", primitive: "state", field: "status" }],
      },
    ],
  };
}

function assessment(a: Assessment): ItemInput {
  const unit = UNITS[a.unit];
  const dueAt = at(a.due);
  const facets: Facet[] = [
    { type: "deadline", data: { dueAt }, capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }] },
    { type: "course-membership", data: { course: `course:${unit.moodle}` }, capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }] },
    { type: "submission", data: { status: a.status }, capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }] },
  ];
  if (a.grade !== undefined) {
    facets.push({ type: "grade", data: { grade: a.grade }, capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }] });
  }
  return {
    id: `assessment:${a.id}`,
    source: "campus-moodle",
    kind: "assessment",
    title: a.name,
    timestamp: dueAt,
    url: `https://learning.monash.edu/mod/assign/view.php?id=${a.id}`,
    raw: { id: a.id, course: unit.moodle },
    facets,
  };
}

function thread(t: Thread): ItemInput {
  const unit = UNITS[t.unit];
  return {
    id: `thread:${t.id}`,
    source: "campus-ed",
    kind: "thread",
    title: t.title,
    timestamp: new Date(NOW - t.daysAgo * DAY - 3 * 3_600_000).toISOString(),
    url: `https://edstem.org/au/courses/${unit.ed}/discussion/${t.id - 8900}`,
    body: t.body,
    raw: { id: t.id, course_id: unit.ed, reply_count: t.replies },
    facets: [
      { type: "course-membership", data: { course: `course:${unit.ed}` }, capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }] },
      { type: "author", data: { actor: `ed-user:${t.id}`, authorRole: t.role }, capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }] },
      {
        type: "discussion-state",
        data: { answerStatus: t.answered ? "answered" : "unanswered", lockStatus: "open", pinStatus: t.pinned ? "pinned" : "normal" },
        capabilities: [
          { name: "has-answer-status", primitive: "state", field: "answerStatus" },
          { name: "has-lock-status", primitive: "state", field: "lockStatus" },
          { name: "has-pin-status", primitive: "state", field: "pinStatus" },
        ],
      },
      {
        type: "engagement",
        data: { replies: t.replies, votes: Math.round(t.replies / 2), stars: 0 },
        capabilities: [
          { name: "has-reply-count", primitive: "scalar", field: "replies" },
          { name: "has-vote-count", primitive: "scalar", field: "votes" },
          { name: "has-star-count", primitive: "scalar", field: "stars" },
        ],
      },
      { type: "discussion-category", data: { category: t.category }, capabilities: [] },
    ],
  };
}

function localDatabasePath(): string {
  const dir = join(process.cwd(), ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (!file) throw new Error(`No local D1 under ${dir}; run: npx wrangler d1 migrations apply unicorn --local`);
  return join(dir, file);
}

async function main(): Promise<void> {
  const sqlite = new DatabaseSync(localDatabasePath());
  for (const table of ["changes", "facets", "relations", "items", "briefs", "plans", "activity_log", "agent_notes"]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  const db = wrapSqliteD1(sqlite);
  const store = new D1ItemStore(db);

  // First sync a week ago: everything appears.
  const first = [...UNITS.flatMap((u) => [moodleCourse(u), edCourse(u)]), ...ASSESSMENTS.map(assessment), ...THREADS.filter((t) => t.daysAgo >= 5).map(thread)];
  await new Kernel(store, () => new Date(NOW - 7 * DAY)).ingest(first);

  // Later syncs: a deadline moves, a grade lands, a submission goes in, new threads.
  const moved = ASSESSMENTS.map((a) => (a.id === 523 ? { ...a, due: 18 } : a.id === 521 ? { ...a, grade: 27 } : a.id === 531 ? { ...a, status: "submitted" } : a));
  for (const [daysAgo, batch] of [
    [3, [...moved.map(assessment), ...THREADS.filter((t) => t.daysAgo >= 3).map(thread)]],
    [0, [...moved.map(assessment), ...THREADS.map(thread)]],
  ] as const) {
    await new Kernel(store, () => new Date(NOW - daysAgo * DAY - 3_600_000)).ingest([...batch]);
  }
  await labelStructure(db);

  const iso = (days: number) => new Date(NOW + days * DAY).toISOString();
  const insert = (sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).run(...values);
  insert(
    "INSERT INTO briefs (id, kind, subject, title, body, created_at, read_at) VALUES (?, 'digest', 'today', ?, ?, ?, NULL)",
    "b-today",
    "Morning digest",
    "**2 deadlines in 48 hours.** FIT3171 Lab 10 (tomorrow) and FIT2004 A2 (in 2 days).\n\nStaff posted the FIT3171 A3 spec and pinned eExam materials for FIT2086.",
    iso(-0.2),
  );
  insert(
    "INSERT INTO briefs (id, kind, subject, title, body, created_at, read_at) VALUES (?, 'forum', 'FIT2004', ?, ?, ?, ?)",
    "b-forum",
    "FIT2004 forum catch-up",
    "A tutor capped the A2 memo table at O(nW). Six students asked about negative weights in Q3.",
    iso(-2),
    iso(-1.5),
  );
  const week = isoWeek(new Date(NOW));
  insert(
    "INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES (?, 'weekly', ?, ?, ?, ?)",
    `weekly:${week}`,
    week,
    "## Monday\n- [x] Read the FIT3171 A3 spec\n- [ ] Lab 10 exercises\n\n## Tuesday\n- [ ] FIT2004 A2 part 2\n- [ ] MAT1830 problem set 9 Q1–3\n\n## Thursday\n- [ ] FIT2086 eExam past paper",
    iso(-1),
    iso(-1),
  );
  insert(
    "INSERT INTO agent_notes (domain, content, updated_at) VALUES ('user', ?, ?)",
    "Second-year IT student at Monash Clayton. Prefers short answers. Exams outrank forum threads.",
    iso(-3),
  );
  const clients = ["Claude", "Codex", "Claude Code", "ChatGPT"];
  const tools = ["due", "changes", "course", "search_items", "get_memory", "brief"];
  for (let i = 0; i < 60; i += 1) {
    insert(
      "INSERT INTO activity_log (at, kind, name, status, error_code, duration_ms, actor, via, detail_json) VALUES (?, 'tool', ?, ?, ?, ?, ?, 'oauth', NULL)",
      iso(-(i * 0.11 + (i % 7) * 0.3)),
      tools[i % tools.length],
      i % 17 === 5 ? "error" : "ok",
      i % 17 === 5 ? "upstream_timeout" : null,
      40 + ((i * 37) % 400),
      clients[i % clients.length],
    );
  }
  for (let i = 0; i < 7 * 24; i += 6) {
    insert(
      "INSERT INTO activity_log (at, kind, name, status, error_code, duration_ms, actor, via, detail_json) VALUES (?, 'sync', ?, 'ok', NULL, ?, NULL, 'scheduler', NULL)",
      new Date(NOW - i * 3_600_000).toISOString(),
      i % 12 ? "campus-ed" : "campus-moodle",
      300 + ((i * 53) % 900),
    );
  }

  const counts = sqlite.prepare("SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM changes) AS changes").get();
  console.log("seeded", counts);
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

await main();
