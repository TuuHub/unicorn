// One SQLite database per tenant (ADR-0046). Isolation is structural: a tenant's Worker env holds
// a handle to its own file and nothing else, so no query — including the user-defined SQL tools of
// ADR-0035, which run arbitrary SELECTs over the v_* views — can ever see another tenant's rows.
// Each file carries the exact schema the Worker's D1 has, built from the same migrations/.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Env } from "../src/runtime/cycle";
import type { ControlStore } from "./control";
import { wrapSqliteD1 } from "./sqlite-d1";

export interface TenantConfig {
  dataDir: string;
  migrationsDir: string;
  moodleBaseUrl: string;
  canvasBaseUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

type DatabaseSyncCtor = typeof DatabaseSyncType;

export class TenantManager {
  private readonly open = new Map<string, { sqlite: DatabaseSyncType; d1: D1Database }>();
  private readonly migrations: Array<{ name: string; sql: string }>;

  constructor(
    private readonly DatabaseSync: DatabaseSyncCtor,
    private readonly control: ControlStore,
    private readonly config: TenantConfig,
    private readonly kv: KVNamespace,
  ) {
    mkdirSync(join(config.dataDir, "tenants"), { recursive: true });
    this.migrations = readdirSync(config.migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(config.migrationsDir, name), "utf8") }));
  }

  private pathOf(id: string): string {
    if (!/^t[0-9a-f]{20}$/.test(id)) {
      throw new Error("Invalid tenant id.");
    }
    return this.config.dataDir === ":memory:" ? ":memory:" : join(this.config.dataDir, "tenants", `${id}.sqlite`);
  }

  database(id: string): D1Database {
    const cached = this.open.get(id);
    if (cached) return cached.d1;
    const sqlite = new this.DatabaseSync(this.pathOf(id));
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate(sqlite);
    const d1 = wrapSqliteD1(sqlite);
    this.open.set(id, { sqlite, d1 });
    return d1;
  }

  private migrate(sqlite: DatabaseSyncType): void {
    sqlite.exec("CREATE TABLE IF NOT EXISTS _unicorn_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set((sqlite.prepare("SELECT name FROM _unicorn_migrations").all() as Array<{ name: string }>).map((row) => row.name));
    for (const migration of this.migrations) {
      if (applied.has(migration.name)) continue;
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(migration.sql);
        sqlite.prepare("INSERT INTO _unicorn_migrations (name, applied_at) VALUES (?, ?)").run(migration.name, new Date().toISOString());
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw new Error(`Tenant migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The Worker Env for one tenant: its own DB, its own derived secrets, the shared OAuth KV. */
  env(id: string): Env {
    const account = this.control.get(id);
    if (!account) {
      throw new Error("Unknown tenant.");
    }
    return {
      ADMIN_TOKEN: this.control.tenantAdminToken(id),
      DB: this.database(id),
      MCP_TOKEN: this.control.personalToken(account),
      MOODLE_BASE_URL: this.config.moodleBaseUrl,
      CANVAS_BASE_URL: this.config.canvasBaseUrl,
      PLUGIN_SECRET_GOOGLE_CLIENT_ID: this.config.googleClientId,
      PLUGIN_SECRET_GOOGLE_CLIENT_SECRET: this.config.googleClientSecret,
      OAUTH_KV: this.kv,
      SCHEDULER: schedulerShim(account.lastCycleAt) as unknown as DurableObjectNamespace,
      DOOR_USER_ID: id,
      HOSTED: "1",
    };
  }

  close(id: string): void {
    const cached = this.open.get(id);
    if (cached) {
      cached.sqlite.close();
      this.open.delete(id);
    }
  }

  destroy(id: string): void {
    this.close(id);
    const path = this.pathOf(id);
    if (path !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(path + suffix)) rmSync(path + suffix);
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}

// The Worker asks its Scheduler Durable Object "is the hourly alarm set?" for /health, /settings
// and the door's status tool. On the hosted server one in-process loop (server/scheduler.ts) runs
// every tenant's cycle, so the answer is always yes; start/stop are accepted and ignored.
function schedulerShim(lastCycleAt: string | null) {
  const nextAlarm = lastCycleAt ? Date.parse(lastCycleAt) + 60 * 60 * 1000 : Date.now() + 60 * 1000;
  const stub = {
    fetch: async (input: Request | string) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path === "/stop") return Response.json({ scheduled: true, note: "The hosted scheduler runs every account hourly." });
      return Response.json({ scheduled: true, nextAlarm });
    },
  };
  return { idFromName: () => ({}), get: () => stub };
}
