// SPEC.md §14 (v0.40): the hosted demo counterparty. A newcomer has nobody to
// countersign their first receipt; this agent plays agent_a for one fixed,
// mechanically checkable task (`demo.sha256`) so the full draft -> countersign
// -> transparency-log flow can be tried in a minute. Demo receipts are real
// and logged, but reputationService excludes every `demo.*` capability (§5.2),
// so running the demo never earns score or anchors anyone (#26).
//
// Stateless: the jobId carries its own issue time and an HMAC binding it to
// the requesting DID, so there is no demo table to keep in sync.
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { fromHex, keypairFromPrivateKey, sha256Hex, sign, toBase64, toHex, type Keypair } from "../../sdk-js/src/crypto/keys.js";
import { DEMO_CAPABILITY, demoOutputHash, demoSpec } from "../../sdk-js/src/core/demo.js";
import * as db from "./db.js";
import * as receiptService from "./receiptService.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { Env, ExecutionReceipt } from "./types.js";

export const DEMO_TASK_TTL_MS = 3600_000;
export const DEMO_RECEIPTS_PER_AGENT = 2;

function demoKeypair(env: Env): Keypair {
  if (!env.DEMO_PRIVATE_KEY) throw new ApiError(503, "DEMO_DISABLED", "This registry does not run the hosted demo counterparty");
  return keypairFromPrivateKey(fromHex(env.DEMO_PRIVATE_KEY));
}

async function mac(kp: Keypair, did: string, nonce: string, issuedAt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", kp.privateKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${did}|${nonce}|${issuedAt}`))));
}

async function ensureRegistered(env: Env, kp: Keypair): Promise<void> {
  if (await db.getAgent(env, kp.did)) return;
  try {
    await db.insertAgent(env, {
      id: kp.did,
      capabilities: ["demo.counterparty"],
      metadata: { name: "INAM Demo Counterparty", demo: true, docs: "https://github.com/inamprotocol/inam-protocol/blob/main/SPEC.md#14-hosted-demo-counterparty" },
      linked: {},
      linkedProof: {},
      stakeUsd: 0,
      createdAt: new Date().toISOString(),
      isAuthorizedVerifier: false,
    });
  } catch (err) {
    if (!(err instanceof db.AgentAlreadyExistsError)) throw err;
  }
}

async function demoReceiptsFor(env: Env, demoDid: string, agentId: string): Promise<number> {
  const receipts = await receiptService.listByAgent(env, agentId);
  return receipts.filter((r) => r.agentA.id === demoDid && r.status === "finalized").length;
}

export async function describeDemo(env: Env) {
  const kp = demoKeypair(env);
  return {
    demoAgentId: kp.did,
    capability: DEMO_CAPABILITY,
    receiptsPerAgent: DEMO_RECEIPTS_PER_AGENT,
    countsTowardReputation: false,
    steps: [
      "POST /v1/demo/task {agentId} -> jobId, spec, specHash",
      "Compute output = sha256 hex of spec; draft a receipt (POST /v1/receipts, signed by you) with agentAId = demoAgentId, task.capability = demo.sha256, result.outputHash = 'sha256:' + sha256 hex of output, verification {method: payer_confirmation, outcome: success}",
      "POST /v1/demo/complete {receiptId} -> the demo agent checks the work and countersigns",
    ],
  };
}

export async function issueTask(env: Env, agentId: string) {
  const kp = demoKeypair(env);
  const agent = await db.getAgent(env, agentId);
  if (!agent) throw notFound("AGENT_NOT_FOUND", "Register your agent (POST /v1/agents) before requesting a demo task");
  if (agentId === kp.did) throw badRequest("SELF_DEALING", "The demo agent cannot be its own counterparty");
  if ((await demoReceiptsFor(env, kp.did, agentId)) >= DEMO_RECEIPTS_PER_AGENT) {
    throw conflict("DEMO_LIMIT_REACHED", `The demo countersigns at most ${DEMO_RECEIPTS_PER_AGENT} receipts per agent`);
  }
  await ensureRegistered(env, kp);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const issuedAt = Date.now().toString();
  const jobId = `demo:${nonce}.${issuedAt}.${await mac(kp, agentId, nonce, issuedAt)}`;
  const spec = demoSpec(jobId);
  return {
    jobId,
    agentAId: kp.did,
    capability: DEMO_CAPABILITY,
    spec,
    specHash: `sha256:${sha256Hex(spec)}`,
    expiresAt: new Date(Number(issuedAt) + DEMO_TASK_TTL_MS).toISOString(),
  };
}

export async function completeTask(env: Env, receiptId: string): Promise<ExecutionReceipt> {
  const kp = demoKeypair(env);
  const r = await receiptService.getReceipt(env, receiptId);
  if (r.status !== "draft") throw conflict("NOT_DRAFT", "Only draft receipts can be countersigned");
  if (r.agentA.id !== kp.did) throw forbidden("NOT_DEMO_RECEIPT", "This receipt does not name the demo agent as agent_a");

  const m = /^demo:([0-9a-f]{16})\.(\d{13})\.([0-9a-f]{64})$/.exec(r.jobId);
  if (!m || m[3] !== (await mac(kp, r.agentB.id, m[1], m[2]))) {
    throw badRequest("DEMO_TASK_INVALID", "jobId was not issued by POST /v1/demo/task for this agent");
  }
  if (Date.now() - Number(m[2]) > DEMO_TASK_TTL_MS) throw badRequest("DEMO_TASK_EXPIRED", "Demo task expired; request a new one");

  const checks: [boolean, string][] = [
    [r.task.capability === DEMO_CAPABILITY, `task.capability must be ${DEMO_CAPABILITY}`],
    [r.task.specHash === `sha256:${sha256Hex(demoSpec(r.jobId))}`, "task.specHash does not match the issued spec"],
    [r.result.outputHash === demoOutputHash(r.jobId), "result.outputHash is wrong: output must be the sha256 hex of the spec"],
    [r.verification.method === "payer_confirmation" && r.verification.outcome === "success", "verification must be {method: payer_confirmation, outcome: success}"],
    [r.visibility !== "participants_only", "demo receipts must be public"],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw badRequest("DEMO_WORK_REJECTED", failed[1]);

  if ((await demoReceiptsFor(env, kp.did, r.agentB.id)) >= DEMO_RECEIPTS_PER_AGENT) {
    throw conflict("DEMO_LIMIT_REACHED", `The demo countersigns at most ${DEMO_RECEIPTS_PER_AGENT} receipts per agent`);
  }

  const content = { ...r, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
  const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), kp.privateKey));
  return receiptService.countersign(env, receiptId, kp.did, signature);
}
