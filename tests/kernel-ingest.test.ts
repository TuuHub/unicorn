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
  it("creates a new item and records its creation event", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store, () => new Date("2026-07-13T00:00:00.000Z"));

    const result = await kernel.ingest([deadline]);

    expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "item.created",
        source: "campus-moodle",
        itemId: "assessment-42",
        createdAt: "2026-07-13T00:00:00.000Z",
      }),
    ]);
    await expect(store.listEvents()).resolves.toEqual(result.events);
  });

  it("records a capability event when a deadline moves", async () => {
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
        type: "capability.changed",
        primitive: "temporal",
        capability: "has-deadline",
        facetType: "deadline",
        field: "dueAt",
        before: "2026-07-20T06:00:00.000Z",
        after: "2026-07-22T06:00:00.000Z",
        createdAt: "2026-07-14T00:00:00.000Z",
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

  it("restores an archived item when it is pulled again unchanged", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);
    await store.archive(deadline.source, deadline.id, "2026-07-13T00:00:00.000Z");

    const result = await kernel.ingest([structuredClone(deadline)]);

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1, events: [] });
    await expect(store.find(deadline.source, deadline.id)).resolves.not.toHaveProperty("archivedAt");
  });

  it("records a primitive event when a capability is removed", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);
    const withoutDeadline = structuredClone(deadline);
    withoutDeadline.facets = [];

    const result = await kernel.ingest([withoutDeadline]);

    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "capability.changed",
          primitive: "temporal",
          capability: "has-deadline",
          facetType: "deadline",
          field: "dueAt",
          before: "2026-07-20T06:00:00.000Z",
        }),
      ]),
    );
    expect(result.events.find((event) => event.type === "capability.changed")).not.toHaveProperty("after");
  });

  it("records an item event for a raw-only source change", async () => {
    const store = new MemoryItemStore();
    const kernel = new Kernel(store);
    await kernel.ingest([deadline]);
    const changed = structuredClone(deadline);
    changed.raw = { id: 42, sourceRevision: 2 };

    const result = await kernel.ingest([changed]);

    expect(result.events).toEqual([
      expect.objectContaining({ type: "item.updated", changedFields: ["raw"] }),
    ]);
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
