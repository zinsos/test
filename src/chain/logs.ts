export interface ProgramDataEntry {
  programId: string;
  data: Buffer;
  index: number;
  depth: number;
}

export interface ExtractedProgramData {
  entries: ProgramDataEntry[];
  truncated: boolean;
}

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const SUCCESS = /^Program (\S+) success$/;
const FAILED = /^Program (\S+) failed/;
const DATA_PREFIX = "Program data: ";

export function extractProgramData(logs: readonly string[]): ExtractedProgramData {
  const stack: string[] = [];
  const entries: ProgramDataEntry[] = [];
  let truncated = false;
  for (const line of logs) {
    if (line.startsWith(DATA_PREFIX)) {
      const programId = stack[stack.length - 1];
      if (!programId) {
        continue;
      }
      const chunks = line.slice(DATA_PREFIX.length).trim().split(" ").filter((chunk) => chunk.length > 0);
      const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64")));
      entries.push({ programId, data, index: entries.length, depth: stack.length });
      continue;
    }
    const invoke = INVOKE.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    if (SUCCESS.test(line) || FAILED.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Log truncated")) {
      truncated = true;
    }
  }
  return { entries, truncated };
}
