import { describe, expect, it, vi } from "vitest";
import { D1DoorRepository } from "../src/mcp/door-repository";

// Same SQL-substring-matching D1 fake as tests/d1-repository.test.ts, extended
// with .batch() since labelItems writes through it.
function fakeDb(routes: Array<{ match: string; rows?: unknown[]; row?: unknown }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  function statement(sql: string, values: unknown[]) {
    return {
      bind: (...boundValues: unknown[]) => statement(sql, boundValues),
      all: async () => {
        calls.push({ sql, values });
        const route = routes.find((candidate) => sql.includes(candidate.match));
        return { results: route?.rows ?? [] };
      },
      first: async () => {
        calls.push({ sql, values });
        const route = routes.find((candidate) => sql.includes(candidate.match));
        return route?.row ?? null;
      },
      run: async () => {
        calls.push({ sql, values });
        return { meta: { changes: 1 } };
      },
    };
  }
  const prepare = vi.fn((sql: string) => statement(sql, []));
  const batch = vi.fn(async (statements: Array<{ sql?: string }>) => statements.map(() => ({ meta: { changes: 1 } })));
  const db = { prepare, batch } as unknown as D1Database;
  return { db, calls, batch };
}

describe("D1DoorRepository.changesSince", () => {
  it("with no cursor, returns the latest 20 ascending with no gaps or dups, and forces hasMore false", async () => {
    // 25 rows exist; the query asks for limit+1=21, newest first (DESC).
    const rows = Array.from({ length: 21 }, (_, i) => changeRow(25 - i));
    const { db } = fakeDb([{ match: "FROM changes c", rows }]);
    const repo = new D1DoorRepository(db);

    const page = await repo.changesSince({ limit: 100 });

    expect(page.events.map((event) => event.cursor)).toEqual(Array.from({ length: 20 }, (_, i) => String(6 + i)));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe("25");
  });

  it("pages forward from a cursor with no overlap and no gap into the next call", async () => {
    // Page 1: cursor 5, limit 10 -> asks for 11 rows ascending from 6.
    const page1Rows = Array.from({ length: 11 }, (_, i) => changeRow(6 + i));
    const { db: db1 } = fakeDb([{ match: "FROM changes c", rows: page1Rows }]);
    const page1 = await new D1DoorRepository(db1).changesSince({ cursor: "5", limit: 10 });
    expect(page1.events.map((e) => e.cursor)).toEqual(["6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("15");

    // Page 2 starts exactly where page 1 stopped.
    const page2Rows = Array.from({ length: 6 }, (_, i) => changeRow(16 + i));
    const { db: db2 } = fakeDb([{ match: "FROM changes c", rows: page2Rows }]);
    const page2 = await new D1DoorRepository(db2).changesSince({ cursor: page1.nextCursor, limit: 10 });
    expect(page2.events.map((e) => e.cursor)).toEqual(["16", "17", "18", "19", "20", "21"]);
    expect(page2.hasMore).toBe(false);

    const combined = [...page1.events, ...page2.events].map((e) => Number(e.cursor));
    expect(combined).toEqual([...new Set(combined)]); // no dups
    expect(combined).toEqual(Array.from({ length: 16 }, (_, i) => 6 + i)); // no gaps
  });

  it("passes a legacy v1 type string through untranslated", async () => {
    const row = { ...changeRow(1), type: "capability.changed" };
    const { db } = fakeDb([{ match: "FROM changes c", rows: [row] }]);
    const repo = new D1DoorRepository(db);

    const page = await repo.changesSince({ limit: 20 });

    expect(page.events[0]!.type).toBe("capability.changed");
  });

  it("filters by course, normalising the code", async () => {
    const { db, calls } = fakeDb([{ match: "FROM changes c", rows: [] }]);
    const repo = new D1DoorRepository(db);

    await repo.changesSince({ limit: 20, course: "fit3175" });

    const call = calls.find((c) => c.sql.includes("i.course = ?"));
    expect(call?.values).toContain("FIT3175");
  });
});

describe("D1DoorRepository.course resolver", () => {
  it("rung 1: a confirmed same-course relation resolves two candidates across terms", async () => {
    const { db } = fakeDb([
      {
        match: "course-identity",
        rows: [
          identityRow({ source: "campus-moodle", item_id: "course:1", code: "FIT3175", term: "2026 S1", status: "closed" }),
          identityRow({ source: "campus-canvas", item_id: "course:2", code: "FIT3175", term: "2026 S2", status: "active" }),
        ],
      },
      { match: "same-course", rows: [{ from_source: "campus-moodle", from_item_id: "course:1", to_source: "campus-canvas", to_item_id: "course:2" }] },
      { match: "i.bucket IS NOT NULL", rows: [] },
      { match: "i.bucket IS NULL", rows: [] },
    ]);
    const repo = new D1DoorRepository(db);

    const view = await repo.course("FIT3175");

    expect(view.ambiguous).toBe(false);
    expect(view.code).toBe("FIT3175");
    expect(view.term).toBeNull(); // two different terms in the resolved group
    expect(view.sources).toEqual(["campus-moodle", "campus-canvas"]);
  });

  it("rung 2: falls back to the one candidate whose course-identity is active", async () => {
    const { db } = fakeDb([
      {
        match: "course-identity",
        rows: [
          identityRow({ source: "campus-moodle", item_id: "course:1", code: "FIT2004", term: "2025 S2", status: "closed" }),
          identityRow({ source: "campus-moodle", item_id: "course:2", code: "FIT2004", term: "2026 S2", status: "active" }),
        ],
      },
      { match: "same-course", rows: [] }, // no confirmed relation
      { match: "i.bucket IS NOT NULL", rows: [] },
      { match: "i.bucket IS NULL", rows: [] },
    ]);
    const repo = new D1DoorRepository(db);

    const view = await repo.course("FIT2004");

    expect(view.ambiguous).toBe(false);
    expect(view.term).toBe("2026 S2");
  });

  it("stays ambiguous, listing every match, when no relation confirms and none (or several) are active", async () => {
    const { db } = fakeDb([
      {
        match: "course-identity",
        rows: [
          identityRow({ source: "campus-moodle", item_id: "course:1", code: "FIT2004", term: "2025 S2", status: "closed" }),
          identityRow({ source: "campus-canvas", item_id: "course:2", code: "FIT2004", term: "2026 S2", status: "closed" }),
        ],
      },
      { match: "same-course", rows: [] },
    ]);
    const repo = new D1DoorRepository(db);

    const view = await repo.course("FIT2004");

    expect(view.ambiguous).toBe(true);
    expect(view.matches).toHaveLength(2);
  });

  it("reports no match at all when the code is unknown", async () => {
    const { db } = fakeDb([{ match: "course-identity", rows: [] }, { match: "same-course", rows: [] }]);
    const repo = new D1DoorRepository(db);

    const view = await repo.course("FIT0000");

    expect(view.code).toBeNull();
    expect(view.ambiguous).toBe(false);
  });
});

describe("D1DoorRepository.searchItems", () => {
  it("quotes every token so quotes, *, AND, - and CJK never reach FTS5 as syntax", async () => {
    const { db, calls } = fakeDb([{ match: "FROM items_fts", rows: [itemRow()] }]);
    const repo = new D1DoorRepository(db);

    await repo.searchItems({ query: 'He said "AND" -x*', limit: 10 });

    const ftsCall = calls.find((c) => c.sql.includes("items_fts MATCH"));
    expect(ftsCall?.values[0]).toBe('"He" "said" """AND""" "-x*"');
  });

  it("falls back to LIKE, which also covers the CJK single/double-character tokenizer gap", async () => {
    const { db } = fakeDb([
      { match: "FROM items_fts", rows: [] }, // FTS finds nothing for a short CJK token
      { match: "i.title LIKE", rows: [itemRow({ title: "第一次作业说明" })] },
    ]);
    const repo = new D1DoorRepository(db);

    const items = await repo.searchItems({ query: "作业", limit: 10 });

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("第一次作业说明");
  });

  it("never lets a raw FTS5 syntax error reach the caller", async () => {
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (..._values: unknown[]) => ({
          all: async () => {
            if (sql.includes("items_fts MATCH")) {
              throw new Error("fts5: syntax error near *");
            }
            return { results: [itemRow()] };
          },
        }),
      })),
    } as unknown as D1Database;
    const repo = new D1DoorRepository(db);

    const items = await repo.searchItems({ query: "***", limit: 10 });

    expect(items).toHaveLength(1);
  });
});

describe("D1DoorRepository.upcoming", () => {
  it("widens the window to 90 days back only when includeOverdue is set", async () => {
    const { db, calls } = fakeDb([{ match: "FROM items i", rows: [] }]);
    const repo = new D1DoorRepository(db);

    await repo.upcoming({ days: 7, includeOverdue: true });
    await repo.upcoming({ days: 7, includeOverdue: false });

    expect(calls[0]!.sql).toContain("-90 days");
    expect(calls[1]!.sql).not.toContain("-90 days");
  });
});

describe("D1DoorRepository.plannedSubjects", () => {
  it("batches the lookup through a single json_each join", async () => {
    const { db, calls } = fakeDb([{ match: "json_each(?) s", rows: [{ subject: "campus-moodle:a1" }] }]);
    const repo = new D1DoorRepository(db);

    const planned = await repo.plannedSubjects("assignment", ["campus-moodle:a1", "campus-moodle:a2"]);

    expect(planned).toEqual(new Set(["campus-moodle:a1"]));
    expect(calls).toHaveLength(1);
  });

  it("returns an empty set without a query when there are no subjects", async () => {
    const { db, calls } = fakeDb([]);
    const repo = new D1DoorRepository(db);

    const planned = await repo.plannedSubjects("assignment", []);

    expect(planned).toEqual(new Set());
    expect(calls).toHaveLength(0);
  });
});

describe("D1DoorRepository.labelItems", () => {
  it("updates known items, and reports unknown items and invalid bucket shapes separately", async () => {
    const { db, batch } = fakeDb([
      { match: "SELECT DISTINCT json_extract", rows: [{ code: "FIT3175" }] }, // listKnownCourseCodes
      {
        match: "JOIN items i ON i.source = r.source",
        rows: [
          { source: "campus-moodle", item_id: "a1" },
          { source: "campus-moodle", item_id: "a2" },
        ],
      },
    ]);
    const repo = new D1DoorRepository(db);

    const result = await repo.labelItems(
      [
        { source: "campus-moodle", itemId: "a1", bucket: "course/FIT3175/general" },
        { source: "campus-moodle", itemId: "a2", bucket: "course/FIT9999/general" }, // unknown course
        { source: "campus-moodle", itemId: "missing", bucket: "life/other" }, // not an existing item
      ],
      "client",
    );

    expect(result.updated).toBe(1);
    expect(result.unknownItems).toEqual(["campus-moodle:missing"]);
    expect(result.invalid).toEqual([{ source: "campus-moodle", itemId: "a2", bucket: "course/FIT9999/general", reason: expect.any(String) }]);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("accepts every one of the five bucket shapes", async () => {
    const { db } = fakeDb([
      { match: "SELECT DISTINCT json_extract", rows: [{ code: "FIT3175" }] },
      { match: "JOIN items i ON i.source = r.source", rows: [{ source: "s", item_id: "i1" }] },
    ]);
    const repo = new D1DoorRepository(db);

    for (const bucket of ["course/FIT3175/assignment-2", "course/FIT3175/general", "life/events", "life/admin", "life/other"]) {
      const result = await repo.labelItems([{ source: "s", itemId: "i1", bucket }], "triage");
      expect(result.invalid).toEqual([]);
      expect(result.updated).toBe(1);
    }
  });
});

describe("D1DoorRepository.sourceStatus", () => {
  it("reads lastCycleAt from the stored cycle's own `at` field", async () => {
    const { db } = fakeDb([
      { match: "GROUP BY source", rows: [{ source: "campus-moodle", n: 10 }] },
      { match: "MAX(seq)", row: { latest: 42 } },
      {
        match: "last_cycle",
        row: { value_json: JSON.stringify({ at: "2026-09-26T21:05:00.000Z", sources: [{ plugin: "campus-moodle", lastSyncAt: "2026-09-26T21:05:00.000Z", lastError: null }] }) },
      },
    ]);
    const repo = new D1DoorRepository(db);

    const status = await repo.sourceStatus();

    expect(status.lastCycleAt).toBe("2026-09-26T21:05:00.000Z");
    expect(status.latestCursor).toBe("42");
    expect(status.sources).toEqual([{ id: "campus-moodle", label: "Moodle", lastSyncAt: "2026-09-26T21:05:00.000Z", lastError: null, items: 10 }]);
  });

  it("reports lastCycleAt null before the first cycle has ever run", async () => {
    const { db } = fakeDb([
      { match: "GROUP BY source", rows: [] },
      { match: "MAX(seq)", row: null },
      { match: "last_cycle", row: null },
    ]);
    const repo = new D1DoorRepository(db);

    const status = await repo.sourceStatus();

    expect(status.lastCycleAt).toBeNull();
    expect(status.latestCursor).toBe("0");
  });
});

function changeRow(seq: number) {
  return {
    seq,
    type: "deadline.changed",
    source: "campus-moodle",
    item_id: `a${seq}`,
    kind: "assessment",
    title: `Item ${seq}`,
    url: null,
    field: "dueAt",
    before_json: null,
    after_json: null,
    topic: null,
    created_at: "2026-09-20T00:00:00.000Z",
    course: null,
    bucket: null,
  };
}

function identityRow(overrides: { source: string; item_id: string; code: string; term: string; status: string }) {
  return { source: overrides.source, item_id: overrides.item_id, title: "Algorithms", url: null, code: overrides.code, term: overrides.term, status: overrides.status };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    source: "campus-moodle",
    item_id: "a1",
    kind: "assessment",
    title: "Assignment",
    url: null,
    timestamp: "2026-09-01T00:00:00.000Z",
    body: null,
    course: null,
    bucket: null,
    topic: null,
    labeled_by: null,
    due_at: null,
    state: null,
    author_role: null,
    pin_status: null,
    thread_type: null,
    ...overrides,
  };
}
