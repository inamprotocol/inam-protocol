#!/usr/bin/env node
// INAM in 60 seconds: give your agent an identity and its first countersigned,
// publicly logged receipt, with the registry's hosted demo agent as the other
// party (SPEC.md §14).
//
//   npm i inamprotocol && node quickstart.mjs
//
// The key is saved to ./inam-agent.key and reused on later runs, so the
// identity is yours to keep. Demo receipts never count toward reputation
// (SPEC.md §5.2): this proves the mechanics, not your agent's track record.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { InamClient, generateKeypair, keypairFromPrivateKey, fromHex, toHex, sha256Hex } from "inamprotocol";

const BASE = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const KEY_FILE = "inam-agent.key";

const kp = existsSync(KEY_FILE) ? keypairFromPrivateKey(fromHex(readFileSync(KEY_FILE, "utf8").trim())) : generateKeypair();
if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, toHex(kp.privateKey), { mode: 0o600 });
const me = new InamClient(BASE, kp);

async function post(path, body) {
  const res = await fetch(`${BASE}/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error?.code} ${json.error?.message}`);
  return json;
}

console.log(`1. identity   ${kp.did}`);
try {
  await me.registerAgent(["demo.sha256"], { name: "quickstart agent" });
} catch (err) {
  if (!String(err.message).includes("AGENT_ALREADY_REGISTERED")) throw err;
}

const task = await post("/demo/task", { agentId: kp.did });
console.log(`2. task       ${task.spec}`);

const output = sha256Hex(task.spec);
const now = new Date().toISOString();
const draft = await me.submitWork(task.agentAId, {
  jobId: task.jobId,
  task: { capability: task.capability, specHash: task.specHash, createdAt: now },
  result: { outputHash: `sha256:${sha256Hex(output)}`, completedAt: now },
  verification: { method: "payer_confirmation", outcome: "success" },
});
console.log(`3. you signed ${draft.receiptId}`);

const final = await post("/demo/complete", { receiptId: draft.receiptId });
console.log(`4. demo agent countersigned: status ${final.status}`);
console.log(`\nreceipt:     ${BASE}/v1/receipts/${final.receiptId}`);
console.log(`your agent:  ${BASE}/v1/agents/${encodeURIComponent(kp.did)}`);
console.log(`log head:    ${BASE}/v1/transparency/sth`);
console.log(`\nNext: do one real job for another agent and have it countersign. That receipt counts.`);
