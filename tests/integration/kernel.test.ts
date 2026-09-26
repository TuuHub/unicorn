import { beforeEach, describe, expect, it } from "vitest";
import { D1ItemStore } from "../../src/kernel/d1-item-store";
import { Kernel } from "../../src/kernel/kernel";
import type { ItemInput } from "../../src/kernel/types";
import { D1RetentionRepository, runRetention } from "../../src/retention";
import { createTestDb } from "../support/sqlite-d1";

interface ChangeRow {
  seq: number;
  type: string;
  source: string;
  item_id: string;
  field: string | null;
  before_json: string | null;
  after_json: string | null;
}

async function readChanges(db: D1Database): Promise<ChangeRow[]> {
  const rows = await db.prepare("SELECT seq, type, source, item_id, field, before_json, after_json FROM changes ORDER BY seq").all<ChangeRow>();
  return rows.results;
}

function assignment(overrides: Partial<ItemInput> = {}): ItemInput {
  return {
    id: "assessment-1",
    source: "campus-moodle",
    kind: "assessment",
    title: "Assignment 1",
    timestamp: "2026-03-01T00:00:00.000Z",
    raw: { id: 1 },
    facets: [
      {
        type: "deadline",
        data: { dueAt: "2026-03-10T00:00:00.000Z" },
        capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
      },
      {
        type: "submission",
        data: { status: "unsubmitted" },
        capabilities: [{ name: "has-submission-status", primitive: "state", field: "status" }],
      },
      {
        type: "grade",
        data: { grade: 0 },
        capabilities: [{ name: "has-grade", primitive: "scalar", field: "grade" }],
      },
      {
        type: "course-membership",
        data: { course: "course:1" },
        capabilities: [{ name: "belongs-to-course", primitive: "relation", field: "course" }],
      },
    ],
    ...overrides,
  };
}

describe("Kernel + D1ItemStore (real schema)", () => {
  let db: D1Database;
  let store: D1ItemStore;

  beforeEach(async () => {
    db = await createTestDb();
    store = new D1ItemStore(db);
  });

  it("persists item.added for a fresh, non-staff item", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    const result = await kernel.ingest([assignment()]);

    expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const changes = await readChanges(db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "item.added", source: "campus-moodle", item_id: "assessment-1" });

    const stored = await store.find("campus-moodle", "assessment-1");
    expect(stored?.title).toBe("Assignment 1");
  });

  it("persists notice.posted instead of item.added when the author is teaching staff", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    const notice: ItemInput = {
      id: "thread-1",
      source: "campus-ed",
      kind: "thread",
      title: "Assignment 2 extension",
      timestamp: "2026-03-01T00:00:00.000Z",
      raw: null,
      facets: [
        {
          type: "author",
          data: { actor: "ed-user:9", authorRole: "tutor" },
          capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
        },
      ],
    };
    await kernel.ingest([notice]);

    const changes = await readChanges(db);
    expect(changes).toEqual([expect.objectContaining({ type: "notice.posted", item_id: "thread-1" })]);
  });

  it("does not write a new changes row (or bump updated_at) for an unchanged re-ingest", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);
    const before = await store.find("campus-moodle", "assessment-1");

    const later = new Kernel(store, () => new Date("2026-03-05T00:00:00.000Z"));
    const result = await later.ingest([structuredClone(assignment())]);

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, events: [] });
    const changes = await readChanges(db);
    expect(changes).toHaveLength(1); // still just the original item.added
    const after = await store.find("campus-moodle", "assessment-1");
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("persists deadline.changed when a temporal capability moves", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);

    const moved = structuredClone(assignment());
    moved.facets[0]!.data.dueAt = "2026-03-15T00:00:00.000Z";
    const later = new Kernel(store, () => new Date("2026-03-02T00:00:00.000Z"));
    const result = await later.ingest([moved]);

    expect(result).toMatchObject({ updated: 1 });
    const changes = await readChanges(db);
    expect(changes[1]).toMatchObject({
      type: "deadline.changed",
      field: "has-deadline",
      before_json: '"2026-03-10T00:00:00.000Z"',
      after_json: '"2026-03-15T00:00:00.000Z"',
    });
  });

  it("persists state.changed for a non-grade state capability", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);

    const submitted = structuredClone(assignment());
    submitted.facets[1]!.data.status = "submitted";
    await kernel.ingest([submitted]);

    const changes = await readChanges(db);
    expect(changes[1]).toMatchObject({ type: "state.changed", field: "has-submission-status", before_json: '"unsubmitted"', after_json: '"submitted"' });
  });

  it("persists grade.changed for a grade-shaped capability regardless of its (scalar) primitive", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);

    const graded = structuredClone(assignment());
    graded.facets[2]!.data.grade = 87;
    await kernel.ingest([graded]);

    const changes = await readChanges(db);
    expect(changes[1]).toMatchObject({ type: "grade.changed", field: "has-grade", before_json: "0", after_json: "87" });
  });

  it("updates the item but writes no changes row for a relation-only change", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);

    const movedCourse = structuredClone(assignment());
    movedCourse.facets[3]!.data.course = "course:2";
    const result = await kernel.ingest([movedCourse]);

    expect(result).toMatchObject({ updated: 1 });
    const changes = await readChanges(db);
    expect(changes).toHaveLength(1); // no new row

    const stored = await store.find("campus-moodle", "assessment-1");
    expect(stored?.facets.find((f) => f.type === "course-membership")?.data.course).toBe("course:2");
  });

  it("persists one content.changed event with full before/after on a title/body edit", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment({ body: "Original body." })]);

    const edited = structuredClone(assignment({ body: "Original body." }));
    edited.title = "Assignment 1 (updated)";
    edited.body = "Edited body.";
    await kernel.ingest([edited]);

    const changes = await readChanges(db);
    expect(changes[1]).toMatchObject({ type: "content.changed", field: null });
    expect(JSON.parse(changes[1]!.before_json!)).toEqual({ title: "Assignment 1", body: "Original body." });
    expect(JSON.parse(changes[1]!.after_json!)).toEqual({ title: "Assignment 1 (updated)", body: "Edited body." });
  });

  it("archives via retention then restores on re-ingest, recording item.restored", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);

    const retention = new D1RetentionRepository(db);
    const archivedCount = await runRetention(retention, 0, new Date("2026-04-01T00:00:00.000Z"));
    expect(archivedCount).toBe(1);
    const archived = await store.find("campus-moodle", "assessment-1");
    expect(archived?.archivedAt).toBeTruthy();

    const restoring = new Kernel(store, () => new Date("2026-04-02T00:00:00.000Z"));
    const result = await restoring.ingest([structuredClone(assignment())]);

    expect(result).toMatchObject({ unchanged: 1 });
    const restored = await store.find("campus-moodle", "assessment-1");
    expect(restored?.archivedAt).toBeUndefined();

    const changes = await readChanges(db);
    expect(changes.map((c) => c.type)).toEqual(["item.added", "item.archived", "item.restored"]);
  });

  it("prepends item.restored ahead of diff events when a changed item was archived", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment()]);
    const retention = new D1RetentionRepository(db);
    await runRetention(retention, 0, new Date("2026-04-01T00:00:00.000Z"));

    const moved = structuredClone(assignment());
    moved.facets[0]!.data.dueAt = "2026-04-20T00:00:00.000Z";
    const restoring = new Kernel(store, () => new Date("2026-04-02T00:00:00.000Z"));
    const result = await restoring.ingest([moved]);

    expect(result).toMatchObject({ updated: 1 });
    const changes = await readChanges(db);
    expect(changes.map((c) => c.type)).toEqual(["item.added", "item.archived", "item.restored", "deadline.changed"]);
  });

  it("keeps changes.seq strictly increasing across ingests — the door's paging cursor", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment(), assignment({ id: "assessment-2", title: "Assignment 2" })]);
    const moved = structuredClone(assignment());
    moved.facets[0]!.data.dueAt = "2026-03-20T00:00:00.000Z";
    await kernel.ingest([moved]);

    const changes = await readChanges(db);
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("D1ItemStore.findMany loads several items in one pair of queries against the real schema", async () => {
    const kernel = new Kernel(store, () => new Date("2026-03-01T00:00:00.000Z"));
    await kernel.ingest([assignment(), assignment({ id: "assessment-2", title: "Assignment 2" })]);

    const items = await store.findMany([
      { source: "campus-moodle", itemId: "assessment-1" },
      { source: "campus-moodle", itemId: "assessment-2" },
    ]);

    expect(items.map((item) => item.id)).toEqual(["assessment-1", "assessment-2"]);
    expect(items[0]?.facets.map((f) => f.type).sort()).toEqual(["course-membership", "deadline", "grade", "submission"]);
  });
});
