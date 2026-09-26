import { describe, expect, it, vi } from "vitest";
import type { Brief, BriefStore } from "../src/briefs";
import { localDateParts, loadDigestSections, renderDigest, runDailyDigest } from "../src/digest";

describe("renderDigest", () => {
  it("returns null when every section is empty", () => {
    expect(renderDigest({ dueSoon: [], notices: [], changes: [] }, "2026-09-26")).toBeNull();
  });

  it("renders a due-soon section with a linked title and the due date", () => {
    const rendered = renderDigest(
      { dueSoon: [{ title: "Assignment 2", url: "https://example.edu/a2", dueAt: "2026-09-30T06:00:00.000Z" }], notices: [], changes: [] },
      "2026-09-26",
    );

    expect(rendered?.title).toContain("2026-09-26");
    expect(rendered?.body).toContain("## Due soon");
    expect(rendered?.body).toContain("[Assignment 2](https://example.edu/a2)");
    expect(rendered?.body).toContain("due 2026-09-30");
  });

  it("renders notices and changes as separate sections with plain titles when there is no url", () => {
    const rendered = renderDigest(
      {
        dueSoon: [],
        notices: [{ title: "Lecture cancelled Friday", type: "notice.posted", url: null }],
        changes: [{ title: "Assignment 2", type: "grade.changed", url: null }],
      },
      "2026-09-26",
    );

    expect(rendered?.body).toContain("## Notices");
    expect(rendered?.body).toContain("- Lecture cancelled Friday");
    expect(rendered?.body).toContain("## Changes");
    expect(rendered?.body).toContain("- Assignment 2 (grade released)");
  });
});

describe("localDateParts", () => {
  it("computes the local date and hour for a given IANA timezone", () => {
    // 2026-09-26T20:30:00Z is 2026-09-27T06:30 in Australia/Melbourne (AEST/AEDT +10/+11).
    const { date, hour } = localDateParts(new Date("2026-09-26T20:30:00.000Z"), "Australia/Melbourne");
    expect(date).toBe("2026-09-27");
    expect(hour).toBeGreaterThanOrEqual(6);
    expect(hour).toBeLessThanOrEqual(7);
  });

  it("agrees with UTC when given the UTC timezone", () => {
    const { date, hour } = localDateParts(new Date("2026-09-26T07:00:00.000Z"), "UTC");
    expect(date).toBe("2026-09-26");
    expect(hour).toBe(7);
  });
});

function fakeDb(routes: Array<{ match: string; rows: unknown[] }>): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: routes.find((route) => sql.includes(route.match))?.rows ?? [] }),
      }),
      all: async () => ({ results: routes.find((route) => sql.includes(route.match))?.rows ?? [] }),
    }),
  } as unknown as D1Database;
}

describe("loadDigestSections", () => {
  it("splits changes into notices and the deadline/grade/content bucket", async () => {
    const db = fakeDb([
      { match: "BETWEEN julianday", rows: [{ title: "Assignment 2", url: null, due_at: "2026-09-30T00:00:00.000Z" }] },
      { match: "type = 'notice.posted'", rows: [{ title: "Lecture moved", type: "notice.posted", url: null }] },
      { match: "IN ('deadline.changed'", rows: [{ title: "Assignment 3", type: "deadline.changed", url: null }] },
    ]);

    const sections = await loadDigestSections(db, "2026-09-25T00:00:00.000Z");

    expect(sections.dueSoon).toEqual([{ title: "Assignment 2", url: null, dueAt: "2026-09-30T00:00:00.000Z" }]);
    expect(sections.notices).toEqual([{ title: "Lecture moved", type: "notice.posted", url: null }]);
    expect(sections.changes).toEqual([{ title: "Assignment 3", type: "deadline.changed", url: null }]);
  });
});

function fakeBriefs(overrides: Partial<BriefStore> = {}): BriefStore {
  return {
    insert: vi.fn().mockImplementation(async (input) => ({ ...input, readAt: null }) as Brief),
    list: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(0),
    prune: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(false),
    latestByKind: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("runDailyDigest", () => {
  it("skips before 07:00 local time without touching the database", async () => {
    const briefs = fakeBriefs();
    const db = fakeDb([]);

    const result = await runDailyDigest(db, briefs, "UTC", new Date("2026-09-26T06:59:00.000Z"));

    expect(result).toEqual({ status: "skipped", reason: "not_due" });
    expect(briefs.exists).not.toHaveBeenCalled();
  });

  it("skips when today's digest already exists", async () => {
    const briefs = fakeBriefs({ exists: vi.fn().mockResolvedValue(true) });
    const db = fakeDb([]);

    const result = await runDailyDigest(db, briefs, "UTC", new Date("2026-09-26T07:30:00.000Z"));

    expect(result).toEqual({ status: "skipped", reason: "already_done" });
    expect(briefs.insert).not.toHaveBeenCalled();
  });

  it("skips and writes nothing when every section is empty", async () => {
    const briefs = fakeBriefs();
    const db = fakeDb([
      { match: "BETWEEN julianday", rows: [] },
      { match: "type = 'notice.posted'", rows: [] },
      { match: "IN ('deadline.changed'", rows: [] },
    ]);

    const result = await runDailyDigest(db, briefs, "UTC", new Date("2026-09-26T07:30:00.000Z"));

    expect(result).toEqual({ status: "skipped", reason: "empty" });
    expect(briefs.insert).not.toHaveBeenCalled();
  });

  it("writes an idempotent digest:YYYY-MM-DD brief when there is something to report", async () => {
    const briefs = fakeBriefs();
    const db = fakeDb([
      { match: "BETWEEN julianday", rows: [{ title: "Assignment 2", url: null, due_at: "2026-09-30T00:00:00.000Z" }] },
      { match: "type = 'notice.posted'", rows: [] },
      { match: "IN ('deadline.changed'", rows: [] },
    ]);

    const result = await runDailyDigest(db, briefs, "UTC", new Date("2026-09-26T07:30:00.000Z"));

    expect(result).toEqual({ status: "written" });
    expect(briefs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "digest:2026-09-26", kind: "digest", subject: "2026-09-26" }),
    );
  });
});
