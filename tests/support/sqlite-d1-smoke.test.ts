import { describe, expect, it } from "vitest";
import { createTestDb } from "./sqlite-d1";

describe("sqlite-d1 smoke test (throwaway, deleted before final commit)", () => {
  it("applies every migration and exposes the expected tables", async () => {
    const db = await createTestDb();
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    expect(names).toContain("items");
    expect(names).toContain("changes");
    expect(names).toContain("items_fts");
  });

  it("first()/first(column) match D1 semantics", async () => {
    const db = await createTestDb();
    await db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)").bind("app", "{}", "now").run();
    const row = await db.prepare("SELECT key, value_json FROM settings WHERE key = ?").bind("app").first<{ key: string }>();
    expect(row?.key).toBe("app");
    const value = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind("app").first("value_json");
    expect(value).toBe("{}");
    const missing = await db.prepare("SELECT * FROM settings WHERE key = ?").bind("nope").first();
    expect(missing).toBeNull();
  });

  it("run() surfaces meta.changes and meta.last_row_id", async () => {
    const db = await createTestDb();
    const result = await db
      .prepare("INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES (?, 'weekly', 's', 'c', 'now', 'now')")
      .bind("plan-1")
      .run();
    expect(result.meta.changes).toBe(1);
    const update = await db.prepare("UPDATE plans SET content = 'c2' WHERE id = 'plan-1'").run();
    expect(update.meta.changes).toBe(1);
    const noop = await db.prepare("UPDATE plans SET content = 'c3' WHERE id = 'nope'").run();
    expect(noop.meta.changes).toBe(0);
  });

  it("run() with RETURNING surfaces the returned rows, matching D1's documented run()==all() alias", async () => {
    const db = await createTestDb();
    const result = await db
      .prepare("INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES (?, 'weekly', 's', 'c', 'now', 'now') RETURNING id")
      .bind("plan-2")
      .run();
    expect(result.results).toEqual([{ id: "plan-2" }]);
  });

  it("batch() is transactional: one failing statement rolls back the whole batch", async () => {
    const db = await createTestDb();
    const statements = [
      db.prepare("INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES ('p1', 'weekly', 's', 'c', 'now', 'now')"),
      db.prepare("INSERT INTO plans (id, kind, subject, content, created_at, updated_at) VALUES ('p1', 'weekly', 's', 'c', 'now', 'now')"), // duplicate PK -> fails
    ];
    await expect(db.batch(statements)).rejects.toThrow();
    const rows = await db.prepare("SELECT * FROM plans").all();
    expect(rows.results).toHaveLength(0);
  });

  it("boolean binds convert to 0/1, and undefined is rejected like D1's D1_TYPE_ERROR", async () => {
    const db = await createTestDb();
    await db
      .prepare("INSERT INTO plugin_manifests (id, name, enabled, manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("m1", "Test", true, "{}", "now", "now")
      .run();
    const row = await db.prepare("SELECT enabled FROM plugin_manifests WHERE id = ?").bind("m1").first<{ enabled: number }>();
    expect(row?.enabled).toBe(1);

    expect(() => db.prepare("SELECT * FROM plugin_manifests WHERE id = ?").bind(undefined)).toThrow(/D1_TYPE_ERROR/);
  });

  it("exec() runs multi-statement SQL directly, no bind params", async () => {
    const db = await createTestDb();
    await db.exec("INSERT INTO settings (key, value_json, updated_at) VALUES ('a', '1', 'now'); INSERT INTO settings (key, value_json, updated_at) VALUES ('b', '2', 'now');");
    const rows = await db.prepare("SELECT key FROM settings ORDER BY key").all<{ key: string }>();
    expect(rows.results.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("FTS5 MATCH and bm25 work over real content, and stay in sync on insert/update/delete", async () => {
    const db = await createTestDb();
    await db
      .prepare(
        "INSERT INTO items (source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind("s", "1", "assessment", "Assignment One", "2026-01-01T00:00:00.000Z", null, "some body text", "{}", "now", "now")
      .run();

    const matched = await db
      .prepare("SELECT i.item_id FROM items_fts JOIN items i ON i.rowid = items_fts.rowid WHERE items_fts MATCH ? ORDER BY bm25(items_fts)")
      .bind('"Assignment"')
      .all<{ item_id: string }>();
    expect(matched.results.map((r) => r.item_id)).toEqual(["1"]);

    // A pure bucket/labeled_by update must not touch the FTS index (per migration 0012's comment).
    await db.prepare("UPDATE items SET bucket = 'course/FIT1/general', labeled_by = 'structure' WHERE item_id = '1'").run();
    const stillMatched = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Assignment"').all();
    expect(stillMatched.results).toHaveLength(1);

    await db.prepare("DELETE FROM items WHERE item_id = '1'").run();
    const goneAfterDelete = await db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind('"Assignment"').all();
    expect(goneAfterDelete.results).toHaveLength(0);
  });
});
