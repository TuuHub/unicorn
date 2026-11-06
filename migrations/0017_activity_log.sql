-- ADR-0048: a transparent activity log. Every door tool call (who called it, from which client,
-- with which arguments, how long it took, whether it failed) and every per-source sync is a row,
-- shown in the panel's Activity page. Not reachable from user-defined SQL tools, which only see
-- the v_* views (ADR-0035/0042). Rows older than 30 days are pruned each cycle.
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'tool' | 'sync' | 'memory' | 'system'
  name TEXT NOT NULL,          -- tool name, source plugin id, or memory target
  status TEXT NOT NULL,        -- 'ok' | 'error'
  error_code TEXT,
  duration_ms INTEGER,
  actor TEXT,                  -- client app name when known (e.g. "Claude", "ChatGPT")
  via TEXT,                    -- 'oauth' | 'mcp_token' | 'scheduler' | 'panel' | 'settings'
  detail_json TEXT
);

CREATE INDEX activity_log_at ON activity_log (at);
CREATE INDEX activity_log_kind ON activity_log (kind, id);
