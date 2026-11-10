import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InamClient, generateKeypair, sha256Hex } from "../../sdk-js/src/index.js";
import { PayPal, mockPayPal } from "./paypal.js";
import { openJob, settleJob, sellerDeliver, type Job, type Step } from "./payOnProof.js";
import { explain, summarize, aiName } from "./ai.js";

/** Pay-on-proof demo server.
 *
 *   npx tsx examples/pay-on-proof/server.ts        -> http://localhost:8787
 *
 * PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET: PayPal sandbox app; without them a stand-in answers
 * with the documented shapes and every order counts as approved.
 * INAM_URL: registry to use; default a throwaway in-process one (demo agents never touch prod).
 * GEMINI_API_KEY or ANTHROPIC_API_KEY: the AI that writes the seller's work and explains each decision. */

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));

async function registryUrl(): Promise<string> {
  if (process.env.INAM_URL) return process.env.INAM_URL;
  process.env.INAM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inam-paypal-demo-"));
  const { createServer } = await import("../../src/server.js");
  const s = createServer().listen(0);
  await new Promise((r) => s.once("listening", r));
  return `http://localhost:${(s.address() as { port: number }).port}`;
}

const live = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const mock = mockPayPal();
const paypal = live
  ? new PayPal({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET!, base: process.env.PAYPAL_BASE })
  : new PayPal({ clientId: "mock", clientSecret: "mock", fetchImpl: mock.impl });

type Scenario = "honest" | "swap" | "overclaim" | "unknown";
interface Run { id: string; scenario: Scenario; job: Job; orderId?: string; result?: string; steps: (Step & { at: string; note?: string })[] }
const runs = new Map<string, Run>();
const byOrder = new Map<string, string>();
const clients = new Set<http.ServerResponse>();
const push = (r: Run) => {
  const data = `data: ${JSON.stringify(r)}\n\n`;
  for (const c of clients) c.write(data);
};

const inamUrl = await registryUrl();
const buyer = new InamClient(inamUrl, generateKeypair());
await buyer.registerAgent(["text.summary.consumer"], { name: "Buyer agent (pay-on-proof demo)", demo: true });
const seller = new InamClient(inamUrl, generateKeypair());
await seller.registerAgent(["text.summary"], { name: "Summary agent (pay-on-proof demo)", demo: true });

const REQUEST = "Summarize for a merchant: why should an AI agent's PayPal payment wait for a verified delivery receipt?";
const ctxFor = (r: Run) => ({
  buyer,
  paypal,
  returnUrl: `${PUBLIC_URL}/paypal/return`,
  cancelUrl: `${PUBLIC_URL}/paypal/cancel`,
  emit: (s: Step) => {
    r.steps.push({ ...s, at: new Date().toISOString() });
    push(r);
    // The AI explains; it never decides. Notes arrive after the step, best effort.
    explain(s, r.job).then((note) => {
      if (!note) return;
      const st = r.steps.find((x) => x.kind === s.kind && !x.note);
      if (st) { st.note = note; push(r); }
    }).catch(() => {});
  },
});

async function settle(r: Run) {
  const deliver = async (job: Job, ref: string) => {
    const output = await summarize(job.request);
    if (r.scenario === "swap") return sellerDeliver(seller, buyer.did, job, ref, output.slice(0, 40), { output }); // delivers less than it signs for
    if (r.scenario === "overclaim") return sellerDeliver(seller, buyer.did, job, ref, output, { amount: "120.00" });
    return sellerDeliver(seller, buyer.did, job, ref, output);
  };
  try {
    r.result = await settleJob(r.job, r.orderId!, deliver, ctxFor(r));
  } catch (e) {
    r.result = `error: ${(e as Error).message}`;
  }
  push(r);
}

async function start(scenario: Scenario): Promise<Run> {
  const jobId = `job-${Date.now().toString(36)}-${sha256Hex(Math.random().toString()).slice(0, 6)}`;
  const target = scenario === "unknown" ? new InamClient(inamUrl, generateKeypair()).did : seller.did;
  const r: Run = { id: jobId, scenario, job: { jobId, capability: "text.summary", request: REQUEST, amount: "12.00", currency: "USD", seller: target }, steps: [] };
  runs.set(jobId, r);
  push(r);
  const hold = await openJob(r.job, ctxFor(r)).catch((e) => { r.result = `error: ${(e as Error).message}`; push(r); return null; });
  if (!hold) { r.result ??= "refused"; push(r); return r; }
  r.orderId = hold.orderId;
  byOrder.set(hold.orderId, jobId);
  if (!live) void settle(r); // stand-in: approval is implied
  return r;
}

const send = (res: http.ServerResponse, code: number, body: string, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", PUBLIC_URL);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, readFileSync(path.join(here, "ui.html"), "utf8"), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state")
        return send(res, 200, JSON.stringify({ live, ai: aiName(), registry: process.env.INAM_URL ?? "in-process (local)", buyer: buyer.did, seller: seller.did, runs: [...runs.values()] }));
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const s = url.searchParams.get("scenario") as Scenario;
        if (!["honest", "swap", "overclaim", "unknown"].includes(s)) return send(res, 400, JSON.stringify({ error: "scenario must be honest, swap, overclaim or unknown" }));
        const r = await start(s);
        return send(res, 200, JSON.stringify(r));
      }
      // PayPal sends the payer back here after approval (?token=<order id>).
      if (req.method === "GET" && (url.pathname === "/paypal/return" || url.pathname === "/paypal/cancel")) {
        const r = runs.get(byOrder.get(url.searchParams.get("token") ?? "") ?? "");
        if (r && url.pathname === "/paypal/return" && !r.result) void settle(r);
        if (r && url.pathname === "/paypal/cancel") { r.result = "cancelled by payer"; push(r); }
        res.writeHead(302, { location: `/#${r?.id ?? ""}` });
        return res.end();
      }
      send(res, 404, JSON.stringify({ error: "not found" }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: (e as Error).message }));
    }
  })
  .listen(PORT, () => console.log(`pay-on-proof demo: ${PUBLIC_URL}  (PayPal ${live ? "sandbox" : "stand-in"}, AI ${aiName()}, registry ${inamUrl})`));
