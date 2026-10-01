import http from "node:http";
import { InamClient, generateKeypair, sha256Hex, inamA2AExtension, verifyA2ACard } from "../sdk-js/src/index.js";

/** INAM on an A2A Agent Card (SPEC.md §11.3), end to end. An agent links its
 * A2A endpoint to its INAM ID and names the ID on its card; a client fetches
 * cards and checks them. A second card copies the first agent's ID onto a
 * different endpoint and is refused.
 *
 *   npm run dev                              # terminal 1
 *   npx tsx examples/a2a-agent-card.ts       # terminal 2
 *
 * Local only: it writes a receipt, and transparency-log leaves are permanent. */
const INAM_URL = process.env.INAM_URL ?? "http://localhost:4021";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(INAM_URL)) throw new Error("refusing to write to a non-local registry");

const server = http.createServer((req, res) => {
  const card = cards[req.url ?? ""];
  if (!card) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(card));
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;

// --- 1. An agent with one countersigned job, its A2A endpoint linked to its INAM ID.
const agent = new InamClient(INAM_URL, generateKeypair());
const client = new InamClient(INAM_URL, generateKeypair());
await agent.registerAgent(["text.translate"], { name: "a2a demo agent", demo: true });
await client.registerAgent(["text.consumer"], { name: "a2a demo client", demo: true });
await agent.linkIdentity("a2a_endpoint", `${base}/translator/a2a`);

const specHash = `sha256:${sha256Hex("translate 3 pages tr->en")}`;
const outputHash = `sha256:${sha256Hex("translated pages")}`;
const job = await client.postJob({ capability: "text.translate", specHash });
await agent.submitOffer(job.jobId);
await client.acceptOffer(job.jobId, agent.did);
const now = new Date().toISOString();
const draft = await agent.submitWork(client.did, {
  jobId: job.jobId,
  task: { capability: "text.translate", specHash, createdAt: now },
  result: { outputHash, completedAt: now },
  verification: { method: "payer_confirmation", outcome: "success" },
});
await client.acceptWork(draft, { jobId: job.jobId, outputHash });

// --- 2. Two A2A 1.0 Agent Cards naming the same INAM ID.
const card = (name: string, url: string) => ({
  name,
  description: "Translates documents.",
  version: "1.0.0",
  supportedInterfaces: [{ url, protocolBinding: "JSONRPC" }],
  capabilities: { extensions: [inamA2AExtension(agent.did)] },
  skills: [{ id: "translate", name: "Translate", description: "tr->en", tags: ["translation"] }],
});
const cards: Record<string, object> = {
  "/translator/.well-known/agent-card.json": card("Translator", `${base}/translator/a2a`),
  "/copycat/.well-known/agent-card.json": card("Copycat", `${base}/copycat/a2a`),
};

// --- 3. The client discovers both and checks them before delegating work.
for (const path of Object.keys(cards)) {
  const fetched = await (await fetch(base + path)).json();
  const d = await verifyA2ACard(fetched, client, { minEvidence: "countersigned" });
  console.log(`${fetched.name.padEnd(11)} ${d.allow ? "✓ delegate" : "✗ skip"}: ${d.allow ? `evidence ${d.reputation!.evidenceLevel}, trustScore ${d.reputation!.trustScore}` : d.reason}`);
}
server.close();
