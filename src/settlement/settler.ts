import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { config } from "../config";
import { db } from "../storage/db";
import { buildInstructionBatches, PendingOp } from "./batch-builder";

let serverWallet: Keypair;

function loadServerWallet(): Keypair {
  try {
    const raw = readFileSync(config.serverWalletPath, "utf-8");
    const secretKey = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secretKey);
  } catch (err) {
    console.error(
      `Failed to load server wallet from ${config.serverWalletPath}:`,
      err
    );
    console.warn("Settlement will not work until a valid wallet is provided.");
    // Return a dummy keypair so the server can still start for reads
    return Keypair.generate();
  }
}

export function getServerWallet(): Keypair {
  if (!serverWallet) {
    serverWallet = loadServerWallet();
  }
  return serverWallet;
}

async function settleBatch(): Promise<void> {
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  // 1. Query pending operations
  const result = await db.query(
    `SELECT id, op_type, follower_tid, following_tid
     FROM pending_operations
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT $1`,
    [config.maxBatchSize]
  );

  if (result.rows.length === 0) return;

  const ops: PendingOp[] = result.rows.map((row) => ({
    id: String(row.id),
    op_type: row.op_type as "follow" | "unfollow",
    follower_tid: parseInt(row.follower_tid, 10),
    following_tid: parseInt(row.following_tid, 10),
  }));

  console.log(`Settling ${ops.length} pending operations...`);

  const wallet = getServerWallet();
  const batches = await buildInstructionBatches(ops, wallet.publicKey, connection);

  for (const batch of batches) {
    // Skip marking for profile-init batches (no opIds)
    if (batch.opIds.length > 0) {
      // 2. Mark as settling
      await db.query(
        `UPDATE pending_operations SET status = 'settling' WHERE id = ANY($1::bigint[])`,
        [batch.opIds]
      );
    }

    try {
      // 3. Build and send transaction
      const tx = new Transaction();
      for (const ix of batch.instructions) {
        tx.add(ix);
      }

      const txSignature = await sendAndConfirmTransaction(
        connection,
        tx,
        [wallet],
        { commitment: "confirmed" }
      );

      console.log(
        `Settlement tx confirmed: ${txSignature} (${batch.opIds.length} ops, ${batch.instructions.length} ixs)`
      );

      if (batch.opIds.length === 0) continue; // Profile init batch, no ops to update

      // 4. Mark as settled
      await db.query(
        `UPDATE pending_operations
         SET status = 'settled', settled_at = NOW(), tx_signature = $1
         WHERE id = ANY($2::bigint[])`,
        [txSignature, batch.opIds]
      );

      // Update er_links to settled
      // Fetch the ops to know which links to update
      for (const opId of batch.opIds) {
        const op = ops.find((o) => o.id === opId);
        if (!op) continue;

        if (op.op_type === "follow") {
          await db.query(
            `UPDATE er_links SET status = 'settled'
             WHERE follower_tid = $1 AND following_tid = $2`,
            [op.follower_tid, op.following_tid]
          );
        } else {
          // unfollow - remove the link
          await db.query(
            `DELETE FROM er_links WHERE follower_tid = $1 AND following_tid = $2`,
            [op.follower_tid, op.following_tid]
          );
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Settlement failed for batch:`, errorMsg);

      // 5. Mark as failed, retry if under limit
      if (batch.opIds.length === 0) continue;
      await db.query(
        `UPDATE pending_operations
         SET status = CASE
           WHEN retry_count < $1 THEN 'pending'
           ELSE 'failed'
         END,
         error = $2,
         retry_count = retry_count + 1
         WHERE id = ANY($3::bigint[])`,
        [config.maxRetries, errorMsg, batch.opIds]
      );
    }
  }
}

let settlementTimer: ReturnType<typeof setInterval> | null = null;

export function startSettlementLoop(): void {
  // Load wallet eagerly
  serverWallet = loadServerWallet();
  console.log(`Server wallet: ${serverWallet.publicKey.toBase58()}`);

  settlementTimer = setInterval(async () => {
    try {
      await settleBatch();
    } catch (err) {
      console.error("Settlement loop error:", err);
    }
  }, config.settlementIntervalMs);

  console.log(
    `Settlement loop started (every ${config.settlementIntervalMs}ms)`
  );
}

export function stopSettlementLoop(): void {
  if (settlementTimer) {
    clearInterval(settlementTimer);
    settlementTimer = null;
  }
}
