CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

CREATE INDEX agent_messages_conversation_idx
ON agent_messages(conversation_id, id DESC);

CREATE TABLE agent_turn_results (
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, idempotency_key),
  FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

INSERT INTO agent_jobs (
  id, enabled, model, monthly_token_cap, schedule_hour_utc,
  credential_preference, last_run_at, created_at, updated_at
) VALUES (
  'resident-agent', 0, 'gpt-5-mini', 200000, 0,
  'byok', NULL, datetime('now'), datetime('now')
);
