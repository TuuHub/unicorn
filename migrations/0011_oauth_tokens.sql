-- OAuth tokens for declarative-plugin MCP transports (ADR-0033). One row per plugin
-- id; the refresh token is application state in this Worker's own D1, not a Worker
-- Secret (ADR-0022 still holds: the Worker never mutates its own Secrets).
CREATE TABLE oauth_tokens (
  plugin_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at TEXT,
  scope TEXT,
  updated_at TEXT NOT NULL
);
