// The activity log (ADR-0048): what unicorn did, on whose behalf, shown verbatim in the panel.
//
// Two writers: the door (one row per tool call, via instrumentTools in src/mcp/door.ts) and the
// scheduler cycle (one row per source sync, plus memory/system events such as a new term being
// detected). Arguments are kept so the user can see exactly what their agent asked, but long
// free text (plan bodies, memory entries, brief bodies) is reduced to its length, and nothing
// that is a credential ever reaches this table — the door never receives one.

export type ActivityKind = "tool" | "sync" | "memory" | "system";

export interface CallerInfo {
  actor: string | null;
  via: string | null;
  userAgent?: string | null;
}

export interface ActivityInput {
  kind: ActivityKind;
  name: string;
  status: "ok" | "error";
  errorCode?: string | null;
  durationMs?: number | null;
  actor?: string | null;
  via?: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}

export interface ActivityEntry {
  id: number;
  at: string;
  kind: ActivityKind;
  name: string;
  status: "ok" | "error";
  errorCode: string | null;
  durationMs: number | null;
  actor: string | null;
  via: string | null;
  detail: Record<string, unknown>;
}

export interface ActivityQuery {
  kind?: ActivityKind;
  status?: "ok" | "error";
  before?: number;
  limit?: number;
}

export interface ActivityStats {
  toolCalls24h: number;
  errors24h: number;
  syncs24h: number;
  topTools7d: Array<{ name: string; calls: number }>;
  clients7d: Array<{ actor: string; calls: number; lastAt: string }>;
  // Agent calls per UTC day for the last seven days, oldest first, zero-filled.
  daily7d: Array<{ day: string; calls: number; errors: number }>;
}

export interface ActivityLog {
  record(input: ActivityInput): Promise<void>;
  list(query?: ActivityQuery): Promise<ActivityEntry[]>;
  stats(now?: Date): Promise<ActivityStats>;
  prune(olderThanDays: number, now?: Date): Promise<number>;
}

export const ACTIVITY_RETENTION_DAYS = 30;
const LONG_TEXT_KEYS = new Set(["content", "body", "text", "sql"]);
const MAX_STRING = 160;

/** Shrinks tool arguments to something safe and readable to keep for 30 days. */
export function redactDetail(value: unknown, key = "", depth = 0): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    if (LONG_TEXT_KEYS.has(key) && value.length > 80) {
      return `[${value.length} chars]`;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth >= 4) {
    return "[…]";
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((item) => redactDetail(item, key, depth + 1));
    return value.length > 10 ? [...items, `…${value.length - 10} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    out[childKey] = redactDetail(child, childKey, depth + 1);
  }
  return out;
}

interface ActivityRow {
  id: number;
  at: string;
  kind: string;
  name: string;
  status: string;
  error_code: string | null;
  duration_ms: number | null;
  actor: string | null;
  via: string | null;
  detail_json: string | null;
}

export class D1ActivityLog implements ActivityLog {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: ActivityInput): Promise<void> {
    const detail = input.detail ? JSON.stringify(redactDetail(input.detail)) : null;
    await this.db
      .prepare(
        `INSERT INTO activity_log (at, kind, name, status, error_code, duration_ms, actor, via, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.at ?? this.now().toISOString(),
        input.kind,
        input.name.slice(0, 120),
        input.status,
        input.errorCode ?? null,
        input.durationMs ?? null,
        input.actor?.slice(0, 120) ?? null,
        input.via ?? null,
        detail,
      )
      .run();
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.kind) {
      conditions.push("kind = ?");
      values.push(query.kind);
    }
    if (query.status) {
      conditions.push("status = ?");
      values.push(query.status);
    }
    if (query.before !== undefined) {
      conditions.push("id < ?");
      values.push(query.before);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.db
      .prepare(`SELECT * FROM activity_log ${where} ORDER BY id DESC LIMIT ${limit}`)
      .bind(...values)
      .all<ActivityRow>();
    return rows.results.map(toEntry);
  }

  async stats(now: Date = this.now()): Promise<ActivityStats> {
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const [counts, tools, clients, daily] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN kind = 'tool' THEN 1 ELSE 0 END) AS tool_calls,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN kind = 'sync' THEN 1 ELSE 0 END) AS syncs
           FROM activity_log WHERE at >= ?`,
        )
        .bind(day)
        .first<{ tool_calls: number | null; errors: number | null; syncs: number | null }>(),
      this.db
        .prepare(`SELECT name, COUNT(*) AS calls FROM activity_log WHERE kind = 'tool' AND at >= ? GROUP BY name ORDER BY calls DESC LIMIT 8`)
        .bind(week)
        .all<{ name: string; calls: number }>(),
      this.db
        .prepare(
          `SELECT COALESCE(actor, via, 'unknown') AS actor, COUNT(*) AS calls, MAX(at) AS last_at
           FROM activity_log WHERE kind = 'tool' AND at >= ? GROUP BY 1 ORDER BY calls DESC LIMIT 8`,
        )
        .bind(week)
        .all<{ actor: string; calls: number; last_at: string }>(),
      this.db
        .prepare(
          `SELECT substr(at, 1, 10) AS day, COUNT(*) AS calls, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
           FROM activity_log WHERE kind = 'tool' AND at >= ? GROUP BY 1`,
        )
        .bind(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)).toISOString())
        .all<{ day: string; calls: number; errors: number | null }>(),
    ]);
    const byDay = new Map(daily.results.map((row) => [row.day, row]));
    const daily7d = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6 + index)).toISOString().slice(0, 10);
      const row = byDay.get(day);
      return { day, calls: Number(row?.calls ?? 0), errors: Number(row?.errors ?? 0) };
    });
    return {
      toolCalls24h: Number(counts?.tool_calls ?? 0),
      errors24h: Number(counts?.errors ?? 0),
      syncs24h: Number(counts?.syncs ?? 0),
      topTools7d: tools.results.map((row) => ({ name: row.name, calls: Number(row.calls) })),
      clients7d: clients.results.map((row) => ({ actor: row.actor, calls: Number(row.calls), lastAt: row.last_at })),
      daily7d,
    };
  }

  async prune(olderThanDays: number, now: Date = this.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
    const result = await this.db.prepare("DELETE FROM activity_log WHERE at < ?").bind(cutoff).run();
    return result.meta.changes;
  }
}

function toEntry(row: ActivityRow): ActivityEntry {
  let detail: Record<string, unknown> = {};
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    } catch {
      detail = {};
    }
  }
  return {
    id: Number(row.id),
    at: row.at,
    kind: row.kind as ActivityKind,
    name: row.name,
    status: row.status === "error" ? "error" : "ok",
    errorCode: row.error_code,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    actor: row.actor,
    via: row.via,
    detail,
  };
}

/** Best-effort client name from a User-Agent, for calls that arrive without an OAuth client name. */
export function actorFromUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude code")) return "Claude Code";
  if (ua.includes("claude")) return "Claude";
  if (ua.includes("openai") || ua.includes("chatgpt")) return "ChatGPT";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("codex")) return "Codex";
  return null;
}
