import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";

const log = moduleLogger("app.health");
const PING_TIMEOUT_MS = 3_000;

export interface HealthServerOptions {
  db: Db;
  port: number;
  host?: string;
  startedAtMs: number;
  nowMs: () => number;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

async function pingDatabase(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      db
        .query("SELECT 1")
        .then(() => true)
        .catch(() => false),
      timeout
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if ((req.method !== "GET" && req.method !== "HEAD") || path !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    void pingDatabase(options.db).then((ok) => {
      const body = JSON.stringify({ ok, db: ok, uptimeSec: Math.max(0, (options.nowMs() - options.startedAtMs) / 1000) });
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  log.info({ port }, "health endpoint listening");
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      })
  };
}
