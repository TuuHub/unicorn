// Proves migration 0013's five views and the four library-seed tools against
// a genuine local D1 (miniflare-backed SQLite via wrangler's getPlatformProxy)
// rather than a hand-written fake — the guard and the store's own EXPLAIN
// step both only prove a statement *parses*; this is what actually proves it
// runs against the real schema, with real data, and returns real columns.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1UserToolStore, extractParamOrder, validateSql, wrapSql, type DefineToolInput } from "../src/tools/user-tools";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

// A real migration file mixes '--'/'/* */' comments, string/identifier
// literals and multi-statement `CREATE TRIGGER ... BEGIN ... END;` blocks.
// Comments must be neutralized before splitting on ';' (a ';' inside a
// comment's text isn't a statement boundary) — blanked to same-length
// whitespace, not deleted, so indices still line up with the original text
// for the `sql.slice` below.
function blankComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Splits on ';' at depth 0, where BEGIN increases depth and END decreases it
// — the only way a trigger body's internal ';'s don't end the statement early.
function splitStatements(sql: string): string[] {
  const blanked = blankComments(sql);
  const statements: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const wordAt = (index: number): string | null => {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(blanked.slice(index));
    return match ? match[0].toLowerCase() : null;
  };
  while (i < blanked.length) {
    const word = /[A-Za-z_]/.test(blanked[i]!) ? wordAt(i) : null;
    if (word === "begin") depth += 1;
    if (word === "end") depth -= 1;
    if (word) {
      i += word.length;
      continue;
    }
    if (blanked[i] === ";" && depth === 0) {
      statements.push(sql.slice(start, i + 1));
      start = i + 1;
    }
    i += 1;
  }
  const rest = sql.slice(start).trim();
  if (rest) statements.push(rest);
  return statements.map((s) => s.trim()).filter(Boolean);
}

async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of splitStatements(sql)) {
      await db.prepare(statement).run();
    }
  }
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: path.join(ROOT, "wrangler.jsonc"), persist: false });
  db = (proxy.env as { DB: D1Database }).DB;
  await applyMigrations(db);
}, 30_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("migration 0013 against a real local D1", () => {
  it("creates user_tools and all five views", async () => {
    const rows = await db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('user_tools', 'v_items', 'v_upcoming', 'v_changes', 'v_courses', 'v_buckets') ORDER BY name")
      .all<{ name: string; type: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["user_tools", "v_buckets", "v_changes", "v_courses", "v_items", "v_upcoming"]);
  });

  it("every view is queryable and returns zero rows on an empty database, not an error", async () => {
    for (const view of ["v_items", "v_upcoming", "v_changes", "v_courses", "v_buckets"]) {
      const result = await db.prepare(`SELECT * FROM ${view}`).all();
      expect(result.results).toEqual([]);
    }
  });

  it("v_items exposes the due_at/state/staff columns computed from facets", async () => {
    const columns = await db.prepare("PRAGMA table_info(v_items)").all<{ name: string }>();
    const names = columns.results.map((c) => c.name);
    for (const expected of ["source", "item_id", "course", "bucket", "due_at", "state", "staff"]) {
      expect(names).toContain(expected);
    }
  });

  it("v_items reflects a real inserted item plus its temporal/state/author facets", async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO items (source, item_id, kind, title, url, timestamp, body, raw_json, created_at, updated_at, course, bucket, labeled_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "campus-moodle",
        "assess-1",
        "assessment",
        "Lab report 4",
        "https://example.edu/1",
        now,
        "",
        "{}",
        now,
        now,
        "FIT2004",
        "course/FIT2004/lab-4",
        "structure",
      )
      .run();
    await db
      .prepare("INSERT INTO facets (source, item_id, type, data_json, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .bind(
        "campus-moodle",
        "assess-1",
        "deadline",
        JSON.stringify({ dueAt: "2026-10-01T00:00:00.000Z" }),
        JSON.stringify([{ primitive: "temporal", field: "dueAt" }]),
      )
      .run();
    await db
      .prepare("INSERT INTO facets (source, item_id, type, data_json, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .bind("campus-moodle", "assess-1", "submission", JSON.stringify({ status: "not submitted" }), JSON.stringify([{ primitive: "state", field: "status" }]))
      .run();

    const row = await db.prepare("SELECT due_at, state, staff FROM v_items WHERE source = ? AND item_id = ?").bind("campus-moodle", "assess-1").first();

    expect(row).toEqual({ due_at: "2026-10-01T00:00:00.000Z", state: "not submitted", staff: 0 });
  });
});

describe("library-seed tools against the real schema", () => {
  const seedDir = path.join(ROOT, "library-seed");
  const index = JSON.parse(readFileSync(path.join(seedDir, "index.json"), "utf8")) as { tools: Array<{ name: string; path: string }> };

  it("index.json lists exactly the four seed tool files, and each one exists", () => {
    expect(index.tools.map((t) => t.name).sort()).toEqual(["course_activity", "next_lab", "overdue", "week_ahead"]);
    for (const entry of index.tools) {
      expect(() => readFileSync(path.join(seedDir, entry.path), "utf8")).not.toThrow();
    }
  });

  it.each(index.tools.map((t) => t.path))("%s passes the SQL guard", (relativePath) => {
    const file = JSON.parse(readFileSync(path.join(seedDir, relativePath), "utf8")) as { inputSchema: Record<string, unknown>; sql: string };
    expect(() => validateSql(file.sql, Object.keys(file.inputSchema))).not.toThrow();
  });

  it.each(index.tools.map((t) => t.path))("%s's wrapped SQL EXPLAINs cleanly against the real schema", async (relativePath) => {
    const file = JSON.parse(readFileSync(path.join(seedDir, relativePath), "utf8")) as {
      inputSchema: Record<string, { type: string }>;
      sql: string;
    };
    const { sql } = validateSql(file.sql, Object.keys(file.inputSchema));
    const order = extractParamOrder(sql);
    const dummyValues = order.map((name) => {
      const type = file.inputSchema[name]?.type;
      return type === "string" ? "" : 0;
    });
    await expect(
      db
        .prepare(`EXPLAIN ${wrapSql(sql)}`)
        .bind(...dummyValues)
        .all(),
    ).resolves.toBeTruthy();
  });

  it("each seed tool defines successfully through D1UserToolStore.define and then runs", async () => {
    const store = new D1UserToolStore(db);
    for (const entry of index.tools) {
      const file = JSON.parse(readFileSync(path.join(seedDir, entry.path), "utf8")) as DefineToolInput;
      await store.define(file);
      const order = extractParamOrder(file.sql);
      const dummyValues = order.map((name) => (file.inputSchema[name]?.type === "string" ? "FIT2004" : 5));
      // The DB isn't empty by this point — the previous describe block left
      // one real "FIT2004" item behind on the same connection — so this only
      // proves the query executes end-to-end and returns rows shaped like a
      // real result set, not any particular row count.
      const result = await db
        .prepare(wrapSql(file.sql))
        .bind(...dummyValues)
        .all();
      expect(Array.isArray(result.results)).toBe(true);
    }
    expect((await store.list()).map((t) => t.name).sort()).toEqual(["course_activity", "next_lab", "overdue", "week_ahead"]);
  });
});
