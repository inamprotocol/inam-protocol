import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import express from "express";
import { InamClient, sha256Hex, checkTarget, type CheckReport } from "../../sdk-js/src/index.js";

/** Payment-succeeded webhook (Stripe or Dodo Payments): `inam check` the buyer agent
 * before fulfilling, then record the decision as a signed INAM receipt.
 *
 * INAM moves and holds no money. The payment already happened on Stripe / Dodo; this
 * handler only decides whether to deliver, and signs a record of that decision whose
 * `settlement.paymentRef` points at the processor's own payment id.
 *
 * Assumptions to adapt (nothing here calls Stripe or Dodo):
 *  - the checkout carries the buyer agent's INAM ID in metadata.inam_agent;
 *  - the signature check is a Stripe-style HMAC (`t=...,v1=...` over `${t}.${body}`) as a
 *    stand-in. In production use `stripe.webhooks.constructEvent` or Dodo's own webhook
 *    verification, with your real signing secret from an env var;
 *  - when fulfilment is withheld you refund or hold via the processor yourself.
 *
 * The receipt is a draft signed by the merchant (SPEC.md section 4.3); it counts toward
 * reputation only if the buyer countersigns. Use `expected` on the buyer's acceptWork.
 *
 *   npx tsx examples/webhook/payment-webhook.ts     # offline self-check, no network */

export interface Deps {
  merchant: InamClient;
  secret: string; // webhook signing secret (a placeholder in the self-check)
  check?: (did: string) => Promise<CheckReport>;
  fulfil: (paymentId: string, buyerDid: string) => Promise<void>;
  strict?: boolean; // true: "caution" also withholds fulfilment
}

const sign = (secret: string, t: string, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
function validSignature(secret: string, header: string | undefined, body: string) {
  const p = Object.fromEntries((header ?? "").split(",").map((kv) => kv.split("=") as [string, string]));
  if (!p.t || !p.v1 || Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;
  const a = Buffer.from(sign(secret, p.t, body)), b = Buffer.from(p.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function webhookApp(d: Deps) {
  const check = d.check ?? ((t: string) => checkTarget(t));
  const app = express();
  app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
    const body = req.body.toString("utf8");
    if (!validSignature(d.secret, req.header("x-webhook-signature"), body)) return res.status(400).send("bad signature");
    const event = JSON.parse(body); // { id, type, data: { id, amount, currency, metadata: { inam_agent } } }
    if (event.type !== "payment_intent.succeeded" && event.type !== "payment.succeeded") return res.sendStatus(200);
    const pay = event.data;
    const buyer: string | undefined = pay.metadata?.inam_agent;
    if (!buyer) return res.json({ fulfilled: false, reason: "no inam_agent in metadata" });

    const report = await check(buyer);
    const ok = report.verdict === "pass" || (report.verdict === "caution" && !d.strict);
    if (ok) await d.fulfil(pay.id, buyer);

    // Record the decision, signed by the merchant. jobId derives from the payment id, so a
    // redelivered webhook maps to the same receipt id (DUPLICATE_RECEIPT, SPEC.md section 4.2).
    const now = new Date().toISOString();
    const decision = JSON.stringify({ event: event.id, verdict: report.verdict, fulfilled: ok });
    const receipt = await d.merchant
      .submitWork(buyer, {
        jobId: `order:webhook:${pay.id}`,
        task: { capability: "order.fulfilment", specHash: `sha256:${sha256Hex(event.id)}`, createdAt: now },
        result: { outputHash: `sha256:${sha256Hex(decision)}`, completedAt: now },
        settlement: { paymentRef: `webhook:${pay.id}`, amount: (pay.amount / 100).toFixed(2), currency: String(pay.currency).toUpperCase() },
        verification: { method: "payer_confirmation", outcome: ok ? "success" : "failed" },
      })
      .catch((e) => {
        console.error("receipt not recorded:", (e as Error).message);
        return null;
      });
    res.json({ fulfilled: ok, verdict: report.verdict, receiptId: receipt?.receiptId ?? null });
  });
  return app;
}

/** Offline self-check: stub `check`, stub registry client, placeholder secret. */
export async function selfCheck() {
  const secret = "whsec_placeholder_not_a_real_secret";
  const fulfilled: string[] = [];
  const recorded: any[] = [];
  const merchant = { submitWork: async (_b: string, input: any) => (recorded.push(input), { receiptId: `sha256:${"0".repeat(64)}` }) } as unknown as InamClient;
  const verdicts: Record<string, CheckReport["verdict"]> = { "did:key:zGood": "pass", "did:key:zBad": "fail" };
  const check = async (t: string): Promise<CheckReport> => ({ target: t, kind: "did", verdict: verdicts[t], checkedAt: "", checks: [] });
  const server = webhookApp({ merchant, secret, check, fulfil: async (id) => void fulfilled.push(id) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://localhost:${(server.address() as { port: number }).port}/webhook`;
  const post = async (agent: string, pid: string, goodSig = true) => {
    const body = JSON.stringify({ id: `evt_${pid}`, type: "payment_intent.succeeded", data: { id: pid, amount: 2500, currency: "usd", metadata: { inam_agent: agent } } });
    const t = String(Math.floor(Date.now() / 1000));
    const r = await fetch(url, { method: "POST", body, headers: { "x-webhook-signature": `t=${t},v1=${sign(goodSig ? secret : "wrong", t, body)}` } });
    return { status: r.status, json: r.status === 200 ? ((await r.json()) as any) : null };
  };
  try {
    assert.equal((await post("did:key:zGood", "pi_1")).json.fulfilled, true);
    assert.equal((await post("did:key:zBad", "pi_2")).json.fulfilled, false);
    assert.equal((await post("did:key:zGood", "pi_3", false)).status, 400);
    assert.deepEqual(fulfilled, ["pi_1"]);
    assert.deepEqual(recorded.map((r) => r.verification.outcome), ["success", "failed"]);
    assert.equal(recorded[0].settlement.paymentRef, "webhook:pi_1");
  } finally {
    server.close();
  }
  console.log("webhook payment-webhook: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await selfCheck();
