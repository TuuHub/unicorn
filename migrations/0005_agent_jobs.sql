CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  model TEXT NOT NULL,
  monthly_token_cap INTEGER NOT NULL CHECK (monthly_token_cap > 0),
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX agent_job_runs_job_time_idx ON agent_job_runs(job_id, created_at DESC);

INSERT INTO agent_jobs (
  id, enabled, model, monthly_token_cap, last_run_at, created_at, updated_at
) VALUES (
  'daily-digest', 0, 'gpt-5-mini', 100000, NULL, datetime('now'), datetime('now')
);
