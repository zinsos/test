CREATE INDEX IF NOT EXISTS positions_run_closed_idx ON positions (run_id, closed_at DESC, id DESC) WHERE status = 'closed';
