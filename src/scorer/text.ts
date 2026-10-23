export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function jaro(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  if (left.length === 0 && right.length === 0) {
    return 1;
  }
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(right.length - 1, i + window);
    for (let j = start; j <= end; j += 1) {
      if (!rightMatched[j] && left[i] === right[j]) {
        leftMatched[i] = true;
        rightMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) {
    return 0;
  }
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (!leftMatched[i]) {
      continue;
    }
    while (!rightMatched[k]) {
      k += 1;
    }
    if (left[i] !== right[k]) {
      transpositions += 1;
    }
    k += 1;
  }
  const m = matches;
  return (m / left.length + m / right.length + (m - transpositions / 2) / m) / 3;
}

export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const base = jaro(a, b);
  const left = [...a];
  const right = [...b];
  let prefix = 0;
  while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  return base + prefix * prefixScale * (1 - base);
}
