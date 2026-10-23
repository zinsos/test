# snypra-edge

snypra-edge runs next to SNYPRA, your pump.fun bot on Railway. It does not try to win the speed race. Snipers with paid low-latency RPCs and Jito bundles, and devs who bundle-buy their own launches and dump, win that race. What a bot can realistically do better is:

- **Filter**: skip the 80 to 90% of launches that rug or die.
- **Keep discipline**: hold to exits and position sizes that a human would not.
- **Measure**: know the expectancy per trade instead of guessing it.

Everything here serves one of those three goals. It all lives in one TypeScript codebase that runs as one or more Railway services, with a shared Postgres database. SNYPRA talks to it through Postgres tables and an HTTP API.

## The seven components

| # | Component | What it does | Code | Main tables |
|---|-----------|--------------|------|-------------|
| 1 | **Launch data recorder** | Subscribes to Pump and PumpSwap logs over a websocket and decodes every launch, trade, completion and migration. Stores holder snapshots at 30s, 1m, 5m and 15m, plus metadata (socials) and outcome labels: rugged, died, migrated, survived 15m, peak and market caps at each checkpoint. Records websocket gaps, so incomplete launches can be left out of analysis. | `src/ingest`, `src/recorder` | `launches`, `trades` (daily partitions), `holder_snapshots`, `launch_outcomes`, `ingest_gaps` |
| 2 | **Launch risk scorer** | Scores every launch from 0 (clean) to 100 (toxic) at 10s, 30s, 60s and 120s. Looks at dev share and dev selling, creation-slot bundles, funding clusters (who funded the early buyers), fresh wallets, the dev's past launches, concentration, order flow, socials and copycats. Hard blocks catch the obvious rugs. Weights can be re-fit from recorded outcomes. | `src/scorer` | `launch_scores`, `wallet_intel`, `scorer_weights` |
| 3 | **Smart wallet tracker** | Ranks wallets weekly by realized round-trip PnL over 30 and 90 days. Excludes devs, insiders, bundlers, bots, snipers and one-hit wonders. Fires a `smart_convergence` signal when several tracked wallets buy the same launch within a window. An optional `score_momentum` signal can also be turned on. | `src/tracker` | `wallet_rank_runs`, `wallet_ranks`, `wallet_history_trades`, `signals` |
| 4 | **Realistic execution model** | The paper executor fills against the real curve or pool math at the moment the order would land. It models latency, jitter, failed transactions, retries, slippage limits, protocol, creator, LP and platform fees, priority fees, Jito tips and token account rent. The live executor builds transactions with the official pump.fun SDKs and parses the real fills. | `src/execution` | `fills` |
| 5 | **Exit engine** | Take-profit ladder, tiered trailing stop, moonbag with its own trail, hard stop, flat time stop and max hold. Exits early when the dev sells, insiders sell or smart wallets exit. Handles migration and splits sells into chunks when liquidity is thin. | `src/exits` | `positions.meta` |
| 6 | **Risk manager** | Sizes each position as a fraction of the bankroll, between a minimum and a maximum. Enforces a max number of concurrent positions, one entry per dev per day, a daily loss halt and a drawdown kill switch that flattens everything. The hot-to-cold sweeper moves profits off the hot wallet. | `src/risk` | `risk_state`, `risk_events`, `sweeps` |
| 7 | **Performance analytics** | Shows expectancy with confidence intervals, a verdict (`edge`, `no_edge`, `insufficient_data`), the trades still needed, and breakdowns by risk score, signal, hour, hold time and exit reason. Compares paper against live and checks scorer calibration. Includes a mobile dashboard. | `src/analytics` | views over `positions`, `fills`, `signals` |

The trader (`src/trader`) connects them: signal, then risk check, then executor, then position, then exits. The backtester (`src/backtest`) replays recorded data through the same components using a virtual clock. Live, paper and backtest share every decision path.

## How it is deployed

The recommended setup is two Railway services built from this repository, plus the Railway Postgres plugin:

| Service | `MODULES` | Role |
|---------|-----------|------|
| **A: data** | `recorder,scorer,tracker,dashboard` | Records everything, writes `launch_scores` for SNYPRA's buy-blockers, ranks wallets weekly, serves the dashboard and API. It also writes the signals it sees to `signals` with no run attached. |
| **B: trading** | `trader` with `TRADING_MODE=paper` | Has its own signal engine and scorer (it does not write scores), and trades paper or live. It restores open positions after a restart. |

Each service opens its own websocket stream and keeps its own in-memory market state, so neither depends on the other being up. They share only Postgres. Service B reads the wallet rankings that A writes.

Only one trader per mode can run at a time. When Railway rolls a deploy, it starts the new container before stopping the old one. The new trader answers `/healthz` straight away but waits on a Postgres advisory lock until the old one has shut down, so the two never trade at the same time.

### Railway step by step

1. Create a project and add the **Postgres** plugin.
2. Add a service from this repo. `railway.json` already sets the build (`npm run build`), the start command (`node dist/src/main.js start`), the `/healthz` health check and a 50 second draining window so in-flight orders can finish.
3. Set its variables (see `.env.example` for all of them):
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `RPC_HTTP_URL`, and `RPC_WS_URL` if your provider uses a separate websocket URL
   - `MODULES=recorder,scorer,tracker,dashboard`
   - `DASHBOARD_TOKEN` set to a long random string
   - Generate a public domain for it so you can open the dashboard.
4. Add a second service from the same repo with:
   - `DATABASE_URL`, `RPC_HTTP_URL`, `RPC_WS_URL`
   - `MODULES=trader`, `TRADING_MODE=paper`
5. Migrations run automatically on start. You can also run `node dist/src/main.js migrate`.
6. To change strategy knobs, edit `config/strategy.json` and redeploy, or point `STRATEGY_CONFIG` at another file.

Local run: `npm ci`, start Postgres, `cp .env.example .env`, edit it, then `npx tsx --env-file=.env src/main.ts start`.

### RPC requirements

- **Websocket**: needs `logsSubscribe` with a `mentions` filter on both Pump (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) and PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). The stream reconnects with backoff, detects stalls and records every gap.
- **HTTP**: used for wallet intel (`getSignaturesForAddress`, `getTransaction` with `maxSupportedTransactionVersion: 1`), RPC holder snapshots, wallet backfills, balance checks and live trading.
- **Plan**: pump.fun produces tens of thousands of launches and a few million log notifications a day. Public endpoints rate-limit and drop websocket notifications, so use a paid RPC (Helius, Triton, QuickNode or similar).
- **Rate limits**: tune `RPC_MAX_RPS` and `RPC_MAX_CONCURRENCY` to your plan. Watch `stream.gaps` and `stream.lagMs` in the health line and on the dashboard's Recorder tab.

### Storage estimate

Rough sizes per day at current pump.fun volume:

| Data | Volume | Size |
|------|--------|------|
| Trades | 1 to 2 million rows at about 550 bytes each with indexes | 0.5 to 1.1 GB |
| Holder snapshots | 4 checkpoints per launch, top 50 holders as JSON | about 0.5 GB |
| Launch scores | 4 checkpoints per launch with all features | about 0.4 GB |
| Launches, outcomes, signals, positions | | under 0.1 GB |

That is roughly 1.5 to 2 GB a day, so plan for **20 to 30 GB for the first two weeks**.

- Measure the real figure after a day with `SELECT pg_size_pretty(pg_database_size(current_database()));`.
- `trades` is partitioned by day (`trades_YYYYMMDD`). Partitions older than the 90-day ranking window can be dropped with `DROP TABLE trades_20261001;`.

## Rollout plan

The order matters. Each step produces the evidence the next one needs.

| When | What | Commands |
|------|------|----------|
| Weeks 1 to 2 | **Record.** Deploy service A only. Check the dashboard's Recorder tab daily: gaps, outcome coverage, trades per launch. | `start` (service A) |
| End of week 2 | **Rank wallets and fetch their history.** | `rank-wallets`, then `backfill-wallets --top 200`, then `rank-wallets` again |
| | **Tune the scorer** on the first 10 days, then backtest on the last 4 days. Testing on data the weights never saw keeps the result honest. | `tune-scorer --checkpoint 30 --label rugged --to 2026-11-10` (the new weights are stored but not active), then `backtest --from 2026-11-10 --to 2026-11-14 --weights <version printed by tune-scorer> --walk-forward`, then `export-dataset --checkpoint 30 --out scorer.csv` for SNYPRA's optimizer |
| | **Activate the weights** if the backtest's expectancy interval and the dashboard's Scorer calibration look right. Restart the services so they load the new weights. | `tune-scorer ... --activate` |
| Weeks 3 to 6 | **Paper trade.** Deploy service B with `TRADING_MODE=paper` until you have **300 or more closed trades**. Fix the strategy using the breakdowns and the `cut` and `scale` hints: risk buckets, hours, exit reasons. | `report --mode paper` |
| Then | **Live, dry run.** Set `TRADING_MODE=live`, `LIVE_DRY_RUN=true` and a hot wallet key. Every order is built and simulated against the chain, never sent. Check the logs for `dry run simulated` with `ok: true` on both a bonding-curve coin and a migrated (PumpSwap) coin. | `start` (service B) |
| Then | **Live, small.** Set `LIVE_DRY_RUN=false` with a small `risk.startingBankrollSol` and a small hot wallet balance. Every live position also opens a paper shadow position, so the two can be compared on the same signals. | `start` (service B) |
| Weekly | **Compare live against paper.** On the dashboard's Paper vs Live tab, check the mean PnL gap with its interval, the entry and exit fill gaps in bps and the failed-fill rates. If paper is too optimistic, raise `execution.latencySlots`, `failureRate` or the fees until paper matches live, then re-read your paper results with the new settings. | `report --mode live` |

Do not size up on a small sample. `report` and the dashboard print how many more trades are needed before the expectancy interval excludes zero.

## Command line

Run commands with `node dist/src/main.js <command>`, or `npx tsx src/main.ts <command>` in development. Every command reads the environment, and `--config` overrides `STRATEGY_CONFIG`. Exit codes: 0 ok, 1 failure, 2 usage error. `help` prints all the options.

| Command | Purpose |
|---------|---------|
| `start` | Run the services listed in `MODULES`. Shuts down cleanly on SIGINT and SIGTERM: stops the stream, finishes in-flight orders, flushes writers and closes the database. |
| `migrate` | Apply database migrations. |
| `backtest --from 2026-10-01 --to 2026-10-15 [--label x] [--config f] [--weights file-or-version] [--walk-forward] [--include-incomplete] [--json]` | Replay a date range (UTC, `--to` exclusive). It records a `strategy_runs` row with mode `backtest`, prints the report and stores the summary on the run. |
| `tune-scorer --checkpoint 30 --label rugged [--from --to] [--activate] [--write-file] [--version name]` | Fit weights against `rugged`, `died`, `survived_15m` or `migrated`. Prints feature AUCs and validation AUC, then stores the new version. |
| `export-dataset --checkpoint 30 --out scorer.csv [--from --to] [--quote SOL]` | Write one row per launch with every feature and outcome label, for SNYPRA's optimizer. Use `--out -` for stdout. |
| `rank-wallets [--as-of 2026-10-15]` | Rank wallets now, or as of a past time using only data before it. |
| `backfill-wallets [--top 200] [--since-days 90]` | Fetch on-chain history for the latest ranking's top wallets. Needs `RPC_HTTP_URL`. |
| `report [--run 12 \| --mode paper] [--from --to]` | Expectancy, interval, verdict and breakdowns. In live mode it adds the paper vs live comparison. |
| `sweep [--dry-run]` | One manual sweep from hot to cold. Live open positions block it. |
| `reset-kill --run 12 [--reason "..."]` | Clear the drawdown kill switch. A running trader picks the reset up within 30 seconds. |
| `recompute-outcomes [--from --to]` | Relabel outcomes after changing `recorder.outcome` settings. Defaults to the last 30 days. |

How a backtest works:

- **Data.** It replays launches created in the window, their trades, completions and migrations, in block order. Launches with ingest gaps are skipped unless `--include-incomplete` is set. The live trader matches this: after a stream gap it does not enter launches created before the gap (skip reason `incomplete_data`).
- **Shared code.** It runs the live scorer (replay mode), signal engine, paper executor, exit engine, risk manager and trader.
- **Time.** A virtual clock drives everything, so latency, score checkpoints, time stops and daily limits behave as they would live.
- **No lookahead.**
  - Deep scorer features (funding clusters, fresh wallets, socials, copycats, dev history) are read from the `launch_scores` rows written live, as of their `computed_at`.
  - Tracked wallets come from the latest `wallet_rank_runs` row with `as_of` at or before the replay time. `--walk-forward` first creates rankings at each rerank interval inside the window, using only data before each one.
- **End of run.** Positions still open at the end are closed at the last quote.
- **Determinism.** The same data and config give the same trades. The report prints a fingerprint so you can check.

## Configuration

**Strategy knobs.** `config/strategy.json` sets every knob explicitly, and `src/config/strategy.ts` validates it.

- It matches the code defaults with one exception: `execution.ataRentLamports` is set to the 1,513,840 lamports measured for pump token accounts on mainnet in October 2026.
- The main knobs:
  - **Entries:** `signals.enabled`, `tracker.convergence` (window, minimum wallets, maximum risk score)
  - **Sizing and limits:** `risk.*`
  - **Exits:** `exits.*`
  - **Paper realism:** `execution.latencySlots`, `failureRate` and the fee defaults
  - **Scorer:** `scorer.maxRisk` and `scorer.hardBlocks`

**Secrets and infrastructure.** These come from environment variables, documented in `.env.example`.

## SNYPRA integration points

- **Buy-blockers.** Read the latest score for a mint from Postgres:
  ```sql
  SELECT score, hard_blocked, flags, checkpoint_sec, computed_at
  FROM analytics_latest_launch_scores WHERE mint = $1;
  ```
  Block when `hard_blocked` is true, or when `score` is above your threshold (`scorer.maxRisk` is 55 by default). Also block when `flags` contains `dev_dumped` or `serial_rugger`: a dev who dumps alone scores only about 24 under the default weights.
- **HTTP.** `GET /api/score/:mint` with `Authorization: Bearer $DASHBOARD_TOKEN` returns the in-memory score when service A has it, otherwise the latest row from the database. It returns 404 `not_scored` when the launch is unknown.
- **Optimizer dataset.** Both give one row per launch and checkpoint, with every feature and outcome label:
  - `GET /api/export/scorer-dataset.csv?checkpoint=30` streams it with `f_`-prefixed feature columns and `o_`-prefixed outcome columns, plus flags and the weights version (token required).
  - `export-dataset` writes the scorer's fixed column layout, the same column order the tuner uses, from the command line.
- **Signals.** The `signals` table and `GET /api/signals/recent`. Read rows by their `run_id`:

  | `run_id` | `acted` | `skip_reason` | Meaning |
  |----------|---------|---------------|---------|
  | null | false | null | Observed by service A and accepted by the signal filters |
  | null | false | set | Observed by service A and rejected; the reason says why |
  | a run id | true | null | Service B traded it |
  | a run id | false | set | Service B skipped it; the reason says why |

- **Tracked wallets.** `GET /api/wallets/tracked`, or `wallet_ranks` joined to the latest `wallet_rank_runs` row.

## Safety notes for live trading

- **Hot wallet.** Holds only the trading bankroll plus a fee reserve (`risk.minFeeReserveSol`). Its key is the only secret the bot needs (`HOT_WALLET_SECRET_KEY`). Set it as a Railway variable on the trading service only, and never commit it. `.gitignore` excludes `.env`, `keys` and `*.keypair.json`.
- **Cold wallet.** Give the bot only its address (`COLD_WALLET_ADDRESS`), never its key. The sweeper:
  - sends profits above `sweeper.hotTargetSol` plus `reserveSol` to that address
  - refuses PDAs and the hot wallet itself
  - never sweeps while positions are open
  - records every sweep in `sweeps`
- **Dry run first.** `LIVE_DRY_RUN` defaults to `true`, so turning on `TRADING_MODE=live` only simulates. Set it to `false` deliberately, after a dry run on both a curve coin and a migrated coin.
- **Kill switch.** Trips at `risk.killSwitchDrawdownFraction` and flattens everything when `risk.flattenOnKill` is true. Resetting it is manual: `reset-kill --run <id>`. The daily loss halt resets at `risk.dayResetUtcHour`.
- **Unconfirmed fills.** The live executor never resends a transaction whose fate is unknown. It reconciles the signature later, so a slow confirmation cannot become a double buy. If a fill stays unknown, the log says to check the wallet.
- **Hot wallet balance.** It is polled every 15 seconds, and sizing never exceeds what the wallet holds minus the fee reserve.

## PUMP-quoted launches

Many launches are now quoted in the PUMP coin (`pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`) instead of SOL.

- **Recorder.** Stores them in their own units, `launches.quote_mint` included.
- **Scores and outcomes.** Use multiples of the initial market cap, so they are comparable across quote mints.
- **Trading and wallet PnL.** SOL-quoted only. Signals for other quote mints are rejected (`quote_mint_not_allowed`), and the trader refuses them (`quote_mint_not_tradable`).
- **Raw values.** Market caps and amounts of PUMP-quoted launches in the raw tables are not SOL. Filter on `quote_mint = 'SOL'`, or use `--quote SOL` on exports, when you need SOL values.

## Dashboard

Open the service A domain with `?token=<DASHBOARD_TOKEN>` once. The page stores the token and removes it from the URL. It is built for phones and has these tabs:

- **Edge:** expectancy and verdict
- **Breakdowns**
- **Paper vs Live**
- **Scorer:** calibration
- **Recorder:** health and gaps
- **Signals**
- **Launches:** tap a mint for its score sheet
- **Wallets**

`/healthz` needs no token.

## Development

- `npm run check` runs the typecheck and all tests.
- Database tests need `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`. Each test file creates and drops its own database.
- Source and test files contain no comments. `test/style.test.ts` enforces this.
- Amounts are `bigint` lamports or raw token units.
- Logic takes a `Clock` instead of calling `Date.now()`, so backtests replay deterministically.
- See `CLAUDE.md` and `docs/ARCHITECTURE.md` for conventions and verified pump.fun facts.
