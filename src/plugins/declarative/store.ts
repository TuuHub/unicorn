import { parsePluginManifest, type PluginManifest } from "./plugin";

interface ManifestRow {
  id: string;
  name: string;
  enabled: number;
  manifest_json: string;
  created_at: string;
  updated_at: string;
}

export interface StoredPluginManifest {
  id: string;
  name: string;
  enabled: boolean;
  manifest: PluginManifest;
  createdAt: string;
  updatedAt: string;
}

export class D1ManifestStore {
  constructor(private readonly db: D1Database) {}

  async list(enabledOnly = false): Promise<StoredPluginManifest[]> {
    const rows = enabledOnly
      ? await this.db
          .prepare("SELECT * FROM plugin_manifests WHERE enabled = 1 ORDER BY id")
          .all<ManifestRow>()
      : await this.db.prepare("SELECT * FROM plugin_manifests ORDER BY id").all<ManifestRow>();
    return rows.results.map(parseRow);
  }

  async upsert(value: unknown, enabled = true): Promise<StoredPluginManifest> {
    const manifest = parsePluginManifest(value);
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO plugin_manifests (id, name, enabled, manifest_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           enabled = excluded.enabled,
           manifest_json = excluded.manifest_json,
           updated_at = excluded.updated_at`,
      )
      .bind(manifest.id, manifest.name, enabled ? 1 : 0, JSON.stringify(manifest), now, now)
      .run();
    const row = await this.db
      .prepare("SELECT * FROM plugin_manifests WHERE id = ?")
      .bind(manifest.id)
      .first<ManifestRow>();
    if (!row) {
      throw new Error("Plugin manifest was not persisted.");
    }
    return parseRow(row);
  }
}

function parseRow(row: ManifestRow): StoredPluginManifest {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    manifest: parsePluginManifest(JSON.parse(row.manifest_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
