export interface RetentionRepository {
  archiveBefore(cutoff: string, archivedAt: string): Promise<number>;
}

export class D1RetentionRepository implements RetentionRepository {
  constructor(private readonly db: D1Database) {}

  async archiveBefore(cutoff: string, archivedAt: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE items
         SET archived_at = ?
         WHERE archived_at IS NULL
           AND kind != 'course'
           AND timestamp < ?`,
      )
      .bind(archivedAt, cutoff)
      .run();
    return result.meta.changes;
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
