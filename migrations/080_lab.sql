CREATE TABLE IF NOT EXISTS lab_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  error TEXT,
  data_from TIMESTAMPTZ,
  data_to TIMESTAMPTZ,
  scorer JSONB NOT NULL DEFAULT '[]',
  notes JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS lab_runs_started_idx ON lab_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS lab_variants (
  id BIGSERIAL PRIMARY KEY,
  lab_run_id BIGINT NOT NULL REFERENCES lab_runs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
  overrides JSONB NOT NULL,
  strategy_run_id BIGINT REFERENCES strategy_runs (id) ON DELETE SET NULL,
  summary JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS lab_variants_run_idx ON lab_variants (lab_run_id, id);

CREATE INDEX IF NOT EXISTS lab_variants_strategy_run_idx ON lab_variants (strategy_run_id) WHERE strategy_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS strategy_runs_lab_idx ON strategy_runs (id) WHERE label LIKE 'lab:%';
