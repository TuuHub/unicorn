-- Source credentials pasted into /settings (ADR-0038 onboarding-by-source), stored
-- as application state in this Worker's own D1 rather than a Worker Secret — the
-- Worker cannot mutate its own Secrets (ADR-0022), and /settings needs a live path
-- for a student who cannot run `wrangler secret put` themselves. Values are AES-GCM
-- encrypted with a key derived from ADMIN_TOKEN (see src/sources.ts); this table
-- never holds plaintext.
CREATE TABLE source_credentials (
  source_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
