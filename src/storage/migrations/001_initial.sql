CREATE TABLE IF NOT EXISTS pending_operations (
  id            BIGSERIAL PRIMARY KEY,
  op_type       TEXT NOT NULL,
  follower_tid  BIGINT NOT NULL,
  following_tid BIGINT NOT NULL,
  custody_pubkey TEXT NOT NULL,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at    TIMESTAMPTZ,
  tx_signature  TEXT,
  error         TEXT,
  retry_count   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS er_links (
  follower_tid  BIGINT NOT NULL,
  following_tid BIGINT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_tid, following_tid)
);

CREATE TABLE IF NOT EXISTS er_profiles (
  tid              BIGINT PRIMARY KEY,
  following_count  INT NOT NULL DEFAULT 0,
  followers_count  INT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_operations_status ON pending_operations(status);
CREATE INDEX IF NOT EXISTS idx_er_links_follower ON er_links(follower_tid);
CREATE INDEX IF NOT EXISTS idx_er_links_following ON er_links(following_tid);
