CREATE TABLE items (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  url TEXT,
  body TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (source, item_id)
);

CREATE TABLE facets (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  PRIMARY KEY (source, item_id, type),
  FOREIGN KEY (source, item_id) REFERENCES items(source, item_id) ON DELETE CASCADE
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  primitive TEXT,
  capability TEXT,
  facet_type TEXT,
  field TEXT,
  before_json TEXT,
  after_json TEXT,
  changed_fields_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source, item_id) REFERENCES items(source, item_id) ON DELETE CASCADE
);

CREATE INDEX items_timestamp_idx ON items(timestamp);
CREATE INDEX items_active_source_idx ON items(source, archived_at);
CREATE INDEX events_created_at_idx ON events(created_at DESC);
CREATE INDEX events_item_idx ON events(source, item_id, created_at DESC);
