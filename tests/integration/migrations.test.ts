import { describe, expect, it } from "vitest";
import {
  applyMigrationFile,
  createTestDb,
  listMigrationFiles,
  openRawSqlite,
  wrapSqliteD1,
} from "../support/sqlite-d1";

describe("migrations", () => {
  it("applies the full chain and produces the expected schema", async () => {
    const db = await createTestDb();
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    for (const expected of ["items", "facets", "changes", "briefs", "plans", "plugin_manifests", "settings", "oauth_tokens", "agent_notes", "relations", "items_fts"]) {
      expect(names).toContain(expected);
    }
    // ADR-0034: the brain's tables are gone.
    for (const removed of ["agent_jobs", "agent_job_runs", "agent_conversations", "agent_messages", "agent_turn_results", "notifications_outbox", "events"]) {
      expect(names).not.toContain(removed);
    }

    const triggers = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual(["items_fts_delete", "items_fts_insert", "items_fts_update"]);
  });

  it("0012 copies existing v1 events into v2 changes, preserving old type names and item state", async () => {
    const sqlite = await openRawSqlite();
    const files = listMigrationFiles();
    const preMemoryLayer = files.filter((file) => !file.includes("0012"));
    const memoryLayerMigration = files.find((file) => file.includes("0012"));
    if (!memoryLayerMigration) {
      throw new Error("expected a 0012 migration file to exist");
    }
    for (const file of preMemoryLayer) {
      applyMigrationFile(sqlite, file);
    }

    // Seed the pre-0012 schema directly: one item, and two v1 events against
    // it using the old type vocabulary (item.created, capability.changed).
    sqlite.exec(`
      INSERT INTO items (source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at)
      VALUES ('campus-moodle', 'assessment:1', 'assessment', 'Assignment 1', '2026-01-01T00:00:00.000Z', 'https://x/1', NULL, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO events (id, type, source, item_id, primitive, capability, facet_type, field, before_json, after_json, changed_fields_json, created_at)
      VALUES ('evt-1', 'item.created', 'campus-moodle', 'assessment:1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z');

      INSERT INTO events (id, type, source, item_id, primitive, capability, facet_type, field, before_json, after_json, changed_fields_json, created_at)
      VALUES ('evt-2', 'capability.changed', 'campus-moodle', 'assessment:1', 'temporal', 'has-deadline', 'deadline', 'dueAt', '"2026-01-05T00:00:00.000Z"', '"2026-01-10T00:00:00.000Z"', NULL, '2026-01-02T00:00:00.000Z');
    `);

    applyMigrationFile(sqlite, memoryLayerMigration);
    const db = wrapSqliteD1(sqlite);

    const changes = await db
      .prepare("SELECT type, source, item_id, kind, title, url, field, before_json, after_json FROM changes ORDER BY seq")
      .all<{
        type: string;
        source: string;
        item_id: string;
        kind: string;
        title: string;
        url: string | null;
        field: string | null;
        before_json: string | null;
        after_json: string | null;
      }>();

    expect(changes.results).toEqual([
      {
        type: "item.created", // old v1 name kept verbatim; ADR-0036 does not retype history
        source: "campus-moodle",
        item_id: "assessment:1",
        kind: "assessment",
        title: "Assignment 1",
        url: "https://x/1",
        field: null,
        before_json: null,
        after_json: null,
      },
      {
        type: "capability.changed",
        source: "campus-moodle",
        item_id: "assessment:1",
        kind: "assessment",
        title: "Assignment 1",
        url: "https://x/1",
        field: "dueAt",
        before_json: '"2026-01-05T00:00:00.000Z"',
        after_json: '"2026-01-10T00:00:00.000Z"',
      },
    ]);

    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").all();
    expect(tables.results).toHaveLength(0);
  });

  it("0012 rebuilds briefs without the closed kind CHECK, preserving existing rows", async () => {
    const sqlite = await openRawSqlite();
    const files = listMigrationFiles();
    const preMemoryLayer = files.filter((file) => !file.includes("0012"));
    const memoryLayerMigration = files.find((file) => file.includes("0012"));
    if (!memoryLayerMigration) {
      throw new Error("expected a 0012 migration file to exist");
    }
    for (const file of preMemoryLayer) {
      applyMigrationFile(sqlite, file);
    }

    sqlite.exec(`
      INSERT INTO briefs (id, kind, subject, title, body, created_at)
      VALUES ('brief-1', 'digest', 'me', 'Daily digest', 'body', '2026-01-01T00:00:00.000Z');
    `);

    applyMigrationFile(sqlite, memoryLayerMigration);
    const db = wrapSqliteD1(sqlite);

    const preserved = await db.prepare("SELECT id, kind FROM briefs WHERE id = 'brief-1'").first<{ id: string; kind: string }>();
    expect(preserved).toEqual({ id: "brief-1", kind: "digest" });

    // A kind outside the old CHECK's fixed list must now be insertable —
    // routines write their own brief kinds (e.g. "routine:<kind>:<key>" ids
    // with arbitrary kinds) once the closed CHECK is gone.
    await db
      .prepare("INSERT INTO briefs (id, kind, subject, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("brief-2", "routine-custom-kind", "me", "t", "b", "2026-01-02T00:00:00.000Z")
      .run();
    const custom = await db.prepare("SELECT kind FROM briefs WHERE id = 'brief-2'").first("kind");
    expect(custom).toBe("routine-custom-kind");
  });

  it("keeps items_fts in sync on insert/delete, but not on a bucket/labeled_by-only update", async () => {
    const db = await createTestDb();
    await db
      .prepare(
        "INSERT INTO items (source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind("s", "1", "assessment", "Assignment One", "2026-01-01T00:00:00.000Z", null, "some body text", "{}", "now", "now")
      .run();

    const matched = await db
      .prepare("SELECT i.item_id FROM items_fts JOIN items i ON i.rowid = items_fts.rowid WHERE items_fts MATCH ?")
      .bind('"Assignment"')
      .all<{ item_id: string }>();
    expect(matched.results.map((r) => r.item_id)).toEqual(["1"]);

    // Structural labelling only ever touches course/bucket/labeled_by — must
    // not re-index (migration 0012's trigger is scoped to title/body only).
    await db.prepare("UPDATE items SET bucket = 'course/FIT2004/general', labeled_by = 'structure' WHERE item_id = '1'").run();
    const stillMatched = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Assignment"').all();
    expect(stillMatched.results).toHaveLength(1);

    // A real title edit does re-index.
    await db.prepare("UPDATE items SET title = 'Renamed Task' WHERE item_id = '1'").run();
    const oldTitleGone = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Assignment"').all();
    expect(oldTitleGone.results).toHaveLength(0);
    const newTitleFound = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Renamed"').all();
    expect(newTitleFound.results).toHaveLength(1);

    await db.prepare("DELETE FROM items WHERE item_id = '1'").run();
    const goneAfterDelete = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Renamed"').all();
    expect(goneAfterDelete.results).toHaveLength(0);
  });
});
