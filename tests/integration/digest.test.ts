// loadDigestSections/runDailyDigest against the real schema. renderDigest and
// localDateParts are pure functions already covered by tests/digest.test.ts —
// not duplicated here.
//
// Hazard: loadDigestSections' "due soon" query uses SQLite's own
// julianday('now', ...) — the real wall clock, not an injectable "now" (same
// as D1DoorRepository.upcoming, see tests/integration/door-repository.test.ts)
// — so due dates below are computed relative to the actual system clock.

import { beforeEach, describe, expect, it } from "vitest";
import { D1BriefStore } from "../../src/briefs";
import { loadDigestSections, runDailyDigest } from "../../src/digest";
import { D1ItemStore } from "../../src/kernel/d1-item-store";
import { Kernel } from "../../src/kernel/kernel";
import type { ItemInput } from "../../src/kernel/types";
import { createTestDb } from "../support/sqlite-d1";

function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function assessmentDueIn(id: string, days: number): ItemInput {
  const dueAt = inDays(days);
  return {
    id,
    source: "campus-moodle",
    kind: "assessment",
    title: `Assignment ${id}`,
    url: `https://moodle.example.edu/${id}`,
    timestamp: dueAt,
    raw: null,
    facets: [{ type: "deadline", data: { dueAt }, capabilities: [{ name: "has-deadline", primitive: "temporal", field: "dueAt" }] }],
  };
}

function notice(id: string, at: Date): ItemInput {
  return {
    id,
    source: "campus-ed",
    kind: "thread",
    title: `Notice ${id}`,
    timestamp: at.toISOString(),
    raw: null,
    facets: [{ type: "author", data: { actor: "ed-user:1", authorRole: "tutor" }, capabilities: [{ name: "has-author", primitive: "actor", field: "actor" }] }],
  };
}

describe("loadDigestSections + runDailyDigest (real schema)", () => {
  let db: D1Database;
  let store: D1ItemStore;

  beforeEach(async () => {
    db = await createTestDb();
    store = new D1ItemStore(db);
  });

  it("returns empty sections when there is nothing in range", async () => {
    const sections = await loadDigestSections(db, new Date(0).toISOString());
    expect(sections).toEqual({ dueSoon: [], notices: [], changes: [] });
  });

  it("splits real rows into dueSoon (7-day window), notices, and the deadline/grade/content bucket", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const kernel = new Kernel(store, () => t0);
    // dueSoon: real wall-clock window, so these must be relative to Date.now().
    // in-10-days is outside the digest's fixed 7-day dueSoon window.
    await kernel.ingest([assessmentDueIn("in-3-days", 3), assessmentDueIn("in-10-days", 10)]);

    const since = new Date().toISOString();
    const afterSince = new Kernel(store, () => new Date()); // real clock: created_at must land after `since` (real now)

    // notices: created_at is the ingest time, not the item's own timestamp.
    await afterSince.ingest([notice("n1", new Date())]);

    // deadline.changed, after `since`, on an item ingested before `since`.
    const moved = structuredClone(assessmentDueIn("in-3-days", 3));
    moved.facets[0]!.data.dueAt = inDays(4);
    await afterSince.ingest([moved]);

    const sections = await loadDigestSections(db, since);

    expect(sections.dueSoon.map((row) => row.title)).toEqual(["Assignment in-3-days"]); // in-10-days is outside the 7-day window
    expect(sections.notices).toEqual([{ title: "Notice n1", type: "notice.posted", url: null }]);
    expect(sections.changes).toEqual([{ title: "Assignment in-3-days", type: "deadline.changed", url: "https://moodle.example.edu/in-3-days" }]);
  });

  it("runDailyDigest is not due before 07:00 local time and touches nothing", async () => {
    const briefs = new D1BriefStore(db, () => new Date());
    const now = new Date(`${new Date().toISOString().slice(0, 10)}T06:00:00.000Z`);
    const result = await runDailyDigest(db, briefs, "UTC", now);
    expect(result).toEqual({ status: "skipped", reason: "not_due" });
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM briefs").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("skips (writes nothing) when every section is empty, then writes once real content exists, and is idempotent per local day", async () => {
    const briefs = new D1BriefStore(db, () => new Date());
    const now = new Date(`${new Date().toISOString().slice(0, 10)}T08:00:00.000Z`);

    const empty = await runDailyDigest(db, briefs, "UTC", now);
    expect(empty).toEqual({ status: "skipped", reason: "empty" });

    const kernel = new Kernel(store, () => new Date("2026-01-01T00:00:00.000Z"));
    await kernel.ingest([assessmentDueIn("due-soon", 2)]);

    const written = await runDailyDigest(db, briefs, "UTC", now);
    expect(written).toEqual({ status: "written" });

    const again = await runDailyDigest(db, briefs, "UTC", new Date(now.getTime() + 60 * 60 * 1000));
    expect(again).toEqual({ status: "skipped", reason: "already_done" });

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE kind = 'digest'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
