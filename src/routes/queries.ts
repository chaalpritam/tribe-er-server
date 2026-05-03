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

  // Net delta of in-flight (pending or settling) operations for this
  // TID. Excludes 'settled' to avoid double-counting once the hub's
  // indexer picks up the on-chain row, and excludes 'failed' since
  // those never landed on L1. Hub adds these to social_graph counts
  // so a hard-reload during the ~10s settlement window still shows
  // the right Following / Followers numbers.
  server.get<{ Params: { tid: string } }>(
    "/pending-deltas/:tid",
    async (request) => {
      const { tid } = request.params;
      const result = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE op_type = 'follow'   AND follower_tid  = $1)
             - COUNT(*) FILTER (WHERE op_type = 'unfollow' AND follower_tid  = $1)
             AS following_delta,
           COUNT(*) FILTER (WHERE op_type = 'follow'   AND following_tid = $1)
             - COUNT(*) FILTER (WHERE op_type = 'unfollow' AND following_tid = $1)
             AS followers_delta
         FROM pending_operations
         WHERE status IN ('pending', 'settling')
           AND (follower_tid = $1 OR following_tid = $1)`,
        [tid]
      );
      const row = result.rows[0] ?? {};
      return {
        tid: parseInt(tid, 10),
        followingDelta: Number(row.following_delta ?? 0),
        followersDelta: Number(row.followers_delta ?? 0),
      };
    }
  );

  // The list-based variant the hub actually uses to merge with its
  // own social_graph. Returns the four sets the hub needs to compute
  // an accurate Following / Followers count without dipping during
  // the indexer-lag window:
  //
  //   followingTids   – tids this user currently follows per ER
  //                     (pending_follow OR settled rows in er_links).
  //   followerTids    – tids that currently follow this user per ER.
  //   unfollowingTids – tids the user has hit unfollow on, but the
  //                     unfollow hasn't fully propagated to the hub's
  //                     social_graph yet. Comes from er_links rows
  //                     still at 'pending_unfollow' AND from recent
  //                     'settled' unfollow ops (5-minute grace —
  //                     after that we let the count snap back if
  //                     the hub indexer is genuinely stuck).
  //   unfollowerTids  – the inverse for incoming unfollows.
  //
  // Hub merges:
  //   (social_graph ∪ followingTids) \ unfollowingTids
  // and counts the set, so deduplication is exact.
  server.get<{ Params: { tid: string } }>(
    "/er-links/:tid",
    async (request) => {
      const { tid } = request.params;
      const linksResult = await db.query(
        `SELECT follower_tid, following_tid, status FROM er_links
         WHERE follower_tid = $1 OR following_tid = $1`,
        [tid]
      );
      const recentUnfollowsResult = await db.query(
        `SELECT follower_tid, following_tid FROM pending_operations
         WHERE op_type = 'unfollow' AND status = 'settled'
           AND settled_at > NOW() - INTERVAL '5 minutes'
           AND (follower_tid = $1 OR following_tid = $1)`,
        [tid]
      );

      const followingTids = new Set<string>();
      const followerTids = new Set<string>();
      const unfollowingTids = new Set<string>();
      const unfollowerTids = new Set<string>();

      for (const row of linksResult.rows) {
        const followerStr = String(row.follower_tid);
        const followingStr = String(row.following_tid);
        if (row.status === "pending_unfollow") {
          if (followerStr === tid) unfollowingTids.add(followingStr);
          if (followingStr === tid) unfollowerTids.add(followerStr);
        } else {
          if (followerStr === tid) followingTids.add(followingStr);
          if (followingStr === tid) followerTids.add(followerStr);
        }
      }
      for (const row of recentUnfollowsResult.rows) {
        const followerStr = String(row.follower_tid);
        const followingStr = String(row.following_tid);
        if (followerStr === tid) unfollowingTids.add(followingStr);
        if (followingStr === tid) unfollowerTids.add(followerStr);
      }

      return {
        tid: parseInt(tid, 10),
        followingTids: [...followingTids],
        followerTids: [...followerTids],
        unfollowingTids: [...unfollowingTids],
        unfollowerTids: [...unfollowerTids],
      };
    }
  );

  // List every follow / unfollow op this TID has touched — as the
  // follower (their own actions) or the followed (incoming follows).
  // Powers the hub's per-account activity feed: each row carries the
  // settlement state and, once on-chain, the Solana tx_signature so
  // the UI can deep-link to a block-explorer for verification.
  server.get<{
    Params: { tid: string };
    Querystring: { limit?: string };
  }>("/v1/operations/:tid", async (request) => {
    const { tid } = request.params;
    const limit = Math.min(parseInt(request.query.limit || "100", 10), 500);
    const result = await db.query(
      `SELECT id, op_type, follower_tid, following_tid, status,
              created_at, settled_at, tx_signature, error
       FROM pending_operations
       WHERE follower_tid = $1 OR following_tid = $1
       ORDER BY COALESCE(settled_at, created_at) DESC
       LIMIT $2`,
      [tid, limit],
    );
    return { operations: result.rows };
  });

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
