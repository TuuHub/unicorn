-- Re-create the FTS update trigger so it only reindexes when title or body
-- actually change. 0012 was edited to add `OF title, body` after production
-- had applied it, so production still reindexed on every UPDATE of any column
-- (labels, raw_json, ...). `OF` alone is not enough either: it fires whenever
-- the column is in the SET list, and the item upsert always sets both — hence
-- the WHEN guard. Dropping and re-creating converges every database.
DROP TRIGGER IF EXISTS items_fts_update;

CREATE TRIGGER items_fts_update AFTER UPDATE OF title, body ON items
WHEN old.title IS NOT new.title OR old.body IS NOT new.body
BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
