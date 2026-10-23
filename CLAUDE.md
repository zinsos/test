# snypra-edge

Companion service to SNYPRA (the user's pump.fun trading bot on Railway). It records every pump.fun launch, scores launch risk, ranks smart wallets, simulates realistic fills, runs exits and risk limits, and reports expectancy. SNYPRA's code is not in this repo; integration is through Postgres tables and the HTTP API.

## Conventions

- No comments anywhere in source code. Names and small functions carry the meaning. `test/style.test.ts` enforces this.
- TypeScript strict, ESM, Node 22. Imports use `.js` suffixes.
- All lamport and token amounts are `bigint`. Convert to SOL only at the edges (analytics, logs, JSON).
- Postgres BIGINT columns come back as `bigint` (type parser in `src/db/pool.ts`). `COUNT(*)` is bigint too: cast with `::int` or use `toNumber`.
- Logic never calls `Date.now()` or `setTimeout` directly. Use the injected `Clock` (`src/core/clock.ts`) so backtests replay with a `VirtualClock`.
- Live and backtest share the same code paths: `MarketState` -> scorer -> signals -> trader -> executor -> exits -> risk. Never fork logic for backtests.
- No lookahead: anything used at decision time must have been knowable then. Dev history uses `launch_outcomes.outcome_known_at < decision time`. Wallet rankings use the latest `wallet_rank_runs.as_of <= decision time`. Deep scorer features are read from `launch_scores` rows computed live.
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
