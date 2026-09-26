// A reusable, realistic mixed dataset for integration tests: one course
// taught partly on Moodle and partly on Ed (same unit code, two sources —
// exercising the course resolver's cross-source bucket matching), one
// Canvas-only course, and two emails with course mentions.
//
// Moodle/Ed/Canvas fixtures are built by calling each plugin's own `pull()`
// with an injected `fetch` returning fixed API payloads, so the resulting
// ItemInputs are exactly what the real mapper code produces — never a
// hand-duplicated guess at their shape. Email has no dedicated plugin class
// (it's the declarative Gmail preset, see src/plugins/presets/gmail.json),
// so its ItemInputs are built directly from the same course-mention facet
// builder the preset's "derive: course-mention" step uses.

import { CanvasPlugin } from "../../src/plugins/campus/canvas-plugin";
import { EdPlugin } from "../../src/plugins/campus/ed-plugin";
import { MoodlePlugin } from "../../src/plugins/campus/moodle-plugin";
import { courseMentionFacet, extractUnitCodes } from "../../src/plugins/course-mention";
import type { ItemInput } from "../../src/kernel/types";

// Fixed "now" for every fixture below, so due dates / created dates / digest
// windows are deterministic across test runs and test files.
export const DATASET_NOW = new Date("2026-03-10T00:00:00.000Z");

function daysFromNow(days: number): string {
  return new Date(DATASET_NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function routedFetch(routes: Array<{ test: (url: string) => boolean; handle: (url: string) => Response }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const route of routes) {
      if (route.test(url)) {
        return route.handle(url);
      }
    }
    throw new Error(`dataset fixture: no route matched ${url}`);
  }) as typeof fetch;
}

// --- Moodle: course FIT2004 with two assignments (one graded, one not) ----

export async function buildMoodleFixture(): Promise<ItemInput[]> {
  const baseUrl = "https://moodle.example.edu";
  const fetcher = routedFetch([
    {
      test: (url) => url.startsWith(`${baseUrl}/my/`),
      handle: () => new Response('<html>"sesskey":"sk123"</html>', { status: 200 }),
    },
    {
      test: (url) => url.includes("/lib/ajax/service.php"),
      handle: () =>
        jsonResponse([
          {
            data: {
              courses: [
                {
                  id: 100,
                  startdate: Math.floor(new Date(daysFromNow(-40)).getTime() / 1000),
                  visible: true,
                  shortname: "FIT2004_S2_2026",
                  fullname: "Algorithms and Data Structures",
                },
              ],
            },
          },
          {
            data: {
              events: [
                {
                  id: 1,
                  purpose: "assessment",
                  modulename: "assign",
                  name: "Assignment 1",
                  timesort: Math.floor(new Date(daysFromNow(5)).getTime() / 1000),
                  url: `${baseUrl}/mod/assign/view.php?id=1`,
                  course: { id: 100 },
                  action: {},
                  grade: 87,
                  submissionstatus: "submitted",
                },
                {
                  id: 2,
                  purpose: "assessment",
                  modulename: "quiz",
                  name: "Assignment 2",
                  timesort: Math.floor(new Date(daysFromNow(12)).getTime() / 1000),
                  url: `${baseUrl}/mod/quiz/view.php?id=2`,
                  course: { id: 100 },
                  action: {},
                  submissionstatus: "unknown",
                },
              ],
            },
          },
        ]),
    },
  ]);

  const plugin = new MoodlePlugin({ baseUrl, session: "sess", fetch: fetcher, now: () => DATASET_NOW });
  return plugin.pull();
}

// --- Ed: same unit (FIT2004), three threads exercising the category ->
// assessment matcher's three outcomes: exact match, no match, ambiguous. ---

export async function buildEdFixture(): Promise<ItemInput[]> {
  const fetcher = routedFetch([
    {
      test: (url) => url.includes("/api/user"),
      handle: () =>
        jsonResponse({
          courses: [
            {
              course: {
                id: 200,
                status: "active",
                year: "2026",
                session: "S2",
                code: "FIT2004 S2 2026",
                name: "Algorithms and Data Structures",
              },
            },
          ],
        }),
    },
    {
      test: (url) => url.includes("/api/courses/200/threads"),
      handle: () =>
        jsonResponse({
          threads: [
            {
              id: 10,
              number: 1,
              course_id: 200,
              user_id: 1,
              user: { course_role: "student" },
              title: "Help with Assignment 1",
              category: "Assignment 1", // exact match -> course/FIT2004/assignment-1
              document: "Anyone else stuck on part B?",
              created_at: daysFromNow(-2),
              is_answered: false,
              is_locked: false,
              is_pinned: false,
              reply_count: 3,
              vote_count: 1,
              view_count: 20,
              star_count: 0,
            },
            {
              id: 11,
              number: 2,
              course_id: 200,
              user_id: 2,
              user: { course_role: "tutor" },
              title: "Week 5 content released",
              category: "General", // no matching assessment -> course/FIT2004/general
              document: "Lecture recording for week 5 is up.",
              created_at: daysFromNow(-1),
              is_answered: true,
              is_locked: false,
              is_pinned: true,
              reply_count: 0,
              vote_count: 5,
              view_count: 80,
              star_count: 2,
            },
            {
              id: 12,
              number: 3,
              course_id: 200,
              user_id: 3,
              user: { course_role: "student" },
              title: "Which assignment is due first?",
              category: "Assignment", // ambiguous prefix match (both Assignment 1 and 2) -> general
              document: "Trying to plan my week.",
              created_at: daysFromNow(0),
              is_answered: false,
              is_locked: false,
              is_pinned: false,
              reply_count: 1,
              vote_count: 0,
              view_count: 5,
              star_count: 0,
            },
          ],
        }),
    },
  ]);

  const plugin = new EdPlugin({ token: "tok", fetch: fetcher, now: () => DATASET_NOW });
  return plugin.pull();
}

// --- Canvas: a second, unrelated course (COMP1511) with one graded
// assignment and one staff-authored announcement. ---

export async function buildCanvasFixture(): Promise<ItemInput[]> {
  const baseUrl = "https://canvas.example.edu";
  const fetcher = routedFetch([
    {
      test: (url) => url.includes("/api/v1/courses?") || url.endsWith("/api/v1/courses"),
      handle: () =>
        jsonResponse([
          {
            id: 300,
            course_code: "COMP1511",
            name: "Programming Fundamentals",
            workflow_state: "available",
            start_at: daysFromNow(-40),
            term: { name: "Semester 2 2026" },
          },
        ]),
    },
    {
      test: (url) => url.includes("/api/v1/courses/300/assignments"),
      handle: () =>
        jsonResponse([
          {
            id: 20,
            name: "Project 1",
            due_at: daysFromNow(7),
            html_url: `${baseUrl}/courses/300/assignments/20`,
            submission: { score: 91, workflow_state: "graded" },
          },
        ]),
    },
    {
      test: (url) => url.includes("/api/v1/announcements"),
      handle: () =>
        jsonResponse([
          {
            id: 30,
            title: "Week 5 update",
            message: "<p>Reminder: quiz moved to next week.</p>",
            posted_at: daysFromNow(-1),
            html_url: `${baseUrl}/courses/300/discussion_topics/30`,
            author: { id: 900 },
          },
        ]),
    },
    {
      test: (url) => url.includes("/api/v1/courses/300/discussion_topics"),
      handle: () => jsonResponse([]),
    },
  ]);

  const plugin = new CanvasPlugin({ baseUrl, token: "tok", fetch: fetcher, now: () => DATASET_NOW });
  return plugin.pull();
}

// --- Email: no dedicated plugin class (declarative Gmail preset) — built
// directly from the same course-mention facet builder the preset uses. ---

function emailItem(id: string, subject: string, body: string, sentAt: string): ItemInput {
  const codes = extractUnitCodes(subject, body);
  const mention = courseMentionFacet(codes);
  return {
    id,
    source: "gmail",
    kind: "email",
    title: subject,
    timestamp: sentAt,
    body,
    raw: { subject, body, sentAt },
    facets: [
      {
        type: "author",
        data: { actor: "email:registrar@example.edu" },
        capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
      },
      ...(mention ? [mention] : []),
    ],
  };
}

/** Mentions exactly one course code (FIT2004) — structurally resolvable. */
export function buildEmailSingleMentionFixture(): ItemInput {
  return emailItem(
    "email:1",
    "FIT2004 assignment extension granted",
    "Your extension request for FIT2004 has been approved.",
    daysFromNow(-3),
  );
}

/**
 * Mentions two course codes — deliberately ambiguous, left unlabeled.
 * Both codes must match extractUnitCodes' pattern (exactly three letters
 * then four digits — deliberately stricter than courses.ts's own code
 * pattern, see course-mention.ts), so this uses MAT1830 rather than
 * Canvas's four-letter COMP1511.
 */
export function buildEmailTwoMentionsFixture(): ItemInput {
  return emailItem(
    "email:2",
    "Timetable clash between FIT2004 and MAT1830",
    "Please note the exam clash between FIT2004 and MAT1830 has been resolved.",
    daysFromNow(-4),
  );
}

/**
 * The full mixed dataset used across the integration test suite: Moodle
 * (FIT2004), Ed (same FIT2004, different source), Canvas (COMP1511), and two
 * emails (one single mention, one ambiguous double mention).
 */
export async function buildMixedDataset(): Promise<ItemInput[]> {
  const [moodle, ed, canvas] = await Promise.all([buildMoodleFixture(), buildEdFixture(), buildCanvasFixture()]);
  return [...moodle, ...ed, ...canvas, buildEmailSingleMentionFixture(), buildEmailTwoMentionsFixture()];
}
