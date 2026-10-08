#!/usr/bin/env node
// INAM demo against the live registry's hosted demo counterparty (SPEC.md §14):
// creates a throwaway did:key identity, takes a demo.sha256 task, signs the
// receipt as the worker, and has the registry's demo agent check the work and
// countersign it. Ends with a real finalized receipt in the public
// transparency log.
//
// Low blast radius by design: the identity is marked `demo: true` (hidden from
// search), demo receipts never count toward anyone's reputation (§5.2), the
// demo agent signs at most 2 per identity, and no key is written to disk.
//
// Usage:
//   npm install inamprotocol@0.17.1
//   node demo.mjs
//   INAM_URL=http://localhost:8787 node demo.mjs   # a local Worker (`npx wrangler dev` in worker/)
import { InamClient, generateKeypair, sha256Hex } from "inamprotocol";

const BASE = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const kp = generateKeypair();
const me = new InamClient(BASE, kp);

async function post(path, body) {
  const res = await fetch(`${BASE}/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error?.code} ${json.error?.message}`);
  return json;
}

console.log(`INAM demo against ${BASE}`);
console.log(`1. throwaway identity  ${kp.did}`);
await me.registerAgent(["demo.sha256"], { demo: true, name: "Claude plugin demo" });

const task = await post("/demo/task", { agentId: kp.did });
console.log(`2. task from demo agent ${task.agentAId}\n   "${task.spec}"`);

const output = sha256Hex(task.spec);
const now = new Date().toISOString();
const draft = await me.submitWork(task.agentAId, {
  jobId: task.jobId,
  task: { capability: task.capability, specHash: task.specHash, createdAt: now },
  result: { outputHash: `sha256:${sha256Hex(output)}`, completedAt: now },
  verification: { method: "payer_confirmation", outcome: "success" },
});
console.log(`3. signed as worker     ${draft.receiptId}`);

const final = await post("/demo/complete", { receiptId: draft.receiptId });
console.log(`4. demo agent checked the output and countersigned: ${final.status}`);

const rep = await me.getReputation(kp.did);
console.log(`\nreceipt: ${BASE}/v1/receipts/${final.receiptId}`);
console.log(`reputation: trustScore ${rep.trustScore}, evidenceLevel ${rep.evidenceLevel} (demo receipts never count; real countersigned work does)`);
