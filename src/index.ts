import { buildServer } from "./server";
import { config } from "./config";
import { runMigrations } from "./storage/db";
import { startSettlementLoop } from "./settlement/settler";
import { startReactionFlusher } from "./flush/reactions";

async function main() {
  await runMigrations();

  startSettlementLoop();
  startReactionFlusher();

  const server = await buildServer();

  try {
    await server.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`ER server running on port ${config.port}`);
    console.log(`Settlement interval: ${config.settlementIntervalMs}ms`);
    console.log(`Reaction flush interval: ${config.reactionFlushIntervalMs}ms → ${config.hubUrl}`);
    console.log(`Solana RPC: ${config.solanaRpcUrl}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
