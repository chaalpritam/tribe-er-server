import { FastifyInstance } from "fastify";
import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../storage/db";
import { config } from "../config";

function writeU64LE(buf: Buffer, offset: number, val: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = val & 0xff;
    val = Math.floor(val / 256);
  }
}

function tidToBuffer(tid: number): Buffer {
  const buf = Buffer.alloc(8);
  writeU64LE(buf, 0, tid);
  return buf;
}

const socialGraphProgramId = new PublicKey(config.programIds.socialGraph);

function deriveLinkPDA(followerTid: number, followingTid: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), tidToBuffer(followerTid), tidToBuffer(followingTid)],
    socialGraphProgramId
  );
  return pda;
}

function deriveSocialProfilePDA(tid: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("social_profile"), tidToBuffer(tid)],
    socialGraphProgramId
  );
  return pda;
}

// SocialProfile account layout after 8-byte discriminator:
// u64 tid (8) + u32 following_count (4) + u32 followers_count (4) + u8 bump (1)
const PROFILE_DISCRIMINATOR_LEN = 8;
const PROFILE_TID_LEN = 8;
const PROFILE_FOLLOWING_OFFSET = PROFILE_DISCRIMINATOR_LEN + PROFILE_TID_LEN;
const PROFILE_FOLLOWERS_OFFSET = PROFILE_FOLLOWING_OFFSET + 4;

function readU32LE(buf: Buffer, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    ((buf[offset + 3] << 24) >>> 0)
  );
}

export async function queryRoutes(server: FastifyInstance) {
  server.get<{ Params: { followerTid: string; followingTid: string } }>(
    "/link/:followerTid/:followingTid",
    async (request) => {
      const { followerTid, followingTid } = request.params;

      // Check local ER state first
      const localResult = await db.query(
        "SELECT status FROM er_links WHERE follower_tid = $1 AND following_tid = $2",
        [followerTid, followingTid]
      );

      if (localResult.rows.length > 0) {
        const status = localResult.rows[0].status;
        return {
          exists: status !== "pending_unfollow",
          status,
        };
      }

      // Fallback: check on-chain
      try {
        const connection = new Connection(config.solanaRpcUrl);
        const linkPDA = deriveLinkPDA(
          parseInt(followerTid, 10),
          parseInt(followingTid, 10)
        );
        const accountInfo = await connection.getAccountInfo(linkPDA);

        if (accountInfo && accountInfo.data.length > 0) {
          return { exists: true, status: "settled" };
        }
      } catch {
        // On-chain lookup failed, fall through
      }

      return { exists: false, status: "none" };
    }
  );

  server.get<{ Params: { tid: string } }>(
    "/profile/:tid",
    async (request) => {
      const { tid } = request.params;

      // Check local ER state first
      const localResult = await db.query(
        "SELECT following_count, followers_count FROM er_profiles WHERE tid = $1",
        [tid]
      );

      if (localResult.rows.length > 0) {
        return {
          tid: parseInt(tid, 10),
          followingCount: localResult.rows[0].following_count,
          followersCount: localResult.rows[0].followers_count,
        };
      }

      // Fallback: check on-chain
      try {
        const connection = new Connection(config.solanaRpcUrl);
        const profilePDA = deriveSocialProfilePDA(parseInt(tid, 10));
        const accountInfo = await connection.getAccountInfo(profilePDA);

        if (
          accountInfo &&
          accountInfo.data.length >= PROFILE_FOLLOWERS_OFFSET + 4
        ) {
          const data = accountInfo.data;
          const followingCount = readU32LE(data, PROFILE_FOLLOWING_OFFSET);
          const followersCount = readU32LE(data, PROFILE_FOLLOWERS_OFFSET);

          return {
            tid: parseInt(tid, 10),
            followingCount,
            followersCount,
          };
        }
      } catch {
        // On-chain lookup failed, fall through
      }

      return {
        tid: parseInt(tid, 10),
        followingCount: 0,
        followersCount: 0,
      };
    }
  );
}
