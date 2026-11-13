export type CsvValue = string | number | bigint | boolean | Date | null | undefined;

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeText(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return escapeText(value);
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(",");
}

export function csvDocument(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return `${lines.join("\n")}\n`;
}

export function featureColumnName(key: string): string {
  return `f_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function sortedFeatureKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function featureCell(features: Record<string, unknown> | null | undefined, key: string): CsvValue {
  const value = features?.[key];
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}
