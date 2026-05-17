import { db } from "../storage/db";
import { config } from "../config";

/// Periodic worker that drains pending_reactions → hub /v1/submit.
///
/// Cadence: every config.reactionFlushIntervalMs (default 5s). Each
/// tick takes up to config.reactionFlushBatchSize rows (default 100)
/// in (created_at ASC) order — FIFO so a reaction submitted at t=0
/// flushes before one at t=1.
///
/// Per-row outcomes:
///
///   - hub 200 → mark `flushed`, set flushed_at. The reaction is now
///     in the hub's messages table and shows up in reaction_count;
///     /v1/pending-reactions stops returning it.
///   - hub 400/409 → envelope rejected (bad signer, dup hash, etc).
///     Mark `failed` with the hub's error so the client can react.
///     Don't retry — a 400 isn't going to fix itself.
///   - hub 5xx / network error → leave as `pending`, retry next tick.
///     The whole point of ER buffering is that a hub blip doesn't
///     drop the like.
///
/// One row at a time over HTTP — no /v1/submit-batch on the hub yet.
/// Pleasantly cheap because the typical batch is empty.

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

interface FlushRow {
  envelope_hash: string;
  envelope_json: unknown; // pg JSONB returns parsed
}

interface FlushOutcome {
  flushed: number;
  failed: number;
  pending: number;
}

export async function flushPendingReactions(): Promise<FlushOutcome> {
  const result = await db.query<FlushRow>(
    `SELECT envelope_hash, envelope_json
       FROM pending_reactions
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1`,
    [config.reactionFlushBatchSize]
  );

  if (result.rows.length === 0) {
    return { flushed: 0, failed: 0, pending: 0 };
  }

  let flushed = 0;
  let failed = 0;
  let pending = 0;

  for (const row of result.rows) {
    const outcome = await sendOneEnvelope(row.envelope_json);
    switch (outcome.kind) {
      case "flushed":
        await db.query(
          `UPDATE pending_reactions
              SET status = 'flushed', flushed_at = NOW(), error = NULL
            WHERE envelope_hash = $1`,
          [row.envelope_hash]
        );
        flushed += 1;
        break;
      case "failed":
        await db.query(
          `UPDATE pending_reactions
              SET status = 'failed', error = $2
            WHERE envelope_hash = $1`,
          [row.envelope_hash, outcome.error]
        );
        failed += 1;
        break;
      case "pending":
        // Leave the row alone — the next tick will retry. Stash the
        // error so we can see what's been going wrong if a hub
        // outage drags on.
        await db.query(
          `UPDATE pending_reactions SET error = $2 WHERE envelope_hash = $1`,
          [row.envelope_hash, outcome.error]
        );
        pending += 1;
        break;
    }
  }

  return { flushed, failed, pending };
}

type SendOutcome =
  | { kind: "flushed" }
  | { kind: "failed"; error: string }
  | { kind: "pending"; error: string };

async function sendOneEnvelope(envelope: unknown): Promise<SendOutcome> {
  const url = `${config.hubUrl.replace(/\/$/, "")}/v1/submit`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (res.ok) {
      return { kind: "flushed" };
    }
    // 4xx → envelope is wrong somehow; no retry.
    // 5xx → hub problem; retry next tick.
    const bodyText = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500) {
      return { kind: "failed", error: `hub ${res.status}: ${bodyText.slice(0, 200)}` };
    }
    return { kind: "pending", error: `hub ${res.status}: ${bodyText.slice(0, 200)}` };
  } catch (err) {
    return {
      kind: "pending",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startReactionFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return; // skip if previous tick still running
    inFlight = true;
    flushPendingReactions()
      .catch((err) => {
        console.error("[reactions-flush] tick failed:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  }, config.reactionFlushIntervalMs);
  if (timer.unref) timer.unref();
}

export function stopReactionFlusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
