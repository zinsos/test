ALTER TABLE lab_runs ADD COLUMN IF NOT EXISTS baseline_hash TEXT;

ALTER TABLE lab_runs ADD COLUMN IF NOT EXISTS engine_version TEXT;

ALTER TABLE lab_runs ADD COLUMN IF NOT EXISTS learner JSONB;

ALTER TABLE lab_variants ADD COLUMN IF NOT EXISTS trades JSONB;

CREATE INDEX IF NOT EXISTS lab_runs_done_window_idx ON lab_runs (data_to DESC, id DESC) WHERE status = 'done';

CREATE TABLE IF NOT EXISTS promotions (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('variant', 'revert')),
  name TEXT NOT NULL,
  overrides JSONB NOT NULL DEFAULT '{}',
  overrides_hash TEXT NOT NULL,
  baseline_hash TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('confirming', 'pending', 'applied', 'rejected', 'superseded', 'reverted')),
  note TEXT,
  lab_run_id BIGINT REFERENCES lab_runs (id) ON DELETE SET NULL,
  confirm_from TIMESTAMPTZ,
  confirm_windows INT,
  confirm_index INT,
  target_id BIGINT REFERENCES promotions (id),
  root_hash TEXT,
  previous_overlay JSONB,
  overlay JSONB,
  applied_hash TEXT,
  undo JSONB,
  probation_result TEXT CHECK (probation_result IN ('kept', 'reverted')),
  apply_attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  CHECK ((status IN ('applied', 'reverted')) = (applied_at IS NOT NULL)),
  CHECK (status NOT IN ('applied', 'reverted') OR (root_hash IS NOT NULL AND overlay IS NOT NULL AND applied_hash IS NOT NULL)),
  CHECK (kind <> 'revert' OR target_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS promotions_one_open_idx ON promotions ((status IN ('confirming', 'pending'))) WHERE status IN ('confirming', 'pending');

CREATE INDEX IF NOT EXISTS promotions_recent_idx ON promotions (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS promotions_content_idx ON promotions (baseline_hash, kind, name, overrides_hash);

CREATE INDEX IF NOT EXISTS promotions_events_idx ON promotions (root_hash, applied_at DESC, id DESC) WHERE status IN ('applied', 'reverted');
