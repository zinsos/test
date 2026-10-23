import type { SignalsConfig, TrackerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { ScoreProvider, TrackedWalletProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { ChainEvent, LaunchScore, Pubkey, Signal, SignalType, TradeEvent } from "../core/types.js";
import type { LaunchState } from "../market/state.js";

const log = moduleLogger("tracker-signals");

export type LaunchLookup =
  | { get(mint: Pubkey): LaunchState | undefined }
  | { launch(mint: Pubkey): LaunchState | undefined };

export type SignalRejectReason =
  | "quote_mint_not_allowed"
  | "launch_too_old"
  | "cooldown"
  | "no_score"
  | "hard_blocked"
  | "risk_too_high"
  | "low_buyer_rate"
  | "low_buy_sell_ratio"
  | "not_sol_quoted"
  | "mcap_out_of_band"
  | "buyers_exited";

export type RejectionListener = (signal: Signal, reason: SignalRejectReason) => void;

export interface SignalEngineOptions {
  clock: Clock;
  bus: Bus;
  market: LaunchLookup;
  scores: ScoreProvider;
  tracked: TrackedWalletProvider;
  signals: SignalsConfig;
  convergence: TrackerConfig["convergence"];
  onRejected?: RejectionListener | null;
  maxMints?: number;
  stateTtlMs?: number;
  pruneEveryEvents?: number;
}

export interface TrackedBuy {
  wallet: Pubkey;
  atMs: number;
  slot: number;
  rank: number | null;
  score: number | null;
}

export interface SignalEngineStats {
  mints: number;
  cooldowns: number;
  pending: number;
  trackedBuys: number;
  smartExits: number;
  evaluations: number;
  accepted: number;
  rejected: number;
  cooldownRepeats: number;
  repeatedRejections: number;
}

interface MintActivity {
  mint: Pubkey;
  buyers: Map<Pubkey, TrackedBuy>;
  exits: Map<Pubkey, number>;
  lastActivityMs: number;
  evaluating: boolean;
  recheckAtMs: number | null;
  reportedPrechecks: Set<SignalRejectReason>;
}

interface ScoreLookup {
  score: LaunchScore | null;
  waitedMs: number;
}

export function resolveLaunch(market: LaunchLookup, mint: Pubkey): LaunchState | undefined {
  return "launch" in market ? market.launch(mint) : market.get(mint);
}

export function tradeTimeMs(event: TradeEvent): number {
  return event.timestampMs > 0 ? event.timestampMs : event.tx.receivedAtMs;
}

function featureValue(score: LaunchScore, name: string): number | null {
  const value = score.features[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buyerMeta(buyers: readonly TrackedBuy[]): Array<Record<string, unknown>> {
  return buyers.map((buyer) => ({ wallet: buyer.wallet, atMs: buyer.atMs, slot: buyer.slot, rank: buyer.rank }));
}

function scoreMeta(score: LaunchScore | null, nowMs: number): Record<string, unknown> {
  if (!score) {
    return { scoreAvailable: false };
  }
  return {
    scoreAvailable: true,
    scoreCheckpointSec: score.checkpointSec,
    scoreComputedAtMs: score.computedAtMs,
    scoreAgeMs: nowMs - score.computedAtMs,
    scoreFlags: score.flags,
    scoreHardBlocked: score.hardBlocked,
    weightsVersion: score.weightsVersion
  };
}

export class SignalEngine {
  private readonly clock: Clock;
  private readonly bus: Bus;
  private readonly market: LaunchLookup;
  private readonly scores: ScoreProvider;
  private readonly tracked: TrackedWalletProvider;
  private readonly signals: SignalsConfig;
  private readonly convergence: TrackerConfig["convergence"];
  private readonly onRejected: RejectionListener | null;
  private readonly maxMints: number;
  private readonly stateTtlMs: number;
  private readonly pruneEveryEvents: number;
  private readonly activity = new Map<Pubkey, MintActivity>();
  private readonly cooldownUntil = new Map<Pubkey, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private stopped = false;
  private eventsSincePrune = 0;
  private readonly counters = {
    trackedBuys: 0,
    smartExits: 0,
    evaluations: 0,
    accepted: 0,
    rejected: 0,
    cooldownRepeats: 0,
    repeatedRejections: 0
  };

  constructor(options: SignalEngineOptions) {
    this.clock = options.clock;
    this.bus = options.bus;
    this.market = options.market;
    this.scores = options.scores;
    this.tracked = options.tracked;
    this.signals = options.signals;
    this.convergence = options.convergence;
    this.onRejected = options.onRejected ?? null;
    this.maxMints = options.maxMints ?? 20_000;
    this.stateTtlMs = options.stateTtlMs ?? Math.max(6 * 3_600_000, options.convergence.maxLaunchAgeSec * 2_000);
    this.pruneEveryEvents = options.pruneEveryEvents ?? 2_048;
  }

  start(): void {
    if (this.unsubscribers.length > 0) {
      return;
    }
    this.stopped = false;
    this.unsubscribers.push(this.bus.on("chain", (event) => this.onChain(event)));
    this.unsubscribers.push(this.bus.on("score", (score) => this.onScore(score)));
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.stopped = true;
    for (const release of [...this.waiters]) {
      release();
    }
    await Promise.allSettled([...this.pending]);
  }

  smartExitCount(mint: Pubkey, sinceMs: number): number {
    const exits = this.activity.get(mint)?.exits;
    if (!exits) {
      return 0;
    }
    let count = 0;
    for (const exitAtMs of exits.values()) {
      if (exitAtMs >= sinceMs) {
        count += 1;
      }
    }
    return count;
  }

  trackedBuyers(mint: Pubkey): TrackedBuy[] {
    const buyers = this.activity.get(mint)?.buyers;
    return buyers ? [...buyers.values()].sort((a, b) => a.atMs - b.atMs) : [];
  }

  isCoolingDown(mint: Pubkey, nowMs: number): boolean {
    const until = this.cooldownUntil.get(mint);
    return until !== undefined && nowMs < until;
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  stats(): SignalEngineStats {
    return {
      mints: this.activity.size,
      cooldowns: this.cooldownUntil.size,
      pending: this.pending.size,
      ...this.counters
    };
  }

  private enabled(type: SignalType): boolean {
    return this.signals.enabled.includes(type);
  }

  private onChain(event: ChainEvent): void {
    if (event.kind !== "trade") {
      return;
    }
    this.maybePrune();
    const tracked = this.tracked.isTracked(event.wallet);
    if (event.isBuy) {
      if (tracked) {
        this.onTrackedBuy(event);
      }
      return;
    }
    this.onSell(event, tracked);
  }

  private activityFor(mint: Pubkey, atMs: number): MintActivity {
    const existing = this.activity.get(mint);
    if (existing) {
      this.activity.delete(mint);
      this.activity.set(mint, existing);
      existing.lastActivityMs = Math.max(existing.lastActivityMs, atMs);
      return existing;
    }
    const created: MintActivity = {
      mint,
      buyers: new Map(),
      exits: new Map(),
      lastActivityMs: atMs,
      evaluating: false,
      recheckAtMs: null,
      reportedPrechecks: new Set()
    };
    this.activity.set(mint, created);
    return created;
  }

  private onTrackedBuy(event: TradeEvent): void {
    const launch = resolveLaunch(this.market, event.mint);
    if (!launch) {
      return;
    }
    const atMs = tradeTimeMs(event);
    const activity = this.activityFor(event.mint, atMs);
    if (activity.buyers.has(event.wallet)) {
      return;
    }
    const info = this.tracked.get(event.wallet);
    activity.buyers.set(event.wallet, {
      wallet: event.wallet,
      atMs,
      slot: event.tx.slot,
      rank: info?.rank ?? null,
      score: info?.score ?? null
    });
    this.counters.trackedBuys += 1;
    this.considerConvergence(launch, activity, atMs);
  }

  private onSell(event: TradeEvent, tracked: boolean): void {
    const existing = this.activity.get(event.mint);
    if (!tracked && !existing?.buyers.has(event.wallet)) {
      return;
    }
    if (existing?.exits.has(event.wallet)) {
      return;
    }
    const launch = resolveLaunch(this.market, event.mint);
    const position = launch?.wallets.get(event.wallet);
    if (!position || position.bought <= 0n || position.sold * 2n < position.bought) {
      return;
    }
    const atMs = tradeTimeMs(event);
    this.activityFor(event.mint, atMs).exits.set(event.wallet, atMs);
    this.counters.smartExits += 1;
  }

  private buyersInWindow(activity: MintActivity, triggerAtMs: number, holdingAtMs: number = triggerAtMs): TrackedBuy[] {
    const windowStart = triggerAtMs - this.convergence.windowSec * 1000;
    return [...activity.buyers.values()]
      .filter((buyer) => buyer.atMs >= windowStart && buyer.atMs <= triggerAtMs && !this.exitedBy(activity, buyer.wallet, holdingAtMs))
      .sort((a, b) => a.atMs - b.atMs);
  }

  private exitedBy(activity: MintActivity, wallet: Pubkey, atMs: number): boolean {
    const exitAtMs = activity.exits.get(wallet);
    return exitAtMs !== undefined && exitAtMs <= atMs;
  }

  private considerConvergence(launch: LaunchState, activity: MintActivity, triggerAtMs: number): void {
    if (!this.enabled("smart_convergence") || this.stopped) {
      return;
    }
    const buyers = this.buyersInWindow(activity, triggerAtMs);
    if (buyers.length < this.convergence.minWallets) {
      return;
    }
    if (activity.evaluating) {
      activity.recheckAtMs = triggerAtMs;
      return;
    }
    const nowMs = this.clock.nowMs();
    const draft = this.draftSignal("smart_convergence", launch, nowMs, buyers, { windowSec: this.convergence.windowSec });
    const precheck = this.convergencePrecheck(launch, nowMs);
    if (precheck) {
      this.rejectOncePerMint(activity, draft, precheck);
      return;
    }
    activity.evaluating = true;
    this.track(this.evaluateConvergence(launch, activity, draft, triggerAtMs));
  }

  private rejectOncePerMint(activity: MintActivity, signal: Signal, reason: SignalRejectReason): void {
    if (reason === "cooldown") {
      this.counters.cooldownRepeats += 1;
      return;
    }
    if (activity.reportedPrechecks.has(reason)) {
      this.counters.repeatedRejections += 1;
      return;
    }
    activity.reportedPrechecks.add(reason);
    this.reject(signal, reason);
  }

  private convergencePrecheck(launch: LaunchState, nowMs: number): SignalRejectReason | null {
    if (!this.signals.quoteMints.includes(launch.info.quoteMint)) {
      return "quote_mint_not_allowed";
    }
    if (launch.ageMs(nowMs) > this.convergence.maxLaunchAgeSec * 1000) {
      return "launch_too_old";
    }
    if (this.isCoolingDown(launch.mint, nowMs)) {
      return "cooldown";
    }
    return null;
  }

  private convergenceVerdict(launch: LaunchState, score: LaunchScore | null, nowMs: number): SignalRejectReason | null {
    if (this.isCoolingDown(launch.mint, nowMs)) {
      return "cooldown";
    }
    if (!score) {
      return "no_score";
    }
    if (score.hardBlocked) {
      return "hard_blocked";
    }
    if (score.score > this.convergence.maxRiskScore) {
      return "risk_too_high";
    }
    return null;
  }

  private async evaluateConvergence(launch: LaunchState, activity: MintActivity, draft: Signal, triggerAtMs: number): Promise<void> {
    let accepted = false;
    this.counters.evaluations += 1;
    try {
      const lookup = await this.scoreFor(launch.mint);
      if (this.stopped) {
        return;
      }
      const decidedAtMs = this.clock.nowMs();
      const holders = this.buyersInWindow(activity, triggerAtMs, decidedAtMs);
      const signal: Signal = {
        ...draft,
        atMs: decidedAtMs,
        slot: launch.lastSlot,
        riskScore: lookup.score?.score ?? null,
        wallets: holders.map((buyer) => buyer.wallet),
        meta: {
          ...draft.meta,
          ...scoreMeta(lookup.score, decidedAtMs),
          buyers: buyerMeta(holders),
          scoreWaitMs: lookup.waitedMs,
          launchAgeSec: launch.ageMs(decidedAtMs) / 1000,
          mcapMultiple: launch.mcapMultiple(),
          mcapSol: launch.mcapSol()
        }
      };
      const reason =
        holders.length < this.convergence.minWallets ? "buyers_exited" : this.convergenceVerdict(launch, lookup.score, decidedAtMs);
      if (reason === "cooldown") {
        this.counters.cooldownRepeats += 1;
      } else if (reason) {
        this.reject(signal, reason);
      } else {
        this.accept(signal);
        accepted = true;
      }
    } catch (error) {
      log.error({ err: error, mint: launch.mint }, "convergence evaluation failed");
    } finally {
      activity.evaluating = false;
      const recheckAtMs = activity.recheckAtMs;
      activity.recheckAtMs = null;
      if (!accepted && recheckAtMs !== null) {
        this.considerConvergence(launch, activity, recheckAtMs);
      }
    }
  }

  private async scoreFor(mint: Pubkey): Promise<ScoreLookup> {
    const startedAtMs = this.clock.nowMs();
    const latest = this.scores.latest(mint);
    const usable = latest && latest.computedAtMs <= startedAtMs ? latest : null;
    if (usable && startedAtMs - usable.computedAtMs <= this.convergence.maxScoreAgeSec * 1000) {
      return { score: usable, waitedMs: 0 };
    }
    if (this.convergence.waitForScoreMs <= 0) {
      return { score: null, waitedMs: 0 };
    }
    const fresh = await this.boundedScoreNow(mint, startedAtMs + this.convergence.waitForScoreMs);
    const nowMs = this.clock.nowMs();
    return { score: fresh && fresh.computedAtMs <= nowMs ? fresh : null, waitedMs: nowMs - startedAtMs };
  }

  private boundedScoreNow(mint: Pubkey, deadlineMs: number): Promise<LaunchScore | null> {
    return new Promise<LaunchScore | null>((resolve) => {
      let settled = false;
      let handle: TimerHandle | null = null;
      const finish = (value: LaunchScore | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (handle) {
          this.clock.cancel(handle);
        }
        this.waiters.delete(release);
        resolve(value);
      };
      const release = (): void => finish(null);
      this.waiters.add(release);
      handle = this.clock.schedule(deadlineMs, release);
      this.scores.scoreNow(mint, "convergence").then(finish, (error: unknown) => {
        log.warn({ err: error, mint }, "on-demand score failed");
        finish(null);
      });
    });
  }

  private onScore(score: LaunchScore): void {
    if (!this.enabled("score_momentum") || this.stopped) {
      return;
    }
    const config = this.signals.scoreMomentum;
    if (score.checkpointSec !== config.checkpointSec) {
      return;
    }
    const launch = resolveLaunch(this.market, score.mint);
    if (!launch) {
      return;
    }
    const nowMs = this.clock.nowMs();
    const draft = this.draftSignal("score_momentum", launch, nowMs, this.trackedBuyers(score.mint), {
      uniqueBuyersPerMin: featureValue(score, "unique_buyers_per_min"),
      buySellCountRatio: featureValue(score, "buy_sell_count_ratio")
    });
    const signal: Signal = { ...draft, riskScore: score.score, meta: { ...draft.meta, ...scoreMeta(score, nowMs) } };
    const reason = this.momentumVerdict(launch, score, nowMs);
    if (reason === "cooldown") {
      this.counters.cooldownRepeats += 1;
    } else if (reason) {
      this.reject(signal, reason);
    } else {
      this.accept(signal);
    }
  }

  private momentumVerdict(launch: LaunchState, score: LaunchScore, nowMs: number): SignalRejectReason | null {
    const config = this.signals.scoreMomentum;
    if (!this.signals.quoteMints.includes(launch.info.quoteMint)) {
      return "quote_mint_not_allowed";
    }
    if (this.isCoolingDown(launch.mint, nowMs)) {
      return "cooldown";
    }
    if (score.hardBlocked) {
      return "hard_blocked";
    }
    if (score.score > config.maxRiskScore) {
      return "risk_too_high";
    }
    const buyerRate = featureValue(score, "unique_buyers_per_min");
    if (buyerRate === null || buyerRate < config.minUniqueBuyersPerMin) {
      return "low_buyer_rate";
    }
    const buySellRatio = featureValue(score, "buy_sell_count_ratio");
    if (buySellRatio === null || buySellRatio < config.minBuySellRatio) {
      return "low_buy_sell_ratio";
    }
    const mcapSol = launch.mcapSol();
    if (mcapSol === null) {
      return "not_sol_quoted";
    }
    if (mcapSol < config.minMcapSol || mcapSol > config.maxMcapSol) {
      return "mcap_out_of_band";
    }
    return null;
  }

  private draftSignal(
    type: SignalType,
    launch: LaunchState,
    nowMs: number,
    buyers: readonly TrackedBuy[],
    extra: Record<string, unknown>
  ): Signal {
    return {
      id: null,
      type,
      mint: launch.mint,
      atMs: nowMs,
      slot: launch.lastSlot,
      riskScore: null,
      wallets: buyers.map((buyer) => buyer.wallet),
      meta: {
        ...extra,
        quoteMint: launch.info.quoteMint,
        launchAgeSec: launch.ageMs(nowMs) / 1000,
        mcapMultiple: launch.mcapMultiple(),
        mcapSol: launch.mcapSol(),
        trackedVersion: this.tracked.version(),
        buyers: buyerMeta(buyers)
      }
    };
  }

  private accept(signal: Signal): void {
    this.cooldownUntil.set(signal.mint, signal.atMs + this.signals.cooldownPerMintSec * 1000);
    this.counters.accepted += 1;
    this.bus.emit("signal", signal);
  }

  private reject(signal: Signal, reason: SignalRejectReason): void {
    this.counters.rejected += 1;
    if (!this.onRejected) {
      return;
    }
    try {
      this.onRejected(signal, reason);
    } catch (error) {
      log.error({ err: error, mint: signal.mint, reason }, "rejection listener failed");
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work
      .finally(() => {
        this.pending.delete(work);
      })
      .catch(() => undefined);
  }

  private maybePrune(): void {
    this.eventsSincePrune += 1;
    if (this.eventsSincePrune < this.pruneEveryEvents && this.activity.size <= this.maxMints) {
      return;
    }
    this.eventsSincePrune = 0;
    const nowMs = this.clock.nowMs();
    for (const [mint, activity] of this.activity) {
      if (!activity.evaluating && nowMs - activity.lastActivityMs > this.stateTtlMs) {
        this.activity.delete(mint);
      }
    }
    for (const [mint, until] of this.cooldownUntil) {
      if (until <= nowMs) {
        this.cooldownUntil.delete(mint);
      }
    }
    for (const [mint, activity] of this.activity) {
      if (this.activity.size <= this.maxMints) {
        break;
      }
      if (!activity.evaluating) {
        this.activity.delete(mint);
      }
    }
  }
}
