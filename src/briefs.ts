// ADR-0031 briefs: durable output of scheduled playbooks and the daily digest.
// This is the one inbox the door's get_briefs/ack_briefs tools (ADR-0030) read from.

export type BriefKind = "weekly-plan" | "assignment-plan" | "forum-brief" | "digest";

export interface Brief {
  id: string;
  kind: BriefKind;
  subject: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface BriefInput {
  id: string;
  kind: BriefKind;
  subject: string;
  title: string;
  body: string;
  createdAt?: string;
}

export interface BriefListQuery {
  unreadOnly?: boolean;
  limit?: number;
}

export interface BriefStore {
  // Idempotent on `id`: a retried cycle that recomputes the same brief is a no-op,
  // so scheduled triggers never need their own dedupe bookkeeping.
  insert(input: BriefInput): Promise<Brief>;
  list(query?: BriefListQuery): Promise<Brief[]>;
  markRead(ids: string[]): Promise<number>;
  prune(retentionDays: number): Promise<number>;
  // Cheap existence check used by the scheduler to skip re-running a playbook whose
  // brief id already exists, without paying for a full row fetch.
  exists(id: string): Promise<boolean>;
  // Most recent brief of a kind — used by the forum-brief trigger to find the
  // window's start (the previous brief's timestamp).
  latestByKind(kind: BriefKind): Promise<Brief | null>;
}

interface BriefRow {
  id: string;
  kind: BriefKind;
  subject: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export class D1BriefStore implements BriefStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insert(input: BriefInput): Promise<Brief> {
    const createdAt = input.createdAt ?? this.now().toISOString();
    await this.db
      .prepare(
        `INSERT INTO briefs (id, kind, subject, title, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(input.id, input.kind, input.subject, input.title, input.body, createdAt)
      .run();
    const row = await this.db.prepare("SELECT * FROM briefs WHERE id = ?").bind(input.id).first<BriefRow>();
    if (!row) {
      throw new Error("Brief was not persisted.");
    }
    return parseBrief(row);
  }

  async list(query: BriefListQuery = {}): Promise<Brief[]> {
    const unreadOnly = query.unreadOnly ?? true;
    const limit = query.limit ?? 20;
    const rows = unreadOnly
      ? await this.db
          .prepare("SELECT * FROM briefs WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?")
          .bind(limit)
          .all<BriefRow>()
      : await this.db.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT ?").bind(limit).all<BriefRow>();
    return rows.results.map(parseBrief);
  }

  async markRead(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const nowIso = this.now().toISOString();
    const placeholders = ids.map(() => "?").join(", ");
    const result = await this.db
      .prepare(`UPDATE briefs SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`)
      .bind(nowIso, ...ids)
      .run();
    return result.meta.changes;
  }

  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.prepare("DELETE FROM briefs WHERE created_at < ?").bind(cutoff).run();
    return result.meta.changes;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 FROM briefs WHERE id = ?").bind(id).first();
    return row !== null;
  }

  async latestByKind(kind: BriefKind): Promise<Brief | null> {
    const row = await this.db
      .prepare("SELECT * FROM briefs WHERE kind = ? ORDER BY created_at DESC LIMIT 1")
      .bind(kind)
      .first<BriefRow>();
    return row ? parseBrief(row) : null;
  }
}

function parseBrief(row: BriefRow): Brief {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
