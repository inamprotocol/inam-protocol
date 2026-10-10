import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTarget, formatReport, paymentOptions, registrableDomain } from "../sdk-js/src/check.js";
import { keypairFromPrivateKey } from "../sdk-js/src/crypto/keys.js";
import { directoryResponseHeaders, httpMessageSignaturesDirectory, verifyDirectoryResponse } from "../sdk-js/src/webBotAuth.js";

const PAYTO = "0x1111111111111111111111111111111111111111";
const DID = "did:key:z6MkpayeeEXAMPLE";
const REG = "https://registry.test";
const key = keypairFromPrivateKey(new Uint8Array(Buffer.from("n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU", "base64url")));

const word = (n: number) => n.toString(16).padStart(64, "0");
const rpcResult = (hex: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${hex}` }));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface World {
  extensions?: object;
  linked?: string; // wallet the INAM agent proved
  erc8004Owned?: number;
  feedback?: { clients: string[]; total: number; receiptBacked: number };
  status?: number;
  directory?: boolean;
}

function stub(w: World) {
  const required = {
    x402Version: 2,
    resource: { url: "https://seller.example/api", description: "weather" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYTO, extra: { name: "USDC" } }],
    ...(w.extensions ? { extensions: w.extensions } : {}),
  };
  const agent = { id: DID, linked: w.linked ? { erc8004_id: w.linked } : {}, createdAt: "2026-01-01T00:00:00Z", metadata: {}, capabilities: [] };
  const reputation = { trustScore: 40, evidenceLevel: "countersigned", components: { finalizedReceipts: 3, attestedReceipts: 0 }, flags: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://seller.example/api") return new Response("{}", { status: w.status ?? 402, headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
    if (url.endsWith("/.well-known/http-message-signatures-directory")) {
      if (!w.directory) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(httpMessageSignaturesDirectory([key.publicKey])), { headers: directoryResponseHeaders("seller.example", key.privateKey) });
    }
    if (url.startsWith("https://rdap.org/domain/seller.example")) return json({ events: [{ eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" }] });
    if (url.startsWith(`${REG}/v1/agents/search`)) return json({ agents: w.linked ? [agent] : [], hasMore: false });
    if (url === `${REG}/v1/agents/${encodeURIComponent(DID)}`) return json(agent);
    if (url === `${REG}/v1/agents/${encodeURIComponent(DID)}/reputation`) return json(reputation);
    if (url.startsWith("https://api.8004scan.io/api/v1/agents")) {
      const items = w.erc8004Owned ? [{ chain_id: 8453, token_id: 7, owner_address: PAYTO, name: "Seller", total_feedbacks: w.feedback?.total ?? 0, is_testnet: false }] : [];
      return json({ items });
    }
    if (url === "https://mainnet.base.org") {
      const data: string = JSON.parse(String(init?.body)).params[0].data;
      if (data.startsWith("0x70a08231")) return rpcResult(word(w.erc8004Owned ?? 0)); // balanceOf
      if (data.startsWith("0x42dd519c")) {
        const c = w.feedback?.clients ?? [];
        return rpcResult(word(32) + word(c.length) + c.map((a) => a.slice(2).padStart(64, "0")).join("")); // getClients
      }
      if (data.startsWith("0x81bbba58")) {
        const tagged = data.includes(Buffer.from("inam-receipt").toString("hex"));
        return rpcResult(word(tagged ? (w.feedback?.receiptBacked ?? 0) : (w.feedback?.total ?? 0)) + word(0) + word(0)); // getSummary
      }
    }
    return new Response("unexpected", { status: 599 });
  });
}

const run = (target: string) => checkTarget(target, { registryUrl: REG });
const status = (r: Awaited<ReturnType<typeof run>>, id: string) => r.checks.filter((c) => c.id === id).map((c) => c.status);

afterEach(() => vi.unstubAllGlobals());

describe("inam check", () => {
  it("with no INAM data and no ERC-8004: reads the 402 and returns caution, not fail", async () => {
    stub({});
    const r = await run("https://seller.example/api");
    expect(r.verdict).toBe("caution");
    expect(r.payment?.accepts[0]).toMatchObject({ payTo: PAYTO, chainId: 8453, price: "0.01 USDC" });
    expect(r.payment?.description).toBe("weather");
    expect(status(r, "x402.response")).toEqual(["pass"]);
    expect(status(r, "erc8004.identity")).toEqual(["warn"]);
    expect(status(r, "inam.link")).toEqual(["warn"]);
    expect(status(r, "webbotauth.directory")).toEqual(["info"]);
    expect(status(r, "domain.age")).toEqual(["pass"]);
    expect(formatReport(r)).toMatch(/CAUTION[\s\S]*payTo\s+0x1111.*0\.01 USDC on Base/);
  });

  it("flags ERC-8004 feedback that no task receipt backs, and passes receipt-backed feedback", async () => {
    stub({ erc8004Owned: 1, feedback: { clients: ["0x2222222222222222222222222222222222222222"], total: 5, receiptBacked: 0 } });
    let r = await run(PAYTO);
    expect(status(r, "erc8004.identity")).toEqual(["pass"]);
    expect(r.checks.find((c) => c.id === "erc8004.feedback")).toMatchObject({ status: "warn", label: expect.stringMatching(/5, none tied/) });

    stub({ erc8004Owned: 1, feedback: { clients: ["0x2222222222222222222222222222222222222222"], total: 5, receiptBacked: 2 } });
    r = await run(PAYTO);
    expect(r.checks.find((c) => c.id === "erc8004.feedback")).toMatchObject({ status: "pass", label: expect.stringMatching(/2 backed/) });
  });

  it("fails when the 402 names an INAM ID whose proven wallet is not payTo (borrowed identity)", async () => {
    stub({ extensions: { inam: { info: { did: DID } } }, linked: "0x9999999999999999999999999999999999999999" });
    const r = await run("https://seller.example/api");
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.id === "inam.extension")?.label).toMatch(/payTo is not an address this INAM ID proved control of/);
  });

  it("passes the binding and reads receipts when payTo is the INAM ID's proven wallet", async () => {
    stub({ extensions: { inam: { info: { did: DID } } }, linked: PAYTO, directory: true });
    const r = await run("https://seller.example/api");
    expect(status(r, "inam.link")).toEqual(["pass"]);
    expect(status(r, "inam.extension")).toEqual(["pass"]);
    expect(r.checks.find((c) => c.id === "inam.reputation")?.label).toMatch(/countersigned, 3 countersigned receipts/);
    expect(status(r, "webbotauth.directory")).toEqual(["pass"]);
  });

  it("fails on a non-402 answer and on plain http", async () => {
    stub({ status: 200 });
    expect((await run("https://seller.example/api")).checks.find((c) => c.id === "x402.response")).toMatchObject({ status: "fail" });
    expect(status(await run("http://seller.example/api"), "tls")).toEqual(["fail"]);
  });

  it("checks a did: unknown is fail, known shows evidence and its wallet", async () => {
    stub({ linked: PAYTO });
    const r = await run(DID);
    expect(status(r, "inam.agent")).toEqual(["pass"]);
    expect(status(r, "inam.reputation")).toEqual(["warn"]); // countersigned only -> escrow
    expect(r.checks.some((c) => c.id === "erc8004.identity")).toBe(true);
    expect((await run("did:key:z6MkUnknown")).verdict).toBe("fail");
  });

  it("rejects an unrecognized target", () => {
    expect(() => checkTarget("seller.example")).toThrow(/unrecognized target/);
  });

  it("parses x402 v1 options and picks registrable domains", () => {
    expect(paymentOptions({ accepts: [{ network: "base-sepolia", maxAmountRequired: "500", payTo: PAYTO, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }] })[0]).toMatchObject({ chainId: 84532, testnet: true, price: "0.0005 USDC" });
    expect(registrableDomain("api.weather.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("x402.coinstats.app")).toBe("coinstats.app");
  });
});

describe("verifyDirectoryResponse", () => {
  const body = JSON.stringify(httpMessageSignaturesDirectory([key.publicKey]));
  it("accepts a directory signed by a key it lists, for the right authority", () => {
    const h = new Headers(directoryResponseHeaders("agent.example", key.privateKey));
    expect(verifyDirectoryResponse("agent.example", h, body)).toMatchObject({ valid: true, keys: 1 });
    expect(verifyDirectoryResponse("other.example", h, body)).toMatchObject({ valid: false, reason: "signature does not verify" });
  });
  it("rejects unsigned, expired, and foreign-key directories", () => {
    expect(verifyDirectoryResponse("agent.example", new Headers(), body).reason).toBe("response is not signed");
    const old = new Headers(directoryResponseHeaders("agent.example", key.privateKey, { created: 1000 }));
    expect(verifyDirectoryResponse("agent.example", old, body).reason).toBe("signature expired");
    const other = keypairFromPrivateKey(new Uint8Array(32).fill(7));
    const h = new Headers(directoryResponseHeaders("agent.example", other.privateKey));
    expect(verifyDirectoryResponse("agent.example", h, body).reason).toBe("keyid matches no listed key");
  });
});
