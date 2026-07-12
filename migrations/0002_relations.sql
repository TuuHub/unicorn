CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_source TEXT NOT NULL,
  from_item_id TEXT NOT NULL,
  to_source TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (type, from_source, from_item_id, to_source, to_item_id),
  FOREIGN KEY (from_source, from_item_id) REFERENCES items(source, item_id) ON DELETE CASCADE,
  FOREIGN KEY (to_source, to_item_id) REFERENCES items(source, item_id) ON DELETE CASCADE
);

CREATE INDEX relations_type_idx ON relations(type, confirmed_at DESC);
