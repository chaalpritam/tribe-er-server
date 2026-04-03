import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Mocks - must be before imports that use them
// ---------------------------------------------------------------------------

vi.mock("../src/storage/db", () => ({
  db: { query: vi.fn(), on: vi.fn() },
  runMigrations: vi.fn(),
}));

vi.mock("../src/validation/tid-cache", () => ({
  tidCache: {
    verifyCustody: vi.fn(),
    getCustodyAddress: vi.fn(),
    invalidate: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../src/settlement/settler", () => {
  const { Keypair } = require("@solana/web3.js");
  const kp = Keypair.generate();
  return {
    getServerWallet: vi.fn(() => kp),
    startSettlementLoop: vi.fn(),
    stopSettlementLoop: vi.fn(),
  };
});

// Mock Connection to avoid real network calls
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    })),
  };
});

import { db } from "../src/storage/db";
import { tidCache } from "../src/validation/tid-cache";
import { buildServer } from "../src/server";
import { buildInstructionBatches, type PendingOp } from "../src/settlement/batch-builder";
import type { FastifyInstance } from "fastify";

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const mockVerifyCustody = tidCache.verifyCustody as ReturnType<typeof vi.fn>;

// Helper: create a valid signed operation body
function createSignedBody(
  opType: "follow" | "unfollow",
  followerTid: string,
  followingTid: string,
  keyPair: nacl.SignKeyPair,
  timestampOverride?: number
) {
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
  const message = `tribe-er:${opType}:${followerTid}:${followingTid}:${timestamp}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keyPair.secretKey);

  // Convert ed25519 public key to a Solana-compatible base58 pubkey
  const custodyPubkey = new PublicKey(keyPair.publicKey).toBase58();

  return {
    followerTid,
    followingTid,
    custodyPubkey,
    signature: Buffer.from(signature).toString("base64"),
    timestamp,
  };
}

let server: FastifyInstance;
let testKeyPair: nacl.SignKeyPair;

beforeEach(async () => {
  vi.clearAllMocks();
  testKeyPair = nacl.sign.keyPair();
  server = await buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

// ===========================================================================
// Health endpoint
// ===========================================================================
describe("GET /health", () => {
  it("returns ok with pendingOps count", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "5" }] });

    const res = await server.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pendingOps).toBe(5);
    expect(body).toHaveProperty("serverWallet");
    expect(body).toHaveProperty("balance");
  });
});

// ===========================================================================
// Follow / Unfollow operations
// ===========================================================================
describe("POST /v1/follow", () => {
  it("valid follow request returns 200 with pending status", async () => {
    const body = createSignedBody("follow", "1", "2", testKeyPair);

    mockVerifyCustody.mockResolvedValueOnce(true);
    // dupCheck: no duplicates
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // insert into pending_operations
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "100" }] });
    // er_links upsert
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // er_profiles upsert (follower)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // er_profiles upsert (following)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await server.inject({
      method: "POST",
      url: "/v1/follow",
      payload: body,
    });
    const parsed = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(parsed.status).toBe("pending");
    expect(parsed.id).toBe("100");
  });

  it("invalid signature returns 400", async () => {
    const body = createSignedBody("follow", "1", "2", testKeyPair);
    // Corrupt the signature
    body.signature = Buffer.from("bad-signature-data-that-is-invalid").toString("base64");

    const res = await server.inject({
      method: "POST",
      url: "/v1/follow",
      payload: body,
    });
    const parsed = JSON.parse(res.body);

    expect(res.statusCode).toBe(400);
    expect(parsed.error).toContain("Invalid signature");
  });

  it("expired timestamp returns 400", async () => {
    // Timestamp 120 seconds in the past (exceeds 60s window)
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 120;
    const body = createSignedBody("follow", "1", "2", testKeyPair, expiredTimestamp);

    // Signature is valid but timestamp is out of range
    const res = await server.inject({
      method: "POST",
      url: "/v1/follow",
      payload: body,
    });
    const parsed = JSON.parse(res.body);

    expect(res.statusCode).toBe(400);
    expect(parsed.error).toContain("Timestamp out of range");
  });

  it("custody mismatch returns 403", async () => {
    const body = createSignedBody("follow", "1", "2", testKeyPair);

    // verifyCustody returns false -> custody does not match
    mockVerifyCustody.mockResolvedValueOnce(false);

    const res = await server.inject({
      method: "POST",
      url: "/v1/follow",
      payload: body,
    });
    const parsed = JSON.parse(res.body);

    expect(res.statusCode).toBe(403);
    expect(parsed.error).toContain("Custody pubkey does not match");
  });
});

describe("POST /v1/unfollow", () => {
  it("valid unfollow request returns 200 with pending status", async () => {
    const body = createSignedBody("unfollow", "1", "2", testKeyPair);

    mockVerifyCustody.mockResolvedValueOnce(true);
    // dupCheck: no duplicates
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // insert into pending_operations
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "200" }] });
    // er_links update
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // er_profiles decrement (follower)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // er_profiles decrement (following)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await server.inject({
      method: "POST",
      url: "/v1/unfollow",
      payload: body,
    });
    const parsed = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(parsed.status).toBe("pending");
    expect(parsed.id).toBe("200");
  });
});

// ===========================================================================
// Query endpoints
// ===========================================================================
describe("GET /v1/link/:followerTid/:followingTid", () => {
  it("returns exists status from local DB", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: "settled" }],
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/link/1/2",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.exists).toBe(true);
    expect(body.status).toBe("settled");
  });

  it("returns not exists when pending_unfollow", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: "pending_unfollow" }],
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/link/1/2",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.exists).toBe(false);
    expect(body.status).toBe("pending_unfollow");
  });

  it("returns not exists when not in local DB and not on-chain", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Connection.getAccountInfo returns null (mocked globally)

    const res = await server.inject({
      method: "GET",
      url: "/v1/link/1/2",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.exists).toBe(false);
    expect(body.status).toBe("none");
  });
});

describe("GET /v1/profile/:tid", () => {
  it("returns profile data from local DB", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ following_count: 10, followers_count: 25 }],
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/profile/1",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.tid).toBe(1);
    expect(body.followingCount).toBe(10);
    expect(body.followersCount).toBe(25);
  });

  it("falls back to zero counts when not in local DB and not on-chain", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Connection.getAccountInfo returns null (mocked globally)

    const res = await server.inject({
      method: "GET",
      url: "/v1/profile/999",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.tid).toBe(999);
    expect(body.followingCount).toBe(0);
    expect(body.followersCount).toBe(0);
  });
});

// ===========================================================================
// Batch builder unit tests
// ===========================================================================
describe("buildInstructionBatches", () => {
  const authority = Keypair.generate().publicKey;

  // Create a mock connection that says all profiles exist
  function mockConnection(profilesExist = true) {
    return {
      getAccountInfo: vi.fn().mockResolvedValue(
        profilesExist ? { data: Buffer.alloc(100) } : null
      ),
    } as unknown as Connection;
  }

  it("creates correct number of batches for operations", async () => {
    const ops: PendingOp[] = [
      { id: "1", op_type: "follow", follower_tid: 1, following_tid: 2 },
      { id: "2", op_type: "follow", follower_tid: 3, following_tid: 4 },
      { id: "3", op_type: "unfollow", follower_tid: 5, following_tid: 6 },
      { id: "4", op_type: "follow", follower_tid: 7, following_tid: 8 },
      { id: "5", op_type: "follow", follower_tid: 9, following_tid: 10 },
    ];

    const batches = await buildInstructionBatches(ops, authority, mockConnection());

    // 5 ops, max 4 per batch -> 2 batches of operations
    // All profiles exist so no init batches
    expect(batches.length).toBe(2);
    expect(batches[0].opIds).toHaveLength(4);
    expect(batches[1].opIds).toHaveLength(1);
  });

  it("adds profile init batches when profiles are missing", async () => {
    const ops: PendingOp[] = [
      { id: "1", op_type: "follow", follower_tid: 1, following_tid: 2 },
    ];

    // All profiles are missing
    const batches = await buildInstructionBatches(ops, authority, mockConnection(false));

    // Should have init batch(es) + operation batch
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // First batch is profile init (no opIds)
    expect(batches[0].opIds).toHaveLength(0);
    // Last batch has the actual follow
    expect(batches[batches.length - 1].opIds).toContain("1");
  });

  it("follow instruction has correct discriminator and 6 accounts (including system_program)", async () => {
    const ops: PendingOp[] = [
      { id: "1", op_type: "follow", follower_tid: 1, following_tid: 2 },
    ];

    const batches = await buildInstructionBatches(ops, authority, mockConnection());
    const followBatch = batches.find((b) => b.opIds.length > 0)!;
    const ix = followBatch.instructions[0];

    // Discriminator: first 8 bytes
    const expectedDiscriminator = Buffer.from([234, 77, 111, 22, 209, 80, 177, 108]);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(expectedDiscriminator);

    // Follow has 6 accounts: sequencer_config, follower_profile, following_profile, link, authority, system_program
    expect(ix.keys).toHaveLength(6);
  });

  it("unfollow instruction has 5 accounts (no system_program)", async () => {
    const ops: PendingOp[] = [
      { id: "1", op_type: "unfollow", follower_tid: 1, following_tid: 2 },
    ];

    const batches = await buildInstructionBatches(ops, authority, mockConnection());
    const unfollowBatch = batches.find((b) => b.opIds.length > 0)!;
    const ix = unfollowBatch.instructions[0];

    // Unfollow has 5 accounts: sequencer_config, follower_profile, following_profile, link, authority
    expect(ix.keys).toHaveLength(5);

    // Verify the unfollow discriminator
    const expectedDiscriminator = Buffer.from([23, 222, 24, 149, 182, 60, 11, 153]);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(expectedDiscriminator);
  });
});
