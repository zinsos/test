CREATE INDEX IF NOT EXISTS wallet_rank_runs_as_of_idx ON wallet_rank_runs (as_of DESC, id DESC);

CREATE INDEX IF NOT EXISTS wallet_ranks_wallet_idx ON wallet_ranks (wallet, run_id);

CREATE INDEX IF NOT EXISTS launch_scores_insiders_gin_idx ON launch_scores USING gin (insiders);

CREATE INDEX IF NOT EXISTS wallet_history_trades_time_idx ON wallet_history_trades (block_time);

ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS exhausted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE wallet_backfill_state ADD COLUMN IF NOT EXISTS trades_found INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wallet_history_trades ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT now();
