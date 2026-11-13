import type { Pubkey } from "../core/types.js";
import { toNullableBigInt, toNullableNumber, type Db } from "../db/pool.js";
import type { WalletIntel } from "./types.js";

interface IntelRow {
  wallet: string;
  funder: string | null;
  funding_signature: string | null;
  funding_slot: unknown;
  funded_at: Date | null;
  funding_amount: unknown;
  prior_tx_count: unknown;
  prior_tx_capped: boolean;
  oldest_seen_at: Date | null;
  checked_before_signature: string | null;
  checked_at: Date;
  error: string | null;
}

export interface HubFacts {
  address: Pubkey;
  entityKind: string | null;
  fundingBursts: number;
  flagged: boolean;
}

export const FUNDING_BURST_MS = 120_000;

export function fundingBurstKey(intel: Pick<WalletIntel, "wallet" | "fundedAtMs">): string {
  return intel.fundedAtMs === null ? `wallet:${intel.wallet}` : `burst:${Math.floor(intel.fundedAtMs / FUNDING_BURST_MS)}`;
}

function msOrNull(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function dateOrNull(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

export function intelFromRow(row: IntelRow): WalletIntel {
  return {
    wallet: row.wallet,
    funder: row.funder,
    fundingSignature: row.funding_signature,
    fundingSlot: toNullableNumber(row.funding_slot),
    fundedAtMs: msOrNull(row.funded_at),
    fundingAmount: toNullableBigInt(row.funding_amount),
    priorTxCount: toNullableNumber(row.prior_tx_count),
    priorTxCapped: row.prior_tx_capped,
    oldestSeenAtMs: msOrNull(row.oldest_seen_at),
    checkedBeforeSignature: row.checked_before_signature,
    checkedAtMs: row.checked_at.getTime(),
    funderIsHub: false,
    error: row.error
  };
}

export async function loadIntelRows(
  db: Db,
  wallets: readonly Pubkey[],
  freshAfterMs: number,
  errorFreshAfterMs: number,
  checkedUntilMs: number | null = null
): Promise<WalletIntel[]> {
  if (wallets.length === 0) {
    return [];
  }
  const result = await db.query<IntelRow>(
    `SELECT wallet, funder, funding_signature, funding_slot, funded_at, funding_amount, prior_tx_count,
            prior_tx_capped, oldest_seen_at, checked_before_signature, checked_at, error
       FROM wallet_intel
      WHERE wallet = ANY($1::text[])
        AND checked_before_signature IS NOT NULL
        AND ((error IS NULL AND checked_at > $2) OR checked_at > $3)
        AND ($4::timestamptz IS NULL OR checked_at <= $4::timestamptz)`,
    [wallets, new Date(freshAfterMs), new Date(errorFreshAfterMs), checkedUntilMs === null ? null : new Date(checkedUntilMs)]
  );
  return result.rows.map(intelFromRow);
}

export async function saveIntelRow(db: Db, intel: WalletIntel): Promise<void> {
  await db.query(
    `INSERT INTO wallet_intel (wallet, funder, funding_signature, funding_slot, funded_at, funding_amount,
                               prior_tx_count, prior_tx_capped, oldest_seen_at, checked_before_signature,
                               checked_at, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (wallet) DO UPDATE SET
       funder = EXCLUDED.funder,
       funding_signature = EXCLUDED.funding_signature,
       funding_slot = EXCLUDED.funding_slot,
       funded_at = EXCLUDED.funded_at,
       funding_amount = EXCLUDED.funding_amount,
       prior_tx_count = EXCLUDED.prior_tx_count,
       prior_tx_capped = EXCLUDED.prior_tx_capped,
       oldest_seen_at = EXCLUDED.oldest_seen_at,
       checked_before_signature = EXCLUDED.checked_before_signature,
       checked_at = EXCLUDED.checked_at,
       error = EXCLUDED.error`,
    [
      intel.wallet,
      intel.funder,
      intel.fundingSignature,
      intel.fundingSlot,
      dateOrNull(intel.fundedAtMs),
      intel.fundingAmount === null ? null : intel.fundingAmount.toString(),
      intel.priorTxCount,
      intel.priorTxCapped,
      dateOrNull(intel.oldestSeenAtMs),
      intel.checkedBeforeSignature,
      new Date(intel.checkedAtMs),
      intel.error
    ]
  );
}

export async function loadHubFacts(db: Db, addresses: readonly Pubkey[]): Promise<Map<Pubkey, HubFacts>> {
  const facts = new Map<Pubkey, HubFacts>();
  if (addresses.length === 0) {
    return facts;
  }
  const result = await db.query<{ address: string; kind: string | null; bursts: number; flagged: boolean }>(
    `SELECT f.address,
            (SELECT k.kind FROM known_entities k WHERE k.address = f.address) AS kind,
            (SELECT count(DISTINCT CASE WHEN w.funded_at IS NULL THEN 'wallet:' || w.wallet
                                        ELSE 'burst:' || floor(extract(epoch FROM w.funded_at) * 1000 / $2)::bigint END)::int
               FROM wallet_intel w WHERE w.funder = f.address) AS bursts,
            COALESCE((SELECT w2.is_hub FROM wallet_intel w2 WHERE w2.wallet = f.address), FALSE) AS flagged
       FROM unnest($1::text[]) AS f(address)`,
    [addresses, FUNDING_BURST_MS]
  );
  for (const row of result.rows) {
    facts.set(row.address, { address: row.address, entityKind: row.kind, fundingBursts: row.bursts, flagged: row.flagged });
  }
  return facts;
}

export async function markHubs(db: Db, addresses: readonly Pubkey[]): Promise<void> {
  if (addresses.length === 0) {
    return;
  }
  await db.query(
    `INSERT INTO wallet_intel (wallet, checked_at, is_hub)
     SELECT address, to_timestamp(0), TRUE FROM unnest($1::text[]) AS a(address)
     ON CONFLICT (wallet) DO UPDATE SET is_hub = TRUE`,
    [addresses]
  );
}
