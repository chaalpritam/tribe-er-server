import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";

interface CachedTidRecord {
  tid: string;
  custodyAddress: string;
  cachedAt: number;
}

const TTL_MS = 60_000; // 60 second cache TTL

// Anchor account layout for TidRecord after 8-byte discriminator:
// u64 tid (8) + Pubkey custody_address (32) + Pubkey recovery_address (32) + i64 registered_at (8) + u8 bump (1)
const DISCRIMINATOR_LEN = 8;
const TID_OFFSET = DISCRIMINATOR_LEN;
const CUSTODY_OFFSET = TID_OFFSET + 8;
const MIN_ACCOUNT_LEN = DISCRIMINATOR_LEN + 8 + 32 + 32 + 8 + 1;

function readU64LE(buf: Buffer, offset: number): number {
  let val = 0;
  let mul = 1;
  for (let i = 0; i < 8; i++) {
    val += buf[offset + i] * mul;
    mul *= 256;
  }
  return val;
}

function writeU64LE(buf: Buffer, offset: number, val: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = val & 0xff;
    val = Math.floor(val / 256);
  }
}

/**
 * In-memory cache of TID records from Solana.
 * Caches tid -> custody_address mappings.
 */
class TidCache {
  private cache = new Map<string, CachedTidRecord>();
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.solanaRpcUrl);
  }

  /**
   * Get the custody address for a TID. Returns null if not found.
   */
  async getCustodyAddress(tid: string): Promise<string | null> {
    const cached = this.cache.get(tid);

    if (cached && Date.now() - cached.cachedAt < TTL_MS) {
      return cached.custodyAddress;
    }

    const record = await this.fetchFromChain(tid);
    if (!record) return null;

    this.cache.set(tid, { ...record, cachedAt: Date.now() });
    return record.custodyAddress;
  }

  /**
   * Verify that a custody pubkey matches the on-chain TID record.
   */
  async verifyCustody(tid: string, custodyPubkey: string): Promise<boolean> {
    const onChainCustody = await this.getCustodyAddress(tid);
    if (!onChainCustody) return false;
    return onChainCustody === custodyPubkey;
  }

  private async fetchFromChain(tid: string): Promise<CachedTidRecord | null> {
    try {
      const tidNum = parseInt(tid, 10);
      const tidBuffer = Buffer.alloc(8);
      writeU64LE(tidBuffer, 0, tidNum);

      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tid"), tidBuffer],
        new PublicKey(config.programIds.tidRegistry)
      );

      const accountInfo = await this.connection.getAccountInfo(pda);
      if (!accountInfo || accountInfo.data.length < MIN_ACCOUNT_LEN)
        return null;

      const data = accountInfo.data;
      const custodyAddress = new PublicKey(
        data.subarray(CUSTODY_OFFSET, CUSTODY_OFFSET + 32)
      ).toBase58();

      return {
        tid,
        custodyAddress,
        cachedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  invalidate(tid: string): void {
    this.cache.delete(tid);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const tidCache = new TidCache();
