# tribe-er-server

Ephemeral Rollup sequencer for TribeEco. Provides instant follow/unfollow confirmations (~50ms) by accepting signed requests and batching them to Solana every 10 seconds.

## Stack

- Fastify HTTP server (port 3003)
- PostgreSQL 16 for pending operations
- TypeScript, pnpm, node:20

## Key Directories

- `src/routes/` — API routes (health, follow, unfollow)
- `src/settlement/` — Batch builder and settler (L1 settlement)
- `src/storage/` — Database queries and migrations
- `src/config.ts` — Environment config

## Server Wallet

The ER server needs a Solana keypair (`server-wallet.json`) registered as a sequencer authority on-chain. The wallet is:
- Generated automatically by `tribe doctor` or `tribe start`
- Persisted at `~/.tribe/server-wallet.json` (survives reinstalls)
- Loaded from `SERVER_WALLET_PATH` env var (default: `./server-wallet.json`)
- Read via `readFileSync` in `src/settlement/settler.ts`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| PORT | 3003 | Server port |
| DATABASE_URL | — | PostgreSQL connection string |
| SOLANA_RPC_URL | — | Solana RPC endpoint |
| SERVER_WALLET_PATH | ./server-wallet.json | Path to sequencer keypair |
| SETTLEMENT_INTERVAL_MS | 10000 | Batch settlement interval (10s) |
| SOCIAL_GRAPH_PROGRAM_ID | — | Social graph program address |
| TID_REGISTRY_PROGRAM_ID | — | TID registry program address |

## Docker

- `Dockerfile` — Multi-stage build: pnpm install → pnpm build → node dist/index.js
- Exposes port 3003
- Migrations included in build output
