import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { InamClient, keypairFromPrivateKey, fromHex, sha256Hex } from "../sdk-js/src/index.js";

/** The maintainers' reference verifier (SPEC.md §12.8 "shape 2": a service the
 * verifier runs in its own environment — here a GitHub Actions cron).
 *
 * What it attests, and nothing more: the content served at a finalized
 * receipt's `result.outputUri` hashes to the receipt's `result.outputHash`.
 * That proves the signed hash points at real, retrievable output. It does NOT
 * judge whether the output is any good — its registry profile says so.
 *
 *   mismatch               -> signs `rejected` (the claimed output isn't what's there)
 *   match, VERIFY_MODE=full        -> signs `verified`
 *   match, VERIFY_MODE=reject-only -> signs nothing (never adds a boost)
 *   no outputUri / unreachable / too large / not visible -> skipped, logged
 *
 * Walks the transparency log's `receipt_finalized` entries from the last
 * processed index (STATE_FILE), so each receipt is looked at once.
 *
 *   VERIFIER_PRIVATE_KEY=<hex> STATE_FILE=verifier-state.json npx tsx scripts/integrity-verifier.ts
 *
 * The verifier must already be operator-authorized (POST /agents/:id/verifier-status). */
const BASE_URL = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const MODE = process.env.VERIFY_MODE ?? "full";
const STATE_FILE = process.env.STATE_FILE ?? "verifier-state.json";
const EVIDENCE_URI = process.env.EVIDENCE_URI; // e.g. this run's GitHub Actions URL
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
// Plain http only when the registry itself is local (tests); outputs on a real registry must be https.
const ALLOW_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL);

if (MODE !== "full" && MODE !== "reject-only") throw new Error(`VERIFY_MODE must be "full" or "reject-only", got "${MODE}"`);
const key = process.env.VERIFIER_PRIVATE_KEY;
if (!key) throw new Error("VERIFIER_PRIVATE_KEY is required");
const verifier = new InamClient(BASE_URL, keypairFromPrivateKey(fromHex(key)));

const PROFILE = {
  name: "INAM Integrity Verifier",
  description:
    "Operated by the INAM maintainers. Checks only that the content at a receipt's outputUri hashes to its outputHash. " +
    "'verified' means the signed output exists and is intact, not that it is correct or good.",
  checks: ["output_integrity"],
  url: "https://github.com/inamprotocol/inam-protocol/blob/main/scripts/integrity-verifier.ts",
  reference: true,
};

async function ensureRegistered() {
  try {
    return await verifier.getAgent(verifier.did);
  } catch (err) {
    if (!/AGENT_NOT_FOUND|-> 404/.test(String(err))) throw err;
    console.log(`registering ${verifier.did}`);
    return verifier.registerAgent(["verification.output-integrity"], PROFILE);
  }
}

/** sha256 of the body, or a reason it couldn't be fetched. Streams with a size cap. */
async function hashRemote(uri: string): Promise<{ hash: string } | { skip: string }> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { skip: "outputUri is not a URL" };
  }
  if (url.protocol !== "https:" && !(ALLOW_HTTP && url.protocol === "http:")) return { skip: `unsupported scheme ${url.protocol}` };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok || !res.body) return { skip: `HTTP ${res.status}` };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BYTES) return { skip: `larger than ${MAX_BYTES} bytes` };
      chunks.push(chunk);
    }
    return { hash: `sha256:${sha256Hex(Buffer.concat(chunks))}` };
  } catch (err) {
    return { skip: `fetch failed: ${(err as Error).message}` };
  }
}

async function check(receiptId: string): Promise<string> {
  let receipt;
  try {
    receipt = await verifier.getReceipt(receiptId);
  } catch (err) {
    return `skip (${/RECEIPT_NOT_VISIBLE/.test(String(err)) ? "participants_only" : "unreadable"})`;
  }
  if (receipt.status !== "finalized") return `skip (status ${receipt.status})`;
  if (receipt.agentA.id === verifier.did || receipt.agentB.id === verifier.did) return "skip (verifier is a party)";
  const uri = receipt.result.outputUri;
  if (!uri) return "skip (no outputUri)";

  const got = await hashRemote(uri);
  if ("skip" in got) return `skip (${got.skip})`;
  const matches = got.hash === receipt.result.outputHash;
  if (matches && MODE === "reject-only") return "match, not attested (reject-only mode)";

  const result = matches ? "verified" : "rejected";
  try {
    await verifier.submitVerification({
      receiptId,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result,
      score: matches ? 1 : 0,
      ...(EVIDENCE_URI ? { evidenceUri: EVIDENCE_URI } : {}),
    });
  } catch (err) {
    if (/DUPLICATE_VERIFICATION|VERIFIER_ALREADY_DECIDED/.test(String(err))) return "skip (already decided)";
    throw err;
  }
  return matches ? "verified" : `rejected (served ${got.hash})`;
}

async function run() {
  const state: { nextLeafIndex: number } = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { nextLeafIndex: 0 };
  console.log(`mode ${MODE}, starting at log index ${state.nextLeafIndex}`);
  let hasMore = true;
  while (hasMore) {
    const page = await verifier.getTransparencyEntries({ offset: state.nextLeafIndex, limit: 200 });
    for (const e of page.entries) {
      if (e.entryType === "receipt_finalized") console.log(`[${e.leafIndex}] ${e.refId}: ${await check(e.refId)}`);
      state.nextLeafIndex = e.leafIndex + 1;
      writeFileSync(STATE_FILE, JSON.stringify(state) + "\n"); // resume point survives a crash mid-run
    }
    hasMore = page.hasMore && page.entries.length > 0;
  }
  console.log(`done, next run starts at ${state.nextLeafIndex}`);
}

const agent = await ensureRegistered();
if (!agent.isAuthorizedVerifier || agent.revokedAt) {
  console.error(`${verifier.did} is not an authorized verifier on ${BASE_URL}; the operator must grant it first.`);
  process.exitCode = 1; // not process.exit(): lets pending sockets close cleanly
} else {
  await run();
}
