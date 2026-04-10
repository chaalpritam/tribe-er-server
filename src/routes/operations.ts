import { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { db } from "../storage/db";
import { tidCache } from "../validation/tid-cache";

interface OperationBody {
  followerTid: string;
  followingTid: string;
  custodyPubkey: string;
  signature: string;
  timestamp: number;
}

function verifySignature(
  opType: string,
  body: OperationBody
): boolean {
  try {
    const message = `tribe-er:${opType}:${body.followerTid}:${body.followingTid}:${body.timestamp}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(body.signature, "base64");
    const pubkeyBytes = new PublicKey(body.custodyPubkey).toBytes();

    return nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

async function handleOperation(
  opType: "follow" | "unfollow",
  body: OperationBody
): Promise<{ id: string; status: string } | { error: string; statusCode: number }> {
  // 1. Verify signature
  if (!verifySignature(opType, body)) {
    return { error: "Invalid signature", statusCode: 400 };
  }

  // 2. Check timestamp within 60s
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - body.timestamp) > 60) {
    return { error: "Timestamp out of range", statusCode: 400 };
  }

  // 3. Verify custody matches on-chain TID record
  const custodyValid = await tidCache.verifyCustody(
    body.followerTid,
    body.custodyPubkey
  );
  if (!custodyValid) {
    return { error: "Custody pubkey does not match TID record", statusCode: 403 };
  }

  // 4. Check for signature replay (same signature seen before)
  const replayCheck = await db.query(
    `SELECT id FROM pending_operations WHERE signature = $1`,
    [body.signature]
  );
  if (replayCheck.rows.length > 0) {
    return { error: "Signature already used (replay)", statusCode: 409 };
  }

  // 5. Check for duplicate pending operation (same action still pending)
  const dupCheck = await db.query(
    `SELECT id FROM pending_operations
     WHERE op_type = $1 AND follower_tid = $2 AND following_tid = $3 AND status = 'pending'`,
    [opType, body.followerTid, body.followingTid]
  );
  if (dupCheck.rows.length > 0) {
    return { error: "Duplicate pending operation", statusCode: 409 };
  }

  // 5. Insert into pending_operations
  const insertResult = await db.query(
    `INSERT INTO pending_operations (op_type, follower_tid, following_tid, custody_pubkey, signature, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
     RETURNING id`,
    [opType, body.followerTid, body.followingTid, body.custodyPubkey, body.signature]
  );
  const opId = insertResult.rows[0].id;

  // 6. Optimistic local state update
  if (opType === "follow") {
    await db.query(
      `INSERT INTO er_links (follower_tid, following_tid, status, created_at)
       VALUES ($1, $2, 'pending_follow', NOW())
       ON CONFLICT (follower_tid, following_tid) DO UPDATE SET status = 'pending_follow'`,
      [body.followerTid, body.followingTid]
    );

    // Upsert follower profile (increment following_count)
    await db.query(
      `INSERT INTO er_profiles (tid, following_count, followers_count, updated_at)
       VALUES ($1, 1, 0, NOW())
       ON CONFLICT (tid) DO UPDATE SET following_count = er_profiles.following_count + 1, updated_at = NOW()`,
      [body.followerTid]
    );

    // Upsert following profile (increment followers_count)
    await db.query(
      `INSERT INTO er_profiles (tid, following_count, followers_count, updated_at)
       VALUES ($1, 0, 1, NOW())
       ON CONFLICT (tid) DO UPDATE SET followers_count = er_profiles.followers_count + 1, updated_at = NOW()`,
      [body.followingTid]
    );
  } else {
    // unfollow
    await db.query(
      `UPDATE er_links SET status = 'pending_unfollow' WHERE follower_tid = $1 AND following_tid = $2`,
      [body.followerTid, body.followingTid]
    );

    // Decrement follower's following_count
    await db.query(
      `UPDATE er_profiles SET following_count = GREATEST(following_count - 1, 0), updated_at = NOW() WHERE tid = $1`,
      [body.followerTid]
    );

    // Decrement following's followers_count
    await db.query(
      `UPDATE er_profiles SET followers_count = GREATEST(followers_count - 1, 0), updated_at = NOW() WHERE tid = $1`,
      [body.followingTid]
    );
  }

  return { id: String(opId), status: "pending" };
}

export async function operationRoutes(server: FastifyInstance) {
  server.post<{ Body: OperationBody }>("/follow", async (request, reply) => {
    const result = await handleOperation("follow", request.body);
    if ("error" in result) {
      return reply.status(result.statusCode).send({ error: result.error });
    }
    return result;
  });

  server.post<{ Body: OperationBody }>("/unfollow", async (request, reply) => {
    const result = await handleOperation("unfollow", request.body);
    if ("error" in result) {
      return reply.status(result.statusCode).send({ error: result.error });
    }
    return result;
  });
}
