CREATE OR REPLACE VIEW analytics_closed_trades AS
SELECT p.id AS position_id,
       p.run_id,
       p.mode,
       p.mint,
       p.signal_type,
       p.risk_score,
       p.opened_at,
       p.closed_at,
       coalesce(p.hold_sec, extract(epoch FROM (p.closed_at - p.opened_at))::float8) AS hold_sec,
       p.entry_cost AS cost_lamports,
       p.proceeds AS proceeds_lamports,
       p.fees_paid AS fees_lamports,
       coalesce(p.realized_pnl, p.proceeds - p.entry_cost) AS pnl_lamports,
       p.entry_cost::float8 / 1e9 AS cost_sol,
       p.fees_paid::float8 / 1e9 AS fees_sol,
       coalesce(p.realized_pnl, p.proceeds - p.entry_cost)::float8 / 1e9 AS pnl_sol,
       CASE WHEN p.entry_cost > 0
            THEN coalesce(p.realized_pnl, p.proceeds - p.entry_cost)::float8 / p.entry_cost::float8
       END AS return_fraction,
       coalesce(p.realized_pnl, p.proceeds - p.entry_cost) > 0 AS is_win,
       p.exit_reason,
       p.peak_multiple,
       p.shadow_of,
       extract(hour FROM p.opened_at AT TIME ZONE 'UTC')::int AS entry_hour_utc,
       extract(isodow FROM p.opened_at AT TIME ZONE 'UTC')::int AS entry_isodow_utc
FROM positions p
WHERE p.status = 'closed' AND p.closed_at IS NOT NULL;

CREATE OR REPLACE VIEW analytics_latest_launch_scores AS
SELECT DISTINCT ON (s.mint)
       s.mint,
       s.launch_id,
       s.checkpoint_sec,
       s.computed_at,
       s.slot,
       s.score,
       s.hard_blocked,
       s.flags,
       s.weights_version
FROM launch_scores s
ORDER BY s.mint, s.checkpoint_sec DESC, s.computed_at DESC;

CREATE OR REPLACE VIEW analytics_paper_live_pairs AS
SELECT l.id AS live_position_id,
       s.id AS paper_position_id,
       l.run_id AS live_run_id,
       l.mint,
       l.closed_at AS live_closed_at,
       coalesce(l.realized_pnl, l.proceeds - l.entry_cost) AS live_pnl_lamports,
       coalesce(s.realized_pnl, s.proceeds - s.entry_cost) AS paper_pnl_lamports,
       coalesce(l.realized_pnl, l.proceeds - l.entry_cost) - coalesce(s.realized_pnl, s.proceeds - s.entry_cost) AS gap_lamports,
       l.exit_reason AS live_exit_reason,
       s.exit_reason AS paper_exit_reason
FROM positions s
JOIN positions l ON l.id = s.shadow_of
WHERE s.status = 'closed' AND l.status = 'closed';
