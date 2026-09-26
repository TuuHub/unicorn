-- ADR-0035: user-defined SQL tools + the five read views they (and
-- describe_schema) are allowed to see. Defined over the 0012 schema
-- (items/facets/changes with course/bucket/labeled_by, events v2).

CREATE TABLE user_tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  sql TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- --- v_items ----------------------------------------------------------
-- Active items with the three capability-derived columns a student's SQL
-- actually wants: due_at (the temporal deadline, if any), state (the first
-- state-primitive value — submission/answer/etc. status), staff (true when
-- an `author` facet carries a teaching-staff role). Mirrors the same
-- json_each-over-capabilities_json pattern as listUpcoming in
-- src/mcp/d1-repository.ts and the role check in src/kernel/staff-roles.ts.
CREATE VIEW v_items AS
SELECT
  i.source,
  i.item_id,
  i.kind,
  i.title,
  i.url,
  i.timestamp,
  i.body,
  i.course,
  i.bucket,
  i.topic,
  i.labeled_by,
  (
    SELECT json_extract(f.data_json, '$.' || json_extract(b.value, '$.field'))
    FROM facets f, json_each(f.capabilities_json) b
    WHERE f.source = i.source AND f.item_id = i.item_id
      AND json_extract(b.value, '$.primitive') = 'temporal'
    LIMIT 1
  ) AS due_at,
  (
    SELECT json_extract(f.data_json, '$.' || json_extract(b.value, '$.field'))
    FROM facets f, json_each(f.capabilities_json) b
    WHERE f.source = i.source AND f.item_id = i.item_id
      AND json_extract(b.value, '$.primitive') = 'state'
    LIMIT 1
  ) AS state,
  EXISTS (
    SELECT 1 FROM facets a
    WHERE a.source = i.source AND a.item_id = i.item_id AND a.type = 'author'
      AND lower(json_extract(a.data_json, '$.authorRole')) IN ('admin', 'tutor', 'staff', 'instructor', 'teacher', 'ta')
  ) AS staff
FROM items i
WHERE i.archived_at IS NULL;

-- --- v_upcoming ---------------------------------------------------------
-- v_items with a deadline in the window a student actually asks about:
-- from a week ago (still worth seeing as "recently missed") to whenever.
CREATE VIEW v_upcoming AS
SELECT * FROM v_items
WHERE due_at IS NOT NULL AND due_at >= datetime('now', '-7 days');

-- --- v_changes ----------------------------------------------------------
-- changes (never pruned, ADR-0036) joined to the item's *current* course
-- and bucket — the item may have been relabelled, or archived, since the
-- change was recorded, and this view always reflects "now", not "then".
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

-- --- v_courses ------------------------------------------------------------
CREATE VIEW v_courses AS
SELECT
  json_extract(f.data_json, '$.code') AS code,
  json_extract(f.data_json, '$.term') AS term,
  i.title AS title,
  i.source AS source,
  i.item_id AS item_id
FROM items i
JOIN facets f ON f.source = i.source AND f.item_id = i.item_id AND f.type = 'course-identity'
WHERE i.archived_at IS NULL;

-- --- v_buckets ------------------------------------------------------------
CREATE VIEW v_buckets AS
SELECT
  bucket,
  course,
  COUNT(*) AS item_count,
  MIN(due_at) AS next_due
FROM v_items
WHERE bucket IS NOT NULL
GROUP BY bucket, course;
