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
| `src/chain` | IDL decoder, log parsing, event mapping, bonding curve and PumpSwap math, canonical PumpSwap pool PDA (`pda.ts`), JSON-RPC client |
| `src/db` | Pool, migrations, daily trade partitions, batched inserts with retry and drop hooks, waiting for Postgres at start (`wait.ts`), data retention for `prune-data` (`retention.ts`) |
| `src/config` | Env schema and strategy config schema |
| `src/market` | `LaunchState` and `MarketState`, the single in-memory model shared by live and backtest |
| `src/ingest` | Websocket log source, dedupe, gap detection, event pipeline |
| `src/recorder` | Persists launches and trades, holder snapshots, metadata (size-limited, SSRF-guarded, swept again after restarts), outcome labelling and finalisation, stream checkpoints and restart gaps (`checkpoints.ts`) |
| `src/scorer` | Launch risk features, wallet intel (funding, freshness, hubs; `fetch` or `stored` mode), dev history, copycat detection with a seeded trending window, scoring model with `solo` weights, weight tuning |
| `src/tracker` | Wallet round-trip PnL, weekly ranking with exclusions, on-chain backfill, tracked wallet registry, signal engine |
| `src/execution` | Fill simulation against curve math with latency, fees, failures and retries; paper and live executors |
| `src/exits` | Exit engine (ladder, trailing, time stop, event exits, migration, liquidity-aware chunks) and event watcher |
| `src/risk` | Sizing, concurrency, daily loss limit, drawdown kill switch, hot to cold sweeper |
| `src/trader` | Orchestrates signal -> risk -> executor -> position -> exits; trading store; pending live entries and wallet reconciliation (`pending.ts`) |
| `src/backtest` | Replays recorded data through the same trader with a virtual clock; out-of-sample weight selection (`weights.ts`) |
| `src/analytics` | Metrics, queries, HTTP API and dashboard, live event hub (`liveHub.ts`, Server-Sent Events) and Lab views |
| `src/lab` | Fast training loop: scorer training on fast labels and backtest replays of strategy variants (`config/lab-variants.json`), stored in `lab_runs` and `lab_variants` |

## Time and determinism

Every component takes a `Clock`. Live uses `SystemClock`. Backtests use `VirtualClock.advanceTo(visibleAtMs)` before applying each recorded event, so timers (score checkpoints, fill latency, time stops) fire in the same order they would have live. `visibleAtMs` is the time the recorder received the event (`trades.received_at`, `launches.observed_at`), clamped between the block time and block time + 30s; rows without a receive time, and migrations, use block time + 1.5s. The clock never moves backwards, so an event is never applied before it was visible. Randomness (simulated transaction failures) comes from `createRng` seeded by run seed, mint, side and attempt, so a backtest is reproducible.

## No lookahead

- Cheap features are recomputed from trades up to the decision time.
- Deep features (funding clusters, fresh wallets) need RPC history and are only available from `launch_scores` rows written live at each checkpoint. A backtest reads them at `computed_at`.
- Dev history only counts launches whose `outcome_known_at` is before the decision time.
- Tracked wallets come from the newest published `wallet_rank_runs` row available at the decision time. A point-in-time run (`params.historyKnownBeforeMs` set) is available at `as_of`; a live or CLI rerank (`historyKnownBeforeMs` null) at `max(as_of, ran_at)`. Walk-forward runs (`params.label = 'walk-forward'`) are private to the backtest that made them and invisible to every live reader and to SNYPRA.
- The copycat `TrendingTracker` is seeded at start from launches and per-minute volume in the window before the clock's now, live and in replay (a backtest seeds at its start time).
- Launches with gaps are replayed in full. `launches.data_incomplete_at` marks the moment their data became incomplete, and the trader skips entries only from then on (`--include-incomplete` turns this off). Restart gaps come from `recorder_checkpoints` coverage, not from the fact of a restart.
- Outcome labels (insider sells, rug detection) use the insiders stored in `launch_scores`, so memory, the finaliser and a recompute agree.
- Backtests without `--weights` skip scorer weights whose training window ends after `--from` unless `--allow-in-sample` is set.
- Fast labels: `survived_15m` enters a dataset once the launch is `surviveCheckSec` + 5 minutes old, `rugged_1h` (insider dump and collapse within the first hour) once it is 1 hour + `rugLookaheadSec` old and its outcome was recomputed after the hour. `launch_outcomes.rug_at` keeps the rug time even when the launch migrates later (`rugged` stays false), and outcomes never finalize before the survival check, so neither fast label depends on what happened after it matured. Training splits by launch time and validates on the newest 30%.

## Data flow per launch

1. `CreateEvent` creates a `LaunchState` and a `launches` row.
2. Every curve, post-complete and PumpSwap trade updates reserves and per-wallet balances, and is batched into `trades` (daily partitions).
3. Holder snapshots at 30s, 1m, 5m, 15m from trades, plus RPC top holders when the launch is active.
4. Scorer checkpoints at 10s, 30s, 60s, 120s write `launch_scores`.
5. The finaliser labels outcomes (`migrated`, `rugged`, `died`, `alive`, `survived_15m`, market caps at checkpoints, peak and time to peak) and ends tracking after 24h or once the outcome is known and post-migration tracking is done.

Only the canonical PumpSwap pool of a launch (the pool PDA for its own quote mint, created by the pump pool authority) is registered in `MarketState`, and the live builder refuses any other pool, so a look-alike pool cannot move prices, exits or orders.

## Live trading lifecycle

1. A live entry first saves a `positions` row with status `pending` (`meta.pendingEntry` holds the order and its settle deadline), then sends. A fill replaces the row; a failure with no cost deletes it. The upsert never turns an open or closed row back into `pending`.
2. A buy whose outcome stays unknown after reconciling is resolved from the hot wallet once its blockhash has surely expired (`MAX_BLOCKHASH_AGE_MS`): a non-dust balance becomes the position (fill note `fill_from_wallet_balance`, cost estimated at budget + rent + fees), an empty wallet releases the entry. On restart, pending rows are resolved the same way and count against `maxConcurrent` meanwhile.
3. After a sell refused for `no_balance`, a sell whose outcome stays unknown, and for every restored position, the trader reads the wallet. Tokens missing from it are booked at the current quote as an external exit (fill note `external_exit_estimated`, exit reason `external_or_unknown_exit` when nothing is left). An empty reading is ignored for the first 30s of a position (RPC lag).
4. `Trader.halt()` stops sending at once (the live executor checks before each attempt and right before sending). Stopping halts first; losing the trading lock halts immediately.
5. The hot-to-cold sweeper holds a Postgres advisory lock keyed on the hot wallet, so the service sweeper and the `sweep` command never sweep at the same time, and it never sweeps while positions or entries are open.

## Flags and switches

- Env: `LIVE_DRY_RUN`, `DATABASE_SSL` and `DASHBOARD_ALLOW_OPEN` accept only true/false, 1/0, yes/no, on/off; anything else stops startup. The dashboard refuses to start without a non-placeholder `DASHBOARD_TOKEN` of at least 24 characters unless `DASHBOARD_ALLOW_OPEN` is true; a set token is always required.
- Strategy: `scorer.deepIntel.minClusterCoverage`, `tracker.convergence.maxScoreAgeSec`, weights `solo` per feature (score = max of the weighted mean and the strongest `solo * risk`), `risk.dailyLossLimitFraction` and `risk.killSwitchDrawdownFraction` must be in (0, 1].
- Services without `recorder` or `scorer` run the scorer with `intelMode: 'stored'`: they read `wallet_intel` rows and make no wallet-intel RPC calls.

## Integration with SNYPRA

- Buy-blockers: read the latest row in `launch_scores` for a mint (`score`, `hard_blocked`, `flags`) or call `GET /api/score/:mint`.
- Optimizer: `GET /api/export/scorer-dataset.csv` returns one row per launch and checkpoint with every feature and outcome label.
- Tracked wallets: the view `snypra_tracked_wallets` (migration `072`) or `GET /api/wallets/tracked`. Both exclude walk-forward runs; a hand-written join to the latest `wallet_rank_runs` row would not.
- Signals: `signals` table and `GET /api/signals/recent`.

## Live tab and Lab

- `GET /api/live/stream` is a Server-Sent Events stream from `LiveHub` in the service that runs the dashboard (scores, accepted, rejected and skipped signals, buys, sells, closes, risk notices, throttled position updates). EventSource cannot send headers, so the token comes as `?token=`. At most 10 streams; a client whose socket stays congested for 30s is disconnected, events are dropped (and counted in a `gap` message) instead of buffered. The replay ring keeps trades, rejections and scores in separate classes so scores never push trades out. `GET /api/live/position/:id/series` returns in-memory prices, exit levels and market cap of an open position plus buy and sell markers read from the `fills` table (the entry price stands in for the buy until its fill is stored; a failed lookup is logged and the chart still renders); its PnL estimate uses the same fee, close-cost and rent-refund formula as the Overview. `GET /api/positions` adds a downsampled price line since entry (`spark`) for open positions the process's `LiveHub` holds. `GET /api/wallet` values open positions with the same estimate: equity and today's PnL are the risk ledger with its own unrealized mark swapped for the `LiveHub` open-position estimate.
- `lab` (CLI) trains the scorer on fast labels (weights saved inactive as `lab-<run>-<label>-<checkpoint>`), then replays the last hours for the baseline and each variant one at a time through `runBacktest` (no rejected signals stored). Variants that only touch settings a replay never reads (recorder, wallet intel, wallet ranking, sweeper, disabled signals) are recorded as `skipped: ...`, and `notes.variants.<name>.sameTradesAsBaseline` flags a variant that traded exactly like the baseline. Lab backtests are `strategy_runs` labelled `lab:<labRunId>:<variant>`; every automatic run or mode pick in the dashboard and `report` leaves them out, and `backtest --label lab:...` is refused. Each lab run prunes lab backtests of all but the latest 20 lab runs. The lab is a separate process: on the 1-CPU VPS run it with `nice` and a heap cap, it re-reads the replay window from Postgres for each variant.
