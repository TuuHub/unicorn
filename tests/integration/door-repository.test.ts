// End-to-end coverage of D1DoorRepository through the real door MCP server
// (src/mcp/door.ts), connected via an in-memory MCP client — the same
// pattern tests/mcp-door.test.ts uses with a fake repository, but here the
// repository, item store, briefs and memory are all backed by real SQLite
// (tests/support/sqlite-d1.ts) running the real migrations.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1BriefStore } from "../../src/briefs";
import { D1ItemStore } from "../../src/kernel/d1-item-store";
import { labelStructure } from "../../src/kernel/courses";
import { Kernel } from "../../src/kernel/kernel";
import type { ItemInput } from "../../src/kernel/types";
import { D1MemoryStore } from "../../src/memory";
import { createDoorMcpServer, type DoorDeps } from "../../src/mcp/door";
import { D1DoorRepository } from "../../src/mcp/door-repository";
import { D1SettingsRepository } from "../../src/settings";
import { buildMixedDataset } from "../support/dataset";
import { createTestDb } from "../support/sqlite-d1";

const NOW = new Date("2026-03-15T10:00:00.000Z");

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectClient(deps: DoorDeps): Promise<Client> {
  const server = createDoorMcpServer(deps);
  const client = new Client({ name: "unicorn-door-integration-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

function structuredOf<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  return result.structuredContent as T;
}

async function insertSameCourseRelation(db: D1Database, a: [string, string], b: [string, string]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO relations (id, type, from_source, from_item_id, to_source, to_item_id, metadata_json, confirmed_at)
       VALUES (?, 'same-course', ?, ?, ?, ?, '{}', ?)`,
    )
    .bind(crypto.randomUUID(), a[0], a[1], b[0], b[1], NOW.toISOString())
    .run();
}

describe("door MCP server + D1DoorRepository (real schema)", () => {
  let db: D1Database;
  let client: Client;
  let totalChanges: number;

  beforeEach(async () => {
    db = await createTestDb();
    const store = new D1ItemStore(db);
    const kernel = new Kernel(store, () => NOW);

    // A CJK item, added directly (not via dataset.ts, which is Latin-only):
    // FTS5's unicode61 tokenizer merges a run of CJK characters into one
    // token, so a short CJK query can MATCH nothing even though the
    // substring is right there — exercising door-repository's LIKE fallback.
    const cjkItem: ItemInput = {
      id: "cjk-1",
      source: "campus-moodle",
      kind: "assessment",
      title: "第一次作业",
      timestamp: NOW.toISOString(),
      raw: null,
      facets: [],
    };

    await kernel.ingest([...(await buildMixedDataset()), cjkItem]);
    await labelStructure(db);

    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM changes").first<{ n: number }>();
    totalChanges = countRow!.n;

    const deps: DoorDeps = {
      briefs: new D1BriefStore(db, () => NOW),
      memory: new D1MemoryStore(db, () => NOW),
      repo: new D1DoorRepository(db),
      settings: new D1SettingsRepository(db),
      schedulerStatus: async () => ({ running: true }),
      now: () => NOW,
    };
    client = await connectClient(deps);
  });

  // --- changes_since ---------------------------------------------------------

  describe("changes_since", () => {
    it("pages from cursor 0 through the full history with no gaps or duplicates", async () => {
      let cursor = "0";
      const seen: string[] = [];
      for (let guard = 0; guard < 20; guard += 1) {
        const result = await client.callTool({ name: "changes_since", arguments: { cursor, limit: 5 } });
        const page = structuredOf<{ events: Array<{ cursor: string }>; nextCursor: string; hasMore: boolean }>(result);
        seen.push(...page.events.map((event) => event.cursor));
        cursor = page.nextCursor;
        if (!page.hasMore) {
          break;
        }
      }
      expect(seen).toHaveLength(totalChanges);
      expect(new Set(seen).size).toBe(totalChanges); // no duplicates
      const asNumbers = seen.map(Number);
      expect(asNumbers).toEqual([...asNumbers].sort((a, b) => a - b)); // ascending, no gaps in ordering
    });

    it("with no cursor, always reports hasMore:false regardless of history size", async () => {
      const result = await client.callTool({ name: "changes_since", arguments: {} });
      const page = structuredOf<{ events: unknown[]; hasMore: boolean }>(result);
      expect(page.hasMore).toBe(false);
      expect(page.events.length).toBeLessThanOrEqual(20);
    });

    it("filters by course and by type", async () => {
      const byCourse = await client.callTool({ name: "changes_since", arguments: { cursor: "0", limit: 200, course: "FIT2004" } });
      const coursePage = structuredOf<{ events: Array<{ course: string | null }> }>(byCourse);
      expect(coursePage.events.length).toBeGreaterThan(0);
      expect(coursePage.events.every((event) => event.course === "FIT2004")).toBe(true);

      const byType = await client.callTool({ name: "changes_since", arguments: { cursor: "0", limit: 200, types: ["notice.posted"] } });
      const typePage = structuredOf<{ events: Array<{ type: string }> }>(byType);
      expect(typePage.events.length).toBe(2); // ed thread:11 (tutor) + canvas announcement:30 (teacher)
      expect(typePage.events.every((event) => event.type === "notice.posted")).toBe(true);
    });
  });

  // --- course() ----------------------------------------------------------------

  describe("course", () => {
    it("reports ambiguous:true for two active same-code offerings with no confirmed relation", async () => {
      const result = await client.callTool({ name: "course", arguments: { code: "FIT2004" } });
      const view = structuredOf<{ ambiguous: boolean; matches: unknown[]; code: string | null }>(result);
      expect(view.ambiguous).toBe(true);
      expect(view.code).toBe("FIT2004");
      expect(view.matches).toHaveLength(2);
    });

    it("resolves via a confirmed same-course relation (rung 1), merging term and sources", async () => {
      await insertSameCourseRelation(db, ["campus-moodle", "course:100"], ["campus-ed", "course:200"]);

      const result = await client.callTool({ name: "course", arguments: { code: "fit 2004" } }); // normalization
      const view = structuredOf<{
        ambiguous: boolean;
        code: string;
        term: string | null;
        sources: string[];
        buckets: Array<{ bucket: string }>;
        unlabeled: Array<{ itemId: string }>;
      }>(result);

      expect(view.ambiguous).toBe(false);
      expect(view.code).toBe("FIT2004");
      expect(view.term).toBe("S2 2026");
      expect(view.sources.sort()).toEqual(["campus-ed", "campus-moodle"]);
      expect(view.buckets.map((b) => b.bucket).sort()).toEqual([
        "course/FIT2004/assignment-1",
        "course/FIT2004/assignment-2",
        "course/FIT2004/general",
      ]);
      // email:2's course is null (ambiguous mention) but it mentions FIT2004,
      // so the course-mention fallback surfaces it here as unlabeled-for-this-course.
      expect(view.unlabeled.map((item) => item.itemId)).toContain("email:2");
    });

    it("resolves a single-source course and uppercases/normalizes its term", async () => {
      const result = await client.callTool({ name: "course", arguments: { code: "comp1511" } });
      const view = structuredOf<{ code: string; term: string | null; sources: string[] }>(result);
      expect(view.code).toBe("COMP1511");
      expect(view.term).toBe("SEMESTER 2 2026");
      expect(view.sources).toEqual(["campus-canvas"]);
    });

    it("returns an empty, non-ambiguous view for an unknown code", async () => {
      const result = await client.callTool({ name: "course", arguments: { code: "ZZZ9999" } });
      const view = structuredOf<{ ambiguous: boolean; code: string | null; matches: unknown[] }>(result);
      expect(view).toMatchObject({ ambiguous: false, code: null, matches: [] });
    });
  });

  // --- life() --------------------------------------------------------------------

  it("life() lists the two-mention email as unlabeled and leaves the life buckets empty", async () => {
    const result = await client.callTool({ name: "life", arguments: {} });
    const view = structuredOf<{ buckets: Array<{ bucket: string; items: unknown[] }>; unlabeled: Array<{ itemId: string }> }>(result);
    expect(view.buckets.map((b) => b.bucket)).toEqual(["life/events", "life/admin", "life/other"]);
    expect(view.buckets.every((b) => b.items.length === 0)).toBe(true);
    expect(view.unlabeled.map((item) => item.itemId)).toContain("email:2");
  });

  // --- search_items --------------------------------------------------------------

  describe("search_items", () => {
    it("ranks by FTS5 bm25 and is case-insensitive", async () => {
      const result = await client.callTool({ name: "search_items", arguments: { query: "assignment", limit: 20 } });
      const { items } = structuredOf<{ items: Array<{ itemId: string }> }>(result);
      expect(items.map((item) => item.itemId)).toEqual(
        expect.arrayContaining(["assessment:1", "assessment:2", "thread:10", "thread:12"]),
      );
    });

    it.each([['"'], ["*"], ["AND"], ["-x"], ["NEAR("]])("never throws on a hostile FTS5 query: %s", async (query) => {
      const result = await client.callTool({ name: "search_items", arguments: { query, limit: 20 } });
      expect(result.isError).toBeFalsy();
      const { items } = structuredOf<{ items: unknown[] }>(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("falls back to a LIKE scan for a CJK query FTS5's tokenizer can't substring-match", async () => {
      const result = await client.callTool({ name: "search_items", arguments: { query: "作业", limit: 20 } });
      const { items } = structuredOf<{ items: Array<{ itemId: string }> }>(result);
      expect(items.map((item) => item.itemId)).toContain("cjk-1");
    });
  });

  // --- upcoming ------------------------------------------------------------------

  it("upcoming() lists items due within the window, ordered by due date, honoring includeOverdue", async () => {
    const store = new D1ItemStore(db);
    const kernel = new Kernel(store, () => new Date());
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const overdue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const dueItem = (id: string, dueAt: string): ItemInput => ({
      id,
      source: "campus-moodle",
      kind: "assessment",
      title: `Upcoming ${id}`,
      timestamp: dueAt,
      raw: null,
      facets: [{ type: "deadline", data: { dueAt }, capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }] }],
    });
    await kernel.ingest([dueItem("soon", soon), dueItem("later", later), dueItem("overdue", overdue)]);

    const within14 = await client.callTool({ name: "upcoming", arguments: { days: 14 } });
    const { items: within14Items } = structuredOf<{ items: Array<{ itemId: string }> }>(within14);
    expect(within14Items.map((item) => item.itemId)).toEqual(["soon", "later"]); // ordered by due date, no overdue

    const withOverdue = await client.callTool({ name: "upcoming", arguments: { days: 14, includeOverdue: true } });
    const { items: withOverdueItems } = structuredOf<{ items: Array<{ itemId: string }> }>(withOverdue);
    expect(withOverdueItems.map((item) => item.itemId)).toEqual(["overdue", "soon", "later"]);
  });

  // --- label_items -----------------------------------------------------------------

  describe("label_items", () => {
    it("labels a life bucket, rejects an unknown course code, and reports an unknown item", async () => {
      const result = await client.callTool({
        name: "label_items",
        arguments: {
          items: [
            { source: "gmail", itemId: "email:2", bucket: "life/other" },
            { source: "gmail", itemId: "email:2", bucket: "course/ZZZ9999/general" },
            { source: "gmail", itemId: "does-not-exist", bucket: "life/other" },
          ],
          by: "client",
        },
      });
      const view = structuredOf<{ updated: number; unknownItems: string[]; invalid: Array<{ bucket: string }> }>(result);
      // Same item appears twice: once valid (life/other), once with an unknown
      // course code — both are evaluated independently by labelItems.
      expect(view.updated).toBe(1);
      expect(view.invalid).toEqual([expect.objectContaining({ bucket: "course/ZZZ9999/general" })]);
      expect(view.unknownItems).toEqual(["gmail:does-not-exist"]);

      const row = await db.prepare("SELECT course, bucket, labeled_by FROM items WHERE source = 'gmail' AND item_id = 'email:2'").first();
      expect(row).toEqual({ course: null, bucket: "life/other", labeled_by: "client" });
    });

    it("accepts a course/<CODE>/general bucket for a known code and persists the topic", async () => {
      const result = await client.callTool({
        name: "label_items",
        arguments: { items: [{ source: "gmail", itemId: "email:2", bucket: "course/FIT2004/general", topic: "extension" }], by: "triage" },
      });
      const view = structuredOf<{ updated: number }>(result);
      expect(view.updated).toBe(1);
      const row = await db.prepare("SELECT course, bucket, topic, labeled_by FROM items WHERE source = 'gmail' AND item_id = 'email:2'").first();
      expect(row).toEqual({ course: "FIT2004", bucket: "course/FIT2004/general", topic: "extension", labeled_by: "triage" });
    });
  });

  // --- write_brief -----------------------------------------------------------------

  it("write_brief is idempotent on (kind, idempotencyKey)", async () => {
    const args = { kind: "forum-brief", subject: "FIT2004", title: "Weekly forum summary", body: "Nothing new.", idempotencyKey: "2026-W11" };
    const first = await client.callTool({ name: "write_brief", arguments: args });
    const second = await client.callTool({ name: "write_brief", arguments: { ...args, body: "A different body — must be ignored." } });

    const firstBrief = structuredOf<{ id: string; body: string }>(first);
    const secondBrief = structuredOf<{ id: string; body: string }>(second);
    expect(secondBrief.id).toBe(firstBrief.id);
    expect(secondBrief.body).toBe(firstBrief.body); // the retry's body was NOT applied

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE id = ?").bind(firstBrief.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  // --- get_plan / save_plan ---------------------------------------------------------

  it("save_plan then get_plan round-trips the saved content", async () => {
    await client.callTool({ name: "save_plan", arguments: { kind: "weekly", subject: "2026-W11", content: "- [ ] Read week 11 notes" } });
    const result = await client.callTool({ name: "get_plan", arguments: { kind: "weekly", subject: "2026-W11" } });
    const { plan } = structuredOf<{ plan: { content: string } | null }>(result);
    expect(plan?.content).toBe("- [ ] Read week 11 notes");
  });

  // --- status ------------------------------------------------------------------------

  it("status reports per-source item counts, the scheduler, latest cursor, and timezone", async () => {
    const result = await client.callTool({ name: "status", arguments: {} });
    const view = structuredOf<{
      sources: Array<{ id: string; items: number }>;
      scheduler: { running: boolean };
      latestCursor: string;
      timezone: string;
    }>(result);
    const bySource = new Map(view.sources.map((s) => [s.id, s.items]));
    expect(bySource.get("campus-moodle")).toBe(4); // course + 2 assessments + cjk-1
    expect(bySource.get("campus-ed")).toBe(4);
    expect(bySource.get("campus-canvas")).toBe(3);
    expect(bySource.get("gmail")).toBe(2);
    expect(view.scheduler.running).toBe(true);
    expect(view.latestCursor).toBe(String(totalChanges));
    expect(view.timezone).toBe("Australia/Melbourne"); // no settings row written -> default
  });

  // --- run_playbook --------------------------------------------------------------------

  it("run_playbook('triage') prefetches the unlabeled items and known course codes", async () => {
    const result = await client.callTool({ name: "run_playbook", arguments: { name: "triage" } });
    const { data } = structuredOf<{ data: { items: Array<{ itemId: string }>; courses: string[] } }>(result);
    expect(data.courses).toEqual(["COMP1511", "FIT2004"]);
    expect(data.items.map((item) => item.itemId)).toContain("email:2");
  });

  it("run_playbook('weekly-plan') computes the ISO week from the injected clock", async () => {
    const result = await client.callTool({ name: "run_playbook", arguments: { name: "weekly-plan" } });
    const { data } = structuredOf<{ data: { isoWeek: string } }>(result);
    expect(data.isoWeek).toBe("2026-W11"); // NOW = 2026-03-15 (a Sunday, ISO week 11)
  });
});
