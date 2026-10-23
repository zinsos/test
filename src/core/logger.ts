import { pino, type Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const rootLogger: Logger = pino({
  level,
  base: { service: "snypra-edge" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["secret", "secretKey", "privateKey", "*.secret", "*.secretKey", "*.privateKey", "HOT_WALLET_SECRET_KEY"],
    censor: "[redacted]"
  }
});

export function moduleLogger(module: string): Logger {
  return rootLogger.child({ module });
}

export type { Logger };
