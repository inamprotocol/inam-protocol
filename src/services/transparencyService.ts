import { transparencyLog } from "../storage/db.js";
import { buildLogEntry, type TransparencyEntryType } from "../../sdk-js/src/core/transparencyLog.js";
import { rootHash, inclusionProof, consistencyProof } from "../../sdk-js/src/core/merkleLog.js";
import { badRequest } from "../middleware/errors.js";

export function appendEntry(entryType: TransparencyEntryType, refId: string, data: unknown): void {
  const timestamp = new Date().toISOString();
  const { canonicalEntry, leafHash } = buildLogEntry({ entryType, refId, timestamp, data });
  transparencyLog.append(entryType, refId, timestamp, canonicalEntry, leafHash);
}

export interface SignedTreeHead {
  treeSize: number;
  rootHash: string;
  timestamp: string;
}

export function getSTH(): SignedTreeHead {
  const leaves = transparencyLog.leafHashes();
  return { treeSize: leaves.length, rootHash: rootHash(leaves), timestamp: new Date().toISOString() };
}

export function getEntries(limit: number, offset: number) {
  return { entries: transparencyLog.entries(limit, offset), total: transparencyLog.count() };
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

export function getInclusionProof(leafIndex: number, treeSize: number | undefined): InclusionProofResult {
  const all = transparencyLog.leafHashes();
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

export function getConsistencyProof(first: number, second: number | undefined): ConsistencyProofResult {
  const all = transparencyLog.leafHashes();
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
