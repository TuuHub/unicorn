import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel/kernel";
import { MemoryItemStore } from "../src/kernel/memory-item-store";
import type { ItemInput } from "../src/kernel/types";

const deadline: ItemInput = {
  id: "assessment-42",
  source: "campus-moodle",
  kind: "assessment",
  title: "Architecture report",
  timestamp: "2026-07-20T06:00:00.000Z",
  url: "https://learning.example.edu/calendar/view.php?view=day",
  raw: { id: 42 },
  facets: [
    {
      type: "deadline",
      data: { dueAt: "2026-07-20T06:00:00.000Z" },
      capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }],
    },
  ],
};

describe("Kernel.ingest", () => {
  it("creates a new item and records an item.added event", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store, () => new Date("2026-07-13T00:00:00.000Z"));

    const result = await kernel.ingest([deadline]);

    expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "item.added",
        source: "campus-moodle",
        itemId: "assessment-42",
        kind: "assessment",
        title: "Architecture report",
        createdAt: "2026-07-13T00:00:00.000Z",
      }),
    ]);
    await expect(store.listEvents()).resolves.toEqual(result.events);
  });

  it("records notice.posted instead of item.added when the author is teaching staff", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store, () => new Date("2026-07-13T00:00:00.000Z"));
    const staffPost: ItemInput = {
      id: "thread-1",
      source: "campus-ed",
      kind: "thread",
      title: "Assignment 2 extension",
      timestamp: "2026-07-13T00:00:00.000Z",
      raw: null,
      facets: [
        {
          type: "author",
          data: { actor: "ed-user:9", authorRole: "Tutor" },
          capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }],
        },
      ],
    };

    const result = await kernel.ingest([staffPost]);

    expect(result.events).toEqual([expect.objectContaining({ type: "notice.posted", topic: null })]);
  });

  it("records a deadline.changed event when a temporal capability moves", async () => {
    const store = new MemoryItemStore();
    const times = [new Date("2026-07-13T00:00:00.000Z"), new Date("2026-07-14T00:00:00.000Z")];
    const kernel = new Kernel(store, () => times.shift() ?? new Date("2026-07-14T00:00:00.000Z"));
    await kernel.ingest([deadline]);

    const moved = structuredClone(deadline);
    moved.timestamp = "2026-07-22T06:00:00.000Z";
    moved.facets[0]!.data.dueAt = "2026-07-22T06:00:00.000Z";
    const result = await kernel.ingest([moved]);

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "deadline.changed",
        field: "has-deadline",
        before: "2026-07-20T06:00:00.000Z",
        after: "2026-07-22T06:00:00.000Z",
        createdAt: "2026-07-14T00:00:00.000Z",
      }),
    ]);
  });

  it("records a grade.changed event for a grade-shaped capability regardless of primitive", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const graded: ItemInput = {
      id: "assessment-99",
      source: "campus-moodle",
      kind: "assessment",
      title: "Quiz 3",
      timestamp: "2026-07-20T06:00:00.000Z",
      raw: null,
      facets: [
        {
          type: "grade",
          data: { score: 0 },
          capabilities: [{ name: "has-grade-score", primitive: "scalar", field: "score" }],
        },
      ],
    };
    await kernel.ingest([graded]);
    const released = structuredClone(graded);
    released.facets[0]!.data.score = 87;

    const result = await kernel.ingest([released]);

    expect(result.events).toEqual([
      expect.objectContaining({ type: "grade.changed", field: "has-grade-score", before: 0, after: 87 }),
    ]);
  });

  it("records a state.changed event for a non-grade state capability", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const thread: ItemInput = {
      id: "thread-2",
      source: "campus-ed",
      kind: "thread",
      title: "Consultation hours",
      timestamp: "2026-07-20T06:00:00.000Z",
      raw: null,
      facets: [
        {
          type: "discussion-state",
          data: { answerStatus: "unanswered" },
          capabilities: [{ name: "has-answer-status", primitive: "state", field: "answerStatus" }],
        },
      ],
    };
    await kernel.ingest([thread]);
    const answered = structuredClone(thread);
    answered.facets[0]!.data.answerStatus = "answered";

    const result = await kernel.ingest([answered]);

    expect(result.events).toEqual([
      expect.objectContaining({ type: "state.changed", field: "has-answer-status", before: "unanswered", after: "answered" }),
    ]);
  });

  it("does not emit an event for a relation, actor, or non-grade scalar capability change", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const engaged: ItemInput = {
      id: "thread-3",
      source: "campus-ed",
      kind: "thread",
      title: "Lecture recording missing",
      timestamp: "2026-07-20T06:00:00.000Z",
      raw: null,
      facets: [
        {
          type: "engagement",
          data: { views: 10 },
          capabilities: [{ name: "has-view-count", primitive: "scalar", field: "views" }],
        },
      ],
    };
    await kernel.ingest([engaged]);
    const viewed = structuredClone(engaged);
    viewed.facets[0]!.data.views = 42;

    const result = await kernel.ingest([viewed]);

    expect(result).toMatchObject({ updated: 1 });
    expect(result.events).toEqual([]);
  });

  it("records one content.changed event with full (never clipped) before/after when title or body edits", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const post: ItemInput = {
      id: "thread-4",
      source: "campus-ed",
      kind: "thread",
      title: "Original title",
      body: "Original body.",
      timestamp: "2026-07-20T06:00:00.000Z",
      raw: null,
      facets: [],
    };
    await kernel.ingest([post]);
    const edited = structuredClone(post);
    edited.title = "Edited title";
    edited.body = "Edited body.";

    const result = await kernel.ingest([edited]);

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "content.changed",
        before: { title: "Original title", body: "Original body." },
        after: { title: "Edited title", body: "Edited body." },
      }),
    ]);
  });

  it("rejects a capability whose value does not match its primitive", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const invalid = structuredClone(deadline);
    invalid.facets[0]!.data.dueAt = "tomorrow sometime";

    await expect(kernel.ingest([invalid])).rejects.toMatchObject({ code: "invalid_capability_value" });
    await expect(store.listEvents()).resolves.toEqual([]);
  });

  it("does not create duplicate events for an unchanged item", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);

    const result = await kernel.ingest([structuredClone(deadline)]);

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, events: [] });
    await expect(store.listEvents()).resolves.toHaveLength(1);
  });

  it("restores an archived item and records item.restored when it is pulled again unchanged", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store, () => new Date("2026-07-15T00:00:00.000Z"));
    await kernel.ingest([deadline]);
    await store.archive(deadline.source, deadline.id, "2026-07-13T00:00:00.000Z");

    const result = await kernel.ingest([structuredClone(deadline)]);

    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(result.events).toEqual([expect.objectContaining({ type: "item.restored", createdAt: "2026-07-15T00:00:00.000Z" })]);
    await expect(store.find(deadline.source, deadline.id)).resolves.not.toHaveProperty("archivedAt");
  });

  it("records item.restored ahead of diff events when a changed item was archived", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store, () => new Date("2026-07-15T00:00:00.000Z"));
    await kernel.ingest([deadline]);
    await store.archive(deadline.source, deadline.id, "2026-07-13T00:00:00.000Z");

    const moved = structuredClone(deadline);
    moved.facets[0]!.data.dueAt = "2026-07-25T06:00:00.000Z";
    const result = await kernel.ingest([moved]);

    expect(result).toMatchObject({ updated: 1 });
    expect(result.events[0]).toMatchObject({ type: "item.restored" });
    expect(result.events[1]).toMatchObject({ type: "deadline.changed" });
  });

  it("records a capability removal as a deadline.changed event with after null", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);
    const withoutDeadline = structuredClone(deadline);
    withoutDeadline.facets = [];

    const result = await kernel.ingest([withoutDeadline]);

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "deadline.changed",
        field: "has-deadline",
        before: "2026-07-20T06:00:00.000Z",
        after: null,
      }),
    ]);
  });

  it("updates the item but records no event for a raw-only source change", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);
    const changed = structuredClone(deadline);
    changed.raw = { id: 42, sourceRevision: 2 };

    const result = await kernel.ingest([changed]);

    expect(result).toMatchObject({ updated: 1 });
    expect(result.events).toEqual([]);
  });

  it("treats facet and capability declaration order as insignificant", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    const item = structuredClone(deadline);
    item.facets.push({
      type: "course-membership",
      data: { course: "course:41031", role: "student" },
      capabilities: [
        { name: "has-role", primitive: "state", field: "role" },
        { name: "belongs-to-course", primitive: "relation", field: "course" },
      ],
    });
    await kernel.ingest([item]);

    const reordered = structuredClone(item);
    reordered.facets.reverse();
    reordered.facets[0]!.capabilities.reverse();
    const result = await kernel.ingest([reordered]);

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, events: [] });
  });
});
