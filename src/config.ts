import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3003", 10),
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://tribe:tribe@localhost:5435/tribe_er",
  serverWalletPath: process.env.SERVER_WALLET_PATH || "./server-wallet.json",
  settlementIntervalMs: parseInt(
    process.env.SETTLEMENT_INTERVAL_MS || "10000",
    10
  ),
  maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || "50", 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
  programIds: {
    socialGraph:
      process.env.SOCIAL_GRAPH_PROGRAM_ID ||
      "8kKnWvbmTjWq5uPePk79RRbQMAXCszNFzHdRwUS4N74w",
    tidRegistry:
      process.env.TID_REGISTRY_PROGRAM_ID ||
      "4BSmJmRGQWKgioP9DG2bUuRS9U3V6soRauU7Nv6yGvHD",
  },
};
