import { runCli } from "./app/cli.js";
import { moduleLogger } from "./core/logger.js";

const log = moduleLogger("main");
const EXIT_FLUSH_MS = 5_000;

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
  log.fatal({ err: error }, "uncaught exception, exiting");
  process.exit(1);
});

const code = await runCli(process.argv.slice(2), {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  }
});

process.exitCode = code;
setTimeout(() => process.exit(code), EXIT_FLUSH_MS).unref();
