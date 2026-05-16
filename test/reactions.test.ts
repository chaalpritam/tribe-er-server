import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import { hash as blake3Hash } from "blake3";

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock("../src/settlement/settler", () => ({
  getServerWallet: vi.fn(),
  startSettlementLoop: vi.fn(),
  stopSettlementLoop: vi.fn(),
}));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>(
    "@solana/web3.js"
  );
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getAccountInfo: vi.fn().mockResolvedValue(null),
    })),
  };
});

import { db } from "../src/storage/db";
import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";

const mockQuery = db.query as ReturnType<typeof vi.fn>;

/// Build a valid REACTION envelope of the shape /v1/submit expects.
/// Same canonical-JSON construction as MessageSigner / tribe-sdk.
function buildReactionEnvelope(
  type: 3 | 4,
  tid: string,
  parentHash: string,
  reactionType: string,
  keyPair: nacl.SignKeyPair,
  timestampOverride?: number
) {
  const data = {
    type,
    tid: Number(tid),
    timestamp: timestampOverride ?? Math.floor(Date.now() / 1000),
    network: 2,
    body: { parent_hash: parentHash, text: reactionType },
  };
  const dataBytes = Buffer.from(
    JSON.stringify({
      body: data.body,
      network: data.network,
      tid: data.tid,
      timestamp: data.timestamp,
      type: data.type,
    })
  );
  const hashBytes = Buffer.from(blake3Hash(dataBytes));
  const signature = nacl.sign.detached(hashBytes, keyPair.secretKey);
  return {
    protocolVersion: 1,
    data,
    dataB64: dataBytes.toString("base64"),
    hash: hashBytes.toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
    signer: Buffer.from(keyPair.publicKey).toString("base64"),
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

describe("POST /v1/reaction", () => {
  it("accepts a valid REACTION_ADD envelope", async () => {
    const envelope = buildReactionEnvelope(3, "42", "ABC123", "1", testKeyPair);
    mockQuery.mockResolvedValueOnce({
      rows: [{ envelope_hash: envelope.hash, status: "pending" }],
    });

    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("pending");
    expect(body.action).toBe("add");
    expect(body.hash).toBe(envelope.hash);
  });

  it("accepts REACTION_REMOVE as action='remove'", async () => {
    const envelope = buildReactionEnvelope(4, "42", "ABC123", "1", testKeyPair);
    mockQuery.mockResolvedValueOnce({
      rows: [{ envelope_hash: envelope.hash, status: "pending" }],
    });

    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.action).toBe("remove");
  });

  it("rejects envelopes with the wrong type", async () => {
    // type=1 is TWEET_ADD, not a reaction
    const envelope = buildReactionEnvelope(1 as 3, "42", "ABC", "1", testKeyPair);
    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("wrong_type");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects envelopes with a stale timestamp", async () => {
    const envelope = buildReactionEnvelope(
      3,
      "42",
      "ABC",
      "1",
      testKeyPair,
      Math.floor(Date.now() / 1000) - 120
    );
    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("stale_timestamp");
  });

  it("rejects envelopes where blake3(dataB64) != hash", async () => {
    const envelope = buildReactionEnvelope(3, "42", "ABC", "1", testKeyPair);
    // Corrupt the hash
    envelope.hash = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("bad_hash");
  });

  it("rejects envelopes signed by a different key", async () => {
    const envelope = buildReactionEnvelope(3, "42", "ABC", "1", testKeyPair);
    // Re-sign with a different key but keep the original signer field
    const otherKey = nacl.sign.keyPair();
    const reHash = Buffer.from(envelope.hash, "base64");
    envelope.signature = Buffer.from(
      nacl.sign.detached(reHash, otherKey.secretKey)
    ).toString("base64");
    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("bad_signature");
  });

  it("rejects envelopes missing body.parent_hash", async () => {
    const envelope = buildReactionEnvelope(3, "42", "ABC", "1", testKeyPair);
    // Strip parent_hash AFTER signing so the signature still verifies
    // against the original hash — but parent_hash check happens before
    // the hash recomputation so we'd hit bad_hash. Instead, build an
    // envelope where parent_hash was never there.
    delete (envelope.data.body as Record<string, unknown>).parent_hash;
    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("missing_target_hash");
  });

  it("returns deduped:true on retry with same envelope hash", async () => {
    const envelope = buildReactionEnvelope(3, "42", "ABC", "1", testKeyPair);
    // First call: INSERT...ON CONFLICT DO NOTHING returns 0 rows
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Follow-up SELECT to surface existing status
    mockQuery.mockResolvedValueOnce({ rows: [{ status: "flushed" }] });

    const res = await server.inject({
      method: "POST",
      url: "/v1/reaction",
      payload: { envelope },
    });
    const body = JSON.parse(res.body);
    expect(body.deduped).toBe(true);
    expect(body.status).toBe("flushed");
  });
});

describe("GET /v1/pending-reactions/:tid", () => {
  it("returns pending reactions by this user", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { envelope_hash: "h1", target_hash: "t1", action: "add", reaction_type: "1" },
        { envelope_hash: "h2", target_hash: "t2", action: "remove", reaction_type: "1" },
      ],
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/pending-reactions/42",
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.reactions).toHaveLength(2);
    const params = mockQuery.mock.calls[0][1] as string[];
    expect(params[0]).toBe("42");
  });
});

describe("GET /v1/pending-reactions-on/:targetHash", () => {
  it("collapses add+remove from the same TID to net zero", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { signer_tid: 1, action: "add", reaction_type: "1" },
        { signer_tid: 1, action: "remove", reaction_type: "1" },
        { signer_tid: 2, action: "add", reaction_type: "1" },
      ],
    });

    const res = await server.inject({
      method: "GET",
      url: "/v1/pending-reactions-on/HASH",
    });
    const body = JSON.parse(res.body);

    expect(body.addCount).toBe(1); // only TID 2's add survives
    expect(body.removeCount).toBe(0);
    expect(body.netDelta).toBe(1);
    expect(body.reactorTids).toEqual(["2"]);
  });
});

describe("flushPendingReactions", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("marks pending → flushed on hub 200", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ envelope_hash: "h1", envelope_json: { foo: "bar" } }],
      }) // SELECT pending
      .mockResolvedValueOnce({ rows: [] }); // UPDATE → flushed
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    const { flushPendingReactions } = await import("../src/flush/reactions");
    const outcome = await flushPendingReactions();

    expect(outcome).toEqual({ flushed: 1, failed: 0, pending: 0 });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'flushed'");
  });

  it("marks pending → failed on hub 4xx", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ envelope_hash: "h1", envelope_json: { foo: "bar" } }],
      })
      .mockResolvedValueOnce({ rows: [] });
    fetchSpy.mockResolvedValueOnce(new Response("bad signer", { status: 400 }));

    const { flushPendingReactions } = await import("../src/flush/reactions");
    const outcome = await flushPendingReactions();

    expect(outcome).toEqual({ flushed: 0, failed: 1, pending: 0 });
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'failed'");
  });

  it("leaves row pending on hub 5xx for retry next tick", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ envelope_hash: "h1", envelope_json: { foo: "bar" } }],
      })
      .mockResolvedValueOnce({ rows: [] });
    fetchSpy.mockResolvedValueOnce(new Response("oops", { status: 503 }));

    const { flushPendingReactions } = await import("../src/flush/reactions");
    const outcome = await flushPendingReactions();

    expect(outcome).toEqual({ flushed: 0, failed: 0, pending: 1 });
    // Second call should update `error` but leave status alone.
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).not.toContain("status =");
    expect(updateSql).toContain("error = $2");
  });

  it("is a no-op when no rows are pending", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { flushPendingReactions } = await import("../src/flush/reactions");
    const outcome = await flushPendingReactions();

    expect(outcome).toEqual({ flushed: 0, failed: 0, pending: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
