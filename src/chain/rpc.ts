import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("rpc");

export type RpcPriority = "high" | "normal" | "low";

export interface RpcClientOptions {
  url: string;
  maxRps: number;
  maxConcurrency: number;
  timeoutMs: number;
  maxRetries: number;
  maxQueued?: number;
  maxQueueWaitMs?: number;
}

const DEFAULT_MAX_QUEUED = 2_000;
const DEFAULT_MAX_QUEUE_WAIT_MS = 120_000;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
  accounts?: string[];
  data?: string;
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages?: string[] | null;
    innerInstructions?: Array<{ index: number; instructions: ParsedInstruction[] }> | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean } | string>;
      instructions: ParsedInstruction[];
    };
  };
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface LargestTokenAccount {
  address: string;
  amount: string;
  decimals: number;
}

export interface ParsedAccountInfo {
  owner: string;
  lamports: number;
  data: { parsed?: { type?: string; info?: Record<string, unknown> }; program?: string } | [string, string] | null;
}

interface QueueItem {
  priority: RpcPriority;
  enqueuedAtMs: number;
  run: () => void;
  drop: (reason: string) => void;
}

const PRIORITY_ORDER: Record<RpcPriority, number> = { high: 0, normal: 1, low: 2 };

export class RpcClient {
  private readonly queue: QueueItem[] = [];
  private active = 0;
  private tokens: number;
  private lastRefill = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private callCount = 0;
  private errorCount = 0;
  private droppedCount = 0;
  private readonly capacity: number;
  private readonly maxQueued: number;
  private readonly maxQueueWaitMs: number;

  constructor(private readonly options: RpcClientOptions) {
    this.capacity = Math.max(1, options.maxRps);
    this.tokens = this.capacity;
    this.maxQueued = Math.max(1, options.maxQueued ?? DEFAULT_MAX_QUEUED);
    this.maxQueueWaitMs = Math.max(1, options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS);
  }

  stats(): { calls: number; errors: number; queued: number; active: number; dropped: number } {
    return {
      calls: this.callCount,
      errors: this.errorCount,
      queued: this.queue.length,
      active: this.active,
      dropped: this.droppedCount
    };
  }

  async call<T>(method: string, params: unknown[], priority: RpcPriority = "normal"): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.schedule(() => this.send<T>(method, params), priority);
      } catch (error) {
        const retryable = error instanceof RpcError ? error.retryable : true;
        if (!retryable || attempt >= this.options.maxRetries) {
          this.errorCount += 1;
          throw error;
        }
        const delay = Math.min(10_000, 250 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  getSignaturesForAddress(
    address: string,
    options: { before?: string; until?: string; limit?: number; commitment?: string },
    priority: RpcPriority = "normal"
  ): Promise<SignatureInfo[]> {
    const config: Record<string, unknown> = { limit: options.limit ?? 1000, commitment: options.commitment ?? "confirmed" };
    if (options.before) {
      config.before = options.before;
    }
    if (options.until) {
      config.until = options.until;
    }
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, config], priority);
  }

  getParsedTransaction(signature: string, priority: RpcPriority = "normal"): Promise<ParsedTransaction | null> {
    return this.call<ParsedTransaction | null>(
      "getTransaction",
      [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
      priority
    );
  }

  async getTokenLargestAccounts(mint: string, priority: RpcPriority = "normal"): Promise<LargestTokenAccount[]> {
    const result = await this.call<{ value: LargestTokenAccount[] }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }],
      priority
    );
    return result.value;
  }

  async getMultipleParsedAccounts(
    addresses: string[],
    priority: RpcPriority = "normal"
  ): Promise<Array<ParsedAccountInfo | null>> {
    const results: Array<ParsedAccountInfo | null> = [];
    for (let start = 0; start < addresses.length; start += 100) {
      const chunk = addresses.slice(start, start + 100);
      const response = await this.call<{ value: Array<ParsedAccountInfo | null> }>(
        "getMultipleAccounts",
        [chunk, { encoding: "jsonParsed", commitment: "confirmed" }],
        priority
      );
      results.push(...response.value);
    }
    return results;
  }

  async getBalance(address: string, priority: RpcPriority = "normal"): Promise<bigint> {
    const result = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }], priority);
    return BigInt(result.value);
  }

  getSlot(priority: RpcPriority = "normal"): Promise<number> {
    return this.call<number>("getSlot", [{ commitment: "confirmed" }], priority);
  }

  async getSignatureStatuses(
    signatures: string[],
    priority: RpcPriority = "high"
  ): Promise<Array<{ slot: number; err: unknown; confirmationStatus: string | null } | null>> {
    const result = await this.call<{
      value: Array<{ slot: number; err: unknown; confirmationStatus: string | null } | null>;
    }>("getSignatureStatuses", [signatures, { searchTransactionHistory: false }], priority);
    return result.value;
  }

  private schedule<T>(task: () => Promise<T>, priority: RpcPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        priority,
        enqueuedAtMs: Date.now(),
        drop: (reason) => {
          this.droppedCount += 1;
          reject(new RpcError(reason, null, false));
        },
        run: () => {
          this.active += 1;
          task()
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              this.pump();
            });
        }
      };
      if (!this.makeRoomFor(priority)) {
        item.drop("rpc queue full");
        return;
      }
      const index = this.queue.findIndex((queued) => PRIORITY_ORDER[queued.priority] > PRIORITY_ORDER[priority]);
      if (index === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(index, 0, item);
      }
      this.pump();
    });
  }

  private makeRoomFor(priority: RpcPriority): boolean {
    this.dropExpired();
    if (this.queue.length < this.maxQueued) {
      return true;
    }
    const tail = this.queue[this.queue.length - 1];
    if (!tail || PRIORITY_ORDER[tail.priority] <= PRIORITY_ORDER[priority]) {
      return false;
    }
    this.queue.pop();
    tail.drop("rpc queue full");
    return true;
  }

  private dropExpired(): void {
    const cutoff = Date.now() - this.maxQueueWaitMs;
    if (!this.queue.some((item) => item.enqueuedAtMs < cutoff)) {
      return;
    }
    const kept: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.enqueuedAtMs < cutoff) {
        item.drop("rpc queue wait exceeded");
      } else {
        kept.push(item);
      }
    }
    this.queue.splice(0, this.queue.length, ...kept);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.options.maxRps);
      this.lastRefill = now;
    }
  }

  private pump(): void {
    this.dropExpired();
    this.refill();
    while (this.queue.length > 0 && this.active < this.options.maxConcurrency && this.tokens >= 1) {
      const item = this.queue.shift();
      if (!item) {
        break;
      }
      this.tokens -= 1;
      item.run();
    }
    if (this.queue.length > 0 && !this.timer) {
      const wait = Math.max(5, Math.ceil(((1 - this.tokens) / this.options.maxRps) * 1000));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      this.timer.unref?.();
    }
  }

  private async send<T>(method: string, params: unknown[]): Promise<T> {
    this.callCount += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal
      });
      if (response.status === 429 || response.status >= 500) {
        throw new RpcError(`rpc http ${response.status}`, response.status, true);
      }
      if (!response.ok) {
        throw new RpcError(`rpc http ${response.status}`, response.status, false);
      }
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        const retryable = body.error.code === -32005 || body.error.code === -32004 || body.error.code === 429;
        throw new RpcError(`${method}: ${body.error.message}`, body.error.code, retryable);
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }
      log.debug({ err: error, method }, "rpc transport error");
      throw new RpcError(`${method}: ${(error as Error).message}`, null, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
