import { buildServer } from "./server";
import { config } from "./config";
import { runMigrations } from "./storage/db";
import { startSettlementLoop } from "./settlement/settler";

async function main() {
  await runMigrations();

  startSettlementLoop();

  const server = await buildServer();

  try {
    await server.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`ER server running on port ${config.port}`);
    console.log(`Settlement interval: ${config.settlementIntervalMs}ms`);
    console.log(`Solana RPC: ${config.solanaRpcUrl}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
