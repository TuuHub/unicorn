import type { CapabilityBinding, Facet, ItemEvent, ItemStore, JsonValue, StoredItem } from "./types";

interface ItemRow {
  source: string;
  item_id: string;
  kind: string;
  title: string;
  timestamp: string;
  url: string | null;
  body: string | null;
  raw_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface FacetRow {
  type: string;
  data_json: string;
  capabilities_json: string;
}

interface BulkFacetRow extends FacetRow {
  source: string;
  item_id: string;
}

export interface ItemKey {
  source: string;
  itemId: string;
}

export class D1ItemStore implements ItemStore {
  constructor(private readonly db: D1Database) {}

  async find(source: string, itemId: string): Promise<StoredItem | null> {
    const row = await this.db
      .prepare(
        `SELECT source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at, archived_at
         FROM items
         WHERE source = ? AND item_id = ?`,
      )
      .bind(source, itemId)
      .first<ItemRow>();
    if (!row) {
      return null;
    }

    const facets = await this.db
      .prepare(
        `SELECT type, data_json, capabilities_json
         FROM facets
         WHERE source = ? AND item_id = ?
         ORDER BY type`,
      )
      .bind(source, itemId)
      .all<FacetRow>();

    return parseItem(row, facets.results);
  }

  async findMany(keys: ItemKey[]): Promise<StoredItem[]> {
    if (keys.length === 0) {
      return [];
    }
    const requested = JSON.stringify(keys);
    const [itemRows, facetRows] = await Promise.all([
      this.db
        .prepare(
          `WITH requested AS (
             SELECT
               CAST(key AS INTEGER) AS position,
               json_extract(value, '$.source') AS source,
               json_extract(value, '$.itemId') AS item_id
             FROM json_each(?)
           )
           SELECT i.*
           FROM requested r
           JOIN items i ON i.source = r.source AND i.item_id = r.item_id
           ORDER BY r.position`,
        )
        .bind(requested)
        .all<ItemRow>(),
      this.db
        .prepare(
          `WITH requested AS (
             SELECT
               CAST(key AS INTEGER) AS position,
               json_extract(value, '$.source') AS source,
               json_extract(value, '$.itemId') AS item_id
             FROM json_each(?)
           )
           SELECT f.source, f.item_id, f.type, f.data_json, f.capabilities_json
           FROM requested r
           JOIN facets f ON f.source = r.source AND f.item_id = r.item_id
           ORDER BY r.position, f.type`,
        )
        .bind(requested)
        .all<BulkFacetRow>(),
    ]);
    const facetsByItem = new Map<string, FacetRow[]>();
    for (const row of facetRows.results) {
      const key = `${row.source}\u0000${row.item_id}`;
      const facets = facetsByItem.get(key) ?? [];
      facets.push(row);
      facetsByItem.set(key, facets);
    }
    return itemRows.results.map((row) => parseItem(row, facetsByItem.get(`${row.source}\u0000${row.item_id}`) ?? []));
  }

  async commit(item: StoredItem, events: ItemEvent[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO items (
             source, item_id, kind, title, timestamp, url, body, raw_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source, item_id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             timestamp = excluded.timestamp,
             url = excluded.url,
             body = excluded.body,
             raw_json = excluded.raw_json,
             updated_at = excluded.updated_at,
             archived_at = NULL`,
        )
        .bind(
          item.source,
          item.id,
          item.kind,
          item.title,
          item.timestamp,
          item.url ?? null,
          item.body ?? null,
          JSON.stringify(item.raw ?? null),
          item.createdAt,
          item.updatedAt,
        ),
      this.db.prepare("DELETE FROM facets WHERE source = ? AND item_id = ?").bind(item.source, item.id),
    ];

    for (const facet of item.facets) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO facets (source, item_id, type, data_json, capabilities_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            item.source,
            item.id,
            facet.type,
            JSON.stringify(facet.data),
            JSON.stringify(facet.capabilities),
          ),
      );
    }

    for (const event of events) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO events (
               id, type, source, item_id, primitive, capability, facet_type, field,
               before_json, after_json, changed_fields_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.type,
            event.source,
            event.itemId,
            event.primitive ?? null,
            event.capability ?? null,
            event.facetType ?? null,
            event.field ?? null,
            event.before === undefined ? null : JSON.stringify(event.before),
            event.after === undefined ? null : JSON.stringify(event.after),
            event.changedFields ? JSON.stringify(event.changedFields) : null,
            event.createdAt,
          ),
      );
    }

    await this.db.batch(statements);
  }
}

function parseItem(row: ItemRow, facets: FacetRow[]): StoredItem {
  return {
    id: row.item_id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    timestamp: row.timestamp,
    ...(row.url ? { url: row.url } : {}),
    ...(row.body ? { body: row.body } : {}),
    raw: parseJson<JsonValue>(row.raw_json),
    facets: facets.map(parseFacet),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

function parseFacet(row: FacetRow): Facet {
  return {
    type: row.type,
    data: parseJson<Record<string, JsonValue>>(row.data_json),
    capabilities: parseJson<CapabilityBinding[]>(row.capabilities_json),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
