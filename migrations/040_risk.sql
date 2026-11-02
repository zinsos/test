CREATE UNIQUE INDEX IF NOT EXISTS sweeps_signature_uidx ON sweeps (signature) WHERE signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS sweeps_at_idx ON sweeps (at);

CREATE INDEX IF NOT EXISTS risk_events_kind_idx ON risk_events (run_id, kind, at);
