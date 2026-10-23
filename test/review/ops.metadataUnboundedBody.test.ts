import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import type { Db } from "../../src/db/pool.js";
import { MetadataFetcher, type FetchLike } from "../../src/recorder/metadata.js";

const CHUNK = 64 * 1024;
const TOTAL_CHUNKS = 320;

function endlessJsonResponse(counter: { bytes: number; urls: string[] }): FetchLike {
  return async (input) => {
    counter.urls.push(input);
    let sent = 0;
    const filler = new TextEncoder().encode("a".repeat(CHUNK));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          const head = new TextEncoder().encode('{"name":"x","description":"');
          counter.bytes += head.length;
          controller.enqueue(head);
        }
        if (sent >= TOTAL_CHUNKS) {
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
          return;
        }
        sent += 1;
        counter.bytes += filler.length;
        controller.enqueue(filler);
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("review ops: launch metadata fetch size bound", () => {
  it("stops reading an attacker-controlled metadata body once it exceeds maxBytes", async () => {
    const counter = { bytes: 0, urls: [] as string[] };
    const fetcher = new MetadataFetcher({
      db: {} as Db,
      clock: new VirtualClock(1_800_000_000_000),
      config: { enabled: true, timeoutMs: 6_000, gateway: "https://ipfs.io/ipfs/", concurrency: 8, maxRetries: 0 },
      fetchImpl: endlessJsonResponse(counter)
    });
    fetcher.start();
    await expect(fetcher.fetchWithRetries("https://attacker.example/meta.json")).rejects.toThrow(/too large/);
    expect(counter.bytes).toBeLessThanOrEqual(256 * 1024 + CHUNK);
  });

  it("does not fetch metadata URIs that point at private or internal hosts", async () => {
    const counter = { bytes: 0, urls: [] as string[] };
    const fetcher = new MetadataFetcher({
      db: {} as Db,
      clock: new VirtualClock(1_800_000_000_000),
      config: { enabled: true, timeoutMs: 6_000, gateway: "https://ipfs.io/ipfs/", concurrency: 8, maxRetries: 0 },
      fetchImpl: endlessJsonResponse(counter)
    });
    fetcher.start();
    await fetcher.fetchWithRetries("http://169.254.169.254/latest/meta-data/").catch(() => undefined);
    await fetcher.fetchWithRetries("http://snypra.railway.internal:8080/api/positions").catch(() => undefined);
    expect(counter.urls).toEqual([]);
  });
});
