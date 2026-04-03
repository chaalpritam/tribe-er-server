import { Connection, PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { config } from "../config";

// Discriminators from the social_graph IDL
const FOLLOW_DELEGATED_DISCRIMINATOR = Buffer.from([234, 77, 111, 22, 209, 80, 177, 108]);
const UNFOLLOW_DELEGATED_DISCRIMINATOR = Buffer.from([23, 222, 24, 149, 182, 60, 11, 153]);
const INIT_PROFILE_DELEGATED_DISCRIMINATOR = Buffer.from([24, 66, 180, 61, 33, 25, 13, 174]);

const socialGraphProgramId = new PublicKey(config.programIds.socialGraph);

function writeU64LE(buf: Buffer, offset: number, val: number): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = val & 0xff;
    val = Math.floor(val / 256);
  }
}

function tidToBuffer(tid: number): Buffer {
  const buf = Buffer.alloc(8);
  writeU64LE(buf, 0, tid);
  return buf;
}

function deriveSequencerConfigPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sequencer_config")],
    socialGraphProgramId
  );
  return pda;
}

function deriveSocialProfilePDA(tid: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("social_profile"), tidToBuffer(tid)],
    socialGraphProgramId
  );
  return pda;
}

function deriveLinkPDA(followerTid: number, followingTid: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), tidToBuffer(followerTid), tidToBuffer(followingTid)],
    socialGraphProgramId
  );
  return pda;
}

export interface PendingOp {
  id: string;
  op_type: "follow" | "unfollow";
  follower_tid: number;
  following_tid: number;
}

/**
 * Build a follow_delegated instruction.
 */
function buildFollowDelegatedIx(
  followerTid: number,
  followingTid: number,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8);
  FOLLOW_DELEGATED_DISCRIMINATOR.copy(data, 0);
  writeU64LE(data, 8, followerTid);
  writeU64LE(data, 16, followingTid);

  const keys = [
    { pubkey: deriveSequencerConfigPDA(), isSigner: false, isWritable: false },
    { pubkey: deriveSocialProfilePDA(followerTid), isSigner: false, isWritable: true },
    { pubkey: deriveSocialProfilePDA(followingTid), isSigner: false, isWritable: true },
    { pubkey: deriveLinkPDA(followerTid, followingTid), isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: socialGraphProgramId,
    keys,
    data,
  });
}

/**
 * Build an unfollow_delegated instruction.
 */
function buildUnfollowDelegatedIx(
  followerTid: number,
  followingTid: number,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8);
  UNFOLLOW_DELEGATED_DISCRIMINATOR.copy(data, 0);
  writeU64LE(data, 8, followerTid);
  writeU64LE(data, 16, followingTid);

  const keys = [
    { pubkey: deriveSequencerConfigPDA(), isSigner: false, isWritable: false },
    { pubkey: deriveSocialProfilePDA(followerTid), isSigner: false, isWritable: true },
    { pubkey: deriveSocialProfilePDA(followingTid), isSigner: false, isWritable: true },
    { pubkey: deriveLinkPDA(followerTid, followingTid), isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: socialGraphProgramId,
    keys,
    data,
  });
}

/**
 * Build an init_profile_delegated instruction.
 */
function buildInitProfileDelegatedIx(
  tid: number,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  INIT_PROFILE_DELEGATED_DISCRIMINATOR.copy(data, 0);
  writeU64LE(data, 8, tid);

  const keys = [
    { pubkey: deriveSequencerConfigPDA(), isSigner: false, isWritable: false },
    { pubkey: deriveSocialProfilePDA(tid), isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: socialGraphProgramId,
    keys,
    data,
  });
}

/**
 * Build instructions from pending operations.
 * Auto-initializes missing social profiles before follow/unfollow.
 * Returns arrays of instructions, each array fits in one transaction (max 4 per tx).
 */
export async function buildInstructionBatches(
  ops: PendingOp[],
  authority: PublicKey,
  connection: Connection
): Promise<{ instructions: TransactionInstruction[]; opIds: string[] }[]> {
  // Collect all unique TIDs that need profiles
  const tidsNeeded = new Set<number>();
  for (const op of ops) {
    tidsNeeded.add(op.follower_tid);
    tidsNeeded.add(op.following_tid);
  }

  // Check which profiles are missing
  const missingProfiles = new Set<number>();
  for (const tid of tidsNeeded) {
    const pda = deriveSocialProfilePDA(tid);
    const info = await connection.getAccountInfo(pda);
    if (!info) missingProfiles.add(tid);
  }

  const batches: { instructions: TransactionInstruction[]; opIds: string[] }[] = [];

  // First batch: init missing profiles (up to 4 per tx)
  if (missingProfiles.size > 0) {
    const profileTids = Array.from(missingProfiles);
    for (let i = 0; i < profileTids.length; i += 4) {
      const chunk = profileTids.slice(i, i + 4);
      const ixs = chunk.map((tid) => buildInitProfileDelegatedIx(tid, authority));
      batches.push({ instructions: ixs, opIds: [] }); // No op IDs for profile inits
    }
  }

  // Then batch the actual follow/unfollow operations
  let currentIxs: TransactionInstruction[] = [];
  let currentIds: string[] = [];

  for (const op of ops) {
    const ix =
      op.op_type === "follow"
        ? buildFollowDelegatedIx(op.follower_tid, op.following_tid, authority)
        : buildUnfollowDelegatedIx(op.follower_tid, op.following_tid, authority);

    currentIxs.push(ix);
    currentIds.push(op.id);

    if (currentIxs.length >= 4) {
      batches.push({ instructions: currentIxs, opIds: currentIds });
      currentIxs = [];
      currentIds = [];
    }
  }

  if (currentIxs.length > 0) {
    batches.push({ instructions: currentIxs, opIds: currentIds });
  }

  return batches;
}
