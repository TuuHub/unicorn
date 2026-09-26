import { describe, expect, it, vi } from "vitest";
import { D1McpRepository } from "../src/mcp/d1-repository";

// Precise SQL-substring-matching D1 fake: several methods under test issue
// more than one distinct query, so routing on a substring of the SQL text
// (as in tests/d1-item-store.test.ts) is required to return the right rows
// to each call rather than one blanket fixture. Match fragments are chosen
// to be single-line and unique to one query, so they don't depend on the
// exact indentation of the template literals in d1-repository.ts.
function fakeDb(routes: Array<{ match: string; rows?: unknown[]; row?: unknown }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const run = vi.fn(async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return { meta: { changes: 1 } };
  });
  // Mirrors D1's real statement shape: all()/first()/run() are callable both
  // directly off prepare() (no parameters) and after bind(...values).
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
      run: () => run(sql, values),
    };
  }
  const prepare = vi.fn((sql: string) => statement(sql, []));
  const db = { prepare } as unknown as D1Database;
  return { db, calls, run };
}

describe("D1McpRepository.listCourses", () => {
  it("projects course-identity rows into CourseSummary", async () => {
    const { db } = fakeDb([
      {
        match: "LIMIT 100",
        rows: [
          {
            source: "campus-moodle",
            item_id: "course:1",
            title: "FIT2004",
            code: "FIT2004 S2 2026",
            platform: "moodle",
            status: "active",
          },
        ],
      },
    ]);
    const repo = new D1McpRepository(db);

    const courses = await repo.listCourses();

    expect(courses).toEqual([
      {
        source: "campus-moodle",
        itemId: "course:1",
        code: "FIT2004 S2 2026",
        name: "FIT2004",
        platform: "moodle",
        status: "active",
      },
    ]);
  });

  it("defaults missing code, platform, and status", async () => {
    const { db } = fakeDb([
      {
        match: "LIMIT 100",
        rows: [{ source: "campus-ed", item_id: "course:2", title: "FIT2099", code: null, platform: null, status: null }],
      },
    ]);
    const repo = new D1McpRepository(db);

    const courses = await repo.listCourses();

    expect(courses[0]).toEqual({
      source: "campus-ed",
      itemId: "course:2",
      code: "",
      name: "FIT2099",
      platform: "campus-ed",
      status: "unknown",
    });
  });
});

describe("D1McpRepository.getCourseOverview", () => {
  it("reports every source as absent when no course-identity matches", async () => {
    const { db } = fakeDb([
      { match: "upper(json_extract(f.data_json, '$.code')) LIKE ? || '%'", rows: [] }, // resolveCourseMatches
      { match: "SELECT 1 FROM items WHERE source LIKE", rows: [] }, // sourceExists
    ]);
    const repo = new D1McpRepository(db);

    const overview = await repo.getCourseOverview("FIT2004");

    expect(overview).toEqual({
      query: "FIT2004",
      identity: null,
      assessments: [],
      staffPosts: [],
      emailMentions: [],
      sources: { moodle: false, ed: false, ontrack: false, email: false },
    });
  });

  it("aggregates assessments and staff posts across matched platforms", async () => {
    const { db } = fakeDb([
      {
        match: "upper(json_extract(f.data_json, '$.code')) LIKE ? || '%'", // resolveCourseMatches
        rows: [
          { source: "campus-moodle", item_id: "course:1", title: "FIT2004", code: "FIT2004", platform: "moodle", status: "active" },
          { source: "campus-ed", item_id: "course:9", title: "FIT2004", code: "FIT2004", platform: "ed", status: "active" },
        ],
      },
      {
        match: "i.kind = 'assessment'", // courseAssessments
        rows: [
          { source: "campus-moodle", item_id: "assessment:1", title: "Assignment 1", url: null, due_at: "2026-09-20T00:00:00.000Z", status: "not submitted" },
        ],
      },
      {
        match: "i.kind = 'thread'", // staffPostsBySource
        rows: [
          {
            source: "campus-ed",
            item_id: "thread:5",
            title: "Assignment 1 clarification",
            url: null,
            timestamp: "2026-09-15T00:00:00.000Z",
            author_role: "tutor",
            pin_status: null,
            thread_type: "discussion",
          },
        ],
      },
      { match: "json_each(f.data_json, '$.codes')", rows: [] }, // courseEmailMentions
      { match: "SELECT 1 FROM items WHERE source LIKE", rows: [] }, // sourceExists(ontrack)
    ]);
    const repo = new D1McpRepository(db);

    const overview = await repo.getCourseOverview("fit2004");

    expect(overview.identity).toEqual({ code: "FIT2004", name: "FIT2004", platforms: ["campus-moodle", "campus-ed"] });
    expect(overview.assessments).toEqual([
      expect.objectContaining({ itemId: "assessment:1", dueAt: "2026-09-20T00:00:00.000Z", status: "not submitted" }),
    ]);
    expect(overview.staffPosts).toEqual([expect.objectContaining({ itemId: "thread:5" })]);
    expect(overview.sources).toEqual({ moodle: true, ed: true, ontrack: false, email: false });
  });
});

describe("D1McpRepository.searchItems", () => {
  it("resolves keys with one query then hydrates them via findMany's two-phase fetch", async () => {
    const { db, calls } = fakeDb([
      { match: "FROM items WHERE", rows: [{ source: "campus-moodle", item_id: "assessment:1" }] },
      {
        match: "SELECT i.*",
        rows: [
          {
            source: "campus-moodle",
            item_id: "assessment:1",
            kind: "assessment",
            title: "Assignment 1",
            timestamp: "2026-09-01T00:00:00.000Z",
            url: null,
            body: null,
            raw_json: "{}",
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
            archived_at: null,
          },
        ],
      },
    ]);
    const repo = new D1McpRepository(db);

    const items = await repo.searchItems({ query: "assignment", limit: 10 });

    expect(items).toEqual([expect.objectContaining({ id: "assessment:1", title: "Assignment 1" })]);
    const keySearch = calls.find((call) => call.sql.includes("FROM items WHERE"));
    expect(keySearch?.values).toEqual(["%assignment%", "%assignment%", 10]);
  });

  it("adds a course filter with matching bind values in placeholder order", async () => {
    const { db, calls } = fakeDb([
      {
        match: "upper(json_extract(f.data_json, '$.code')) LIKE ? || '%'", // resolveCourseMatches
        rows: [{ source: "campus-moodle", item_id: "course:1", title: "FIT2004", code: "FIT2004", platform: "moodle", status: "active" }],
      },
      { match: "FROM items WHERE", rows: [] },
    ]);
    const repo = new D1McpRepository(db);

    await repo.searchItems({ query: "quiz", course: "fit2004", limit: 5 });

    const keySearch = calls.find((call) => call.sql.includes("FROM items WHERE"));
    expect(keySearch?.sql).toContain("course-membership");
    expect(keySearch?.sql).toContain("course-mention");
    // like, like, [membership: source, itemId] per match, then mention code, then limit
    expect(keySearch?.values).toEqual(["%quiz%", "%quiz%", "campus-moodle", "course:1", "FIT2004", 5]);
  });
});

describe("D1McpRepository.listStaffPosts", () => {
  it("filters to campus-ed matches only when a course is given", async () => {
    const { db, calls } = fakeDb([
      {
        match: "upper(json_extract(f.data_json, '$.code')) LIKE ? || '%'", // resolveCourseMatches
        rows: [
          { source: "campus-moodle", item_id: "course:1", title: "FIT2004", code: "FIT2004", platform: "moodle", status: "active" },
          { source: "campus-ed", item_id: "course:9", title: "FIT2004", code: "FIT2004", platform: "ed", status: "active" },
        ],
      },
      {
        match: "i.kind = 'thread'", // staffPostsBySource
        rows: [
          {
            source: "campus-ed",
            item_id: "thread:1",
            title: "Pinned announcement",
            url: "https://ed.example/thread/1",
            timestamp: "2026-09-14T00:00:00.000Z",
            author_role: null,
            pin_status: "pinned",
            thread_type: "discussion",
          },
        ],
      },
    ]);
    const repo = new D1McpRepository(db);

    const posts = await repo.listStaffPosts({ course: "FIT2004", limit: 20 });

    expect(posts).toEqual([
      { source: "campus-ed", itemId: "thread:1", title: "Pinned announcement", url: "https://ed.example/thread/1", timestamp: "2026-09-14T00:00:00.000Z" },
    ]);
    const postsQuery = calls.find((call) => call.sql.includes("i.kind = 'thread'"));
    expect(postsQuery?.sql).toContain("JOIN facets m ON");
    expect(postsQuery?.values.at(-2)).toBe("course:9");
  });

  it("queries globally (no membership join) when no course is given", async () => {
    const { db, calls } = fakeDb([{ match: "i.kind = 'thread'", rows: [] }]);
    const repo = new D1McpRepository(db);

    await repo.listStaffPosts({ limit: 10 });

    const postsQuery = calls.find((call) => call.sql.includes("i.kind = 'thread'"));
    expect(postsQuery?.sql).not.toContain("JOIN facets m ON");
  });
});

describe("D1McpRepository plans", () => {
  it("returns null for a plan that has not been saved", async () => {
    const { db } = fakeDb([{ match: "FROM plans", row: null }]);
    const repo = new D1McpRepository(db);

    await expect(repo.getPlan("weekly", "2026-W38")).resolves.toBeNull();
  });

  it("parses a stored plan row", async () => {
    const row = {
      id: "plan-1",
      kind: "weekly",
      subject: "2026-W38",
      content: "Focus on FIT2004 assignment 2.",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    const { db } = fakeDb([{ match: "FROM plans", row }]);
    const repo = new D1McpRepository(db);

    await expect(repo.getPlan("weekly", "2026-W38")).resolves.toEqual({
      id: "plan-1",
      kind: "weekly",
      subject: "2026-W38",
      content: "Focus on FIT2004 assignment 2.",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    });
  });

  it("upserts on save and re-reads the persisted row", async () => {
    const savedRow = {
      id: "plan-2",
      kind: "assignment",
      subject: "campus-moodle:assessment:1",
      content: "Step 1: read the brief.",
      created_at: "2026-09-16T00:00:00.000Z",
      updated_at: "2026-09-16T00:00:00.000Z",
    };
    const { db, calls } = fakeDb([{ match: "FROM plans", row: savedRow }]);
    const repo = new D1McpRepository(db);

    const plan = await repo.savePlan("assignment", "campus-moodle:assessment:1", "Step 1: read the brief.");

    expect(plan).toEqual({
      id: "plan-2",
      kind: "assignment",
      subject: "campus-moodle:assessment:1",
      content: "Step 1: read the brief.",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    const upsert = calls.find((call) => call.sql.includes("ON CONFLICT (kind, subject)"));
    expect(upsert?.values).toEqual(
      expect.arrayContaining(["assignment", "campus-moodle:assessment:1", "Step 1: read the brief."]),
    );
  });
});

describe("D1McpRepository.listEvents", () => {
  const changeRow = {
    seq: 42,
    type: "grade.changed",
    source: "campus-moodle",
    item_id: "assessment:1",
    kind: "assessment",
    title: "Assignment 1",
    url: null,
    field: "grade",
    before_json: "70",
    after_json: "82.5",
    topic: null,
    created_at: "2026-09-20T00:00:00.000Z",
  };

  it("parses newest-first changes rows into ItemEvent", async () => {
    const { db, calls } = fakeDb([{ match: "ORDER BY seq DESC", rows: [changeRow] }]);
    const repo = new D1McpRepository(db);

    const events = await repo.listEvents({ limit: 10 });

    expect(events).toEqual([
      {
        type: "grade.changed",
        source: "campus-moodle",
        itemId: "assessment:1",
        kind: "assessment",
        title: "Assignment 1",
        url: null,
        topic: null,
        field: "grade",
        before: 70,
        after: 82.5,
        createdAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
    const call = calls.find((entry) => entry.sql.includes("ORDER BY seq DESC"));
    expect(call?.sql).not.toContain("WHERE");
    expect(call?.values).toEqual([10]);
  });

  it("filters by created_at when since is given", async () => {
    const { db, calls } = fakeDb([{ match: "ORDER BY seq DESC", rows: [changeRow] }]);
    const repo = new D1McpRepository(db);

    await repo.listEvents({ since: "2026-09-19T00:00:00.000Z", limit: 5 });

    const call = calls.find((entry) => entry.sql.includes("ORDER BY seq DESC"));
    expect(call?.sql).toContain("WHERE created_at >= ?");
    expect(call?.values).toEqual(["2026-09-19T00:00:00.000Z", 5]);
  });
});

describe("D1McpRepository.listEventsAscending", () => {
  it("reads the changes table oldest-first by seq for cursor-based paging", async () => {
    const { db, calls } = fakeDb([
      {
        match: "ORDER BY seq ASC",
        rows: [
          {
            seq: 1,
            type: "item.added",
            source: "campus-ed",
            item_id: "thread:1",
            kind: "thread",
            title: "Welcome",
            url: null,
            field: null,
            before_json: null,
            after_json: null,
            topic: null,
            created_at: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    ]);
    const repo = new D1McpRepository(db);

    const events = await repo.listEventsAscending("2026-08-31T00:00:00.000Z", 100);

    expect(events).toEqual([
      expect.objectContaining({ type: "item.added", itemId: "thread:1", before: null, after: null }),
    ]);
    const call = calls.find((entry) => entry.sql.includes("ORDER BY seq ASC"));
    expect(call?.values).toEqual(["2026-08-31T00:00:00.000Z", 100]);
  });
});

describe("D1McpRepository.remember", () => {
  it("delegates to recordCorrection against the underlying memory store", async () => {
    const { db, run } = fakeDb([{ match: "FROM agent_notes", row: null }]);
    const repo = new D1McpRepository(db);

    const result = await repo.remember("Quiz marks don't count towards the final grade.");

    expect(result).toBe("saved");
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports duplicate when the same correction was already recorded", async () => {
    const existing = {
      domain: "corrections",
      content: "- [2026-09-01] Quiz marks don't count towards the final grade.",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    const { db } = fakeDb([{ match: "FROM agent_notes", row: existing }]);
    const repo = new D1McpRepository(db);

    await expect(repo.remember("Quiz marks don't count towards the final grade.")).resolves.toBe("duplicate");
  });

  it("reports empty for blank input without touching the store", async () => {
    const { db, run } = fakeDb([{ match: "FROM agent_notes", row: null }]);
    const repo = new D1McpRepository(db);

    await expect(repo.remember("   ")).resolves.toBe("empty");
    expect(run).not.toHaveBeenCalled();
  });
});
