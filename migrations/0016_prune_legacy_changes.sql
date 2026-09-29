-- Drop v1 event noise that 0012 carried into `changes`: `item.updated` and
-- scalar/actor `capability.changed` rows (view/vote/star/reply counters, an
-- author swap). ADR-0036 already says those are not news, and on production
-- they were ~98% of the table, so a door `get_changes` from cursor 0 paged
-- through ~98k junk rows. Real v1 news (item.created, dueAt/answerStatus/
-- pinStatus changes) is kept under its old type names, as before.
--
-- Rebuild instead of DELETE: a DELETE writes every doomed row plus its index
-- entry (~200k row writes on production, double D1's free daily quota);
-- copying the ~1k survivors writes only those. `seq` values are copied as-is
-- and the AUTOINCREMENT high-water mark is carried over, so existing cursors
-- stay valid and no seq is ever reused.
DROP VIEW v_changes;

CREATE TABLE changes_v2 (
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

INSERT INTO changes_v2 (seq, type, source, item_id, kind, title, url, field, before_json, after_json, topic, created_at)
SELECT seq, type, source, item_id, kind, title, url, field, before_json, after_json, topic, created_at
FROM changes
WHERE NOT (
  type = 'item.updated'
  OR (type = 'capability.changed' AND field IN ('views', 'votes', 'stars', 'replies', 'actor'))
)
ORDER BY seq;

DELETE FROM sqlite_sequence WHERE name = 'changes_v2';
INSERT INTO sqlite_sequence (name, seq) SELECT 'changes_v2', seq FROM sqlite_sequence WHERE name = 'changes';

DROP TABLE changes;
ALTER TABLE changes_v2 RENAME TO changes;

CREATE INDEX changes_source_item_idx ON changes(source, item_id, seq);

-- Same definition as 0013.
CREATE VIEW v_changes AS
SELECT
  c.seq,
  c.type,
  c.created_at AS at,
  c.source,
  c.item_id,
  c.kind,
  c.title,
  c.url,
  i.course AS course,
  i.bucket AS bucket,
  c.field,
  c.before_json,
  c.after_json
FROM changes c
LEFT JOIN items i ON i.source = c.source AND i.item_id = c.item_id;
