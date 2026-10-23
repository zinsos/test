export type OptionKind = "string" | "number" | "boolean" | "date";
export type OptionValue = string | number | boolean | Date;

export interface OptionSpec {
  name: string;
  kind: OptionKind;
  required?: boolean;
  description: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  options: readonly OptionSpec[];
}

export interface ParsedArgs {
  command: string;
  options: Record<string, OptionValue>;
}

export class UsageError extends Error {
  constructor(
    message: string,
    readonly command: string | null = null
  ) {
    super(message);
    this.name = "UsageError";
  }
}

const CONFIG_OPTION: OptionSpec = { name: "config", kind: "string", description: "strategy config file (default STRATEGY_CONFIG or config/strategy.json)" };
const FROM_OPTION: OptionSpec = { name: "from", kind: "date", description: "start (YYYY-MM-DD, ISO time or epoch ms, UTC)" };
const TO_OPTION: OptionSpec = { name: "to", kind: "date", description: "end, exclusive (YYYY-MM-DD, ISO time or epoch ms, UTC)" };

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "start",
    summary: "run the services listed in MODULES (recorder, scorer, tracker, trader, dashboard)",
    options: [CONFIG_OPTION]
  },
  { name: "migrate", summary: "apply database migrations", options: [] },
  {
    name: "backtest",
    summary: "replay recorded launches through the scorer, signals, trader, exits and risk with a virtual clock",
    options: [
      { ...FROM_OPTION, required: true },
      { ...TO_OPTION, required: true },
      { name: "label", kind: "string", description: "label stored on the strategy run" },
      CONFIG_OPTION,
      {
        name: "weights",
        kind: "string",
        description: "scorer weights file or stored weights version (default: the active, file or hand weights fitted before --from)"
      },
      { name: "allow-in-sample", kind: "boolean", description: "allow default weights fitted on data from the backtest window or later" },
      { name: "walk-forward", kind: "boolean", description: "rank wallets at every rerank interval inside the window first" },
      { name: "include-incomplete", kind: "boolean", description: "keep entering launches after their data became incomplete" },
      { name: "json", kind: "boolean", description: "print the full summary as JSON after the report" }
    ]
  },
  {
    name: "tune-scorer",
    summary: "fit suggested scorer weights from recorded outcomes and store them as a new version",
    options: [
      { name: "checkpoint", kind: "number", required: true, description: "scorer checkpoint in seconds (10, 30, 60, 120)" },
      { name: "label", kind: "string", required: true, description: "outcome to predict: rugged, died, survived_15m or migrated" },
      FROM_OPTION,
      TO_OPTION,
      { name: "activate", kind: "boolean", description: "make the new weights the active version" },
      { name: "write-file", kind: "boolean", description: "also write them to scorer.weightsFile" },
      { name: "version", kind: "string", description: "version name for the new weights" },
      CONFIG_OPTION
    ]
  },
  {
    name: "export-dataset",
    summary: "write the scorer dataset (features and outcomes per launch) as CSV",
    options: [
      { name: "checkpoint", kind: "number", required: true, description: "scorer checkpoint in seconds" },
      FROM_OPTION,
      TO_OPTION,
      { name: "quote", kind: "string", description: "only launches with this quote mint (SOL for SOL-quoted)" },
      { name: "out", kind: "string", required: true, description: "output file, or - for stdout" },
      CONFIG_OPTION
    ]
  },
  {
    name: "rank-wallets",
    summary: "rank wallets by realized round-trip PnL and store a new tracked set",
    options: [{ name: "as-of", kind: "date", description: "rank as of this time using only data before it (default now)" }, CONFIG_OPTION]
  },
  {
    name: "backfill-wallets",
    summary: "fetch on-chain history for the top wallets of the latest ranking",
    options: [
      { name: "top", kind: "number", description: "number of wallets (default tracker.backfill.maxWallets)" },
      { name: "since-days", kind: "number", description: "history window in days (default tracker.longWindowDays)" },
      CONFIG_OPTION
    ]
  },
  {
    name: "report",
    summary: "print expectancy, breakdowns and the verdict for closed trades",
    options: [
      { name: "run", kind: "number", description: "strategy run id" },
      { name: "mode", kind: "string", description: "paper, live, backtest or shadow (default: most recent mode)" },
      FROM_OPTION,
      TO_OPTION
    ]
  },
  {
    name: "sweep",
    summary: "move hot wallet profits above the target to the cold wallet once",
    options: [{ name: "dry-run", kind: "boolean", description: "only report what would be swept" }, CONFIG_OPTION]
  },
  {
    name: "reset-kill",
    summary: "clear the drawdown kill switch of a strategy run",
    options: [
      { name: "run", kind: "number", required: true, description: "strategy run id" },
      { name: "reason", kind: "string", description: "note stored with the reset" },
      CONFIG_OPTION
    ]
  },
  {
    name: "recompute-outcomes",
    summary: "relabel launch outcomes after changing recorder.outcome settings",
    options: [FROM_OPTION, TO_OPTION, CONFIG_OPTION]
  },
  {
    name: "prune-data",
    summary: "free disk space: drop trades, scores and holder snapshots of launches older than the kept window",
    options: [
      { name: "keep-days", kind: "number", required: true, description: "days of recorded data to keep (at least 100 keeps 90-day wallet rankings intact)" },
      { name: "dry-run", kind: "boolean", description: "only report what would be deleted" }
    ]
  },
  { name: "help", summary: "show this help", options: [] }
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function parseDateArg(value: string): Date {
  const trimmed = value.trim();
  let ms: number;
  if (DIGITS.test(trimmed)) {
    ms = Number(trimmed);
  } else if (DATE_ONLY.test(trimmed)) {
    ms = Date.parse(`${trimmed}T00:00:00Z`);
  } else {
    ms = Date.parse(trimmed);
  }
  if (!Number.isFinite(ms)) {
    throw new UsageError(`invalid date: ${value}`);
  }
  return new Date(ms);
}

function parseValue(spec: OptionSpec, raw: string, command: string): OptionValue {
  switch (spec.kind) {
    case "number": {
      const value = Number(raw);
      if (raw.trim().length === 0 || !Number.isFinite(value)) {
        throw new UsageError(`--${spec.name} expects a number, got "${raw}"`, command);
      }
      return value;
    }
    case "date":
      try {
        return parseDateArg(raw);
      } catch {
        throw new UsageError(`--${spec.name} expects a date, got "${raw}"`, command);
      }
    case "boolean": {
      const normalized = raw.toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
      }
      throw new UsageError(`--${spec.name} expects true or false, got "${raw}"`, command);
    }
    default:
      return raw;
  }
}

function splitToken(token: string): { name: string; inline: string | null } {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  return equals === -1 ? { name: body, inline: null } : { name: body.slice(0, equals), inline: body.slice(equals + 1) };
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return { command: "help", options: {} };
  }
  const spec = commandSpec(first);
  if (!spec) {
    throw new UsageError(`unknown command "${first}"`);
  }
  const options: Record<string, OptionValue> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--help" || token === "-h") {
      return { command: "help", options: { topic: spec.name } };
    }
    if (!token.startsWith("--") || token.length <= 2) {
      throw new UsageError(`unexpected argument "${token}"`, spec.name);
    }
    const { name, inline } = splitToken(token);
    const option = spec.options.find((candidate) => candidate.name === name);
    if (!option) {
      throw new UsageError(`unknown option --${name} for ${spec.name}`, spec.name);
    }
    if (name in options) {
      throw new UsageError(`--${name} given more than once`, spec.name);
    }
    if (option.kind === "boolean" && inline === null) {
      options[name] = true;
      continue;
    }
    let raw = inline;
    if (raw === null) {
      const next = rest[index + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new UsageError(`--${name} needs a value`, spec.name);
      }
      raw = next;
      index += 1;
    }
    options[name] = parseValue(option, raw, spec.name);
  }
  for (const option of spec.options) {
    if (option.required && !(option.name in options)) {
      throw new UsageError(`missing required option --${option.name}`, spec.name);
    }
  }
  return { command: spec.name, options };
}

function optionLine(option: OptionSpec): string {
  const value = option.kind === "boolean" ? "" : ` <${option.kind}>`;
  const flag = `--${option.name}${value}`;
  const required = option.required ? " (required)" : "";
  return `    ${flag.padEnd(28)} ${option.description}${required}`;
}

export function usageText(topic?: string): string {
  const spec = topic ? commandSpec(topic) : undefined;
  if (spec) {
    return [`usage: snypra-edge ${spec.name} [options]`, "", `  ${spec.summary}`, "", ...spec.options.map(optionLine)].join("\n");
  }
  const lines = ["usage: snypra-edge <command> [options]", "", "commands:"];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(20)} ${command.summary}`);
    lines.push(...command.options.map(optionLine));
  }
  lines.push("", "exit codes: 0 ok, 1 failure, 2 usage error");
  return lines.join("\n");
}

export function stringOption(options: Record<string, OptionValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function numberOption(options: Record<string, OptionValue>, name: string): number | undefined {
  const value = options[name];
  return typeof value === "number" ? value : undefined;
}

export function dateOption(options: Record<string, OptionValue>, name: string): Date | undefined {
  const value = options[name];
  return value instanceof Date ? value : undefined;
}

export function flagOption(options: Record<string, OptionValue>, name: string): boolean {
  return options[name] === true;
}
