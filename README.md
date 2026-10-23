# snypra-edge

snypra-edge runs next to SNYPRA, your pump.fun bot on Railway. It does not try to win the speed race. Snipers with paid low-latency RPCs and Jito bundles, and devs who bundle-buy their own launches and dump, win that race. What a bot can realistically do better is:

- **Filter**: skip the 80 to 90% of launches that rug or die.
- **Keep discipline**: hold to exits and position sizes that a human would not.
- **Measure**: know the expectancy per trade instead of guessing it.

Everything here serves one of those three goals. It all lives in one TypeScript codebase that runs as one or more Railway services, with a shared Postgres database. SNYPRA talks to it through Postgres tables and an HTTP API.

## The seven components

| # | Component | What it does | Code | Main tables |
|---|-----------|--------------|------|-------------|
| 1 | **Launch data recorder** | Subscribes to Pump and PumpSwap logs over a websocket and decodes every launch, trade, completion and migration. Stores holder snapshots at 30s, 1m, 5m and 15m, plus metadata (socials) and outcome labels: rugged, died, migrated, survived 15m, peak and market caps at each checkpoint. Records websocket gaps, restart holes and dropped writes, with the time each launch's data became incomplete. | `src/ingest`, `src/recorder` | `launches`, `trades` (daily partitions), `holder_snapshots`, `launch_outcomes`, `ingest_gaps`, `recorder_checkpoints` |
| 2 | **Launch risk scorer** | Scores every launch from 0 (clean) to 100 (toxic) at 10s, 30s, 60s and 120s. Looks at dev share and dev selling, creation-slot bundles, funding clusters (who funded the early buyers), fresh wallets, the dev's past launches, concentration, order flow, socials and copycats. Hard blocks catch the obvious rugs. Weights can be re-fit from recorded outcomes. | `src/scorer` | `launch_scores`, `wallet_intel`, `scorer_weights` |
| 3 | **Smart wallet tracker** | Ranks wallets weekly by realized round-trip PnL over 30 and 90 days. Excludes devs, insiders, bundlers, bots, snipers and one-hit wonders. Fires a `smart_convergence` signal when several tracked wallets buy the same launch within a window. An optional `score_momentum` signal can also be turned on. | `src/tracker` | `wallet_rank_runs`, `wallet_ranks`, `wallet_history_trades`, `signals` |
| 4 | **Realistic execution model** | The paper executor fills against the real curve or pool math at the moment the order would land. It models latency, jitter, failed transactions, retries, slippage limits, protocol, creator, LP and platform fees, priority fees, Jito tips and token account rent. The live executor builds transactions with the official pump.fun SDKs and parses the real fills. | `src/execution` | `fills` |
| 5 | **Exit engine** | Take-profit ladder, tiered trailing stop, moonbag with its own trail, hard stop, flat time stop and max hold. Exits early when the dev sells, insiders sell or smart wallets exit. Handles migration and splits sells into chunks when liquidity is thin. | `src/exits` | `positions.meta` |
| 6 | **Risk manager** | Sizes each position as a fraction of the bankroll, between a minimum and a maximum. Enforces a max number of concurrent positions, one entry per dev per day, a daily loss halt and a drawdown kill switch that flattens everything. The hot-to-cold sweeper moves profits off the hot wallet. | `src/risk` | `risk_state`, `risk_events`, `sweeps` |
| 7 | **Performance analytics** | Shows expectancy with confidence intervals, a verdict (`edge`, `no_edge`, `insufficient_data`), the trades still needed, and breakdowns by risk score, signal, hour, hold time and exit reason. Compares paper against live and checks scorer calibration. Includes a mobile dashboard. | `src/analytics` | views over `positions`, `fills`, `signals` |

The trader (`src/trader`) connects them: signal, then risk check, then executor, then position, then exits. The backtester (`src/backtest`) replays recorded data through the same components using a virtual clock. Live, paper and backtest share every decision path.

## How it is deployed

The simplest setup, and the recommended one for paper trading from a phone, is **one Railway service** built from this repository plus the Railway Postgres plugin:

| Service | `MODULES` | Role |
|---------|-----------|------|
| **snypra-edge** | `recorder,scorer,tracker,trader,dashboard` with `TRADING_MODE=paper` | Records everything, writes `launch_scores` for SNYPRA's buy-blockers, ranks wallets, trades paper and serves the dashboard and API. Recorder, scorer and trader share one stream and one in-memory market, so the trader sees exactly what the recorder stores and the backtest replays it with the same timing. |

Splitting into two services is optional. It isolates the trader from the recorder's load, at the cost of a second stream:

| Service | `MODULES` | Role |
|---------|-----------|------|
| **A: data** | `recorder,scorer,tracker,dashboard` | Everything above except trading. It also writes the signals it sees to `signals` with no run attached. |
| **B: trading** | `trader` with `TRADING_MODE=paper` or `live` | Has its own signal engine and scorer (it does not write scores) and trades. It reads the wallet rankings and the wallet intel that A stores and makes no wallet-intel RPC calls itself, so its RPC key is left for orders and confirmations. |

Each service opens its own websocket stream and keeps its own in-memory market state. They share only Postgres. Every service restores open positions after a restart.

Deploys and restarts:

- **Restart policy.** `railway.json` restarts the service whenever it exits (`ALWAYS`), so a crash loop during a long Postgres outage cannot exhaust a retry budget.
- **Postgres outages.** On start the service waits up to 10 minutes for Postgres, with backoff, before it gives up and lets Railway restart it.
- **Overlapping deploys.** Railway starts the new container, waits for `/healthz`, then keeps the old one running for 20 more seconds (`overlapSeconds`) before draining it for 50 seconds. A service that records answers `/healthz` with 503 until its stream has delivered data.
- **Recorder handover.** Every recorder writes its stream position to `recorder_checkpoints`. When a new recorder starts streaming, it checks whether an earlier recorder covered the slots up to its first event. Only a real hole (a crash, or a stop followed by a late start) is recorded as a `restart` gap, and only launches that were being tracked during the hole are marked incomplete, from the time of the hole. Aggregates count each stored trade once, even while two recorders overlap.
- **Trading lock.** Only one trader per mode can run at a time. The new trader answers `/healthz` straight away but waits on a Postgres advisory lock until the old one has shut down, so the two never trade at the same time. A trader that loses the lock's connection stops sending orders at once and shuts down.
- **Live orders across restarts.** Before a live buy is sent, the trader writes a `positions` row with status `pending` that holds the order. If the process stops before the outcome is known, the next start reads the hot wallet once the transaction's blockhash has surely expired: tokens in the wallet become the position, and an empty wallet releases the entry. Pending entries count against `risk.maxConcurrent` and block the sweeper until they are resolved.

### Railway step by step

1. Create a project and add the **Postgres** plugin.
2. Add a service from this repo. `railway.json` already sets the build (`npm run build`), the start command (`node dist/src/main.js start`), the `/healthz` health check, the restart policy, a 20 second overlap and a 50 second draining window so in-flight orders can finish.
3. Set its variables (see `.env.example` for all of them):
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `RPC_HTTP_URL`, and `RPC_WS_URL` if your provider uses a separate websocket URL
   - `MODULES=recorder,scorer,tracker,trader,dashboard` and `TRADING_MODE=paper`
   - `DASHBOARD_TOKEN` set to at least 24 random characters (for example the output of `openssl rand -hex 24`). A service with the dashboard refuses to start without it, because the API exposes trades, positions and wallets.
   - Generate a public domain for it so you can open the dashboard.
4. Optional split: set `MODULES=recorder,scorer,tracker,dashboard` on the first service and add a second service from the same repo with `DATABASE_URL`, `RPC_HTTP_URL`, `RPC_WS_URL`, `MODULES=trader` and `TRADING_MODE=paper`.
5. Migrations run automatically on start. You can also run `node dist/src/main.js migrate`.
6. To change strategy knobs, edit `config/strategy.json` and redeploy, or point `STRATEGY_CONFIG` at another file.

Local run: `npm ci`, start Postgres, `cp .env.example .env`, edit it, then `npx tsx --env-file=.env src/main.ts start`.

### RPC requirements

- **Websocket**: needs `logsSubscribe` with a `mentions` filter on both Pump (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) and PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). The stream reconnects with backoff, detects stalls and records every gap.
- **HTTP**: used for wallet intel (`getSignaturesForAddress`, `getTransaction` with `maxSupportedTransactionVersion: 1`), RPC holder snapshots, wallet backfills, balance checks and live trading. Wallet intel is fetched only by services that run `recorder` or `scorer`: up to 25 early buyers per launch, each one signature page plus up to 5 transactions, so budget about 150 calls for an active launch and far fewer for the many launches that never reach 5 buyers.
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

- Measure the real figure after a day with `SELECT pg_size_pretty(pg_database_size(current_database()));`. Postgres stops accepting writes when the volume is full, and SNYPRA's buy-blockers go stale with it, so size the Railway volume for your retention: about 200 GB for 100 days.
- Nothing is deleted automatically. `prune-data --keep-days 100 --dry-run` shows what would go, and `prune-data --keep-days 100` drops whole days of `trades` partitions and the `launch_scores` and `holder_snapshots` of launches created before the kept window. Launch rows and outcomes stay, so dev history keeps working. Keep at least 100 days so the 90-day wallet rankings and your backtest windows still have their data.

## Rollout plan

The order matters. Each step produces the evidence the next one needs.

| When | What | Commands |
|------|------|----------|
| Weeks 1 to 2 | **Record.** Deploy with `MODULES=recorder,scorer,tracker,dashboard`. Check the dashboard's Recorder tab daily: gaps, outcome coverage, trades per launch. | `start` |
| End of week 2 | **Rank wallets and fetch their history.** | `rank-wallets`, then `backfill-wallets --top 200`, then `rank-wallets` again |
| | **Tune the scorer** on the first 10 days, then backtest on the last 4 days. Testing on data the weights never saw keeps the result honest. | `tune-scorer --checkpoint 30 --label rugged --to 2026-11-10` (the new weights are stored but not active), then `backtest --from 2026-11-10 --to 2026-11-14 --weights <version printed by tune-scorer> --walk-forward`, then `export-dataset --checkpoint 30 --out scorer.csv` for SNYPRA's optimizer |
| | **Activate the weights** if the backtest's expectancy interval and the dashboard's Scorer calibration look right. Restart the services so they load the new weights. | `tune-scorer ... --activate` |
| Weeks 3 to 6 | **Paper trade.** Add `trader` to `MODULES` with `TRADING_MODE=paper` (or deploy the optional trading service) until you have **300 or more closed trades**. Fix the strategy using the breakdowns and the `cut` and `scale` hints: risk buckets, hours, exit reasons. | `report --mode paper` |
| Then | **Live, dry run.** Set `TRADING_MODE=live`, `LIVE_DRY_RUN=true` and a hot wallet key. Every order is built and simulated against the chain, never sent. Check the logs for `dry run simulated` with `ok: true` on both a bonding-curve coin and a migrated (PumpSwap) coin. | `start` |
| Then | **Live, small.** Set `LIVE_DRY_RUN=false` with a small `risk.startingBankrollSol` and a small hot wallet balance. Every live position also opens a paper shadow position, so the two can be compared on the same signals. | `start` |
| Weekly | **Compare live against paper.** On the dashboard's Paper vs Live tab, check the mean PnL gap with its interval, the entry and exit fill gaps in bps and the failed-fill rates. If paper is too optimistic, raise `execution.latencySlots`, `failureRate` or the fees until paper matches live, then re-read your paper results with the new settings. | `report --mode live` |

Do not size up on a small sample. `report` and the dashboard print how many more trades are needed before the expectancy interval excludes zero.

## Command line

Run commands with `node dist/src/main.js <command>`, or `npx tsx src/main.ts <command>` in development. Every command reads the environment, and `--config` overrides `STRATEGY_CONFIG`. Exit codes: 0 ok, 1 failure, 2 usage error. `help` prints all the options.

| Command | Purpose |
|---------|---------|
| `start` | Run the services listed in `MODULES`. Shuts down cleanly on SIGINT and SIGTERM: stops the stream, finishes in-flight orders, flushes writers and closes the database. |
| `migrate` | Apply database migrations. |
| `backtest --from 2026-10-01 --to 2026-10-15 [--label x] [--config f] [--weights file-or-version] [--allow-in-sample] [--walk-forward] [--include-incomplete] [--json]` | Replay a date range (UTC, `--to` exclusive). It records a `strategy_runs` row with mode `backtest`, prints the report and stores the summary on the run. |
| `tune-scorer --checkpoint 30 --label rugged [--from --to] [--activate] [--write-file] [--version name]` | Fit weights against `rugged`, `died`, `survived_15m` or `migrated`. Prints feature AUCs and validation AUC, then stores the new version. It uses only launches older than `recorder.outcome.finalizeAfterHours`, whose labels are final, and keeps the `solo` weights of the current model. |
| `export-dataset --checkpoint 30 --out scorer.csv [--from --to] [--quote SOL]` | Write one row per launch with every feature and outcome label, for SNYPRA's optimizer. Use `--out -` for stdout. Launches younger than `recorder.outcome.finalizeAfterHours` are left out because their labels can still change. |
| `rank-wallets [--as-of 2026-10-15]` | Rank wallets now, or as of a past time using only data before it. |
| `backfill-wallets [--top 200] [--since-days 90]` | Fetch on-chain history for the latest ranking's top wallets. Needs `RPC_HTTP_URL`. |
| `report [--run 12 \| --mode paper] [--from --to]` | Expectancy, interval, verdict and breakdowns. In live mode it adds the paper vs live comparison. |
| `sweep [--dry-run]` | One manual sweep from hot to cold. Live open positions block it. |
| `reset-kill --run 12 [--reason "..."]` | Clear the drawdown kill switch. A running trader picks the reset up within 30 seconds. |
| `recompute-outcomes [--from --to]` | Relabel outcomes after changing `recorder.outcome` settings. Defaults to the last 30 days. |
| `prune-data --keep-days 100 [--dry-run]` | Free disk space: drop trade partitions, launch scores and holder snapshots older than the kept window. |

How a backtest works:

- **Data.** It replays every launch created in the window, with its trades, completions and migrations, in block order. A launch whose data became incomplete (a stream gap, a recorder restart hole or a dropped write) is replayed in full but not entered from the moment its data became incomplete (skip reason `incomplete_data`), unless `--include-incomplete` is set. The live trader matches this: after a stream gap it does not enter launches created before the gap. Launches are never dropped because they were still alive when a gap happened.
- **Timing.** Each event becomes visible at the time the recorder received it (`trades.received_at`, `launches.observed_at`), never at the whole block second, so signals, fills and exits wait for the same stream latency they faced live. Rows recorded before receive times were stored use the block time plus 1.5 seconds.
- **Scorer weights.** Without `--weights`, the backtest uses the active weights, then `scorer.weightsFile`, then the hand-set defaults, skipping any weights fitted on data from the backtest window or later (the training range stored by `tune-scorer`, or the save time when no range was given). The report shows which weights were used and their training range. `--weights` or `--allow-in-sample` uses in-sample weights anyway, and the report then marks them `IN-SAMPLE`.
- **Shared code.** It runs the live scorer (replay mode), signal engine, paper executor, exit engine, risk manager and trader.
- **Time.** A virtual clock drives everything, so latency, score checkpoints, time stops and daily limits behave as they would live.
- **No lookahead.**
  - Deep scorer features (funding clusters, fresh wallets, socials, copycats, dev history) are read from the `launch_scores` rows written live, as of their `computed_at`.
  - Tracked wallets come from the newest published `wallet_rank_runs` row that was available at the replay time: a point-in-time ranking at its `as_of`, a ranking made live or from the CLI at the later of `as_of` and `ran_at`. `--walk-forward` first creates rankings at each rerank interval inside the window, using only data before each one. Those runs are labelled `walk-forward`, are used only by that backtest and are never shown to live readers or SNYPRA.
  - The copycat detector starts from the launches and volume recorded in the window before the start time, live and in replay alike.
- **End of run.** Positions still open at the end are closed at the last quote.
- **Determinism.** The same data and config give the same trades. The report prints a fingerprint so you can check.

## Configuration

**Strategy knobs.** `config/strategy.json` sets every knob explicitly, and `src/config/strategy.ts` validates it.

- It matches the code defaults. `execution.ataRentLamports` is the 1,513,840 lamports measured for pump token accounts on mainnet in October 2026.
- The main knobs:
  - **Entries:** `signals.enabled`, `tracker.convergence` (window, minimum wallets, maximum risk score)
  - **Sizing and limits:** `risk.*`
  - **Exits:** `exits.*`
  - **Paper realism:** `execution.latencySlots`, `failureRate` and the fee defaults
  - **Scorer:** `scorer.maxRisk`, `scorer.hardBlocks`, and `scorer.deepIntel.minClusterCoverage` (below this share of buyers with wallet intel, funding-cluster features count as unknown instead of clean)
  - **Signal freshness:** `tracker.convergence.maxScoreAgeSec` (an older checkpoint score is recomputed before a signal fires)

**Secrets and infrastructure.** These come from environment variables, documented in `.env.example`.

## SNYPRA integration points

- **Buy-blockers.** Read the latest score for a mint from Postgres:
  ```sql
  SELECT score, hard_blocked, flags, checkpoint_sec, computed_at
  FROM analytics_latest_launch_scores WHERE mint = $1;
  ```
  Block when `hard_blocked` is true, or when `score` is above your threshold (`scorer.maxRisk` is 55 by default). The score is the larger of the weighted mean of all features and the strongest single red flag (each feature's `solo` weight times its risk), so one strong signal is not diluted by clean ones: under the default weights a dev who has sold a quarter of his tokens scores 60 and a full dump 80. A flag `solo_<feature>` names the feature that set the score. Blocking on the `dev_dumped` and `serial_rugger` flags as well costs nothing.
- **HTTP.** `GET /api/score/:mint` with `Authorization: Bearer $DASHBOARD_TOKEN` returns the in-memory score when service A has it, otherwise the latest row from the database. It returns 404 `not_scored` when the launch is unknown.
- **Optimizer dataset.** Both give one row per launch and checkpoint, with every feature and outcome label:
  - `GET /api/export/scorer-dataset.csv?checkpoint=30` streams it with `f_`-prefixed feature columns and `o_`-prefixed outcome columns, plus flags and the weights version (token required). It leaves out launches younger than `recorder.outcome.finalizeAfterHours`, whose labels can still change; `&all=1` returns every row.
  - `export-dataset` writes the scorer's fixed column layout, the same column order the tuner uses, from the command line.
- **Signals.** The `signals` table and `GET /api/signals/recent`. Read rows by their `run_id`:

  | `run_id` | `acted` | `skip_reason` | Meaning |
  |----------|---------|---------------|---------|
  | null | false | null | Observed by service A and accepted by the signal filters |
  | null | false | set | Observed by service A and rejected; the reason says why |
  | a run id | true | null | Service B traded it |
  | a run id | false | set | Service B skipped it; the reason says why |

- **Tracked wallets.** `GET /api/wallets/tracked`, or the view `snypra_tracked_wallets` (the tracked rows of the latest published ranking). Do not join `wallet_ranks` to the latest `wallet_rank_runs` row yourself: that table also holds private walk-forward backtest runs (`params->>'label' = 'walk-forward'`).

## Safety notes for live trading

- **Hot wallet.** Holds only the trading bankroll plus a fee reserve (`risk.minFeeReserveSol`). Its key is the only secret the bot needs (`HOT_WALLET_SECRET_KEY`). Set it as a Railway variable on the trading service only, and never commit it. `.gitignore` excludes `.env`, `keys` and `*.keypair.json`.
- **Cold wallet.** Give the bot only its address (`COLD_WALLET_ADDRESS`), never its key. The sweeper:
  - sends profits above `sweeper.hotTargetSol` plus `reserveSol` to that address
  - refuses PDAs and the hot wallet itself
  - never sweeps while positions are open
  - records every sweep in `sweeps`
- **Dry run first.** `LIVE_DRY_RUN` defaults to `true`, so turning on `TRADING_MODE=live` only simulates. Set it to `false` deliberately, after a dry run on both a curve coin and a migrated coin.
- **Kill switch.** Trips at `risk.killSwitchDrawdownFraction` (a drawdown from peak equity; it and `risk.dailyLossLimitFraction` must be above 0 and at most 1, and both need an actual loss to trip) and flattens everything when `risk.flattenOnKill` is true. Resetting it is manual: `reset-kill --run <id>`. The daily loss halt resets at `risk.dayResetUtcHour`.
- **Unconfirmed fills.** The live executor never resends a transaction whose fate is unknown. It reconciles the signature later, so a slow confirmation cannot become a double buy. A buy still unknown after that is settled from the wallet once its blockhash has expired: tokens found become the position (fill note `fill_from_wallet_balance`, cost estimated at the full budget plus rent and fees), an empty wallet releases the entry.
- **Wallet checks.** When a sell is refused because the wallet holds too few tokens, or its outcome stays unknown, and on every restart, the trader compares the position with the hot wallet. Tokens that left the wallet some other way are booked at the current quote as exit reason `external_or_unknown_exit` (fill note `external_exit_estimated`). Treat those amounts as estimates.
- **Hot wallet balance.** It is polled every 15 seconds, and sizing never exceeds what the wallet holds minus the fee reserve.
- **A trader that is down manages nothing.** While the trading process is stopped, open positions get no stop loss, trailing stop or time stop. Railway restarts it after any exit, and on start it waits up to 10 minutes for Postgres and then restores its open positions. If the dashboard or Railway shows the trader down for longer, check the open positions and the hot wallet by hand.

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

`/healthz` needs no token, and on a service that also records it answers 503 until the stream has delivered data. Every other route needs `DASHBOARD_TOKEN`, and the service will not start the dashboard without a token of at least 24 characters. `DASHBOARD_ALLOW_OPEN=true` serves the API without a token, for a private network only. A token that is set is always required.

## Development

- `npm run check` runs the typecheck and all tests.
- Database tests need `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`. Each test file creates and drops its own database.
- Source and test files contain no comments. `test/style.test.ts` enforces this.
- Amounts are `bigint` lamports or raw token units.
- Logic takes a `Clock` instead of calling `Date.now()`, so backtests replay deterministically.
- See `CLAUDE.md` and `docs/ARCHITECTURE.md` for conventions and verified pump.fun facts.
