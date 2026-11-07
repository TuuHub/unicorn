// A faithful D1Database adapter over Node's built-in node:sqlite (DatabaseSync).
//
// Shared by the test suite (tests/support/sqlite-d1.ts) and the hosted server (ADR-0046), which
// runs the unchanged Worker code against one SQLite file per tenant. Implements exactly what this
// codebase uses against D1Database: prepare().bind().first()/all()/run()/raw(), batch()
// (transactional), exec(), and meta.changes / meta.last_row_id, following Cloudflare's documented
// D1 Worker Binding API (developers.cloudflare.com/d1/worker-api). Node 22 ships FTS5 enabled.

import type { DatabaseSync } from "node:sqlite";

// D1's documented bind semantics (developers.cloudflare.com/d1/worker-api/prepared-statements/
// and .../d1/observability/debug-d1/#error-list): booleans are stored as 0/1;
// `undefined` is unsupported (D1_TYPE_ERROR) — use null instead.
function convertBindValue(value: unknown): unknown {
  if (value === undefined) {
    throw new Error("D1_TYPE_ERROR: type undefined is unsupported, use null instead of undefined when binding a parameter.");
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

type Row = Record<string, unknown>;

function runOnce(db: DatabaseSync, sql: string, values: unknown[]): Row[] {
  // node:sqlite's own SQLInputValue type is narrower than D1's bind() surface;
  // convertBindValue() already normalized what we accept.
  return db.prepare(sql).all(...(values as never[])) as Row[];
}

// meta.changes / meta.last_row_id come from SQLite's own connection-level
// changes()/last_insert_rowid(), read right after the statement executed —
// the same values D1 itself surfaces in D1Meta. Built as a plain record
// (rather than typed as D1Meta) so it satisfies D1Meta's actual runtime
// shape, `D1Meta & Record<string, unknown>`, without a redundant cast.
function readMeta(db: DatabaseSync): Record<string, unknown> {
  const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n);
  const lastRowId = Number((db.prepare("SELECT last_insert_rowid() AS n").get() as { n: number }).n);
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

function makeStatement(db: DatabaseSync, sql: string, values: unknown[]): D1PreparedStatement {
  const statement = {
    bind(...boundValues: unknown[]): D1PreparedStatement {
      return makeStatement(db, sql, boundValues.map(convertBindValue));
    },
    async first(column?: string): Promise<unknown> {
      const rows = runOnce(db, sql, values);
      if (rows.length === 0) {
        return null;
      }
      const row = rows[0]!;
      if (column !== undefined) {
        if (!(column in row)) {
          throw new Error(`D1_ERROR: no such column: ${column}`);
        }
        return row[column];
      }
      return row;
    },
    // D1's docs describe run() as functionally equivalent to all() (an
    // alias) — both execute the statement once and return every row,
    // including RETURNING rows on a write.
    async run() {
      const rows = runOnce(db, sql, values);
      return { success: true, results: rows, meta: readMeta(db) };
    },
    async all() {
      const rows = runOnce(db, sql, values);
      return { success: true, results: rows, meta: readMeta(db) };
    },
    async raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
      const rows = runOnce(db, sql, values);
      const columns = db
        .prepare(sql)
        .columns()
        .map((column) => column.name as string);
      const arrays = rows.map((row) => columns.map((name) => row[name]));
      return options?.columnNames ? [columns, ...arrays] : arrays;
    },
  };
  return statement as unknown as D1PreparedStatement;
}

/** Wraps an already-open node:sqlite DatabaseSync as a D1Database. */
export function wrapSqliteD1(db: DatabaseSync): D1Database {
  const database = {
    prepare(sql: string): D1PreparedStatement {
      return makeStatement(db, sql, []);
    },
    // D1 batches run every statement in one transaction. node:sqlite has no
    // built-in transaction helper (that's better-sqlite3's API), so this
    // wraps the statements in an explicit BEGIN/COMMIT, rolling back on
    // failure — the same all-or-nothing guarantee D1 documents for batch().
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      db.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string): Promise<D1ExecResult> {
      db.exec(sql);
      const count = sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean).length;
      return { count, duration: 0 };
    },
  };
  return database as unknown as D1Database;
}

