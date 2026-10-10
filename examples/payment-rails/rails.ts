import type { InamClient, ExecutionReceipt } from "../../sdk-js/src/index.js";
import { sha256Hex } from "../../sdk-js/src/index.js";

/** INAM on agent payment rails: two calls, the same on every rail.
 *
 *   1. Before payment: `checkTrust(merchantDid, inam)` -> allow / escrow / deny.
 *   2. After delivery: a receipt whose `settlement.paymentRef` is the rail's own
 *      order or payment id (`writeReceipt` below, countersigned by the buyer).
 *
 * INAM never sees card data, tokens or mandates and moves no money; it only
 * records the id the rail already returned. Each rail function below calls the
 * merchant with the request shape from that protocol's public docs and returns
 * the id to record. `merchant` is any fetch; the demo passes a mock. */

export interface Settlement { paymentRef: string; amount: string; currency: string }
export type Rail = (merchant: typeof fetch) => Promise<Settlement>;

const post = async (merchant: typeof fetch, url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await merchant(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<any>; // the rail's documented response JSON; validate it in production code
};
// ponytail: assumes a 2-decimal currency (USD, EUR); use the ISO 4217 exponent for JPY, KWD, etc.
const fromMinor = (minor: number) => (minor / 100).toFixed(2);
const total = (totals: { type: string; amount: number }[]) => fromMinor(totals.find((t) => t.type === "total")!.amount);

/** Stripe / OpenAI Agentic Commerce Protocol: Checkout API, paid with a Shared Payment Token.
 * https://developers.openai.com/commerce/specs/checkout */
export const acp: Rail = async (merchant) => {
  const session = await post(merchant, "https://merchant.example/checkout_sessions", { items: [{ id: "sku_report", quantity: 1 }] });
  const done = await post(merchant, `https://merchant.example/checkout_sessions/${session.id}/complete`, {
    payment_data: { token: "spt_demo", provider: "stripe" },
  });
  return { paymentRef: `acp:${done.order.id}`, amount: total(session.totals), currency: session.currency.toUpperCase() };
};

/** Universal Commerce Protocol (Google, Shopify): REST binding, a Google Pay instrument.
 * https://ucp.dev/specification/shopping/checkout/ */
export const ucp: Rail = async (merchant) => {
  const headers = { "UCP-Agent": 'profile="https://agent.example/profile"' };
  const session = await post(merchant, "https://merchant.example/checkout-sessions", { line_items: [{ item: { id: "sku_report" }, quantity: 1 }] }, headers);
  const done = await post(merchant, `https://merchant.example/checkout-sessions/${session.id}/complete`, {
    payment: { instruments: [{ id: "pi_demo", handler_id: "gpay_1234", type: "card", selected: true, credential: { type: "PAYMENT_GATEWAY", token: "demo" } }] },
  }, headers);
  return { paymentRef: `ucp:${done.order.id}`, amount: total(done.totals), currency: done.currency };
};

/** Visa Trusted Agent Protocol: the agent signs the checkout request (RFC 9421, tag
 * `agent-payer-auth`); the order itself is the merchant's own API, here the shape
 * of Visa's sample merchant backend. https://github.com/visa/trusted-agent-protocol */
export const visaTap: Rail = async (merchant) => {
  const now = Math.floor(Date.now() / 1000);
  const order = await post(merchant, "https://merchant.example/api/orders", { items: [{ product_id: 1, quantity: 1 }] }, {
    "Signature-Input": `sig1=("@authority" "@path");created=${now};expires=${now + 480};keyid="demo-key";alg="ed25519";nonce="${crypto.randomUUID()}";tag="agent-payer-auth"`,
    Signature: "sig1=:ZGVtbw==:",
  });
  return { paymentRef: `visa-tap:${order.order_number}`, amount: order.total_amount.toFixed(2), currency: "USD" };
};

/** Mastercard Agent Pay: Web Bot Auth signature (tag `agent-pay-auth`, key directory in
 * `Signature-Agent`); the Agentic Token rides the normal card fields to the merchant's PSP.
 * https://developer.mastercard.com/merchant-cloud/documentation/tutorials-and-guides/agentic-commerce-guide/21/ */
export const mastercardAgentPay: Rail = async (merchant) => {
  const now = Math.floor(Date.now() / 1000);
  const payment = await post(merchant, "https://merchant.example/payments", { amount: 2500, currency: "USD", card: { number: "agentic-token", cryptogram: "demo" } }, {
    "Signature-Agent": '"https://agentpay-key-directory.mastercard.com/"',
    "Signature-Input": `sig1=("@authority" "@path" "signature-agent");created=${now};expires=${now + 480};keyid="demo-key";alg="ed25519";nonce="${crypto.randomUUID()}";tag="agent-pay-auth"`,
    Signature: "sig1=:ZGVtbw==:",
  });
  return { paymentRef: `mastercard-agent-pay:${payment.id}`, amount: fromMinor(payment.amount), currency: payment.currency };
};

/** Google Agent Payments Protocol: the user-signed Payment Mandate goes out, a Payment
 * Receipt comes back; its `payment_id` is what the INAM receipt records.
 * https://github.com/google-agentic-commerce/AP2/tree/main/code/sdk/schemas/ap2 */
export const ap2: Rail = async (merchant) => {
  const mandate = {
    vct: "mandate.payment.1",
    transaction_id: "demo-checkout-hash",
    payee: { id: "merchant_demo", name: "Demo Merchant" },
    payment_amount: { amount: 2500, currency: "USD" },
    payment_instrument: { id: "pi_demo", type: "card" },
  };
  const receipt = await post(merchant, "https://merchant.example/ap2/payments", { payment_mandate: mandate });
  if (receipt.status !== "Success") throw new Error(`AP2 payment failed: ${receipt.error}`);
  return { paymentRef: `ap2:${receipt.payment_id}`, amount: fromMinor(mandate.payment_amount.amount), currency: mandate.payment_amount.currency };
};

/** Step 2, merchant side: after delivering, draft a receipt naming the rail's id. The buyer
 * countersigns it with `buyer.acceptWork(draft, { amount, currency })`, which refuses a
 * receipt that names a different amount or currency than the one it paid. */
export function writeReceipt(merchant: InamClient, buyerDid: string, capability: string, request: string, output: string, settlement: Settlement): Promise<ExecutionReceipt> {
  const now = new Date().toISOString();
  return merchant.submitWork(buyerDid, {
    jobId: `order:${settlement.paymentRef}`,
    task: { capability, specHash: `sha256:${sha256Hex(request)}`, createdAt: now },
    result: { outputHash: `sha256:${sha256Hex(output)}`, completedAt: now },
    settlement,
    verification: { method: "payer_confirmation", outcome: "success" },
  });
}

/** A stand-in merchant answering every rail above with the response shapes from its docs. */
export const mockMerchant: typeof fetch = async (input) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  const totals = [{ type: "subtotal", amount: 2500 }, { type: "total", amount: 2500 }];
  const json = (body: unknown) => Response.json(body);
  if (path === "/checkout_sessions") return json({ id: "checkout_session_123", status: "ready_for_payment", currency: "usd", totals });
  if (path === "/checkout_sessions/checkout_session_123/complete")
    return json({ id: "checkout_session_123", status: "completed", order: { id: "order_acp_456", checkout_session_id: "checkout_session_123", permalink_url: "https://merchant.example/orders/order_acp_456" } });
  if (path === "/checkout-sessions") return json({ id: "chk_123456789", status: "ready_for_complete", currency: "USD", totals });
  if (path === "/checkout-sessions/chk_123456789/complete")
    return json({ id: "chk_123456789", status: "completed", currency: "USD", totals, order: { id: "ord_99887766", permalink_url: "https://merchant.example/orders/ord_99887766" } });
  if (path === "/api/orders") return json({ order_number: "ORD-20261010-0001", total_amount: 25, status: "pending" });
  if (path === "/payments") return json({ id: "pay_mc_789", status: "authorized", amount: 2500, currency: "USD" });
  if (path === "/ap2/payments")
    return json({ status: "Success", iss: "https://psp.example", iat: Math.floor(Date.now() / 1000), reference: "demo-mandate-hash", payment_id: "pay_ap2_321", psp_confirmation_id: "psp_1", network_confirmation_id: "net_1" });
  return new Response("not found", { status: 404 });
};
