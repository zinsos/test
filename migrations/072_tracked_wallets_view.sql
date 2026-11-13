CREATE OR REPLACE VIEW snypra_tracked_wallets AS
SELECT r.*
FROM wallet_ranks r
WHERE r.tracked
  AND r.run_id = (
    SELECT id
    FROM wallet_rank_runs
    WHERE COALESCE(params->>'label', '') <> 'walk-forward'
    ORDER BY as_of DESC, id DESC
    LIMIT 1
  );
