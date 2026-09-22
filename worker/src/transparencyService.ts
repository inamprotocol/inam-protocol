import * as db from "./db.js";
import { buildLogEntry, type TransparencyEntryType } from "../../sdk-js/src/core/transparencyLog.js";
import { rootHash, inclusionProof, consistencyProof } from "../../sdk-js/src/core/merkleLog.js";
import { badRequest } from "./errors.js";
import type { Env } from "./types.js";

export async function appendEntry(env: Env, entryType: TransparencyEntryType, refId: string, data: unknown): Promise<void> {
  const timestamp = new Date().toISOString();
  const { canonicalEntry, leafHash } = buildLogEntry({ entryType, refId, timestamp, data });
  await db.appendTransparencyLog(env, entryType, refId, timestamp, canonicalEntry, leafHash);
}

export interface SignedTreeHead {
  treeSize: number;
  rootHash: string;
  timestamp: string;
}

export async function getSTH(env: Env): Promise<SignedTreeHead> {
  const leaves = await db.transparencyLeafHashes(env);
  return { treeSize: leaves.length, rootHash: rootHash(leaves), timestamp: new Date().toISOString() };
}

export async function getEntries(env: Env, limit: number, offset: number) {
  const [entries, total] = await Promise.all([db.transparencyEntries(env, limit, offset), db.transparencyLogCount(env)]);
  return { entries, total };
}

function assertValidTreeSize(size: number, currentCount: number): void {
  if (!Number.isInteger(size) || size < 0 || size > currentCount) {
    throw badRequest("INVALID_TREE_SIZE", `treeSize must be an integer between 0 and the current log size (${currentCount})`);
  }
}

export interface InclusionProofResult {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  rootHash: string;
  proof: string[];
}

export async function getInclusionProof(env: Env, leafIndex: number, treeSize: number | undefined): Promise<InclusionProofResult> {
  const all = await db.transparencyLeafHashes(env);
  const size = treeSize ?? all.length;
  assertValidTreeSize(size, all.length);
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= size) {
    throw badRequest("INVALID_LEAF_INDEX", `leafIndex must be an integer between 0 and treeSize-1 (${size - 1})`);
  }
  const leaves = all.slice(0, size);
  return { leafIndex, treeSize: size, leafHash: leaves[leafIndex], rootHash: rootHash(leaves), proof: inclusionProof(leaves, leafIndex, size) };
}

export interface ConsistencyProofResult {
  firstSize: number;
  firstRootHash: string;
  secondSize: number;
  secondRootHash: string;
  proof: string[];
}

export async function getConsistencyProof(env: Env, first: number, second: number | undefined): Promise<ConsistencyProofResult> {
  const all = await db.transparencyLeafHashes(env);
  const secondSize = second ?? all.length;
  assertValidTreeSize(secondSize, all.length);
  if (!Number.isInteger(first) || first < 0 || first > secondSize) {
    throw badRequest("INVALID_TREE_SIZE", `first must be an integer between 0 and second (${secondSize})`);
  }
  const leavesToSecond = all.slice(0, secondSize);
  return {
    firstSize: first,
    firstRootHash: rootHash(all.slice(0, first)),
    secondSize,
    secondRootHash: rootHash(leavesToSecond),
    proof: consistencyProof(leavesToSecond, first, secondSize),
  };
}
