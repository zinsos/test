# snypra-edge

Companion service to SNYPRA (the user's pump.fun trading bot on Railway). It records every pump.fun launch, scores launch risk, ranks smart wallets, simulates realistic fills, runs exits and risk limits, and reports expectancy. SNYPRA's code is not in this repo; integration is through Postgres tables and the HTTP API.

## Conventions

- No comments anywhere in source code. Names and small functions carry the meaning. `test/style.test.ts` enforces this.
- TypeScript strict, ESM, Node 22. Imports use `.js` suffixes.
- All lamport and token amounts are `bigint`. Convert to SOL only at the edges (analytics, logs, JSON).
- Postgres BIGINT columns come back as `bigint` (type parser in `src/db/pool.ts`). `COUNT(*)` is bigint too: cast with `::int` or use `toNumber`.
- Logic never calls `Date.now()` or `setTimeout` directly. Use the injected `Clock` (`src/core/clock.ts`) so backtests replay with a `VirtualClock`.
- Live and backtest share the same code paths: `MarketState` -> scorer -> signals -> trader -> executor -> exits -> risk. Never fork logic for backtests.
- No lookahead: anything used at decision time must have been knowable then. Dev history uses `launch_outcomes.outcome_known_at < decision time`. Backtests use the newest published wallet ranking available at decision time: live/CLI-now reranks (`params.historyKnownBeforeMs` null) become available at `max(as_of, ran_at)`, point-in-time runs at `as_of`, and walk-forward runs (`params.label = 'walk-forward'`) are private to the backtest that made them (filter with `PUBLISHED_RUN_SQL`). Deep scorer features are read from `launch_scores` rows computed live. Replay advances the clock to each event's receive time (`trades.received_at`, `launches.observed_at`), not the block second. The copycat trending window is seeded from the DB window before the clock's now.
- Schema changes go in new numbered files in `migrations/`. Never edit an applied migration.
- Config: secrets and infra in env (`src/config/env.ts`), strategy knobs in `config/strategy.json` validated by `src/config/strategy.ts` (zod 4: nested defaults use `.prefault({})`).

## pump.fun facts (verified against pump-fun/pump-public-docs, October 2026)

- Programs: Pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, Fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`.
- Events are Anchor events in `Program data:` log lines. Decoding is IDL-driven from `idl/pump.json` and `idl/pump_amm.json` and tolerates shorter historical layouts. Update the IDLs from the official repo when pump.fun ships changes.
- `TradeEvent` has variable-length fields mid-struct (`ix_name`, `shareholders`), so fixed offsets are wrong.
- Coins can be quoted in SOL, USDC or another pump coin (`quote_mint`). Trading here is SOL-quoted only; the recorder stores everything.
- Fees are tiered by market cap. Use the bps reported in the latest `TradeEvent` for a mint.
- Buys: user pays `quote_amount + fee + creator_fee`. Sells: user receives `quote_amount - fee - creator_fee`.
- v3 trades keep fees on the curve; `fee_recipient` is the zero key in those events.
- Synthetic migration: a v3 buy that empties the curve emits `TradeEvent`, `CompleteEvent`, `PostCompleteBuyEvent`.
- PumpSwap pricing uses effective quote reserves = vault amount + signed `virtual_quote_reserves` (i128, can be negative).
- Solana now has version 1 transactions: `getTransaction` needs `maxSupportedTransactionVersion: 1`.

## Local development

- Local Postgres 16 is available in cloud sessions: `service postgresql start`, user `postgres` / password `postgres`, databases `snypra_dev` and `snypra_test`.
- The sandbox cannot reach Solana RPC. Real transaction fixtures live in `test/fixtures/`.
- `npm run check` runs typecheck and tests.

## Memory log

- 2026-10-23: Project created. Repo previously held only stray assets (cog.png, info.png, fontz.ttf), removed.
- 2026-10-23: Integration verified end to end (`test/e2e.*.test.ts`): websocket stream to recorder and scorer; synthetic market recorded through the live recorder, scorer and finalizer, then `rank-wallets` and `backtest` via the CLI; the live paper trader service trades the same window identically to the backtest. Rug labels compare the post-dump low with the price inside the rug window, not the all-time peak (a dev exit after a natural fade is not a rug). Scorer checkpoints below `minBuyersForDeep` read stored `wallet_intel` rows (checked at or before now) instead of only process memory, so every service scores a launch the same way. Ingest gaps mark in-memory launches incomplete in every process and the trader skips them.
- 2026-10-23: Adversarial review round fixed (three areas) and verified. Lessons:
  - Live money: before sending a live buy the trader writes a `positions` row with status `pending`; restarts resolve it from the hot wallet after the blockhash expiry (`MAX_BLOCKHASH_AGE_MS`). Unknown buys are adopted from the wallet balance (note `fill_from_wallet_balance`); tokens missing from the wallet are booked as an external exit (`external_or_unknown_exit`, note `external_exit_estimated`). `Trader.halt()` must run before anything that could still send (stop, lost trading lock). Paper and backtest executors have no `tokenBalance`, so none of this touches backtests.
  - Code that counts or filters positions must handle three statuses (`pending`, `open`, `closed`). `countOpenPositions` and `loadOpenPositions` include `pending`.
  - Only canonical PumpSwap pools (`src/chain/pda.ts`) are trusted, in `MarketState` and in the live builder. Tracker wallet history (`src/tracker/txParse.ts`) still attributes trades in any PumpSwap pool, including WSOL-base and USDC pools from mainnet fixtures.
  - Scores are `max(weighted mean, max solo*risk)`; a dev dump alone now scores 60 to 80. `config/scorer-weights.json` must equal `DEFAULT_WEIGHTS` (tested). `execution.ataRentLamports` default is 1_513_840 (measured), and `config/strategy.json` must equal the code defaults (tested).
  - Services without recorder/scorer use `createScorerModule({ intelMode: 'stored' })`; a scorer without RPC but with a DB also reads stored intel, so every service scores alike.
  - SNYPRA must read tracked wallets from the `snypra_tracked_wallets` view or the API, never a raw join to the latest `wallet_rank_runs`.
  - `test/review/` is for adversarial repros only and must be empty (deleted) when a round ends; every repro becomes a permanent test in the matching `test/<area>.*.test.ts`.
  - Harness checkpoint commits (`Work in progress: ...`) can appear mid-round; diff a round against the last real build commit, not `HEAD`.
