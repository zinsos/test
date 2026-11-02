ALTER TABLE launches ADD COLUMN IF NOT EXISTS metadata_error TEXT;

ALTER TABLE ingest_gaps ADD COLUMN IF NOT EXISTS affected_launches INTEGER;

CREATE INDEX IF NOT EXISTS launches_tracked_created_idx ON launches (created_at) WHERE tracking_ended_at IS NULL;
