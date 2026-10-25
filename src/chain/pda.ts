import { PublicKey } from "@solana/web3.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, SOL_QUOTE, WSOL_MINT } from "../core/constants.js";

const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const PUMP_AMM_PROGRAM = new PublicKey(PUMP_AMM_PROGRAM_ID);
const CANONICAL_POOL_INDEX = Buffer.from([0, 0]);

function publicKeyOf(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function pumpPoolAuthority(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0];
}

export function canonicalPumpPoolAddress(mint: string, quoteMint: string): string | null {
  const base = publicKeyOf(mint);
  const quote = publicKeyOf(quoteMint === SOL_QUOTE ? WSOL_MINT : quoteMint);
  if (!base || !quote) {
    return null;
  }
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), CANONICAL_POOL_INDEX, pumpPoolAuthority(base).toBuffer(), base.toBuffer(), quote.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  return pool.toBase58();
}

export function isCanonicalPumpPool(pool: string, mint: string, quoteMint: string): boolean {
  return canonicalPumpPoolAddress(mint, quoteMint) === pool;
}
