-- ADR-0031 briefs: durable output of scheduled playbooks (weekly plan, assignment
-- decomposition, forum summary) and the daily digest. get_briefs/ack_briefs (ADR-0030)
-- make this the one inbox a client agent pulls from.
CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('weekly-plan', 'assignment-plan', 'forum-brief', 'digest')),
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX briefs_unread_idx ON briefs(read_at, created_at DESC);
