import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "../sdk-js/node_modules/@noble/curves/secp256k1.js";
import { inamSellerMiddleware, inamSellerHono, withInamExtension } from "../sdk-js/src/seller.js";
import { linkWallet, introMessage } from "../sdk-js/src/linkWallet.js";
import { ethPersonalSignDigest, generateSecp256k1Keypair, ethAddressFromUncompressedPublicKey, secp256k1Verify } from "../sdk-js/src/crypto/secp256k1.js";
import { fromBase64, toHex } from "../sdk-js/src/crypto/keys.js";
import type { InamClient } from "../sdk-js/src/client.js";

const DID = "did:key:z6MkSELLER";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64").toString());
const PR = b64({ x402Version: 2, accepts: [{ payTo: "0xabc" }], extensions: { other: { info: {} } } });

describe("seller middleware", () => {
  it("adds the inam extension and keeps existing ones", () => {
    const out = decode(withInamExtension(PR, DID));
    expect(out.extensions.inam.info.did).toBe(DID);
    expect(out.extensions.other).toBeDefined();
    expect(withInamExtension("not base64 json", DID)).toBe("not base64 json");
  });

  it("express: rewrites the payment-required header whenever it is set", () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (n: string, v: string) => void (headers[n] = v) };
    inamSellerMiddleware(DID)({}, res, () => {});
    res.setHeader("PAYMENT-REQUIRED", PR);
    res.setHeader("x-other", "1");
    expect(decode(headers["PAYMENT-REQUIRED"]).extensions.inam.info.did).toBe(DID);
    expect(headers["x-other"]).toBe("1");
  });

  it("hono: rewrites a 402 and leaves other responses alone", async () => {
    const c402 = { res: new Response(null, { status: 402, headers: { "payment-required": PR } }) };
    await inamSellerHono(DID)(c402, async () => {});
    expect(decode(c402.res.headers.get("payment-required")!).extensions.inam.info.did).toBe(DID);
    const ok = new Response("ok");
    const c200 = { res: ok };
    await inamSellerHono(DID)(c200, async () => {});
    expect(c200.res).toBe(ok);
  });
});

describe("link-wallet page flow", () => {
  it("recovers the wallet key from a personal_sign signature and completes the link", async () => {
    const wallet = generateSecp256k1Keypair();
    const address = ethAddressFromUncompressedPublicKey(wallet.publicKey);
    // What window.ethereum personal_sign returns: r||s||v over the prefixed message.
    const walletSign = (msg: Uint8Array) => {
      const rec = secp256k1.sign(ethPersonalSignDigest(msg), wallet.privateKey, { prehash: false, format: "recovered" });
      return "0x" + toHex(Uint8Array.of(...rec.slice(1), rec[0] + 27));
    };
    const challenge = "ab".repeat(32);
    let linked: string | undefined;
    const fake = {
      did: DID,
      requestLinkChallenge: async (_p: string, pub: string) => ((fake as any).pub = fromBase64(pub), { challengeId: "c1", challenge, expiresAt: "" }),
      completeLink: async (_p: string, value: string, id: string, proof: string) => {
        expect(secp256k1Verify(fromBase64(proof), Buffer.from(challenge, "hex"), (fake as any).pub)).toBe(true);
        linked = value;
      },
    } as unknown as InamClient;

    let url = "";
    const done = linkWallet(fake, (u) => (url = u));
    await new Promise((r) => setTimeout(r, 100));
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url.replace(/\/[0-9a-f]+$/, "/wrongtoken/challenge"), { method: "POST", body: "{}" })).status).toBe(404);
    const sig1 = walletSign(new TextEncoder().encode(introMessage(DID)));
    expect((await fetch(`${url}/challenge`, { method: "POST", body: JSON.stringify({ address: "0x" + "1".repeat(40), signature: sig1 }) })).status).toBe(400);
    const r1 = (await (await fetch(`${url}/challenge`, { method: "POST", body: JSON.stringify({ address, signature: sig1 }) })).json()) as { challenge: string };
    expect(r1).toEqual({ challenge });
    const sig2 = walletSign(Buffer.from(challenge, "hex"));
    await fetch(`${url}/complete`, { method: "POST", body: JSON.stringify({ signature: sig2 }) });
    expect(await done).toBe(address);
    expect(linked).toBe(address);
  });
});

describe("cli: link-wallet never starts on help or unknown flags", () => {
  const run = (...a: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../sdk-js/src/cli.ts", import.meta.url)), ...a], { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: "/nonexistent", USERPROFILE: "/nonexistent" } });
  it("--help prints usage and exits 0 without touching the key file", () => {
    const r = run("link-wallet", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: inam link-wallet");
  });
  it("an unknown flag exits 2", () => {
    const r = run("link-wallet", "--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unexpected argument");
  });
});
