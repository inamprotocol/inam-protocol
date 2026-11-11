import type { Job, Rail } from "./payOnProof.js";

/** Braintree (a PayPal service) as a pay-on-proof rail, over the GraphQL API. Sandbox by default.
 * https://developer.paypal.com/braintree/graphql/guides/transactions/
 *
 *   hold    = authorizePaymentMethod (money authorized, not settled)
 *   capture = captureTransaction     (submitted for settlement)
 *   void    = reverseTransaction     (before settlement this is a void; the payer is never charged)
 *
 * The payment method is a sandbox test nonce; `fake-paypal-one-time-nonce` stands in for a
 * PayPal wallet payment, so no browser and no PayPal account are needed. */

export interface BraintreeConfig {
  publicKey: string;
  privateKey: string;
  merchantAccountId?: string; // picks the currency; default: the account's default merchant account
  nonce?: string; // default fake-paypal-one-time-nonce
  endpoint?: string; // default sandbox
  fetchImpl?: typeof fetch;
}

const TXN = "id status amount { value currencyCode }";

export class BraintreeRail implements Rail {
  readonly name = "braintree";
  private f: typeof fetch;
  constructor(private cfg: BraintreeConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await this.f(this.cfg.endpoint ?? "https://payments.sandbox.braintree-api.com/graphql", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${this.cfg.publicKey}:${this.cfg.privateKey}`)}`, "braintree-version": "2019-01-01", "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await res.json().catch(() => ({}))) as { data?: any; errors?: { message: string }[] };
    if (!res.ok || j.errors?.length) throw new Error(`Braintree: HTTP ${res.status} ${j.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
    return j.data;
  }

  async hold(job: Job) {
    const d = await this.gql(`mutation($input: AuthorizePaymentMethodInput!) { authorizePaymentMethod(input: $input) { transaction { ${TXN} } } }`, {
      input: {
        paymentMethodId: this.cfg.nonce ?? "fake-paypal-one-time-nonce",
        transaction: { amount: job.amount, orderId: job.jobId.slice(0, 255), ...(this.cfg.merchantAccountId ? { merchantAccountId: this.cfg.merchantAccountId } : {}) },
      },
    });
    return { holdRef: d.authorizePaymentMethod.transaction.id as string };
  }

  /** No payer redirect: the hold already exists. Reads it back so the amount checked is Braintree's, not ours. */
  async confirm(id: string) {
    const d = await this.gql(`query($id: ID!) { node(id: $id) { ... on Transaction { ${TXN} } } }`, { id });
    const t = d.node;
    if (t?.status !== "AUTHORIZED") throw new Error(`Braintree transaction ${id} is ${t?.status ?? "missing"}, not AUTHORIZED`);
    return { ref: t.id as string, amount: t.amount.value as string, currency: t.amount.currencyCode as string };
  }

  async capture(id: string) {
    const d = await this.gql(`mutation($input: CaptureTransactionInput!) { captureTransaction(input: $input) { transaction { id status } } }`, { input: { transactionId: id } });
    return { captureId: d.captureTransaction.transaction.id as string, status: d.captureTransaction.transaction.status as string };
  }

  async void(id: string) {
    const d = await this.gql(`mutation($input: ReverseTransactionInput!) { reverseTransaction(input: $input) { reversal { ... on Transaction { id status } } } }`, { input: { transactionId: id } });
    return { status: (d.reverseTransaction.reversal?.status as string) ?? "VOIDED" };
  }
}

/** Stand-in for the Braintree sandbox GraphQL API with the documented response shapes. */
export function mockBraintree() {
  const calls: string[] = [];
  let n = 0;
  const txns = new Map<string, { status: string; value: string }>();
  const impl: typeof fetch = async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const op = /authorizePaymentMethod|captureTransaction|reverseTransaction|node\(/.exec(query)?.[0] ?? "unknown";
    calls.push(op);
    const ok = (data: unknown) => Response.json({ data });
    if (op === "authorizePaymentMethod") {
      const id = `dHJhbnNhY3Rpb25f${++n}`;
      txns.set(id, { status: "AUTHORIZED", value: variables.input.transaction.amount });
      return ok({ authorizePaymentMethod: { transaction: { id, status: "AUTHORIZED", amount: { value: variables.input.transaction.amount, currencyCode: "USD" } } } });
    }
    const t = txns.get(variables.input?.transactionId ?? variables.id);
    if (!t) return Response.json({ errors: [{ message: "transaction not found" }] });
    if (op === "node(") return ok({ node: { id: variables.id, status: t.status, amount: { value: t.value, currencyCode: "USD" } } });
    if (t.status !== "AUTHORIZED") return Response.json({ errors: [{ message: `cannot ${op} a ${t.status} transaction` }] });
    t.status = op === "captureTransaction" ? "SUBMITTED_FOR_SETTLEMENT" : "VOIDED";
    return ok(op === "captureTransaction" ? { captureTransaction: { transaction: { id: variables.input.transactionId, status: t.status } } } : { reverseTransaction: { reversal: { id: variables.input.transactionId, status: t.status } } });
  };
  return { impl, calls, txns };
}
