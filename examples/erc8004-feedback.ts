import { InamClient, generateKeypair, sha256Hex, toBase64, buildErc8004Feedback, verifyErc8004Feedback } from "../sdk-js/src/index.js";
import { generateSecp256k1Keypair, secp256k1Sign, ethAddressFromUncompressedPublicKey } from "../sdk-js/src/crypto/secp256k1.js";

/** INAM receipts as ERC-8004 feedback (SPEC.md §11.1), end to end and with no chain writes.
 * A requester finishes a job with a provider, builds the feedback for ERC-8004's
 * giveFeedback() from the countersigned receipt, and a reader checks it. Sending
 * the transaction is left out: any wallet can send the printed arguments.
 *
 *   npm run dev                              # terminal 1
 *   npx tsx examples/erc8004-feedback.ts     # terminal 2
 *
 * Local only: it writes receipts, and transparency-log leaves are permanent. */
const INAM_URL = process.env.INAM_URL ?? "http://localhost:4021";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(INAM_URL)) throw new Error("refusing to write to a non-local registry");

async function withWallet(client: InamClient) {
  const w = generateSecp256k1Keypair();
  const address = ethAddressFromUncompressedPublicKey(w.publicKey);
  const ch = await client.requestLinkChallenge("erc8004_id", toBase64(w.publicKey), "secp256k1");
  await client.completeLink("erc8004_id", address, ch.challengeId, toBase64(secp256k1Sign(Buffer.from(ch.challenge, "hex"), w.privateKey)));
  return address;
}

// --- 1. Two agents, each with a proven EVM address, and one finished job.
const provider = new InamClient(INAM_URL, generateKeypair());
const requester = new InamClient(INAM_URL, generateKeypair());
await provider.registerAgent(["translation.tr-en"], { name: "8004 demo provider", demo: true });
await requester.registerAgent(["translation.buyer"], { name: "8004 demo requester", demo: true });
await withWallet(provider);
const requesterAddress = await withWallet(requester);

const specHash = `sha256:${sha256Hex("translate the README to English")}`;
const outputHash = `sha256:${sha256Hex("translated README")}`;
const now = new Date().toISOString();
const draft = await provider.submitWork(requester.did, {
  jobId: `job_${Date.now()}`,
  task: { capability: "translation.tr-en", specHash, createdAt: now },
  result: { outputHash, completedAt: now },
  verification: { method: "payer_confirmation", outcome: "success" },
});
const receipt = await requester.acceptWork(draft, { jobId: draft.jobId, outputHash });

// --- 2. The requester builds the feedback. agentRegistry/agentId are placeholders for the provider's ERC-8004 identity.
const target = { agentRegistry: "eip155:84532:0x0000000000000000000000000000000000008004", agentId: 42 };
const fb = buildErc8004Feedback(receipt, await requester.getAgent(requester.did), target);
console.log("giveFeedback, sent from", requesterAddress);
console.log(fb.args);
console.log(`host these ${fb.fileText.length} bytes at feedbackURI (IPFS or HTTPS)\n`);

// --- 3. A reader, given the NewFeedback event fields and the hosted file.
const reader = new InamClient(INAM_URL, generateKeypair());
const genuine = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: requesterAddress, value: fb.args.value }, reader);
console.log("genuine feedback:", genuine.valid ? "valid" : genuine.reasons, `(provider ${genuine.providerAddress})`);

// The same file replayed from a Sybil wallet, which is what ERC-8004 can't tell apart on its own.
const sybil = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: "0x000000000000000000000000000000000000dEaD", value: 100 }, reader);
console.log("replayed from another wallet:", sybil.reasons);
