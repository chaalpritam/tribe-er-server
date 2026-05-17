import { FastifyInstance } from "fastify";
import { db } from "../storage/db";
import {
  SignedEnvelope,
  validateReactionEnvelope,
} from "../validation/envelope";

/// REACTION_ADD = 3, REACTION_REMOVE = 4. Same MessageType ints the
/// hub and tribe-sdk use — keep them in sync if the protocol changes.
const REACTION_ADD = 3;
const REACTION_REMOVE = 4;

interface ReactionBody {
  envelope: SignedEnvelope;
}

/// POST /v1/reaction — accept a user-signed REACTION envelope, store
/// it in pending_reactions, return immediately so the client can show
/// the like as confirmed. The flusher (src/flush/reactions.ts) forwards
/// it to the hub on its 5s tick.
///
/// We validate signature + hash + timestamp here to keep bad envelopes
/// out of the pending state; app-key validity is the hub's job and
/// the flusher just marks an envelope failed if the hub rejects it.
///
/// GET /v1/pending-reactions/:tid — reactions BY this TID that are
/// still pending (not yet flushed to hub). Lets a client show "I
/// liked this" before the hub-side count has caught up.
///
/// GET /v1/pending-reactions-on/:targetHash — aggregate pending net
/// delta on a single message. Lets a client overlay pending likes on
/// top of the hub's count without each viewer doing their own
/// bookkeeping.
export async function reactionRoutes(server: FastifyInstance) {
  server.post<{ Body: ReactionBody }>("/reaction", async (request, reply) => {
    const envelope = request.body?.envelope;
    if (!envelope) {
      return reply.status(400).send({ error: "Missing envelope" });
    }

    const validation = validateReactionEnvelope(envelope, [
      REACTION_ADD,
      REACTION_REMOVE,
    ]);
    if (!validation.ok) {
      return reply.status(400).send({ error: `Invalid envelope: ${validation.reason}` });
    }

    const action = envelope.data.type === REACTION_ADD ? "add" : "remove";
    const targetHash = envelope.data.body.parent_hash as string;
    // Reaction subtype: '1' = like for now; protocol leaves room for
    // emoji codes ("❤" etc) in the same field.
    const reactionType =
      typeof envelope.data.body.text === "string"
        ? (envelope.data.body.text as string)
        : "1";
    const signerTid = String(envelope.data.tid);

    // envelope_hash is the dedup key — a client retry with the same
    // envelope shouldn't double-insert. ON CONFLICT DO NOTHING returns
    // 0 rows; we surface the existing row's status so the client can
    // tell whether the retry hit a still-pending entry or one that's
    // already been flushed.
    const insert = await db.query(
      `INSERT INTO pending_reactions
         (envelope_hash, signer_tid, target_hash, reaction_type, action,
          envelope_json, signature, envelope_ts, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       ON CONFLICT (envelope_hash) DO NOTHING
       RETURNING envelope_hash, status`,
      [
        envelope.hash,
        signerTid,
        targetHash,
        reactionType,
        action,
        JSON.stringify(envelope),
        envelope.signature,
        envelope.data.timestamp,
      ]
    );

    if (insert.rows.length > 0) {
      return { hash: envelope.hash, status: "pending", action };
    }

    // Conflict — surface the existing row's status. Helps clients
    // know whether their retry needs to bother polling or if the
    // reaction has already landed at the hub.
    const existing = await db.query(
      `SELECT status FROM pending_reactions WHERE envelope_hash = $1`,
      [envelope.hash]
    );
    return {
      hash: envelope.hash,
      status: existing.rows[0]?.status ?? "pending",
      action,
      deduped: true,
    };
  });

  server.get<{ Params: { tid: string } }>(
    "/pending-reactions/:tid",
    async (request) => {
      // Returns only pending rows (status='pending'). Once flushed,
      // the reaction lives on the hub and shows up in the regular
      // reaction_count, so the client doesn't need ER any more.
      const result = await db.query(
        `SELECT envelope_hash, target_hash, action, reaction_type, envelope_ts, created_at
           FROM pending_reactions
          WHERE signer_tid = $1
            AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 200`,
        [request.params.tid]
      );
      return { reactions: result.rows };
    }
  );

  server.get<{ Params: { targetHash: string } }>(
    "/pending-reactions-on/:targetHash",
    async (request) => {
      // Hashes are base64 which can contain '/' and '+'; Fastify
      // already URL-decoded the param so we use it as-is.
      const result = await db.query(
        `SELECT signer_tid, action, reaction_type
           FROM pending_reactions
          WHERE target_hash = $1
            AND status = 'pending'`,
        [request.params.targetHash]
      );

      // Collapse to per-tid net state: a TID that did add-then-remove
      // within the batch window cancels out. The hub will see both
      // envelopes when we flush, but for the pending view we only
      // want the net effect.
      const perTid = new Map<string, "add" | "remove">();
      for (const row of result.rows) {
        const tid = String(row.signer_tid);
        const prev = perTid.get(tid);
        if (prev && prev !== row.action) {
          perTid.delete(tid);
        } else {
          perTid.set(tid, row.action as "add" | "remove");
        }
      }
      let addCount = 0;
      let removeCount = 0;
      const reactorTids: string[] = [];
      for (const [tid, action] of perTid) {
        if (action === "add") {
          addCount += 1;
          reactorTids.push(tid);
        } else {
          removeCount += 1;
        }
      }
      return {
        targetHash: request.params.targetHash,
        addCount,
        removeCount,
        netDelta: addCount - removeCount,
        reactorTids,
      };
    }
  );
}
