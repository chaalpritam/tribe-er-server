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
   Query up to MAX_BATCH_SIZE pending operations (default 50)
   Auto-init missing social profiles on-chain
   Pack follow_delegated / unfollow_delegated instructions
     into Solana transactions (~4 instructions per tx)
   Sign with server wallet, send to Solana
   Mark settled with tx_signature
```

A single settlement cycle drains up to `MAX_BATCH_SIZE` operations, splitting them across as many transactions as needed (Solana's per-tx size cap is what bounds the ~4 ix-per-tx figure, not the batch as a whole).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/follow` | Submit follow (signed by custody wallet) |
| POST | `/v1/unfollow` | Submit unfollow (signed by custody wallet) |
| GET | `/v1/link/:followerTid/:followingTid` | Check follow status (includes pending) |
| GET | `/v1/profile/:tid` | Social profile (includes pending counts) |
| GET | `/health` | Server health, server wallet pubkey, SOL balance, and pending ops count |

## Trust Model

- The server wallet is registered on-chain as a sequencer authority (`SequencerConfig` PDA)
- `follow_delegated` / `unfollow_delegated` instructions verify the authority before accepting operations
- Users can always bypass the ER server and call `follow()` directly on Solana L1
- The ER server is a convenience layer, not a gatekeeper

### Replay & freshness

Every accepted request is gated on:

- **Signature uniqueness** -- `pending_operations` rejects duplicate ed25519 signatures, blocking replays
- **Timestamp window** -- the signed payload includes a Unix timestamp; requests outside a 60-second window are rejected
- **Optimistic local state** -- `er_links` and `er_profiles` are updated immediately on accept (status: `pending_follow` / `pending_unfollow`) so reads see the new edge before L1 settlement; on settlement, unfollows delete the row outright

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

The server binds to `0.0.0.0:3003`, so other devices on the same Wi-Fi reach it as `http://<hostname>.local:3003`. Run `tribe share` from the parent repo for the exact URL — it shows the ER server URL alongside the hub URL so you can plug both into a remote frontend or native app. See the [main README](../Readme.md#cross-device-development-on-one-wi-fi) for the full flow.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | HTTP port |
| `DATABASE_URL` | `postgresql://tribe:tribe@localhost:5435/tribe_er` | PostgreSQL |
| `SOLANA_RPC_URL` | devnet | Solana JSON-RPC |
| `SERVER_WALLET_PATH` | `./server-wallet.json` | Sequencer keypair |
| `SETTLEMENT_INTERVAL_MS` | `10000` | Settlement loop interval |
| `MAX_BATCH_SIZE` | `50` | Max operations per settlement cycle (split across ~4-ix transactions) |
| `MAX_RETRIES` | `3` | Retry failed settlements before marking failed |
| `SOCIAL_GRAPH_PROGRAM_ID` | (devnet default) | Override `social-graph` program ID |
| `TID_REGISTRY_PROGRAM_ID` | (devnet default) | Override `tid-registry` program ID |

## Multi-Node

In a multi-node setup, each machine runs its own ER server with its own PostgreSQL, but all share the same `server-wallet.json`. Solana PDA uniqueness prevents duplicate settlements -- if a Link PDA already exists, the settlement fails gracefully and the operation is marked as completed.

The frontend's failover layer automatically routes requests to the healthy ER server.

## Related Repos

| Repo | Description |
|------|-------------|
| [tribe-protocol](../tribe-protocol) | Solana programs (Anchor) — 12 programs: tid-registry, app-key-registry, username-registry, social-graph w/ ER delegation, hub-registry, tip-registry, crowdfund-registry, task-registry, channel-registry, karma-registry, poll-registry, event-registry |
| [tribe-sdk](../tribe-sdk) | TypeScript SDK — DirectSolana and EphemeralRollup providers; clients for identity, tweets, DMs, profiles, channels, bookmarks, polls, events, tasks, crowdfunds, tips, search |
| [tribe-hub](../tribe-hub) | Decentralized hub — signed-message storage + Solana indexer + gossip peer sync; REST + WebSocket APIs |
| [tribe-er-server](../tribe-er-server) | Ephemeral Rollup sequencer — instant follows, batched L1 settlement every 10s |
| [tribe-app](../tribe-app) | Next.js frontend — protocol-first reference client with multi-node failover |
| [tribeapp.wtf](../tribeapp.wtf) | Consumer-facing web app + landing page at tribeapp.wtf — hyperlocal social built entirely on the protocol |
| [tribe-ios](../tribe-ios) | Native SwiftUI iOS client (Twitter-shaped) — full read/write against hub + ER, NaCl-box DMs, BLAKE3 + ed25519 signing via Apple CryptoKit |
| [tribe-insta](../tribe-insta) | Native SwiftUI iOS client (Instagram-shaped) — photo grid, stories, reels; same hub + envelope format as tribe-ios. Scaffolding stage — see `tribe-insta/PLAN.md` |
| [tribe-core-swift](../tribe-core-swift) | Shared Swift package consumed by tribe-ios + tribe-insta — crypto (BLAKE3, NaCl box, ed25519 signing, BIP39, SolanaHD), backup file format, envelope signer. See `tribe-core-swift/MIGRATION.md` |
| [homebrew-tap](../homebrew-tap) | Homebrew formulas: `brew install tribe` (hub + ER) and `brew install tribe-app` (demo UI) |
## License

MIT
