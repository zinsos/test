import type { Connection } from "@solana/web3.js";
import type { RpcClient } from "../chain/rpc.js";
import { fromRpcTransaction, fromWeb3Transaction, type ConfirmedTransaction } from "./fillParser.js";

export interface TransactionSender {
  readonly name: string;
  send(raw: Uint8Array): Promise<string>;
}

export type TransactionFetcher = (signature: string) => Promise<ConfirmedTransaction | null>;

export class RpcTransactionSender implements TransactionSender {
  readonly name = "rpc";

  constructor(private readonly connection: Pick<Connection, "sendRawTransaction">) {}

  send(raw: Uint8Array): Promise<string> {
    return this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  }
}

export interface JitoTransactionSenderOptions {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function jitoTransactionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  const path = base.endsWith("/api/v1/transactions") ? base : `${base}/api/v1/transactions`;
  return `${path}?bundleOnly=true`;
}

export class JitoTransactionSender implements TransactionSender {
  readonly name = "jito";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(options: JitoTransactionSenderOptions) {
    this.url = jitoTransactionsUrl(options.endpoint);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(raw: Uint8Array): Promise<string> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "sendTransaction",
      params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }]
    });
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const reply = (await response.json()) as JsonRpcReply;
    if (!response.ok || reply.error || typeof reply.result !== "string") {
      throw new Error(`jito sendTransaction failed: ${reply.error?.message ?? `http ${response.status}`}`);
    }
    return reply.result;
  }
}

export function web3TransactionFetcher(connection: Pick<Connection, "getParsedTransaction">): TransactionFetcher {
  return async (signature) => {
    const tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
    return tx ? fromWeb3Transaction(signature, tx) : null;
  };
}

export function rpcClientTransactionFetcher(rpc: Pick<RpcClient, "getParsedTransaction">): TransactionFetcher {
  return async (signature) => {
    const tx = await rpc.getParsedTransaction(signature, "high");
    return tx ? fromRpcTransaction(signature, tx) : null;
  };
}
