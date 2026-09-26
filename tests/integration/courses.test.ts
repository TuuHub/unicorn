import { beforeEach, describe, expect, it } from "vitest";
import { D1ItemStore } from "../../src/kernel/d1-item-store";
import { labelStructure } from "../../src/kernel/courses";
import { Kernel } from "../../src/kernel/kernel";
import { buildMixedDataset } from "../support/dataset";
import { createTestDb } from "../support/sqlite-d1";

interface LabelRow {
  source: string;
  item_id: string;
  course: string | null;
  bucket: string | null;
  labeled_by: string | null;
}

async function readLabels(db: D1Database): Promise<Map<string, LabelRow>> {
  const rows = await db.prepare("SELECT source, item_id, course, bucket, labeled_by FROM items").all<LabelRow>();
  return new Map(rows.results.map((row) => [`${row.source}\u0000${row.item_id}`, row]));
}

describe("labelStructure (real schema)", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await createTestDb();
    const kernel = new Kernel(new D1ItemStore(db));
    await kernel.ingest(await buildMixedDataset());
  });

  it("labels every structurally-resolvable item with its course code and bucket", async () => {
    await labelStructure(db);
    const labels = await readLabels(db);

    // Moodle assessments: assessment kind -> course/<code>/<assessment-title-slug>.
    expect(labels.get("campus-moodle\u0000assessment:1")).toMatchObject({
      course: "FIT2004",
      bucket: "course/FIT2004/assignment-1",
      labeled_by: "structure",
    });
    expect(labels.get("campus-moodle\u0000assessment:2")).toMatchObject({
      course: "FIT2004",
      bucket: "course/FIT2004/assignment-2",
      labeled_by: "structure",
    });

    // A course item's own course-identity resolves to itself, landing in that
    // course's general bucket (kind "course" is not an assessment kind).
    expect(labels.get("campus-moodle\u0000course:100")).toMatchObject({ course: "FIT2004", bucket: "course/FIT2004/general" });
    expect(labels.get("campus-ed\u0000course:200")).toMatchObject({ course: "FIT2004", bucket: "course/FIT2004/general" });

    // Ed threads: category matcher's three outcomes, cross-source (Ed thread
    // matched against a Moodle assessment title via the shared course code).
    expect(labels.get("campus-ed\u0000thread:10")).toMatchObject({
      course: "FIT2004",
      bucket: "course/FIT2004/assignment-1", // exact category match
      labeled_by: "structure",
    });
    expect(labels.get("campus-ed\u0000thread:11")).toMatchObject({
      course: "FIT2004",
      bucket: "course/FIT2004/general", // no matching assessment
    });
    expect(labels.get("campus-ed\u0000thread:12")).toMatchObject({
      course: "FIT2004",
      bucket: "course/FIT2004/general", // ambiguous prefix match against two assessments
    });

    // Canvas: separate course, its own assignment bucket, staff-authored
    // announcement still lands in that course's general bucket.
    expect(labels.get("campus-canvas\u0000course:300")).toMatchObject({ course: "COMP1511", bucket: "course/COMP1511/general" });
    expect(labels.get("campus-canvas\u0000assignment:20")).toMatchObject({
      course: "COMP1511",
      bucket: "course/COMP1511/project-1",
    });
    expect(labels.get("campus-canvas\u0000announcement:30")).toMatchObject({
      course: "COMP1511",
      bucket: "course/COMP1511/general",
    });

    // Email with a single course mention resolves; with two, it's ambiguous
    // and is deliberately left unlabeled rather than guessed (ADR-0036).
    expect(labels.get("gmail\u0000email:1")).toMatchObject({ course: "FIT2004", bucket: "course/FIT2004/general" });
    const unresolved = labels.get("gmail\u0000email:2");
    expect(unresolved).toMatchObject({ course: null, bucket: null, labeled_by: null });
  });

  it("never overwrites a triage or client label on a later run", async () => {
    await labelStructure(db);

    // Simulate a prior triage/client correction on an item structure would
    // otherwise re-bucket.
    await db
      .prepare("UPDATE items SET course = ?, bucket = ?, labeled_by = 'triage' WHERE source = ? AND item_id = ?")
      .bind("LIFE", "life/admin", "campus-ed", "thread:11")
      .run();

    const result = await labelStructure(db);

    const labels = await readLabels(db);
    expect(labels.get("campus-ed\u0000thread:11")).toMatchObject({
      course: "LIFE",
      bucket: "life/admin",
      labeled_by: "triage",
    });
    // The triage-protected item is excluded from candidateRows entirely, so
    // it never counts toward this run's labeled total either.
    const relabeledKeys = [...labels.entries()].filter(([, row]) => row.labeled_by === "structure").map(([key]) => key);
    expect(relabeledKeys).not.toContain("campus-ed\u0000thread:11");
    expect(result.labeled).toBe(relabeledKeys.length);
  });

  it("is idempotent: a second run with no changes re-derives the same labels", async () => {
    const first = await labelStructure(db);
    const firstLabels = await readLabels(db);

    const second = await labelStructure(db);
    const secondLabels = await readLabels(db);

    expect(second.labeled).toBe(first.labeled);
    expect(secondLabels).toEqual(firstLabels);
  });
});
