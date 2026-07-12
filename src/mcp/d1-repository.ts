import { D1ItemStore } from "../kernel/d1-item-store";
import type { ItemEvent, JsonValue, StoredItem } from "../kernel/types";
import type { AgentJob } from "../jobs/daily-digest";
import { D1JobStore, type AgentJobRun } from "../jobs/d1-job-store";
import { D1ManifestStore, type StoredPluginManifest } from "../plugins/declarative/store";
import type {
  EventQuery,
  ItemQuery,
  ItemRelation,
  LinkItemsInput,
  McpRepository,
  UpcomingItem,
  UpcomingQuery,
} from "./server";

interface ItemKeyRow {
  source: string;
  item_id: string;
}

interface UpcomingRow {
  source: string;
  item_id: string;
  title: string;
  url: string | null;
  facet_type: string;
  capability: string;
  due_at: string;
}

interface EventRow {
  id: string;
  type: ItemEvent["type"];
  source: string;
  item_id: string;
  primitive: ItemEvent["primitive"] | null;
  capability: string | null;
  facet_type: string | null;
  field: string | null;
  before_json: string | null;
  after_json: string | null;
  changed_fields_json: string | null;
  created_at: string;
}

interface RelationRow {
  id: string;
  type: string;
  from_source: string;
  from_item_id: string;
  to_source: string;
  to_item_id: string;
  metadata_json: string;
  confirmed_at: string;
}

export class D1McpRepository implements McpRepository {
  private readonly items: D1ItemStore;
  private readonly manifests: D1ManifestStore;
  private readonly jobs: D1JobStore;

  constructor(private readonly db: D1Database) {
    this.items = new D1ItemStore(db);
    this.manifests = new D1ManifestStore(db);
    this.jobs = new D1JobStore(db);
  }

  find(source: string, itemId: string): Promise<StoredItem | null> {
    return this.items.find(source, itemId);
  }

  async listItems(query: ItemQuery): Promise<StoredItem[]> {
    const conditions = ["archived_at IS NULL"];
    const values: Array<string | number> = [];
    if (query.source) {
      conditions.push("source = ?");
      values.push(query.source);
    }
    if (query.kind) {
      conditions.push("kind = ?");
      values.push(query.kind);
    }
    values.push(query.limit);
    const rows = await this.db
      .prepare(
        `SELECT source, item_id
         FROM items
         WHERE ${conditions.join(" AND ")}
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .bind(...values)
      .all<ItemKeyRow>();

    const items: StoredItem[] = [];
    for (const row of rows.results) {
      const item = await this.find(row.source, row.item_id);
      if (item) {
        items.push(item);
      }
    }
    return items;
  }

  async listUpcoming(query: UpcomingQuery): Promise<UpcomingItem[]> {
    const rows = await this.db
      .prepare(
        `SELECT
           i.source,
           i.item_id,
           i.title,
           i.url,
           f.type AS facet_type,
           json_extract(binding.value, '$.name') AS capability,
           json_extract(
             f.data_json,
             '$.' || json_extract(binding.value, '$.field')
           ) AS due_at
         FROM items i
         JOIN facets f ON f.source = i.source AND f.item_id = i.item_id
         JOIN json_each(f.capabilities_json) binding
         WHERE i.archived_at IS NULL
           AND json_extract(binding.value, '$.primitive') = 'temporal'
           AND julianday(due_at) BETWEEN julianday('now') AND julianday('now', '+' || ? || ' days')
         ORDER BY julianday(due_at), i.title
         LIMIT ?`,
      )
      .bind(query.days, query.limit)
      .all<UpcomingRow>();
    return rows.results.map((row) => ({
      source: row.source,
      itemId: row.item_id,
      title: row.title,
      dueAt: row.due_at,
      ...(row.url ? { url: row.url } : {}),
      facetType: row.facet_type,
      capability: row.capability,
    }));
  }

  async listEvents(query: EventQuery): Promise<ItemEvent[]> {
    const rows = query.since
      ? await this.db
          .prepare(
            `SELECT * FROM events
             WHERE created_at >= ?
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .bind(query.since, query.limit)
          .all<EventRow>()
      : await this.db
          .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
          .bind(query.limit)
          .all<EventRow>();
    return rows.results.map(parseEvent);
  }

  async listRelations(type?: string): Promise<ItemRelation[]> {
    const rows = type
      ? await this.db
          .prepare("SELECT * FROM relations WHERE type = ? ORDER BY confirmed_at DESC")
          .bind(type)
          .all<RelationRow>()
      : await this.db.prepare("SELECT * FROM relations ORDER BY confirmed_at DESC").all<RelationRow>();
    return rows.results.map(parseRelation);
  }

  async linkItems(input: LinkItemsInput): Promise<ItemRelation> {
    const normalized = normalizeRelation(input);
    const [from, to] = await Promise.all([
      this.find(normalized.fromSource, normalized.fromItemId),
      this.find(normalized.toSource, normalized.toItemId),
    ]);
    if (!from || !to) {
      throw new Error("Both linked items must exist.");
    }
    const confirmedAt = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO relations (
           id, type, from_source, from_item_id, to_source, to_item_id, metadata_json, confirmed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, from_source, from_item_id, to_source, to_item_id) DO UPDATE SET
           metadata_json = excluded.metadata_json,
           confirmed_at = excluded.confirmed_at`,
      )
      .bind(
        id,
        normalized.type,
        normalized.fromSource,
        normalized.fromItemId,
        normalized.toSource,
        normalized.toItemId,
        JSON.stringify(normalized.metadata),
        confirmedAt,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT * FROM relations
         WHERE type = ? AND from_source = ? AND from_item_id = ? AND to_source = ? AND to_item_id = ?`,
      )
      .bind(
        normalized.type,
        normalized.fromSource,
        normalized.fromItemId,
        normalized.toSource,
        normalized.toItemId,
      )
      .first<RelationRow>();
    if (!row) {
      throw new Error("Relation was not persisted.");
    }
    return parseRelation(row);
  }

  listPluginManifests(): Promise<StoredPluginManifest[]> {
    return this.manifests.list();
  }

  putPluginManifest(manifest: unknown, enabled: boolean): Promise<StoredPluginManifest> {
    return this.manifests.upsert(manifest, enabled);
  }

  listAgentJobs(): Promise<AgentJob[]> {
    return this.jobs.list();
  }

  configureAgentJob(
    id: string,
    input: { enabled: boolean; model: string; monthlyTokenCap: number },
  ): Promise<AgentJob> {
    return this.jobs.configure(id, input);
  }

  listAgentJobRuns(id: string, limit: number): Promise<AgentJobRun[]> {
    return this.jobs.listRuns(id, limit);
  }
}

function parseEvent(row: EventRow): ItemEvent {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    itemId: row.item_id,
    createdAt: row.created_at,
    ...(row.primitive ? { primitive: row.primitive } : {}),
    ...(row.capability ? { capability: row.capability } : {}),
    ...(row.facet_type ? { facetType: row.facet_type } : {}),
    ...(row.field ? { field: row.field } : {}),
    ...(row.before_json ? { before: JSON.parse(row.before_json) as JsonValue } : {}),
    ...(row.after_json ? { after: JSON.parse(row.after_json) as JsonValue } : {}),
    ...(row.changed_fields_json ? { changedFields: JSON.parse(row.changed_fields_json) as string[] } : {}),
  };
}

function parseRelation(row: RelationRow): ItemRelation {
  return {
    id: row.id,
    type: row.type,
    fromSource: row.from_source,
    fromItemId: row.from_item_id,
    toSource: row.to_source,
    toItemId: row.to_item_id,
    metadata: JSON.parse(row.metadata_json) as JsonValue,
    confirmedAt: row.confirmed_at,
  };
}

function normalizeRelation(input: LinkItemsInput): LinkItemsInput {
  if (input.type !== "same-course") {
    return input;
  }
  const from = `${input.fromSource}:${input.fromItemId}`;
  const to = `${input.toSource}:${input.toItemId}`;
  if (from <= to) {
    return input;
  }
  return {
    ...input,
    fromSource: input.toSource,
    fromItemId: input.toItemId,
    toSource: input.fromSource,
    toItemId: input.fromItemId,
  };
}
