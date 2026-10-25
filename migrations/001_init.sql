CREATE TABLE IF NOT EXISTS launches (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL UNIQUE,
  bonding_curve TEXT NOT NULL,
  dev_wallet TEXT NOT NULL,
  creator TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL DEFAULT '',
  quote_mint TEXT NOT NULL DEFAULT 'SOL',
  token_program TEXT,
  is_mayhem BOOLEAN NOT NULL DEFAULT FALSE,
  is_cashback BOOLEAN NOT NULL DEFAULT FALSE,
  is_holder_reward BOOLEAN NOT NULL DEFAULT FALSE,
  creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  depth SMALLINT NOT NULL DEFAULT 0,
  create_signature TEXT NOT NULL,
  create_slot BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_total_supply BIGINT NOT NULL,
  initial_virtual_token BIGINT NOT NULL,
  initial_virtual_quote BIGINT NOT NULL,
  initial_real_token BIGINT NOT NULL,
  data_complete BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  has_twitter BOOLEAN,
  has_telegram BOOLEAN,
  has_website BOOLEAN,
  metadata_fetched_at TIMESTAMPTZ,
  trade_count INTEGER NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  unique_traders INTEGER NOT NULL DEFAULT 0,
  last_trade_at TIMESTAMPTZ,
  last_trade_slot BIGINT,
  last_virtual_token BIGINT,
  last_virtual_quote BIGINT,
  last_real_token BIGINT,
  last_real_quote BIGINT,
  peak_mcap_quote BIGINT,
  peak_at TIMESTAMPTZ,
  peak_slot BIGINT,
  completed_at TIMESTAMPTZ,
  completed_slot BIGINT,
  migrated_at TIMESTAMPTZ,
  migrated_slot BIGINT,
  pool TEXT,
  tracking_ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS launches_created_at_idx ON launches (created_at);
CREATE INDEX IF NOT EXISTS launches_dev_wallet_idx ON launches (dev_wallet, created_at);
CREATE INDEX IF NOT EXISTS launches_pool_idx ON launches (pool) WHERE pool IS NOT NULL;
CREATE INDEX IF NOT EXISTS launches_symbol_idx ON launches (upper(symbol));
CREATE INDEX IF NOT EXISTS launches_tracking_idx ON launches (tracking_ended_at) WHERE tracking_ended_at IS NULL;

CREATE TABLE IF NOT EXISTS trades (
  launch_id BIGINT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  slot BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  signature TEXT NOT NULL,
  event_index SMALLINT NOT NULL,
  venue SMALLINT NOT NULL,
  wallet TEXT NOT NULL,
  is_buy BOOLEAN NOT NULL,
  token_amount BIGINT NOT NULL,
  quote_amount BIGINT NOT NULL,
  user_quote BIGINT NOT NULL,
  protocol_fee BIGINT NOT NULL DEFAULT 0,
  creator_fee BIGINT NOT NULL DEFAULT 0,
  lp_fee BIGINT NOT NULL DEFAULT 0,
  protocol_fee_bps INTEGER NOT NULL DEFAULT 0,
  creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  lp_fee_bps INTEGER NOT NULL DEFAULT 0,
  virtual_token BIGINT NOT NULL,
  virtual_quote BIGINT NOT NULL,
  real_token BIGINT,
  real_quote BIGINT,
  ix_name TEXT,
  PRIMARY KEY (block_time, signature, event_index)
) PARTITION BY RANGE (block_time);

CREATE TABLE IF NOT EXISTS trades_default PARTITION OF trades DEFAULT;

CREATE INDEX IF NOT EXISTS trades_launch_idx ON trades (launch_id, slot, seq, event_index);
CREATE INDEX IF NOT EXISTS trades_wallet_idx ON trades (wallet, block_time);

CREATE TABLE IF NOT EXISTS ingest_gaps (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  from_slot BIGINT,
  to_slot BIGINT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ingest_gaps_time_idx ON ingest_gaps (started_at, ended_at);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  launch_id BIGINT NOT NULL REFERENCES launches (id) ON DELETE CASCADE,
  checkpoint_sec INTEGER NOT NULL,
  source TEXT NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL,
  slot BIGINT,
  holder_count INTEGER NOT NULL,
  top10_share DOUBLE PRECISION,
  dev_share DOUBLE PRECISION,
  curve_share DOUBLE PRECISION,
  mcap_quote BIGINT,
  holders JSONB NOT NULL,
  PRIMARY KEY (launch_id, checkpoint_sec, source)
);

CREATE TABLE IF NOT EXISTS launch_outcomes (
  launch_id BIGINT PRIMARY KEY REFERENCES launches (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  migrated BOOLEAN NOT NULL DEFAULT FALSE,
  rugged BOOLEAN NOT NULL DEFAULT FALSE,
  died BOOLEAN NOT NULL DEFAULT FALSE,
  survived_15m BOOLEAN,
  initial_mcap_quote BIGINT,
  mcap_30s BIGINT,
  mcap_1m BIGINT,
  mcap_5m BIGINT,
  mcap_15m BIGINT,
  mcap_1h BIGINT,
  peak_mcap_quote BIGINT,
  peak_at TIMESTAMPTZ,
  time_to_peak_sec DOUBLE PRECISION,
  final_mcap_quote BIGINT,
  max_drawdown_from_peak DOUBLE PRECISION,
  peak_multiple_from_1m DOUBLE PRECISION,
  return_15m_from_1m DOUBLE PRECISION,
  dev_sold_at TIMESTAMPTZ,
  dev_sold_fraction DOUBLE PRECISION,
  rug_at TIMESTAMPTZ,
  last_trade_at TIMESTAMPTZ,
  trade_count INTEGER,
  unique_traders INTEGER,
  total_volume_quote BIGINT,
  outcome_known_at TIMESTAMPTZ,
  finalized BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB
);

CREATE INDEX IF NOT EXISTS launch_outcomes_known_idx ON launch_outcomes (outcome_known_at);

CREATE TABLE IF NOT EXISTS wallet_intel (
  wallet TEXT PRIMARY KEY,
  funder TEXT,
  funding_signature TEXT,
  funding_slot BIGINT,
  funded_at TIMESTAMPTZ,
  funding_amount BIGINT,
  prior_tx_count INTEGER,
  prior_tx_capped BOOLEAN NOT NULL DEFAULT FALSE,
  oldest_seen_at TIMESTAMPTZ,
  checked_before_signature TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_hub BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT
);

CREATE INDEX IF NOT EXISTS wallet_intel_funder_idx ON wallet_intel (funder);

CREATE TABLE IF NOT EXISTS known_entities (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scorer_weights (
  version TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  label_name TEXT,
  weights JSONB NOT NULL,
  metrics JSONB,
  active BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS launch_scores (
  launch_id BIGINT NOT NULL REFERENCES launches (id) ON DELETE CASCADE,
  checkpoint_sec INTEGER NOT NULL,
  mint TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  slot BIGINT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  hard_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  flags TEXT[] NOT NULL DEFAULT '{}',
  features JSONB NOT NULL,
  contributions JSONB NOT NULL,
  weights_version TEXT NOT NULL,
  PRIMARY KEY (launch_id, checkpoint_sec)
);

CREATE INDEX IF NOT EXISTS launch_scores_mint_idx ON launch_scores (mint);
CREATE INDEX IF NOT EXISTS launch_scores_time_idx ON launch_scores (computed_at);

CREATE TABLE IF NOT EXISTS wallet_history_trades (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_index SMALLINT NOT NULL,
  slot BIGINT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  venue SMALLINT NOT NULL,
  is_buy BOOLEAN NOT NULL,
  token_amount BIGINT NOT NULL,
  quote_amount BIGINT NOT NULL,
  user_quote BIGINT NOT NULL,
  quote_mint TEXT NOT NULL DEFAULT 'SOL',
  PRIMARY KEY (signature, event_index)
);

CREATE INDEX IF NOT EXISTS wallet_history_wallet_idx ON wallet_history_trades (wallet, block_time);

CREATE TABLE IF NOT EXISTS wallet_backfill_state (
  wallet TEXT PRIMARY KEY,
  oldest_signature TEXT,
  newest_signature TEXT,
  covered_from TIMESTAMPTZ,
  covered_to TIMESTAMPTZ,
  tx_scanned INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_rank_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  as_of TIMESTAMPTZ NOT NULL,
  params JSONB NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0,
  tracked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wallet_ranks (
  run_id BIGINT NOT NULL REFERENCES wallet_rank_runs (id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  rank INTEGER,
  score DOUBLE PRECISION NOT NULL,
  tracked BOOLEAN NOT NULL DEFAULT FALSE,
  excluded BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_reason TEXT,
  pnl_30d DOUBLE PRECISION,
  pnl_90d DOUBLE PRECISION,
  trades_30d INTEGER,
  trades_90d INTEGER,
  win_rate_30d DOUBLE PRECISION,
  win_rate_90d DOUBLE PRECISION,
  median_win DOUBLE PRECISION,
  median_loss DOUBLE PRECISION,
  median_hold_sec DOUBLE PRECISION,
  median_entry_delay_sec DOUBLE PRECISION,
  stats JSONB,
  PRIMARY KEY (run_id, wallet)
);

CREATE INDEX IF NOT EXISTS wallet_ranks_tracked_idx ON wallet_ranks (run_id) WHERE tracked;

CREATE TABLE IF NOT EXISTS strategy_runs (
  id BIGSERIAL PRIMARY KEY,
  mode TEXT NOT NULL,
  label TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  data_from TIMESTAMPTZ,
  data_to TIMESTAMPTZ,
  config JSONB NOT NULL,
  summary JSONB
);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES strategy_runs (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  mint TEXT NOT NULL,
  launch_id BIGINT,
  at TIMESTAMPTZ NOT NULL,
  slot BIGINT NOT NULL,
  risk_score DOUBLE PRECISION,
  wallets TEXT[] NOT NULL DEFAULT '{}',
  meta JSONB NOT NULL DEFAULT '{}',
  acted BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS signals_run_idx ON signals (run_id, at);
CREATE INDEX IF NOT EXISTS signals_mint_idx ON signals (mint);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES strategy_runs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  launch_id BIGINT,
  signal_id BIGINT,
  signal_type TEXT NOT NULL,
  risk_score DOUBLE PRECISION,
  opened_at TIMESTAMPTZ NOT NULL,
  opened_slot BIGINT NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  entry_tokens BIGINT NOT NULL,
  entry_cost BIGINT NOT NULL,
  tokens_held BIGINT NOT NULL,
  proceeds BIGINT NOT NULL DEFAULT 0,
  fees_paid BIGINT NOT NULL DEFAULT 0,
  peak_price DOUBLE PRECISION NOT NULL,
  last_price DOUBLE PRECISION NOT NULL,
  take_profit_levels_hit INTEGER NOT NULL DEFAULT 0,
  migrated_seen BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  closed_at TIMESTAMPTZ,
  exit_reason TEXT,
  realized_pnl BIGINT,
  hold_sec DOUBLE PRECISION,
  peak_multiple DOUBLE PRECISION,
  shadow_of TEXT,
  meta JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS positions_run_idx ON positions (run_id, opened_at);
CREATE INDEX IF NOT EXISTS positions_status_idx ON positions (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS positions_shadow_idx ON positions (shadow_of) WHERE shadow_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS fills (
  id BIGSERIAL PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL,
  side TEXT NOT NULL,
  reason TEXT NOT NULL,
  urgency TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  venue TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  requested_slot BIGINT NOT NULL,
  filled_at TIMESTAMPTZ,
  filled_slot BIGINT,
  token_amount BIGINT NOT NULL,
  quote_amount BIGINT NOT NULL,
  user_quote BIGINT NOT NULL,
  protocol_fee BIGINT NOT NULL,
  creator_fee BIGINT NOT NULL,
  lp_fee BIGINT NOT NULL,
  extra_platform_fee BIGINT NOT NULL,
  network_fees BIGINT NOT NULL,
  tips BIGINT NOT NULL,
  rent_paid BIGINT NOT NULL,
  rent_refunded BIGINT NOT NULL,
  reference_price DOUBLE PRECISION NOT NULL,
  fill_price DOUBLE PRECISION,
  slippage_bps DOUBLE PRECISION,
  price_impact_bps DOUBLE PRECISION,
  attempts JSONB NOT NULL,
  signature TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS fills_position_idx ON fills (position_id);

CREATE TABLE IF NOT EXISTS risk_state (
  run_id BIGINT PRIMARY KEY REFERENCES strategy_runs (id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  starting_bankroll BIGINT NOT NULL,
  realized_pnl BIGINT NOT NULL DEFAULT 0,
  peak_equity BIGINT NOT NULL,
  day_key TEXT NOT NULL,
  day_start_equity BIGINT NOT NULL,
  halted_until TIMESTAMPTZ,
  killed BOOLEAN NOT NULL DEFAULT FALSE,
  kill_reason TEXT,
  state JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS risk_events (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS risk_events_run_idx ON risk_events (run_id, at);

CREATE TABLE IF NOT EXISTS sweeps (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_wallet TEXT NOT NULL,
  to_wallet TEXT NOT NULL,
  lamports BIGINT NOT NULL,
  hot_balance_before BIGINT NOT NULL,
  signature TEXT,
  status TEXT NOT NULL,
  error TEXT
);
