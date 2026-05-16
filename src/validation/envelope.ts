import nacl from "tweetnacl";
import { hash as blake3Hash } from "blake3";

/// Shape of the signed envelope every tribe-eco client POSTs to the
/// hub's /v1/submit. ER accepts the same shape on /v1/reaction and
/// only forwards once it's been validated, so we don't pollute the
/// pending state with envelopes the hub will reject.
export interface SignedEnvelope {
  protocolVersion: number;
  data: {
    type: number;
    tid: string | number;
    timestamp: number;
    network: number;
    body: Record<string, unknown>;
  };
  dataB64: string;
  hash: string;
  signature: string;
  signer: string;
}

export type ValidationFailure =
  | { ok: false; reason: "shape" }
  | { ok: false; reason: "wrong_type" }
  | { ok: false; reason: "stale_timestamp" }
  | { ok: false; reason: "bad_hash" }
  | { ok: false; reason: "bad_signature" }
  | { ok: false; reason: "missing_target_hash" };

export type ValidationResult = { ok: true } | ValidationFailure;

/// Verify an envelope is well-formed AND signed correctly. We do NOT
/// check app-key validity here — the hub does that at /v1/submit time.
/// Reasons for splitting:
///
///   1. App-key validity needs the Solana account cache the hub
///      already maintains; duplicating it in ER would mean every
///      reaction round-trips to Solana.
///   2. If the signer's app key gets revoked between ER queue-up and
///      hub flush, the hub rejects the envelope — ER marks it failed,
///      no harm done.
///
/// So we only validate what ER can validate cheaply: shape, hash,
/// signature, timestamp. Returns ok:true on success or a tagged
/// failure reason on validation failure.
export function validateReactionEnvelope(
  envelope: SignedEnvelope,
  acceptedTypes: number[]
): ValidationResult {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.protocolVersion !== 1 ||
    !envelope.data ||
    typeof envelope.dataB64 !== "string" ||
    typeof envelope.hash !== "string" ||
    typeof envelope.signature !== "string" ||
    typeof envelope.signer !== "string"
  ) {
    return { ok: false, reason: "shape" };
  }

  if (!acceptedTypes.includes(envelope.data.type)) {
    return { ok: false, reason: "wrong_type" };
  }

  // 60s drift window — same as /v1/follow uses.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - envelope.data.timestamp) > 60) {
    return { ok: false, reason: "stale_timestamp" };
  }

  // Reactions reference the message they react to via body.parent_hash.
  if (typeof envelope.data.body?.parent_hash !== "string") {
    return { ok: false, reason: "missing_target_hash" };
  }

  // blake3(dataB64-decoded) must equal envelope.hash. Recompute and
  // compare bytes rather than strings so different base64 padding
  // doesn't cause a false negative.
  let dataBytes: Buffer;
  let expectedHash: Buffer;
  let claimedHash: Buffer;
  try {
    dataBytes = Buffer.from(envelope.dataB64, "base64");
    expectedHash = Buffer.from(blake3Hash(dataBytes));
    claimedHash = Buffer.from(envelope.hash, "base64");
  } catch {
    return { ok: false, reason: "bad_hash" };
  }
  if (!expectedHash.equals(claimedHash)) {
    return { ok: false, reason: "bad_hash" };
  }

  // ed25519_verify(hash, signature, signer).
  let signatureBytes: Buffer;
  let signerBytes: Buffer;
  try {
    signatureBytes = Buffer.from(envelope.signature, "base64");
    signerBytes = Buffer.from(envelope.signer, "base64");
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (signatureBytes.length !== 64 || signerBytes.length !== 32) {
    return { ok: false, reason: "bad_signature" };
  }
  const verified = nacl.sign.detached.verify(
    claimedHash,
    signatureBytes,
    signerBytes
  );
  if (!verified) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
