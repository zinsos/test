import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./config.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect | null;
  maximized: boolean;
}

export interface Placement {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const MIN_VISIBLE_PX = 96;
const TITLE_STRIP_PX = 40;

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000;
}

function readRect(value: unknown): Rect | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  if (!isFiniteInt(x) || !isFiniteInt(y) || !isFiniteInt(width) || !isFiniteInt(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function parseWindowState(text: string): WindowState {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return { bounds: null, maximized: false };
    }
    const record = raw as Record<string, unknown>;
    return { bounds: readRect(record.bounds), maximized: record.maximized === true };
  } catch {
    return { bounds: null, maximized: false };
  }
}

export function readWindowState(file: string): WindowState {
  if (!existsSync(file)) {
    return { bounds: null, maximized: false };
  }
  try {
    return parseWindowState(readFileSync(file, "utf8"));
  } catch {
    return { bounds: null, maximized: false };
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  writeFileAtomic(file, `${JSON.stringify(state)}\n`);
}

function overlap(a: Rect, b: Rect): Size {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

export function placeWindow(state: WindowState, workAreas: readonly Rect[], preferred: Size, minimum: Size): Placement {
  const largest = workAreas.reduce<Size>((best, area) => (area.width * area.height > best.width * best.height ? area : best), { width: 0, height: 0 });
  const clampWidth = (value: number): number => Math.max(minimum.width, largest.width > 0 ? Math.min(value, largest.width) : value);
  const clampHeight = (value: number): number => Math.max(minimum.height, largest.height > 0 ? Math.min(value, largest.height) : value);
  const saved = state.bounds;
  if (saved === null) {
    return { width: clampWidth(preferred.width), height: clampHeight(preferred.height), maximized: state.maximized };
  }
  const width = clampWidth(saved.width);
  const height = clampHeight(saved.height);
  const titleStrip: Rect = { x: saved.x, y: saved.y, width, height: TITLE_STRIP_PX };
  const visible = workAreas.some((area) => {
    const shared = overlap(titleStrip, area);
    return shared.width >= Math.min(MIN_VISIBLE_PX, width) && shared.height > 0;
  });
  return visible ? { x: saved.x, y: saved.y, width, height, maximized: state.maximized } : { width, height, maximized: state.maximized };
}
