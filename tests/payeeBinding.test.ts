import { describe, expect, it } from "vitest";
import { payeeBindingItem, verifyPayeeBinding, type PayeeBinding } from "../sdk-js/src/payeeBinding.js";
import type { PaymentOption } from "../sdk-js/src/check.js";

// Synthetic vector posted by imokokok in agentic-commerce-protocol discussion #317 (2026-11-21); its key was discarded.
const VECTOR: PayeeBinding = {
  domain: { name: "INAM Payee Binding", version: "1", chainId: 8453 },
  primaryType: "PayeeBinding",
  message: { serverName: "io.github.example/my-server", wallet: "0x9B4cc3395981cCF6aC3035BE6999F40860Df5206", walletChainId: 8453, repository: "", issuedAt: 1795281902, sequence: 1 },
  signature: "0xc696f75d321bb2dfe8cf5eb7fd2e0187619d0d0046039bdb55f59ce1792dcb496df85dc94781e47b3f74a49bb6e9fc332054c45b0b63757c460958e5508c60211c",
};
const NAME = VECTOR.message.serverName;
const pays = (payTo: string, chainId = 8453) => [{ payTo, chainId, network: `eip155:${chainId}` } as PaymentOption];
const registry = (server: object | null) => (async () => new Response(JSON.stringify({ servers: server ? [{ server }] : [] }))) as unknown as typeof fetch;
const entry = (b: PayeeBinding) => ({ name: NAME, version: "1.0.2", _meta: { "io.modelcontextprotocol.registry/publisher-provided": { payeeBinding: b } } });
const item = (server: object | null, accepts: PaymentOption[]) => payeeBindingItem(NAME, accepts, { fetch: registry(server) });

describe("payee binding", () => {
  it("the published vector recovers to its wallet", () => {
    expect(verifyPayeeBinding(VECTOR)).toEqual({ ok: true });
  });

  it("any changed member breaks the signature", () => {
    for (const message of [
      { ...VECTOR.message, serverName: "io.github.example/other" },
      { ...VECTOR.message, wallet: "0x1111111111111111111111111111111111111111" },
      { ...VECTOR.message, sequence: 2 },
      { ...VECTOR.message, repository: "https://github.com/example/my-server" },
    ])
      expect(verifyPayeeBinding({ ...VECTOR, message }).ok).toBe(false);
    expect(verifyPayeeBinding({ ...VECTOR, domain: { ...VECTOR.domain, chainId: 1 } }).ok).toBe(false);
    expect(verifyPayeeBinding({ ...VECTOR, domain: { ...VECTOR.domain, name: "Other" } }).ok).toBe(false);
    expect(verifyPayeeBinding({} as PayeeBinding).ok).toBe(false);
  });

  it("pass only when the bound wallet and chain are what the 402 asks to pay", async () => {
    expect((await item(entry(VECTOR), pays(VECTOR.message.wallet.toLowerCase()))).status).toBe("pass");
    expect((await item(entry(VECTOR), pays("0x1111111111111111111111111111111111111111"))).status).toBe("fail");
    expect((await item(entry(VECTOR), pays(VECTOR.message.wallet, 84532))).status).toBe("fail");
  });

  it("never passes without a verified binding from the registry", async () => {
    expect((await item({ name: NAME, version: "1.0.2" }, pays(VECTOR.message.wallet))).status).toBe("info");
    expect((await item(null, pays(VECTOR.message.wallet))).status).toBe("warn");
    expect((await item(entry({ ...VECTOR, message: { ...VECTOR.message, sequence: 2 } }), pays(VECTOR.message.wallet))).status).toBe("warn");
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect((await payeeBindingItem(NAME, pays(VECTOR.message.wallet), { fetch: down })).status).toBe("warn");
    // a registry entry for another name that carries this binding is not found under the asked name
    expect((await payeeBindingItem("io.github.attacker/copy", pays(VECTOR.message.wallet), { fetch: registry({ ...entry(VECTOR), name: "io.github.attacker/copy" }) })).status).toBe("fail");
  });
});
