const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function normalizedHour(resetUtcHour: number): number {
  return Math.min(23, Math.max(0, Math.floor(resetUtcHour)));
}

export function tradingDayStartMs(nowMs: number, resetUtcHour: number): number {
  const offset = normalizedHour(resetUtcHour) * HOUR_MS;
  return Math.floor((nowMs - offset) / DAY_MS) * DAY_MS + offset;
}

export function nextDayResetMs(nowMs: number, resetUtcHour: number): number {
  return tradingDayStartMs(nowMs, resetUtcHour) + DAY_MS;
}

export function dayKeyFor(nowMs: number, resetUtcHour: number): string {
  const offset = normalizedHour(resetUtcHour) * HOUR_MS;
  return new Date(tradingDayStartMs(nowMs, resetUtcHour) - offset).toISOString().slice(0, 10);
}
