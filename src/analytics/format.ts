import type { Interval } from "../core/stats.js";

export const NOT_AVAILABLE = "n/a";

export function formatSol(value: number | null | undefined, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE;
  }
  const magnitude = Math.abs(value);
  let digits = magnitude >= 1 ? magnitude.toFixed(3) : magnitude.toFixed(4);
  if (magnitude < 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
  }
  if (Number(digits) === 0) {
    return digits;
  }
  if (value < 0) {
    return `-${digits}`;
  }
  return signed ? `+${digits}` : digits;
}

export function formatPct(fraction: number | null | undefined, decimals = 1): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return NOT_AVAILABLE;
  }
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function formatBps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE;
  }
  return `${Math.round(value)} bps`;
}

export function groupThousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.round(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function approxCount(value: number): string {
  if (!Number.isFinite(value)) {
    return NOT_AVAILABLE;
  }
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 100) {
    return String(rounded);
  }
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(rounded))) - 1);
  return groupThousands(Math.round(rounded / magnitude) * magnitude);
}

export function formatInterval(interval: Interval | null | undefined): string {
  if (!interval) {
    return NOT_AVAILABLE;
  }
  return `${formatSol(interval.low)} to ${formatSol(interval.high)}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return NOT_AVAILABLE;
  }
  const safe = Math.max(0, seconds);
  if (safe < 60) {
    return `${Math.round(safe)}s`;
  }
  if (safe < 3600) {
    const minutes = Math.floor(safe / 60);
    const rest = Math.round(safe - minutes * 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  if (safe < 86_400) {
    const hours = Math.floor(safe / 3600);
    const minutes = Math.round((safe - hours * 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return `${(safe / 86_400).toFixed(1)}d`;
}

export function formatRatio(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE;
  }
  return value.toFixed(decimals);
}
