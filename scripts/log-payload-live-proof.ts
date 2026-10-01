import { InamClient, generateKeypair, sha256Hex, payloadHash } from "../sdk-js/src/index.js";

/** SPEC.md v0.34 live proof: transparency-log leaves commit to payloads by
 * hash, free text stays out of the leaf, and a participants_only receipt's
 * payload is withheld. Real HTTP through the real SDK client:
 *
 *   INAM_URL=http://localhost:4021 npx tsx scripts/log-payload-live-proof.ts
 *
 * Never point this at production: log leaves are permanent. */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL)) throw new Error("refusing to write to a non-local registry");

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const requester = new InamClient(BASE_URL, generateKeypair());
const provider = new InamClient(BASE_URL, generateKeypair());
await requester.registerAgent(["job.posting"], { name: "v0.34 proof requester", demo: true });
await provider.registerAgent(["text.summary"], { name: "v0.34 proof provider", demo: true });

async function receipt(visibility: "public" | "participants_only", n: number) {
  const specHash = `sha256:${sha256Hex(`spec ${visibility} ${n}`)}`;
  const outputHash = `sha256:${sha256Hex(`output ${visibility} ${n}`)}`;
  const j = await requester.postJob({ capability: "text.summary", specHash });
  await provider.submitOffer(j.jobId, "on it");
  await requester.acceptOffer(j.jobId, provider.did);
  const now = new Date().toISOString();
  const draft = await provider.submitWork(requester.did, {
    jobId: j.jobId,
    task: { capability: "text.summary", specHash, createdAt: now },
    result: { outputHash, completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
  }, { visibility });
  return requester.acceptWork(draft, { jobId: j.jobId, outputHash });
}

const { treeSize: before } = await requester.getTransparencySTH();
const pub = await receipt("public", Date.now());
await requester.disputeReceipt(pub.receiptId, "contact jane.doe@example.com about this");
await receipt("participants_only", Date.now());

const { entries } = await requester.getTransparencyEntries({ offset: before, limit: 10 });
const [finalized, dispute, priv] = entries;
check("3 new entries", entries.length === 3);
for (const e of [finalized, dispute]) check(`${e.entryType}: payload matches dataHash`, payloadHash(e.payload!) === JSON.parse(e.data).dataHash);
check("dispute reason not in the permanent leaf", !dispute.data.includes("jane.doe"));
check("dispute reason in the erasable payload", dispute.payload!.includes("jane.doe"));
check("participants_only payload withheld", priv.payload === null);
check("participants_only leaf still commits by hash", /^sha256:[0-9a-f]{64}$/.test(JSON.parse(priv.data).dataHash));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
