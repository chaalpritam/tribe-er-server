# tribe-er-server

Ephemeral Rollup sequencer for TribeEco. Two workloads:

- **On-chain ops** (follow / unfollow): accept signed requests, batch them to Solana's social-graph program every 10s. ~50ms confirmation, hub reads pending state via `/v1/er-links/:tid`.
- **Off-chain envelope buffer** (reactions): accept user-signed REACTION envelopes, store, forward to hub `/v1/submit` every 5s. Clients can read pending reactions via `/v1/pending-reactions/:tid` and `/v1/pending-reactions-on/:targetHash` before the hub has indexed them — same "instant confirmation" feel as follows, without the Solana round-trip (reactions are off-chain).

## Stack

- Fastify HTTP server (port 3003)
- PostgreSQL 16 for pending operations
- TypeScript, pnpm, node:20

## Key Directories

- `src/routes/` — API routes (health, follow, unfollow, reaction, queries)
- `src/settlement/` — Batch builder and settler (Solana L1 settlement)
- `src/flush/` — Off-chain envelope flusher (hub forwarding for reactions)
- `src/validation/` — Envelope shape + signature verification
- `src/storage/` — Database queries and migrations
- `src/config.ts` — Environment config

## Reaction buffer (PLAN.md Phase 5)

Unlike follows, REACTION_ADD (type=3) / REACTION_REMOVE (type=4) are off-chain envelopes signed by the user's app key. ER doesn't sign anything — it accepts the user-signed envelope on `POST /v1/reaction`, validates (shape, blake3 hash, ed25519 signature, 60s timestamp window), stores in `pending_reactions`, and the `src/flush/reactions.ts` worker drains the queue to the hub on a 5s tick. Failed hub submissions get marked `failed` (4xx) or left `pending` for retry (5xx / network).

Dedup is keyed on `envelope_hash` — a client retry with the same envelope hits `ON CONFLICT DO NOTHING` and the existing row's status is surfaced back, so the client can tell whether the reaction is still pending, already flushed, or failed.

`/v1/pending-reactions-on/:targetHash` collapses add+remove from the same TID to net zero, so the UI doesn't double-count a like-then-unlike that's still in the batch window.

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
| HUB_URL | http://localhost:4000 | Hub base URL for reaction flusher |
| REACTION_FLUSH_INTERVAL_MS | 5000 | Reaction batch flush interval (5s) |
| REACTION_FLUSH_BATCH_SIZE | 100 | Max envelopes per flush tick |

## Docker

- `Dockerfile` — Multi-stage build: pnpm install → pnpm build → node dist/index.js
- Exposes port 3003
- Migrations included in build output
