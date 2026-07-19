-- ADR-0025 notification outbox: every outbound message is enqueued and delivered
-- with an idempotency key and bounded retry, so a retried cycle never double-sends.
CREATE TABLE notifications_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX notifications_outbox_pending_idx ON notifications_outbox(status, next_attempt_at);

-- ADR-0024 agent memory: one markdown notes document per domain, read in full on
-- every reasoning call and rewritten after triage. Facts stay in the typed tables;
-- this holds judgment only.
CREATE TABLE agent_notes (
  domain TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ADR-0023 resident triage: the one v1 agent job that watches facet events, keeps
-- deterministic reflexes, and speaks only when something matters.
INSERT INTO agent_jobs (
  id, enabled, model, monthly_token_cap, schedule_hour_utc, credential_preference, last_run_at, created_at, updated_at
) VALUES (
  'triage', 0, 'gpt-5-mini', 200000, 0, 'byok', NULL, datetime('now'), datetime('now')
);
