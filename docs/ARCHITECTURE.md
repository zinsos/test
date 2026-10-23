# Architecture

snypra-edge is one TypeScript codebase that runs as one or more Railway services next to SNYPRA. Every process subscribes to the chain itself and keeps its own in-memory `MarketState`. Postgres is the shared record.

```
Solana RPC websocket (logsSubscribe: Pump + PumpSwap)
        |
        v
  ingest  ── decodeLogs (IDL-driven) ── MarketState.resolve/apply ── Bus "chain"
        |                                                     |
        |                 ┌───────────────┬───────────────────┼──────────────────┬─────────────┐
        v                 v               v                   v                  v             v
   recorder          scorer          tracker/signals      trader            exits/risk    analytics
 (launches,       (features,       (tracked wallets,   (signal -> risk ->   (exit engine, (expectancy,
  trades,          wallet intel,    convergence,        executor ->          risk gate,    breakdowns,
  snapshots,       dev history,     score momentum)     positions)           sweeper)      paper vs live,
  outcomes)        copycat, score)                                                         dashboard)
```

## Modules

| Path | Owns |
| --- | --- |
| `src/core` | Types, contracts, clock (system and virtual), bus, stats, rng, logger |
| `src/chain` | IDL decoder, log parsing, event mapping, bonding curve and PumpSwap math, JSON-RPC client |
| `src/db` | Pool, migrations, daily trade partitions, batched inserts |
| `src/config` | Env schema and strategy config schema |
| `src/market` | `LaunchState` and `MarketState`, the single in-memory model shared by live and backtest |
| `src/ingest` | Websocket log source, dedupe, gap detection, event pipeline |
| `src/recorder` | Persists launches and trades, holder snapshots, metadata, outcome labelling and finalisation |
| `src/scorer` | Launch risk features, wallet intel (funding, freshness), dev history, copycat detection, scoring model, weight tuning |
| `src/tracker` | Wallet round-trip PnL, weekly ranking with exclusions, on-chain backfill, tracked wallet registry, signal engine |
| `src/execution` | Fill simulation against curve math with latency, fees, failures and retries; paper and live executors |
| `src/exits` | Exit engine (ladder, trailing, time stop, event exits, migration, liquidity-aware chunks) and event watcher |
| `src/risk` | Sizing, concurrency, daily loss limit, drawdown kill switch, hot to cold sweeper |
| `src/trader` | Orchestrates signal -> risk -> executor -> position -> exits; trading store |
| `src/backtest` | Replays recorded data through the same trader with a virtual clock |
| `src/analytics` | Metrics, queries, HTTP API and dashboard |

## Time and determinism

Every component takes a `Clock`. Live uses `SystemClock`. Backtests use `VirtualClock.advanceTo(eventTime)` before applying each recorded event, so timers (score checkpoints, fill latency, time stops) fire in the same order they would have live. Randomness (simulated transaction failures) comes from `createRng` seeded by run seed, mint, side and attempt, so a backtest is reproducible.

## No lookahead

- Cheap features are recomputed from trades up to the decision time.
- Deep features (funding clusters, fresh wallets) need RPC history and are only available from `launch_scores` rows written live at each checkpoint. A backtest reads them at `computed_at`.
- Dev history only counts launches whose `outcome_known_at` is before the decision time.
- Tracked wallets come from the most recent `wallet_rank_runs` row with `as_of` at or before the decision time.

## Data flow per launch

1. `CreateEvent` creates a `LaunchState` and a `launches` row.
2. Every curve, post-complete and PumpSwap trade updates reserves and per-wallet balances, and is batched into `trades` (daily partitions).
3. Holder snapshots at 30s, 1m, 5m, 15m from trades, plus RPC top holders when the launch is active.
4. Scorer checkpoints at 10s, 30s, 60s, 120s write `launch_scores`.
5. The finaliser labels outcomes (`migrated`, `rugged`, `died`, `alive`, `survived_15m`, market caps at checkpoints, peak and time to peak) and ends tracking after 24h or once the outcome is known and post-migration tracking is done.

## Integration with SNYPRA

- Buy-blockers: read the latest row in `launch_scores` for a mint (`score`, `hard_blocked`, `flags`) or call `GET /api/score/:mint`.
- Optimizer: `GET /api/export/scorer-dataset.csv` returns one row per launch and checkpoint with every feature and outcome label.
- Tracked wallets: `wallet_ranks` joined to the latest `wallet_rank_runs`.
- Signals: `signals` table and `GET /api/signals/recent`.
