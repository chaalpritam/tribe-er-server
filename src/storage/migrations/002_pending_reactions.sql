-- Off-chain reaction buffer.
--
-- Unlike follow/unfollow (which go on-chain via the social-graph
-- program), reactions live as off-chain envelopes the hub indexes.
-- ER doesn't sign reactions itself — the user's app key does — so
-- this table just stores the user-signed envelope verbatim and
-- forwards it to the hub on a 5s tick via src/flush/reactions.ts.
--
-- The point of ER sitting in front: clients can read
-- /v1/pending-reactions/:tid before the hub has indexed the reaction,
-- which gives the IG-shaped surface the "I tapped like and it shows
-- up everywhere immediately" feeling without each client doing its
-- own optimistic-update bookkeeping.
--
-- envelope_hash IS the dedup key — same hash twice means the client
-- retried; we accept silently and surface the same response.

CREATE TABLE IF NOT EXISTS pending_reactions (
  envelope_hash   TEXT PRIMARY KEY,
  signer_tid      BIGINT NOT NULL,
  target_hash     TEXT NOT NULL,
  reaction_type   TEXT NOT NULL,             -- '1' = like; future: emoji codes
  action          TEXT NOT NULL,             -- 'add' (type=3) or 'remove' (type=4)
  envelope_json   JSONB NOT NULL,            -- full envelope, ready to POST to hub /v1/submit
  signature       TEXT NOT NULL,
  envelope_ts     BIGINT NOT NULL,           -- envelope.data.timestamp (epoch seconds)
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | flushed | failed
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  flushed_at      TIMESTAMPTZ
);

-- Per-user pending lookup: powers /v1/pending-reactions/:tid.
CREATE INDEX IF NOT EXISTS idx_pending_reactions_signer
  ON pending_reactions (signer_tid, status, created_at DESC);

-- Per-target lookup: powers /v1/pending-reactions-on/:targetHash and
-- the flusher's "take next N pending" query.
CREATE INDEX IF NOT EXISTS idx_pending_reactions_target
  ON pending_reactions (target_hash, status);

CREATE INDEX IF NOT EXISTS idx_pending_reactions_status_created
  ON pending_reactions (status, created_at);
