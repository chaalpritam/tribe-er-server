import { FastifyInstance } from "fastify";
import { db } from "../storage/db";
import { getServerWallet } from "../settlement/settler";
import { Connection } from "@solana/web3.js";
import { config } from "../config";

export async function healthRoutes(server: FastifyInstance) {
  server.get("/health", async () => {
    const pendingResult = await db.query(
      "SELECT COUNT(*) FROM pending_operations WHERE status = 'pending'"
    );
    const pendingOps = parseInt(pendingResult.rows[0].count, 10);

    const wallet = getServerWallet();
    const pubkey = wallet.publicKey.toBase58();

    let balance = 0;
    try {
      const connection = new Connection(config.solanaRpcUrl);
      const lamports = await connection.getBalance(wallet.publicKey);
      balance = lamports / 1e9;
    } catch {
      // balance stays 0 on error
    }

    return {
      ok: true,
      pendingOps,
      serverWallet: pubkey,
      balance,
    };
  });
}
