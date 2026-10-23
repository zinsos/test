import { describe, expect, it } from "vitest";
import { parseArgv, parseDateArg, usageText, UsageError } from "../src/app/args.js";
import { runCli, type CommandHandler } from "../src/app/cli.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from "../src/app/commandContext.js";
import { loadEnv } from "../src/config/env.js";

function captureIo(): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line)
  };
}

describe("parseArgv", () => {
  it("parses a backtest with dates, strings and flags in both spellings", () => {
    const parsed = parseArgv([
      "backtest",
      "--from",
      "2026-10-01",
      "--to=2026-10-15T12:00:00Z",
      "--label",
      "week one",
      "--walk-forward",
      "--include-incomplete=false"
    ]);
    expect(parsed.command).toBe("backtest");
    expect(parsed.options.from).toEqual(new Date(Date.UTC(2026, 9, 1)));
    expect(parsed.options.to).toEqual(new Date(Date.UTC(2026, 9, 15, 12)));
    expect(parsed.options.label).toBe("week one");
    expect(parsed.options["walk-forward"]).toBe(true);
    expect(parsed.options["include-incomplete"]).toBe(false);
  });

  it("parses numbers, epoch dates and negative values", () => {
    const parsed = parseArgv(["backfill-wallets", "--top", "25", "--since-days", "-3"]);
    expect(parsed.options).toEqual({ top: 25, "since-days": -3 });
    expect(parseArgv(["rank-wallets", "--as-of", "1792000000000"]).options["as-of"]).toEqual(new Date(1_792_000_000_000));
  });

  it("returns help for no arguments, help, --help and per-command help", () => {
    expect(parseArgv([]).command).toBe("help");
    expect(parseArgv(["help"]).command).toBe("help");
    expect(parseArgv(["--help"]).command).toBe("help");
    expect(parseArgv(["report", "--help"])).toEqual({ command: "help", options: { topic: "report" } });
  });

  it("rejects unknown commands, unknown options, missing values and missing required options", () => {
    const cases: Array<[string[], RegExp]> = [
      [["deploy"], /unknown command "deploy"/],
      [["report", "--verbose"], /unknown option --verbose/],
      [["report", "--run"], /--run needs a value/],
      [["report", "--run", "--mode", "paper"], /--run needs a value/],
      [["report", "--run", "abc"], /expects a number/],
      [["backtest", "--from", "2026-10-01"], /missing required option --to/],
      [["backtest", "--from", "yesterday", "--to", "2026-10-02"], /expects a date/],
      [["report", "extra"], /unexpected argument "extra"/],
      [["report", "--run", "1", "--run", "2"], /given more than once/],
      [["sweep", "--dry-run=maybe"], /expects true or false/]
    ];
    for (const [argv, message] of cases) {
      expect(() => parseArgv(argv)).toThrowError(message);
    }
  });

  it("parses date arguments as UTC and refuses garbage", () => {
    expect(parseDateArg("2026-10-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseDateArg("2026-10-01T05:06:07+02:00").toISOString()).toBe("2026-10-01T03:06:07.000Z");
    expect(() => parseDateArg("not a date")).toThrow(UsageError);
  });

  it("documents every command and its options", () => {
    const text = usageText();
    for (const command of ["start", "migrate", "backtest", "tune-scorer", "export-dataset", "rank-wallets", "backfill-wallets", "report", "sweep", "reset-kill", "recompute-outcomes"]) {
      expect(text).toContain(`  ${command}`);
    }
    expect(usageText("tune-scorer")).toContain("--activate");
    expect(text).toContain("exit codes");
  });
});

describe("runCli", () => {
  const env = loadEnv({});

  it("dispatches to the command handler with parsed options and returns its exit code", async () => {
    const io = captureIo();
    const seen: Array<Record<string, unknown>> = [];
    const handler: CommandHandler = async (ctx) => {
      seen.push(ctx.options);
      ctx.io.out("done");
      return EXIT_OK;
    };
    const code = await runCli(["report", "--mode", "paper"], io, { env, handlers: { report: handler } });
    expect(code).toBe(EXIT_OK);
    expect(seen).toEqual([{ mode: "paper" }]);
    expect(io.outLines).toEqual(["done"]);
  });

  it("returns 2 with usage on bad arguments and 1 on command failures", async () => {
    const usage = captureIo();
    expect(await runCli(["backtest"], usage, { env })).toBe(EXIT_USAGE);
    expect(usage.errLines[0]).toContain("missing required option --from");
    expect(usage.errLines[1]).toContain("usage: snypra-edge backtest");

    const failing = captureIo();
    const code = await runCli(["migrate"], failing, {
      env,
      handlers: {
        migrate: async () => {
          throw new Error("database unreachable");
        }
      }
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(failing.errLines).toEqual(["error: database unreachable"]);

    const thrownUsage = captureIo();
    expect(
      await runCli(["report"], thrownUsage, {
        env,
        handlers: {
          report: async () => {
            throw new UsageError("--mode must be paper, live, backtest or shadow", "report");
          }
        }
      })
    ).toBe(EXIT_USAGE);
  });

  it("prints help with exit code 0 and fails cleanly without DATABASE_URL", async () => {
    const help = captureIo();
    expect(await runCli(["help"], help, { env })).toBe(EXIT_OK);
    expect(help.outLines[0]).toContain("usage: snypra-edge <command>");
    const noDb = captureIo();
    expect(await runCli(["migrate"], noDb, { env })).toBe(EXIT_FAILURE);
    expect(noDb.errLines[0]).toContain("DATABASE_URL");
  });

  it("reports an invalid environment as a failure", async () => {
    const io = captureIo();
    const original = process.env.MODULES;
    process.env.MODULES = "recorder,teleporter";
    try {
      expect(await runCli(["migrate"], io)).toBe(EXIT_FAILURE);
      expect(io.errLines[0]).toContain("invalid environment");
    } finally {
      if (original === undefined) {
        delete process.env.MODULES;
      } else {
        process.env.MODULES = original;
      }
    }
  });
});
