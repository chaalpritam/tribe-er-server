# tribe-er-server

Ephemeral Rollup sequencer for the Tribe protocol. Provides instant follow/unfollow confirmations (~50ms) by accepting signed requests and settling them to Solana L1 in batches every 10 seconds.

## How It Works

```
1. User clicks "Follow"
   Frontend signs: "tribe-er:follow:9:1:<timestamp>"
   POST /v1/follow → ER server

2. ER server (instant)
   Verify ed25519 signature against on-chain TID custody address
   INSERT pending_operations (status: 'pending')
   Return { id, status: "pending" }

3. User sees "Following" immediately

4. Settlement loop (every 10s)
   Query pending operations
   Auto-init missing social profiles on-chain
   Batch follow_delegated/unfollow_delegated instructions (up to 4 per tx)
   Sign with server wallet, send to Solana
   Mark settled with tx_signature
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/follow` | Submit follow (signed by custody wallet) |
| POST | `/v1/unfollow` | Submit unfollow (signed by custody wallet) |
| GET | `/v1/link/:followerTid/:followingTid` | Check follow status (includes pending) |
| GET | `/v1/profile/:tid` | Social profile (includes pending counts) |
| GET | `/health` | Server health + pending ops count |

## Trust Model

- The server wallet is registered on-chain as a sequencer authority (`SequencerConfig` PDA)
- `follow_delegated` / `unfollow_delegated` instructions verify the authority before accepting operations
- Users can always bypass the ER server and call `follow()` directly on Solana L1
- The ER server is a convenience layer, not a gatekeeper

## Project Structure

```
src/
  index.ts                    # Bootstrap (settler + HTTP server)
  server.ts                   # Fastify setup + CORS
  config.ts                   # Environment configuration
  routes/
    operations.ts             # POST /v1/follow, /v1/unfollow
    queries.ts                # GET /v1/link, /v1/profile
    health.ts                 # Health check
  settlement/
    settler.ts                # Settlement loop (setInterval, every 10s)
    batch-builder.ts          # Group operations into Solana transactions
  storage/
    db.ts                     # PostgreSQL pool + migrations
    migrations/
      001_initial.sql         # Schema: pending_operations, er_links, er_profiles
  validation/
    tid-cache.ts              # In-memory cache of TID → custody_pubkey (60s TTL)
```

## Getting Started

```bash
# Start PostgreSQL
docker compose up -d    # or use deploy/docker-compose.node.yml

# Configure
cp .env.example .env    # edit DATABASE_URL, SERVER_WALLET_PATH

# Run
pnpm install
pnpm dev                # http://localhost:3003
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP port |
| `DATABASE_URL` | `postgresql://tribe:tribe@localhost:5435/tribe_er` | PostgreSQL |
| `SOLANA_RPC_URL` | devnet | Solana JSON-RPC |
| `SERVER_WALLET_PATH` | `./server-wallet.json` | Sequencer keypair |
| `SETTLEMENT_INTERVAL_MS` | `10000` | Settlement loop interval |
| `MAX_BATCH_SIZE` | `50` | Max operations per settlement cycle |
| `MAX_RETRIES` | `3` | Retry failed settlements before marking failed |

## Multi-Node

In a multi-node setup, each machine runs its own ER server with its own PostgreSQL, but all share the same `server-wallet.json`. Solana PDA uniqueness prevents duplicate settlements -- if a Link PDA already exists, the settlement fails gracefully and the operation is marked as completed.

The frontend's failover layer automatically routes requests to the healthy ER server.

## License

MIT
