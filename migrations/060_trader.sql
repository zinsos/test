ALTER TABLE fills ADD COLUMN IF NOT EXISTS fill_seq INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS fills_position_seq_uidx ON fills (position_id, fill_seq) WHERE fill_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS positions_mode_closed_idx ON positions (mode, closed_at) WHERE status = 'closed';

CREATE INDEX IF NOT EXISTS positions_run_status_idx ON positions (run_id, status);

CREATE INDEX IF NOT EXISTS strategy_runs_open_idx ON strategy_runs (mode, id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS signals_at_idx ON signals (at);
