import { moduleLogger } from "../../core/logger.js";
import { stringOption } from "../args.js";
import { resolveStrategyPath } from "../autoLearn.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, EXIT_RESTART, type CommandContext } from "../commandContext.js";
import { startLiveApp } from "../live.js";

const log = moduleLogger("app.start");
const SHUTDOWN_GRACE_MS = 45_000;

export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const handler = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      const force = (): void => {
        log.error("second shutdown signal, exiting immediately");
        process.exit(EXIT_FAILURE);
      };
      process.once("SIGINT", force);
      process.once("SIGTERM", force);
      resolve(signal);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}

export function exitCodeFor(reason: string, restartRequested: boolean): number {
  if (restartRequested) {
    return EXIT_RESTART;
  }
  return reason === "SIGINT" || reason === "SIGTERM" ? EXIT_OK : EXIT_FAILURE;
}

export async function startCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  let signalled: NodeJS.Signals | null = null;
  const shutdownSignal = waitForShutdownSignal().then((signal) => {
    signalled = signal;
    return signal;
  });
  let app: Awaited<ReturnType<typeof startLiveApp>>;
  try {
    const strategyPath = resolveStrategyPath(stringOption(ctx.options, "config") ?? ctx.env.STRATEGY_CONFIG);
    app = await startLiveApp({ env: ctx.env, config, abort: () => signalled !== null, strategyPath });
  } catch (error) {
    if (signalled !== null) {
      log.info({ signal: signalled }, "stopped during startup");
      return EXIT_OK;
    }
    throw error;
  }
  const reason = await Promise.race([shutdownSignal, app.done]);
  const watchdog = setTimeout(() => {
    log.error({ graceMs: SHUTDOWN_GRACE_MS }, "graceful shutdown timed out, exiting");
    process.exit(EXIT_FAILURE);
  }, SHUTDOWN_GRACE_MS);
  watchdog.unref();
  await app.stop(reason);
  clearTimeout(watchdog);
  const code = exitCodeFor(reason, app.restartRequested());
  if (code === EXIT_RESTART) {
    log.info({ code }, "exiting so the supervisor restarts the service");
  }
  return code;
}
