export interface RetentionRepository {
  archiveBefore(cutoff: string, archivedAt: string): Promise<number>;
}

interface ArchivedRow {
  source: string;
  item_id: string;
  kind: string;
  title: string;
  url: string | null;
}

export class D1RetentionRepository implements RetentionRepository {
  constructor(private readonly db: D1Database) {}

  async archiveBefore(cutoff: string, archivedAt: string): Promise<number> {
    // RETURNING the archived rows lets us emit one item.archived change per row
    // (ADR-0036) without a second per-item SELECT.
    const archived = await this.db
      .prepare(
        `UPDATE items
         SET archived_at = ?
         WHERE archived_at IS NULL
           AND kind != 'course'
           AND timestamp < ?
         RETURNING source, item_id, kind, title, url`,
      )
      .bind(archivedAt, cutoff)
      .all<ArchivedRow>();

    if (archived.results.length === 0) {
      return 0;
    }

    await this.db.batch(
      archived.results.map((row) =>
        this.db
          .prepare(
            `INSERT INTO changes (type, source, item_id, kind, title, url, field, before_json, after_json, topic, created_at)
             VALUES ('item.archived', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
          )
          .bind(row.source, row.item_id, row.kind, row.title, row.url, archivedAt),
      ),
    );
    return archived.results.length;
  }
}

export function runRetention(
  repository: RetentionRepository,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return repository.archiveBefore(cutoff, now.toISOString());
}

// Archives a source's items of the given kinds that its last full pull left out, with one
// item.archived change each. The source stopped listing them: handed in, closed, unenrolled.
export async function archiveMissing(
  db: D1Database,
  source: string,
  kinds: string[],
  keepIds: string[],
  archivedAt: string,
): Promise<number> {
  if (kinds.length === 0) return 0;
  const archived = await db
    .prepare(
      `UPDATE items
       SET archived_at = ?
       WHERE archived_at IS NULL
         AND source = ?
         AND kind IN (SELECT value FROM json_each(?))
         AND item_id NOT IN (SELECT value FROM json_each(?))
       RETURNING source, item_id, kind, title, url`,
    )
    .bind(archivedAt, source, JSON.stringify(kinds), JSON.stringify(keepIds))
    .all<ArchivedRow>();
  if (archived.results.length === 0) return 0;
  await db.batch(
    archived.results.map((row) =>
      db
        .prepare(
          `INSERT INTO changes (type, source, item_id, kind, title, url, field, before_json, after_json, topic, created_at)
           VALUES ('item.archived', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
        )
        .bind(row.source, row.item_id, row.kind, row.title, row.url, archivedAt),
    ),
  );
  return archived.results.length;
}
