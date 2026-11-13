CREATE TABLE IF NOT EXISTS recorder_checkpoints (
  instance TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  first_slot BIGINT,
  first_event_at TIMESTAMPTZ,
  last_slot BIGINT,
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS recorder_checkpoints_updated_idx ON recorder_checkpoints (updated_at);

ALTER TABLE launches ADD COLUMN IF NOT EXISTS data_incomplete_at TIMESTAMPTZ;

UPDATE launches l
   SET data_incomplete_at = COALESCE(
         (SELECT min(GREATEST(g.started_at, l.created_at))
            FROM ingest_gaps g
           WHERE g.ended_at >= l.created_at
             AND (l.tracking_ended_at IS NULL OR g.started_at <= l.tracking_ended_at)),
         l.created_at)
 WHERE NOT l.data_complete AND l.data_incomplete_at IS NULL;
