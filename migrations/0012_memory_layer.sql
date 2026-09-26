-- ADR-0034 (brain removed) + ADR-0036 (change model and buckets, events v2,
-- course-aware structural labelling, FTS5 search).

-- --- ADR-0034: drop the brain's tables -------------------------------------
-- agent_notes (0007) is kept: `remember` still stores verbatim corrections.
DROP TABLE IF EXISTS agent_turn_results;
DROP TABLE IF EXISTS agent_messages;
DROP TABLE IF EXISTS agent_conversations;
DROP TABLE IF EXISTS notifications_outbox;
DROP TABLE IF EXISTS agent_job_runs;
DROP TABLE IF EXISTS agent_jobs;

-- --- ADR-0036: buckets and structural labels on items ----------------------
ALTER TABLE items ADD COLUMN course TEXT;
ALTER TABLE items ADD COLUMN bucket TEXT;
ALTER TABLE items ADD COLUMN topic TEXT;
ALTER TABLE items ADD COLUMN labeled_by TEXT CHECK (labeled_by IN ('structure', 'triage', 'client'));

CREATE INDEX items_course_idx ON items(course);
CREATE INDEX items_bucket_idx ON items(bucket);

-- --- ADR-0036: events v2 ----------------------------------------------------
-- No FK to items: changes are never pruned and must survive anything
-- (including the item they described being archived or deleted).
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  field TEXT,
  before_json TEXT,
  after_json TEXT,
  topic TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX changes_source_item_idx ON changes(source, item_id, seq);

-- Existing event rows are kept under their old v1 type names (item.created,
-- item.updated, capability.changed) — ADR-0036 does not retype history.
-- kind/title/url are filled from the item when it still exists; an event for
-- an item that was later hard-deleted (should not normally happen, since
-- items are archived, not deleted) falls back to empty strings / NULL rather
-- than being dropped, because changes must survive anything.
INSERT INTO changes (type, source, item_id, kind, title, url, field, before_json, after_json, topic, created_at)
SELECT
  e.type,
  e.source,
  e.item_id,
  COALESCE(i.kind, ''),
  COALESCE(i.title, ''),
  i.url,
  e.field,
  e.before_json,
  e.after_json,
  NULL,
  e.created_at
FROM events e
LEFT JOIN items i ON i.source = e.source AND i.item_id = e.item_id
ORDER BY e.created_at, e.id;

DROP TABLE events;

-- --- ADR-0036: FTS5 over item title and body --------------------------------
CREATE VIRTUAL TABLE items_fts USING fts5(
  title,
  body,
  content='items',
  content_rowid='rowid'
);

INSERT INTO items_fts(rowid, title, body)
SELECT rowid, title, body FROM items;

CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

-- Only title/body feed the index; labelling and sync bookkeeping update items
-- every cycle and must not churn FTS.
CREATE TRIGGER items_fts_update AFTER UPDATE OF title, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Backfill/rebuild so the external-content index matches the table exactly
-- (the INSERT above already seeded it; 'rebuild' is idempotent and cheap at
-- single-user scale, and is the documented way to (re)populate an
-- external-content FTS5 table).
INSERT INTO items_fts(items_fts) VALUES('rebuild');

-- --- ADR-0035: briefs without the fixed `kind` CHECK ------------------------
-- Routines will write their own brief kinds via write_brief later; rebuild
-- the table to drop the closed CHECK while preserving rows and the unread
-- index (SQLite has no ALTER TABLE DROP CONSTRAINT).
CREATE TABLE briefs_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

INSERT INTO briefs_v2 (id, kind, subject, title, body, created_at, read_at)
SELECT id, kind, subject, title, body, created_at, read_at FROM briefs;

DROP TABLE briefs;
ALTER TABLE briefs_v2 RENAME TO briefs;

CREATE INDEX briefs_unread_idx ON briefs(read_at, created_at DESC);
