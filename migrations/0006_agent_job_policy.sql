ALTER TABLE agent_jobs
ADD COLUMN schedule_hour_utc INTEGER NOT NULL DEFAULT 0 CHECK (schedule_hour_utc BETWEEN 0 AND 23);

ALTER TABLE agent_jobs
ADD COLUMN credential_preference TEXT NOT NULL DEFAULT 'byok' CHECK (credential_preference = 'byok');
