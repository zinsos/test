import type { CalibrationAssessment, CalibrationGroup } from "./calibration.js";
import type { PaperLiveComparison } from "./compare.js";
import {
  approxCount,
  formatBps,
  formatDuration,
  formatInterval,
  formatPct,
  formatRatio,
  formatSol
} from "./format.js";
import type { TradeSummary } from "./metrics.js";

export type Tone = "good" | "bad" | "warn" | "neutral";

export interface Narrative {
  tone: Tone;
  headline: string;
  detail: string;
}

export const TWO_WEEKS_DAYS = 14;
const STALLED_TRADE_AGE_SEC = 300;

function insufficientSummary(summary: TradeSummary): Narrative {
  const spread =
    summary.tradesNeeded === null || summary.tradesNeeded <= summary.minTrades
      ? ""
      : ` At this spread you need about ${approxCount(summary.tradesNeeded)} trades to know.`;
  return {
    tone: "warn",
    headline: `Too early: ${summary.n} of ${summary.minTrades} trades`,
    detail:
      `Expectancy so far ${formatSol(summary.expectancySol)} SOL/trade (95% range ${formatInterval(summary.decisionCi95)}).` +
      `${spread} Keep paper trading and do not size up on a small sample.`
  };
}

function edgeSummary(summary: TradeSummary): Narrative {
  return {
    tone: "good",
    headline: `Edge: ${formatSol(summary.expectancySol)} SOL/trade after fees`,
    detail:
      `95% range ${formatInterval(summary.decisionCi95)} over ${summary.n} trades. Win rate ${formatPct(summary.winRate)}, ` +
      `profit factor ${formatRatio(summary.profitFactor)}. Scale slowly and compare live against paper every week.`
  };
}

function losingSummary(summary: TradeSummary): Narrative {
  return {
    tone: "bad",
    headline: `Losing: ${formatSol(summary.expectancySol)} SOL/trade after fees`,
    detail:
      `The 95% range (${formatInterval(summary.decisionCi95)}) is entirely below zero over ${summary.n} trades. ` +
      "Cut or change this setup. A negative result here is the tooling working: it saved real money."
  };
}

function noEdgeSummary(summary: TradeSummary): Narrative {
  const more = summary.moreTradesNeeded;
  const needs = more !== null && more > 0 ? `, need ~${approxCount(more)} more trades to know` : "";
  return {
    tone: "warn",
    headline: `No edge yet: expectancy ${formatSol(summary.expectancySol)} SOL/trade${needs}`,
    detail:
      `The 95% range (${formatInterval(summary.decisionCi95)}) still includes zero after ${summary.n} trades. ` +
      "Flat results are the tooling working: they kept you from sizing up on noise."
  };
}

export function describeSummary(summary: TradeSummary): Narrative {
  if (summary.n === 0) {
    return {
      tone: "neutral",
      headline: "No closed trades yet",
      detail:
        "Run the recorder for two weeks, backtest the scorer and wallet tracker, then paper trade 300+ trades. " +
        `This card turns into a verdict after ${summary.minTrades} closed trades.`
    };
  }
  if (summary.verdict === "insufficient_data") {
    return insufficientSummary(summary);
  }
  if (summary.verdict === "edge") {
    return edgeSummary(summary);
  }
  return summary.significance === "negative" ? losingSummary(summary) : noEdgeSummary(summary);
}

function gapsSentence(comparison: PaperLiveComparison): string {
  return (
    `Entries fill ${formatBps(comparison.entryGap.meanBps)} worse live, exits ${formatBps(comparison.exitGap.meanBps)} worse; ` +
    `failed fills ${formatPct(comparison.fillFailureRate.live)} live vs ${formatPct(comparison.fillFailureRate.paper)} paper.`
  );
}

export function describeComparison(comparison: PaperLiveComparison): Narrative {
  if (comparison.n === 0) {
    return {
      tone: "neutral",
      headline: "No paper/live pairs yet",
      detail:
        "Once live trading starts small, every live entry gets a shadow paper trade. " +
        "This tab then shows where the simulation is too optimistic."
    };
  }
  const means = `Live averages ${formatSol(comparison.meanLiveSol)} SOL/trade vs paper ${formatSol(comparison.meanPaperSol)}.`;
  switch (comparison.verdict) {
    case "insufficient_data":
      return {
        tone: "warn",
        headline: `Too early: ${comparison.n} of ${comparison.minPairs} paired trades`,
        detail: `${means} Compare again after ${comparison.minPairs}+ pairs.`
      };
    case "paper_too_optimistic":
      return {
        tone: "bad",
        headline: `Paper is too optimistic: live makes ${formatSol(Math.abs(comparison.meanDiffSol ?? 0), false)} SOL/trade less`,
        detail:
          `${means} ${gapsSentence(comparison)} Make the execution model harsher (latency, slippage, failure rate) ` +
          "before trusting paper results."
      };
    case "paper_too_pessimistic":
      return {
        tone: "good",
        headline: `Paper is conservative: live beats paper by ${formatSol(comparison.meanDiffSol, false)} SOL/trade`,
        detail: `${means} Paper understates live here; keep comparing weekly.`
      };
    case "consistent":
      return {
        tone: "good",
        headline: "Paper matches live within noise",
        detail:
          `Mean difference ${formatSol(comparison.meanDiffSol)} SOL/trade (95% range ${formatInterval(comparison.diffCi95)}) ` +
          `over ${comparison.n} pairs. ${gapsSentence(comparison)}`
      };
  }
}

export function describeCalibration(
  assessment: CalibrationAssessment,
  pass: CalibrationGroup,
  block: CalibrationGroup
): Narrative {
  if (assessment.n === 0) {
    return {
      tone: "neutral",
      headline: "No scored launches with known outcomes yet",
      detail: "Run the recorder for two weeks before tuning. Each launch needs a score and a labelled outcome."
    };
  }
  const passSurvival = formatPct(pass.survived15mRate);
  const blockSurvival = formatPct(block.survived15mRate);
  const rugs = `Rug rate ${formatPct(pass.ruggedRate)} passed vs ${formatPct(block.ruggedRate)} blocked.`;
  switch (assessment.verdict) {
    case "insufficient_data":
      return {
        tone: "warn",
        headline: `Too early: ${assessment.n} labelled launches`,
        detail:
          `Need ${assessment.minLaunches}+ launches and ${assessment.minGroup}+ in both the passed and blocked groups. ` +
          "Run the recorder for two weeks before tuning."
      };
    case "scorer_works":
      return {
        tone: "good",
        headline: `Scorer works: passed launches survive 15m ${passSurvival} vs ${blockSurvival} blocked`,
        detail: `${rugs} Threshold ${assessment.maxRisk}. Recheck weekly as launches change.`
      };
    case "scorer_inverted":
      return {
        tone: "bad",
        headline: `Scorer is inverted: blocked launches survive more (${blockSurvival} vs ${passSurvival})`,
        detail: `${rugs} Retune the weights before using the score as a filter.`
      };
    case "inconclusive":
      return {
        tone: "warn",
        headline: `Scorer not proven: ${passSurvival} passed vs ${blockSurvival} blocked survive 15m`,
        detail: `${rugs} The difference is within noise. Collect more launches or retune.`
      };
  }
}

export interface RecorderNarrativeInput {
  recordingDays: number | null;
  lastTradeAgeSec: number | null;
  gapCount24h: number;
  gapSeconds24h: number;
}

function gapSentence(input: RecorderNarrativeInput): string {
  if (input.gapCount24h === 0) {
    return "No ingest gaps in the last 24h.";
  }
  return `${input.gapCount24h} ${input.gapCount24h === 1 ? "ingest gap" : "ingest gaps"} in the last 24h totalling ${formatDuration(input.gapSeconds24h)}.`;
}

export function describeRecorder(input: RecorderNarrativeInput): Narrative {
  if (input.recordingDays === null) {
    return {
      tone: "bad",
      headline: "Recorder has no data yet",
      detail: "Start the recorder and leave it running for two weeks before tuning anything."
    };
  }
  if (input.lastTradeAgeSec === null || input.lastTradeAgeSec > STALLED_TRADE_AGE_SEC) {
    return {
      tone: "bad",
      headline: `Recorder looks stalled: last trade ${formatDuration(input.lastTradeAgeSec)} ago`,
      detail: `Check the RPC websocket and the logs. ${gapSentence(input)}`
    };
  }
  if (input.recordingDays < TWO_WEEKS_DAYS) {
    const remaining = TWO_WEEKS_DAYS - input.recordingDays;
    return {
      tone: "warn",
      headline: `Recording for ${input.recordingDays.toFixed(1)} days`,
      detail: `About ${remaining.toFixed(1)} more days until the two-week mark. Do not tune the scorer before then. ${gapSentence(input)}`
    };
  }
  return {
    tone: input.gapCount24h > 0 ? "warn" : "good",
    headline: `Recorder healthy: ${input.recordingDays.toFixed(1)} days of data`,
    detail: gapSentence(input)
  };
}
