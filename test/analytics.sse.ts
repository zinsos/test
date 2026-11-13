import { request, type IncomingHttpHeaders } from "node:http";

export interface SseMessage {
  event: string;
  id: string | null;
  data: Record<string, unknown>;
}

export function parseSse(text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("id: ")) {
        id = line.slice(4);
      } else if (line.startsWith("data: ")) {
        data.push(line.slice(6));
      }
    }
    if (data.length > 0) {
      messages.push({ event, id, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    }
  }
  return messages;
}

export interface StreamHandle {
  status: number;
  headers: IncomingHttpHeaders;
  raw(): string;
  messages(): SseMessage[];
  next(predicate: (message: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  ended(): Promise<void>;
  close(): void;
}

export function openStream(port: number, path: string, headers: Record<string, string> = {}): Promise<StreamHandle> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let raw = "";
      const waiters = new Set<() => void>();
      let finished = false;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        for (const waiter of [...waiters]) {
          waiter();
        }
      });
      const finish = (): void => {
        finished = true;
        for (const waiter of [...waiters]) {
          waiter();
        }
      };
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", finish);
      const handle: StreamHandle = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        raw: () => raw,
        messages: () => parseSse(raw.slice(0, raw.lastIndexOf("\n\n") + 2)),
        next(predicate, timeoutMs = 3_000) {
          return new Promise((done, fail) => {
            const check = (): boolean => {
              const found = handle.messages().find(predicate);
              if (found) {
                waiters.delete(waiter);
                clearTimeout(timer);
                done(found);
                return true;
              }
              return false;
            };
            const waiter = (): void => {
              check();
            };
            const timer = setTimeout(() => {
              waiters.delete(waiter);
              fail(new Error(`no matching event in ${timeoutMs}ms: ${raw.slice(-500)}`));
            }, timeoutMs);
            if (!check()) {
              waiters.add(waiter);
            }
          });
        },
        ended() {
          return new Promise((done) => {
            if (finished) {
              done();
              return;
            }
            waiters.add(() => {
              if (finished) {
                done();
              }
            });
          });
        },
        close() {
          req.destroy();
        }
      };
      resolve(handle);
    });
    req.on("error", reject);
    req.end();
  });
}
