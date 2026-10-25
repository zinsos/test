CREATE INDEX IF NOT EXISTS launches_creator_idx ON launches (creator, created_at);

ALTER TABLE launch_scores ADD COLUMN IF NOT EXISTS insiders TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS launch_scores_checkpoint_idx ON launch_scores (checkpoint_sec, launch_id);

CREATE INDEX IF NOT EXISTS scorer_weights_active_idx ON scorer_weights (created_at) WHERE active;
