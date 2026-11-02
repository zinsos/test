export function pgParam(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

export function valuesList(rows: readonly (readonly unknown[])[], casts: readonly string[], params: unknown[]): string {
  const tuples: string[] = [];
  for (const row of rows) {
    const placeholders: string[] = [];
    row.forEach((value, index) => {
      params.push(pgParam(value));
      const cast = casts[index];
      placeholders.push(cast ? `$${params.length}::${cast}` : `$${params.length}`);
    });
    tuples.push(`(${placeholders.join(",")})`);
  }
  return tuples.join(",");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

const NUL = new RegExp(String.fromCharCode(0), "g");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export function cleanText(value: string, maxLength = 2_000): string {
  const bounded = value.length > maxLength ? value.slice(0, maxLength) : value;
  return bounded.replace(NUL, "").replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

export function dateOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
}
