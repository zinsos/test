import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeLogs, type DecodedChainEvent, type PoolCreatedEvent, type PoolTradeEvent } from "../src/chain/events.js";
import { canonicalPumpPoolAddress } from "../src/chain/pda.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ChainEvent, IngestGap, LaunchCreatedEvent, MigrationEvent } from "../src/core/types.js";
import { createIngestModule } from "../src/ingest/index.js";
import { IngestPipeline, poolTradeToChain } from "../src/ingest/pipeline.js";
import { ReplayLogSource, type ReplayTransaction } from "../src/ingest/replaySource.js";
import { MarketState } from "../src/market/state.js";

interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number;
  category: string;
  logs: string[];
}

const fixtures = (
  JSON.parse(readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")) as FixtureTx[]
).sort((a, b) => a.slot - b.slot);

function decodeTx(tx: FixtureTx): DecodedChainEvent[] {
  return decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events;
}

function fixtureBySignature(prefix: string): FixtureTx {
  const tx = fixtures.find((candidate) => candidate.signature.startsWith(prefix));
  if (!tx) {
    throw new Error(`fixture ${prefix} missing`);
  }
  return tx;
}

function syntheticCreateFor(migration: MigrationEvent, template: LaunchCreatedEvent): ReplayTransaction & { event: LaunchCreatedEvent } {
  const event: LaunchCreatedEvent = {
    ...template,
    mint: migration.mint,
    bondingCurve: migration.bondingCurve,
    tx: { ...template.tx, signature: `synthetic-${migration.mint}`, slot: migration.tx.slot - 500 },
    timestampMs: migration.timestampMs - 200_000
  };
  return { signature: event.tx.signature, slot: event.tx.slot, logs: [], event };
}

function createTemplate(): LaunchCreatedEvent {
  const create = decodeTx(fixtureBySignature("K48XDQLk")).find((event): event is LaunchCreatedEvent => event.kind === "create");
  if (!create) {
    throw new Error("template missing");
  }
  return create;
}

function migrationIn(prefix: string): MigrationEvent {
  const migration = decodeTx(fixtureBySignature(prefix)).find((event): event is MigrationEvent => event.kind === "migrate");
  if (!migration) {
    throw new Error("migration missing");
  }
  return migration;
}

function harness(poolLookup?: (pool: string) => string | undefined): {
  market: MarketState;
  bus: Bus;
  pipeline: IngestPipeline;
  events: ChainEvent[];
  gaps: IngestGap[];
} {
  const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
  const bus = new Bus();
  const clock = new VirtualClock(1_792_767_900_000);
  const pipeline = new IngestPipeline({ market, bus, clock, poolLookup });
  const events: ChainEvent[] = [];
  const gaps: IngestGap[] = [];
  bus.on("chain", (event) => events.push(event));
  bus.on("gap", (gap) => gaps.push(gap));
  return { market, bus, pipeline, events, gaps };
}

function feedCreate(pipeline: IngestPipeline, event: LaunchCreatedEvent): void {
  pipeline.handleBatch(
    { events: [event], truncated: false, incomplete: 0, unknown: 0 },
    { signature: event.tx.signature, slot: event.tx.slot, seq: event.tx.seq, receivedAtMs: event.tx.receivedAtMs }
  );
}

describe("ingest pipeline", () => {
  it("applies every fixture event in order and emits resolved chain events on the bus", async () => {
    const { market, pipeline, events } = harness();
    const source = new ReplayLogSource({ clock: new VirtualClock(0), transactions: fixtures });
    await pipeline.attach(source);
    const creates = events.filter((event) => event.kind === "create");
    expect(creates).toHaveLength(8);
    expect(market.size).toBe(8);
    const devBuyTx = fixtureBySignature("K48XDQLk");
    const fromTx = events.filter((event) => event.tx.signature === devBuyTx.signature);
    expect(fromTx.map((event) => event.kind)).toEqual(["create", "trade"]);
    const mint = fromTx[0]?.kind === "create" ? fromTx[0].mint : "";
    expect(market.get(mint)?.trades).toHaveLength(1);
    const seqs = events.map((event) => event.tx.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const stats = pipeline.stats();
    expect(stats.unresolvedPoolTrades).toBeGreaterThan(20);
    expect(stats.emitted).toBe(events.length);
    expect(stats.marketLaunches).toBe(8);
  });

  it("ignores pool trades of unknown pools, including the pump quote swap inside a create", () => {
    const { pipeline, events } = harness();
    const tx = fixtureBySignature("4K4iSwphGH");
    const decoded = decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 });
    pipeline.handleBatch(decoded, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 });
    expect(events.map((event) => event.kind)).toEqual(["create", "trade"]);
    expect(events.every((event) => event.kind !== "trade" || event.venue === "curve")).toBe(true);
    expect(pipeline.stats().unresolvedPoolTrades).toBe(1);
  });

  it("registers the pool from a migration before the pool buy in the same transaction", () => {
    const { market, pipeline, events } = harness();
    const migration = migrationIn("GK5Z3vZ6WS");
    const create = syntheticCreateFor(migration, createTemplate());
    feedCreate(pipeline, create.event);
    const tx = fixtureBySignature("GK5Z3vZ6WS");
    const decoded = decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 2, receivedAtMs: 0 });
    expect(decoded.events.map((event) => event.kind)).toEqual(["poolCreated", "migrate", "poolTrade"]);
    pipeline.handleBatch(decoded, { signature: tx.signature, slot: tx.slot, seq: 2, receivedAtMs: 0 });
    expect(events.map((event) => event.kind)).toEqual(["create", "migrate", "trade"]);
    const poolTrade = events[2];
    expect(poolTrade?.kind === "trade" && poolTrade.venue).toBe("pool");
    expect(poolTrade?.kind === "trade" && poolTrade.mint).toBe(migration.mint);
    expect(poolTrade?.kind === "trade" && poolTrade.pool).toBe(migration.pool);
    const launch = market.get(migration.mint);
    expect(launch?.migrated).toBe(true);
    expect(launch?.pool).toBe(migration.pool);
    expect(launch?.trades.at(-1)?.venue).toBe("pool");
    expect(market.mintForPool(migration.pool)).toBe(migration.mint);
  });

  it("ignores a permissionless PumpSwap pool for a coin still on its curve and after it migrated", () => {
    const { market, pipeline, events } = harness();
    const migration = migrationIn("GK5Z3vZ6WS");
    const create = syntheticCreateFor(migration, createTemplate());
    feedCreate(pipeline, create.event);
    const tx = fixtureBySignature("GK5Z3vZ6WS");
    const decoded = decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 2, receivedAtMs: 0 });
    const realTrade = decoded.events.find((event): event is PoolTradeEvent => event.kind === "poolTrade");
    if (!realTrade) {
      throw new Error("pool trade missing");
    }
    const attackerPool = Keypair.generate().publicKey.toBase58();
    const attackerTx = { ...realTrade.tx, signature: "attacker", slot: migration.tx.slot - 10 };
    const attackerCreate: PoolCreatedEvent = {
      kind: "poolCreated",
      tx: attackerTx,
      pool: attackerPool,
      baseMint: migration.mint,
      quoteMint: "SOL",
      coinCreator: null,
      timestampMs: migration.timestampMs - 10_000
    };
    const attackerTrade: PoolTradeEvent = {
      ...realTrade,
      tx: { ...attackerTx, eventIndex: 1 },
      pool: attackerPool,
      virtualTokenReserves: 1_000_000n,
      virtualQuoteReserves: 900_000_000_000n
    };
    const launch = market.get(migration.mint);
    const reservesBefore = launch?.virtualQuoteReserves;
    pipeline.handleBatch(
      { events: [attackerCreate, attackerTrade], truncated: false, incomplete: 0, unknown: 0 },
      { signature: "attacker", slot: attackerTx.slot, seq: 1, receivedAtMs: 0 }
    );
    expect({ migrated: launch?.migrated, pool: launch?.pool, reserves: launch?.virtualQuoteReserves }).toEqual({
      migrated: false,
      pool: null,
      reserves: reservesBefore
    });
    expect(market.mintForPool(attackerPool)).toBeUndefined();
    pipeline.handleBatch(decoded, { signature: tx.signature, slot: tx.slot, seq: 2, receivedAtMs: 0 });
    expect(launch?.pool).toBe(migration.pool);
    const afterMigration = launch?.virtualQuoteReserves;
    pipeline.handleBatch(
      { events: [attackerCreate, { ...attackerTrade, tx: { ...attackerTrade.tx, slot: tx.slot + 5 } }], truncated: false, incomplete: 0, unknown: 0 },
      { signature: "attacker", slot: tx.slot + 5, seq: 3, receivedAtMs: 0 }
    );
    expect({ pool: launch?.pool, reserves: launch?.virtualQuoteReserves }).toEqual({ pool: migration.pool, reserves: afterMigration });
    expect(events.filter((event) => event.kind === "trade" && event.venue === "pool").map((event) => event.kind === "trade" && event.pool)).toEqual([
      migration.pool
    ]);
  });

  it("registers the canonical pool from its creation event alone", () => {
    const { market, pipeline } = harness();
    const migration = migrationIn("GK5Z3vZ6WS");
    feedCreate(pipeline, syntheticCreateFor(migration, createTemplate()).event);
    const tx = fixtureBySignature("GK5Z3vZ6WS");
    const created = decodeTx(tx).find((event): event is PoolCreatedEvent => event.kind === "poolCreated");
    expect(created?.pool).toBe(canonicalPumpPoolAddress(migration.mint, "SOL"));
    pipeline.handleBatch(
      { events: created ? [created] : [], truncated: false, incomplete: 0, unknown: 0 },
      { signature: tx.signature, slot: tx.slot, seq: 2, receivedAtMs: 0 }
    );
    expect(market.mintForPool(migration.pool)).toBe(migration.mint);
    expect(canonicalPumpPoolAddress(migration.mint, "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn")).not.toBe(migration.pool);
    expect(canonicalPumpPoolAddress("not a key", "SOL")).toBeNull();
  });

  it("falls back to the pool lookup for launches that are no longer in memory", () => {
    const migration = migrationIn("4uaZFYCyDw");
    const lookups: string[] = [];
    const { market, pipeline, events } = harness((pool) => {
      lookups.push(pool);
      return pool === migration.pool ? migration.mint : undefined;
    });
    const tx = fixtureBySignature("4uaZFYCyDw");
    const decoded = decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 });
    pipeline.handleBatch(decoded, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 });
    expect(events.map((event) => event.kind)).toEqual(["migrate", "trade"]);
    expect(events[1]?.kind === "trade" && events[1].mint).toBe(migration.mint);
    expect(lookups).toEqual([migration.pool]);
    expect(market.size).toBe(0);
    expect(pipeline.stats().poolLookupHits).toBe(1);
    expect(pipeline.stats().notInMemory).toBe(2);
  });

  it("lets the pool lookup be wired after construction", () => {
    const migration = migrationIn("4uaZFYCyDw");
    const { pipeline, events } = harness();
    pipeline.setPoolLookup((pool) => (pool === migration.pool ? migration.mint : undefined));
    const tx = fixtureBySignature("4uaZFYCyDw");
    pipeline.handleBatch(decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 1, receivedAtMs: 0 }), {
      signature: tx.signature,
      slot: tx.slot,
      seq: 1,
      receivedAtMs: 0
    });
    expect(events.filter((event) => event.kind === "trade")).toHaveLength(1);
  });

  it("forwards source gaps to the bus", async () => {
    const { pipeline, gaps } = harness();
    const source = new ReplayLogSource({ clock: new VirtualClock(0) });
    await pipeline.attach(source);
    const gap: IngestGap = { source: "ws", fromSlot: 1, toSlot: 9, startedAtMs: 10, endedAtMs: 20, reason: "closed 1006" };
    source.reportGap(gap);
    expect(gaps).toEqual([gap]);
    expect(pipeline.stats().gaps).toBe(1);
  });

  it("marks in-memory launches created at or before the gap start as incomplete before emitting the gap", () => {
    const { market, bus, pipeline } = harness();
    const template = createTemplate();
    const early = { ...template, mint: "EarlyMint1111111111111111111111111111111111", tx: { ...template.tx, slot: 100 }, timestampMs: 1_000 };
    const late = { ...template, mint: "LateMint11111111111111111111111111111111111", tx: { ...template.tx, slot: 300 }, timestampMs: 9_000 };
    feedCreate(pipeline, early);
    feedCreate(pipeline, late);
    const seenOnGap: boolean[] = [];
    bus.on("gap", () => seenOnGap.push(market.get(early.mint)?.dataComplete ?? true));
    pipeline.handleGap({ source: "ws", fromSlot: 200, toSlot: 250, startedAtMs: 5_000, endedAtMs: 6_000, reason: "closed 1006" });
    expect(market.get(early.mint)?.dataComplete).toBe(false);
    expect(market.get(late.mint)?.dataComplete).toBe(true);
    expect(seenOnGap).toEqual([false]);
    pipeline.handleGap({ source: "ws", fromSlot: null, toSlot: null, startedAtMs: 8_000, endedAtMs: 10_000, reason: "restart" });
    expect(market.get(late.mint)?.dataComplete).toBe(false);
    expect(pipeline.stats().launchesMarkedIncomplete).toBe(2);
  });

  it("keeps processing later events when one event fails to apply", () => {
    const { market, pipeline, events } = harness();
    const template = createTemplate();
    feedCreate(pipeline, template);
    const launch = market.get(template.mint);
    if (!launch) {
      throw new Error("launch missing");
    }
    const original = launch.applyTrade.bind(launch);
    let calls = 0;
    launch.applyTrade = (event, maxTrades) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("boom");
      }
      return original(event, maxTrades);
    };
    const tx = fixtureBySignature("K48XDQLk");
    const trades = decodeTx(tx).filter((event) => event.kind === "trade");
    pipeline.handleBatch(
      { events: [...trades, ...trades], truncated: false, incomplete: 0, unknown: 0 },
      { signature: tx.signature, slot: tx.slot, seq: 5, receivedAtMs: 0 }
    );
    expect(pipeline.stats().applyErrors).toBe(1);
    expect(events.filter((event) => event.kind === "trade")).toHaveLength(1);
  });

  it("converts pool trades into chain trades without losing fields", () => {
    const tx = fixtureBySignature("4uaZFYCyDw");
    const poolTrade = decodeTx(tx).find((event): event is PoolTradeEvent => event.kind === "poolTrade");
    if (!poolTrade) {
      throw new Error("pool trade missing");
    }
    const chain = poolTradeToChain(poolTrade, "Mint");
    expect(chain.kind).toBe("trade");
    expect(chain.mint).toBe("Mint");
    expect(chain.venue).toBe("pool");
    expect(chain.pool).toBe(poolTrade.pool);
    expect(chain.userQuote).toBe(poolTrade.userQuote);
    expect(chain.virtualQuoteReserves).toBe(poolTrade.virtualQuoteReserves);
  });
});

describe("ingest module", () => {
  it("wires a provided source through the pipeline and stops it", async () => {
    const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const bus = new Bus();
    const clock = new VirtualClock(0);
    const source = new ReplayLogSource({ clock, transactions: fixtures.filter((tx) => tx.category === "create") });
    const module = createIngestModule({
      env: { RPC_WS_URL: undefined, RPC_HTTP_URL: undefined, STREAM_COMMITMENT: "confirmed" },
      clock,
      market,
      bus,
      source
    });
    const seen: ChainEvent[] = [];
    bus.on("chain", (event) => seen.push(event));
    await module.start();
    expect(seen.filter((event) => event.kind === "create")).toHaveLength(8);
    expect(module.stats().pipeline?.emitted).toBe(seen.length);
    await module.stop();
    expect(source.push(fixtures[0] as ReplayTransaction)).toBe(false);
  });

  it("builds a websocket source from the environment", () => {
    const module = createIngestModule({
      env: { RPC_WS_URL: "ws://127.0.0.1:1", RPC_HTTP_URL: undefined, STREAM_COMMITMENT: "processed" },
      clock: new VirtualClock(0),
      market: new MarketState({ maxTradesPerLaunch: 10, evictInactiveMs: 1, evictMaxAgeMs: 1, quoteMints: null }),
      bus: new Bus()
    });
    expect(module.source.name).toBe("ws");
  });
});
