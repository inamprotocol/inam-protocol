/** Minimal PayPal REST client for pay-on-proof: Orders v2 with intent AUTHORIZE,
 * then capture or void the authorization. Sandbox by default.
 * https://developer.paypal.com/docs/api/orders/v2/ and /docs/api/payments/v2/
 *
 * `fetchImpl` is injectable so tests run against a stand-in (mockPayPal below). */

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  base?: string; // default sandbox
  fetchImpl?: typeof fetch;
}

export interface HoldRequest {
  jobId: string;
  description: string;
  amount: string; // "12.00"
  currency: string; // "USD"
  payeeEmail?: string; // seller's PayPal account; default: the app's own account
  returnUrl: string;
  cancelUrl: string;
}

export class PayPal {
  private base: string;
  private f: typeof fetch;
  private token?: { value: string; until: number };
  constructor(private cfg: PayPalConfig) {
    this.base = cfg.base ?? "https://api-m.sandbox.paypal.com";
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await this.f(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal auth failed: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return j.access_token;
  }

  private async call(method: string, path: string, body?: unknown, requestId?: string): Promise<any> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.auth()}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...(requestId ? { "paypal-request-id": requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PayPal ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  /** Creates an AUTHORIZE order. The payer approves it at `approveUrl`; nothing is held until `authorize`. */
  async createHold(r: HoldRequest): Promise<{ orderId: string; approveUrl: string }> {
    const o = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: r.jobId.slice(0, 256),
            custom_id: r.jobId.slice(0, 127),
            description: r.description.slice(0, 127),
            amount: { currency_code: r.currency, value: r.amount },
            ...(r.payeeEmail ? { payee: { email_address: r.payeeEmail } } : {}),
          },
        ],
        payment_source: { paypal: { experience_context: { return_url: r.returnUrl, cancel_url: r.cancelUrl, user_action: "CONTINUE", shipping_preference: "NO_SHIPPING" } } },
      },
      `hold-${r.jobId}`,
    );
    const approveUrl = (o.links as { rel: string; href: string }[]).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approveUrl) throw new Error(`PayPal order ${o.id} has no approval link`);
    return { orderId: o.id, approveUrl };
  }

  /** After payer approval: places the hold. Returns the authorization id (the money is held, not moved). */
  async authorize(orderId: string): Promise<{ authorizationId: string; amount: string; currency: string; expiresAt?: string }> {
    const o = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, `auth-${orderId}`);
    const a = o.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a?.id) throw new Error(`PayPal order ${orderId}: no authorization in response`);
    return { authorizationId: a.id, amount: a.amount.value, currency: a.amount.currency_code, expiresAt: a.expiration_time };
  }

  /** Releases the held money to the payee. */
  async capture(authorizationId: string, note: string): Promise<{ captureId: string; status: string }> {
    const c = await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, { final_capture: true, note_to_payer: note.slice(0, 255) }, `cap-${authorizationId}`);
    return { captureId: c.id, status: c.status };
  }

  /** Cancels the hold; the payer is never charged. */
  async void(authorizationId: string): Promise<{ status: string }> {
    const v = await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, `void-${authorizationId}`);
    return { status: v.status ?? "VOIDED" };
  }

  async getOrder(orderId: string): Promise<any> {
    return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }
}

/** Stand-in for the sandbox with the documented response shapes, for tests and offline demos.
 * Every created order counts as approved. `calls` records what was called. */
export function mockPayPal() {
  const calls: string[] = [];
  let n = 0;
  const holds = new Map<string, { amount: string; currency: string; state: string }>();
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const p = url.pathname;
    const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
    calls.push(`${init?.method ?? "GET"} ${p}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (p === "/v1/oauth2/token") return json({ access_token: "mock-token", expires_in: 32400 });
    if (p === "/v2/checkout/orders") {
      const id = `MOCKORDER${++n}`;
      const amt = body.purchase_units[0].amount;
      holds.set(id, { amount: amt.value, currency: amt.currency_code, state: "CREATED" });
      return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] }, 201);
    }
    let m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/);
    if (m) {
      const h = holds.get(m[1])!;
      const authId = `MOCKAUTH${m[1].slice(9)}`;
      holds.set(authId, { ...h, state: "CREATED" });
      return json({ id: m[1], status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: authId, status: "CREATED", amount: { value: h.amount, currency_code: h.currency }, expiration_time: "2026-12-10T00:00:00Z" }] } }] }, 201);
    }
    m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/(capture|void)$/);
    if (m) {
      const h = holds.get(m[1]);
      if (!h || h.state !== "CREATED") return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_PROCESSED" }] }, 422);
      h.state = m[2] === "capture" ? "CAPTURED" : "VOIDED";
      return m[2] === "capture" ? json({ id: `MOCKCAP${m[1].slice(8)}`, status: "COMPLETED" }, 201) : json({ id: m[1], status: "VOIDED" });
    }
    return json({ name: "RESOURCE_NOT_FOUND" }, 404);
  };
  return { impl, calls, holds };
}
