import { createMarket } from "../src/app/context.js";
import type { StrategyConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { Db } from "../src/db/pool.js";
import { IngestPipeline } from "../src/ingest/pipeline.js";
import { createRecorderModule } from "../src/recorder/index.js";
import { createScorerModule } from "../src/scorer/index.js";
import { decodeResultOf, ScenarioIntelRpc, simulateScenario, type Scenario } from "./e2e.market.js";

const HOUR_MS = 3_600_000;
export const STREAM_LAG_MS = 400;

export interface RecordingResult {
  transactions: number;
  events: number;
  recorder: Record<string, Record<string, number>>;
  pipeline: Record<string, number>;
  intelRpc: { signatures: number; transactions: number };
  clockErrors: unknown[];
}

export async function recordScenario(db: Db, scenario: Scenario, config: StrategyConfig): Promise<RecordingResult> {
  const clock = new VirtualClock(scenario.t0Ms - 60_000);
  const bus = new Bus();
  const market = createMarket(config, null);
  const intelRpc = new ScenarioIntelRpc(scenario.profiles);
  const recorder = createRecorderModule({
    db,
    rpc: null,
    bus,
    market,
    clock,
    config,
    env: { METADATA_GATEWAY: undefined },
    marketEviction: { intervalSec: 60 }
  });
  const scorer = createScorerModule({ db, rpc: intelRpc, bus, market, clock, config: config.scorer, mode: "live", persistScores: true });
  const pipeline = new IngestPipeline({ market, bus, clock, poolLookup: recorder.poolLookup });
  await recorder.start();
  await scorer.start();
  const transactions = simulateScenario(scenario);
  let events = 0;
  for (const tx of transactions) {
    await clock.advanceTo(tx.atMs + STREAM_LAG_MS);
    pipeline.handleBatch(decodeResultOf(tx, clock.nowMs()), {
      signature: tx.signature,
      slot: tx.slot,
      seq: tx.events[0]?.tx.seq ?? 0,
      receivedAtMs: clock.nowMs()
    });
    events += tx.events.length;
  }
  const finalizeBy = scenario.lastLaunchMs + (config.recorder.outcome.finalizeAfterHours + 1) * HOUR_MS;
  for (let at = clock.nowMs() + HOUR_MS; at <= finalizeBy; at += HOUR_MS) {
    await clock.advanceTo(at);
  }
  await recorder.service.settleInflight();
  await scorer.stop();
  await recorder.stop();
  return {
    transactions: transactions.length,
    events,
    recorder: recorder.stats(),
    pipeline: pipeline.stats(),
    intelRpc: { signatures: intelRpc.signatureCalls, transactions: intelRpc.transactionCalls },
    clockErrors: clock.drainErrors()
  };
}
