import { moduleLogger } from "../../core/logger.js";
import { commandConfig, EXIT_FAILURE, EXIT_OK, type CommandContext } from "../commandContext.js";
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

export async function startCommand(ctx: CommandContext): Promise<number> {
  const config = await commandConfig(ctx);
  let signalled: NodeJS.Signals | null = null;
  const shutdownSignal = waitForShutdownSignal().then((signal) => {
    signalled = signal;
    return signal;
  });
  let app: Awaited<ReturnType<typeof startLiveApp>>;
  try {
    app = await startLiveApp({ env: ctx.env, config, abort: () => signalled !== null });
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
  return reason === "SIGINT" || reason === "SIGTERM" ? EXIT_OK : EXIT_FAILURE;
}
