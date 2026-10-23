import type { ClosedTrade } from "../core/types.js";

export type BreakdownDimension = "riskBucket" | "signalType" | "hourUtc" | "holdBucket" | "exitReason" | "weekday";

export const BREAKDOWN_DIMENSIONS: readonly BreakdownDimension[] = [
  "riskBucket",
  "signalType",
  "hourUtc",
  "holdBucket",
  "exitReason",
  "weekday"
];

export interface BucketKey {
  key: string;
  label: string;
  order: number;
}

export interface BucketOptions {
  riskBucketWidth?: number;
}

export const DEFAULT_RISK_BUCKET_WIDTH = 10;
export const UNSCORED_BUCKET = "unscored";
const UNSCORED_ORDER = 1_000_000;
const CATEGORICAL_ORDER = 0;

const HOLD_BUCKETS: ReadonlyArray<{ maxSec: number; key: string }> = [
  { maxSec: 60, key: "<1m" },
  { maxSec: 300, key: "1-5m" },
  { maxSec: 900, key: "5-15m" },
  { maxSec: 3600, key: "15-60m" },
  { maxSec: Number.POSITIVE_INFINITY, key: ">60m" }
];

export const HOLD_BUCKET_KEYS: readonly string[] = HOLD_BUCKETS.map((bucket) => bucket.key);

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function isBreakdownDimension(value: string): value is BreakdownDimension {
  return (BREAKDOWN_DIMENSIONS as readonly string[]).includes(value);
}

function sanitizeWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width) || width <= 0 || width > 100) {
    return DEFAULT_RISK_BUCKET_WIDTH;
  }
  return width;
}

export function riskBucketCount(width: number = DEFAULT_RISK_BUCKET_WIDTH): number {
  return Math.ceil(100 / sanitizeWidth(width));
}

export function riskBucketIndex(score: number, width: number = DEFAULT_RISK_BUCKET_WIDTH): number {
  const safeWidth = sanitizeWidth(width);
  const clamped = Math.min(100, Math.max(0, score));
  return Math.min(Math.floor(clamped / safeWidth), riskBucketCount(safeWidth) - 1);
}

export function riskBucketBounds(index: number, width: number = DEFAULT_RISK_BUCKET_WIDTH): { low: number; high: number } {
  const safeWidth = sanitizeWidth(width);
  const low = index * safeWidth;
  return { low, high: Math.min(100, low + safeWidth) };
}

export function riskBucketLabel(low: number, high: number): string {
  return `${trimNumber(low)}-${trimNumber(high)}`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function riskBucket(score: number | null, width: number = DEFAULT_RISK_BUCKET_WIDTH): BucketKey {
  if (score === null || !Number.isFinite(score)) {
    return { key: UNSCORED_BUCKET, label: UNSCORED_BUCKET, order: UNSCORED_ORDER };
  }
  const index = riskBucketIndex(score, width);
  const { low, high } = riskBucketBounds(index, width);
  const label = riskBucketLabel(low, high);
  return { key: label, label, order: index };
}

export function holdBucket(holdSec: number): BucketKey {
  const safe = Number.isFinite(holdSec) ? holdSec : 0;
  const index = HOLD_BUCKETS.findIndex((bucket) => safe < bucket.maxSec);
  const resolved = index === -1 ? HOLD_BUCKETS.length - 1 : index;
  const key = HOLD_BUCKETS[resolved]?.key ?? ">60m";
  return { key, label: key, order: resolved };
}

export function hourUtcBucket(atMs: number): BucketKey {
  const hour = new Date(atMs).getUTCHours();
  const padded = String(hour).padStart(2, "0");
  return { key: padded, label: `${padded}:00`, order: hour };
}

export function weekdayBucket(atMs: number): BucketKey {
  const mondayFirst = (new Date(atMs).getUTCDay() + 6) % 7;
  const label = WEEKDAY_LABELS[mondayFirst] ?? "Mon";
  return { key: label.toLowerCase(), label, order: mondayFirst };
}

function categorical(value: string | null | undefined): BucketKey {
  const key = value && value.length > 0 ? value : "unknown";
  return { key, label: key, order: CATEGORICAL_ORDER };
}

export function bucketOf(trade: ClosedTrade, dimension: BreakdownDimension, options: BucketOptions = {}): BucketKey {
  switch (dimension) {
    case "riskBucket":
      return riskBucket(trade.riskScore, options.riskBucketWidth);
    case "signalType":
      return categorical(trade.signalType);
    case "hourUtc":
      return hourUtcBucket(trade.openedAtMs);
    case "holdBucket":
      return holdBucket(trade.holdSec);
    case "exitReason":
      return categorical(trade.exitReason);
    case "weekday":
      return weekdayBucket(trade.openedAtMs);
  }
}

export function isCategoricalDimension(dimension: BreakdownDimension): boolean {
  return dimension === "signalType" || dimension === "exitReason";
}

export function dimensionTitle(dimension: BreakdownDimension): string {
  switch (dimension) {
    case "riskBucket":
      return "Risk score at entry";
    case "signalType":
      return "Signal type";
    case "hourUtc":
      return "Entry hour (UTC)";
    case "holdBucket":
      return "Hold time";
    case "exitReason":
      return "Exit reason";
    case "weekday":
      return "Entry weekday (UTC)";
  }
}
