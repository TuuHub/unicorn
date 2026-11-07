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

export { wrapSqliteD1 } from "../../server/sqlite-d1";
import { wrapSqliteD1 } from "../../server/sqlite-d1";

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
