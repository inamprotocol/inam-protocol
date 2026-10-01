import http from "node:http";
import {
  InamClient, generateKeypair, sha256Hex, toBase64,
  withInamX402Gate, inamX402Extension, X402PaymentBlocked,
} from "../sdk-js/src/index.js";
import { generateSecp256k1Keypair, secp256k1Sign, ethAddressFromUncompressedPublicKey } from "../sdk-js/src/crypto/secp256k1.js";

/** "Verify before you pay" (SPEC.md §11.2), end to end and with no real money.
 * Three paid x402 v2 endpoints; a buyer agent's fetch is wrapped with
 * withInamX402Gate, so it only pays the one whose INAM ID proved control of
 * the payTo wallet and has countersigned work behind it.
 *
 *   npm run dev                                     # terminal 1
 *   npx tsx examples/x402-verify-before-pay.ts      # terminal 2
 *
 * Local only: it writes receipts, and transparency-log leaves are permanent. */
const INAM_URL = process.env.INAM_URL ?? "http://localhost:4021";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(INAM_URL)) throw new Error("refusing to write to a non-local registry");

// --- 1. A seller agent with a wallet linked to its INAM ID and one finished job.
const seller = new InamClient(INAM_URL, generateKeypair());
const buyer = new InamClient(INAM_URL, generateKeypair());
await seller.registerAgent(["data.weather"], { name: "x402 demo seller", demo: true });
await buyer.registerAgent(["data.consumer"], { name: "x402 demo buyer", demo: true });

const wallet = generateSecp256k1Keypair();
const payTo = ethAddressFromUncompressedPublicKey(wallet.publicKey);
const ch = await seller.requestLinkChallenge("erc8004_id", toBase64(wallet.publicKey), "secp256k1");
await seller.completeLink("erc8004_id", payTo, ch.challengeId, toBase64(secp256k1Sign(Buffer.from(ch.challenge, "hex"), wallet.privateKey)));

const specHash = `sha256:${sha256Hex("hourly forecast, Istanbul")}`;
const outputHash = `sha256:${sha256Hex("forecast payload")}`;
const job = await buyer.postJob({ capability: "data.weather", specHash });
await seller.submitOffer(job.jobId);
await buyer.acceptOffer(job.jobId, seller.did);
const now = new Date().toISOString();
const draft = await seller.submitWork(buyer.did, {
  jobId: job.jobId,
  task: { capability: "data.weather", specHash, createdAt: now },
  result: { outputHash, completedAt: now },
  verification: { method: "payer_confirmation", outcome: "success" },
});
await buyer.acceptWork(draft, { jobId: job.jobId, outputHash });

// A newcomer with a linked wallet but no work history.
const newcomer = new InamClient(INAM_URL, generateKeypair());
await newcomer.registerAgent(["data.weather"], { name: "x402 demo newcomer", demo: true });
const w2 = generateSecp256k1Keypair();
const ch2 = await newcomer.requestLinkChallenge("erc8004_id", toBase64(w2.publicKey), "secp256k1");
await newcomer.completeLink("erc8004_id", ethAddressFromUncompressedPublicKey(w2.publicKey), ch2.challengeId, toBase64(secp256k1Sign(Buffer.from(ch2.challenge, "hex"), w2.privateKey)));

// --- 2. Three paid endpoints (a stand-in x402 server: 402 until a PAYMENT-SIGNATURE arrives).
const impostorWallet = "0x000000000000000000000000000000000000dead";
const endpoints: Record<string, { did: string; payTo: string }> = {
  "/forecast": { did: seller.did, payTo },                // honest seller
  "/borrowed": { did: seller.did, payTo: impostorWallet }, // claims the seller's DID, routes money elsewhere
  "/newcomer": { did: newcomer.did, payTo: ethAddressFromUncompressedPublicKey(w2.publicKey) },
};
const server = http.createServer((req, res) => {
  const e = endpoints[req.url ?? ""];
  if (req.headers["payment-signature"]) return res.end(`paid content from ${req.url}`);
  const required = {
    x402Version: 2,
    resource: { url: `http://localhost${req.url}` },
    accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", asset: "USDC", payTo: e.payTo, maxTimeoutSeconds: 60 }],
    extensions: inamX402Extension(e.did),
  };
  res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") }).end();
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;

// --- 3. The buyer. `fakePay` stands in for @x402/fetch's wrapFetchWithPayment.
const fakePay = (f: typeof fetch): typeof fetch => async (input, init) => {
  const res = await f(input, init);
  if (res.status !== 402) return res;
  const { accepts } = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
  console.log(`   paying ${Number(accepts[0].amount) / 1e6} USDC to ${accepts[0].payTo}`); // amount is in atomic units (6 decimals)
  return f(input, { ...init, headers: { "payment-signature": "demo" } });
};
const paidFetch = fakePay(withInamX402Gate(fetch, buyer, { minEvidence: "countersigned" }));

for (const path of Object.keys(endpoints)) {
  console.log(`GET ${path}`);
  try {
    console.log(`   ✓ ${await (await paidFetch(base + path)).text()}`);
  } catch (e) {
    if (!(e instanceof X402PaymentBlocked)) throw e;
    console.log(`   ✗ not paid: ${e.decision.reason}`);
  }
}
server.close();
