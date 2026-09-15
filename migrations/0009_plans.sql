-- ADR-0031 plans: durable state produced by the weekly-plan and
-- decompose-assignment playbooks. One current row per (kind, subject); a
-- rerun overwrites the previous plan rather than accumulating history.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'assignment')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, subject)
);
