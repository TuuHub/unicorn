// A faithful D1Database adapter over Node's built-in node:sqlite
// (DatabaseSync), so integration tests run the real SQL — FTS5 MATCH/bm25,
// json_extract, RETURNING, batch() transactions — instead of a
// substring-matching fake. Node 22 ships FTS5 enabled; no new dependency.
//
// Implements exactly what this codebase uses against D1Database:
// prepare().bind().first()/all()/run(), batch() (transactional), exec(), and
// meta.changes / meta.last_row_id. Shapes and semantics follow Cloudflare's
// documented D1 Worker Binding API (developers.cloudflare.com/d1/worker-api).

// Type-only: erased at compile time, so it can't itself trigger node:sqlite's
// module side effects. The runtime binding is loaded lazily below, via a real
// dynamic import, only once the warning filter is already installed.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DatabaseSync = DatabaseSyncType;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// node:sqlite is stable enough for our purposes here; it just hasn't dropped
// the "experimental" label yet. Scoped to this module only — every other
// warning still reaches whatever was listening before us.
const SQLITE_EXPERIMENTAL_WARNING = /SQLite is an experimental feature/;
let warningFilterInstalled = false;

function suppressSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) {
    return;
  }
  warningFilterInstalled = true;
  const previousListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && SQLITE_EXPERIMENTAL_WARNING.test(warning.message)) {
      return;
    }
    if (previousListeners.length === 0) {
      console.error(warning);
      return;
    }
    for (const listener of previousListeners) {
      listener(warning);
    }
  });
}

// Under Vite/vite-node's SSR transform (which is how vitest runs this file),
// a static top-level `import { DatabaseSync } from "node:sqlite"` is rewritten
// into an awaited dynamic import — inserting an async boundary *before* any
// of this module's own top-level statements after it run. node:sqlite emits
// its "experimental" warning on process.nextTick as a side effect of that
// import, so it can fire and reach Node's default listener during that gap,
// before our filter above ever gets installed. Loading node:sqlite lazily
// ourselves — after suppressSqliteExperimentalWarning() has already run —
// avoids the race entirely.
let databaseSyncCtor: typeof DatabaseSyncType | undefined;

async function loadDatabaseSync(): Promise<typeof DatabaseSyncType> {
  suppressSqliteExperimentalWarning();
  if (!databaseSyncCtor) {
    ({ DatabaseSync: databaseSyncCtor } = await import("node:sqlite"));
  }
  return databaseSyncCtor;
}

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

/**
 * Creates an in-memory D1-compatible database with every migration in
 * `migrations/` applied in order, exactly as `wrangler d1 migrations apply`
 * would. Each test gets its own fresh, isolated database.
 */
export async function createTestDb(): Promise<D1Database> {
  const sqlite = await openRawSqlite();
  for (const file of listMigrationFiles()) {
    applyMigrationFile(sqlite, file);
  }
  return wrapSqliteD1(sqlite);
}

/** Every migration filename in `migrations/`, in the order wrangler applies them. */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** Runs a single migration file (by the name listMigrationFiles() returns) against an open connection. */
export function applyMigrationFile(sqlite: DatabaseSync, file: string): void {
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/**
 * Opens a fresh in-memory node:sqlite connection with no migrations applied.
 * Exposed (alongside listMigrationFiles/applyMigrationFile) so tests that
 * need to inspect state *between* migrations — e.g. 0012's events->changes
 * copy — can apply a prefix, seed data on the pre-migration schema, then
 * continue. Most tests want createTestDb() instead.
 */
export async function openRawSqlite(): Promise<DatabaseSync> {
  const DatabaseSync = await loadDatabaseSync();
  return new DatabaseSync(":memory:");
}
