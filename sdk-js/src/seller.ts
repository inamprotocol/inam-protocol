import { inamX402Extension } from "./x402.js";

/** Seller side of x402 verify-before-pay: add your INAM ID to the 402 your payment middleware already sends.
 * Rewrites the v2 `PAYMENT-REQUIRED` header value; returns it unchanged if unreadable. */
// ponytail: v2 header only (the buyer gate reads only that too); v1 body-JSON 402s are left untouched.
export function withInamExtension(headerValue: string, did: string): string {
  try {
    const required = JSON.parse(Buffer.from(headerValue, "base64").toString());
    required.extensions = { ...required.extensions, ...inamX402Extension(did) };
    return Buffer.from(JSON.stringify(required)).toString("base64");
  } catch {
    return headerValue;
  }
}

/** Express: `app.use(inamSellerMiddleware(did))` BEFORE the x402 payment middleware. */
export function inamSellerMiddleware(did: string) {
  return (_req: unknown, res: { setHeader: (name: string, value: any) => unknown }, next: () => void) => {
    const set = res.setHeader.bind(res);
    res.setHeader = (name, value) => set(name, name.toLowerCase() === "payment-required" && typeof value === "string" ? withInamExtension(value, did) : value);
    next();
  };
}

/** Hono: `app.use(inamSellerHono(did))` BEFORE the x402 payment middleware. */
export function inamSellerHono(did: string) {
  return async (c: { res: Response }, next: () => Promise<void>) => {
    await next();
    const header = c.res.status === 402 ? c.res.headers.get("payment-required") : null;
    if (!header) return;
    const headers = new Headers(c.res.headers);
    headers.set("payment-required", withInamExtension(header, did));
    c.res = new Response(c.res.body, { status: 402, headers });
  };
}
