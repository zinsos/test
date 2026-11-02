import type { Db } from "../src/db/pool.js";

export interface LaunchRowSpec {
  mint: string;
  dev?: string;
  creator?: string;
  createdAtMs: number;
  migratedAtMs?: number | null;
  quoteMint?: string;
}

export interface OutcomeRowSpec {
  status?: string;
  rugged?: boolean;
  migrated?: boolean;
  died?: boolean;
  survived15m?: boolean | null;
  knownAtMs?: number | null;
  finalized?: boolean;
  peakMultiple?: number | null;
  peakAtMs?: number | null;
  rugAtMs?: number | null;
  peakMultipleFrom1m?: number | null;
  return15mFrom1m?: number | null;
}

export const INITIAL_MCAP = (30_000_000_000n * 1_000_000_000_000_000n) / 1_073_000_000_000_000n;

function date(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

export async function insertLaunch(db: Db, spec: LaunchRowSpec): Promise<number> {
  const result = await db.query<{ id: bigint }>(
    `INSERT INTO launches (mint, bonding_curve, dev_wallet, creator, create_signature, create_slot, created_at,
                           token_total_supply, initial_virtual_token, initial_virtual_quote, initial_real_token,
                           migrated_at, quote_mint)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 1000000000000000, 1073000000000000, 30000000000, 793100000000000, $7, $8)
     RETURNING id`,
    [
      spec.mint,
      `${spec.mint}Curve`,
      spec.dev ?? "Dev",
      spec.creator ?? spec.dev ?? "Dev",
      `${spec.mint}Sig`,
      new Date(spec.createdAtMs),
      date(spec.migratedAtMs),
      spec.quoteMint ?? "SOL"
    ]
  );
  return Number(result.rows[0]?.id ?? 0);
}

export async function insertOutcome(db: Db, launchId: number, spec: OutcomeRowSpec): Promise<void> {
  const peak =
    spec.peakMultiple === null || spec.peakMultiple === undefined
      ? null
      : ((INITIAL_MCAP * BigInt(Math.round(spec.peakMultiple * 1_000_000))) / 1_000_000n).toString();
  await db.query(
    `INSERT INTO launch_outcomes (launch_id, status, migrated, rugged, died, survived_15m, initial_mcap_quote,
                                  peak_mcap_quote, peak_at, rug_at, outcome_known_at, finalized,
                                  peak_multiple_from_1m, return_15m_from_1m)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      launchId,
      spec.status ?? "known",
      spec.migrated ?? false,
      spec.rugged ?? false,
      spec.died ?? false,
      spec.survived15m ?? null,
      INITIAL_MCAP.toString(),
      peak,
      date(spec.peakAtMs),
      date(spec.rugAtMs),
      date(spec.knownAtMs),
      spec.finalized ?? false,
      spec.peakMultipleFrom1m ?? null,
      spec.return15mFrom1m ?? null
    ]
  );
}

export function countingDb(db: Db): { db: Db; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "query") {
        return (...args: unknown[]) => {
          calls += 1;
          return (target.query as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  return { db: proxy, calls: () => calls };
}
