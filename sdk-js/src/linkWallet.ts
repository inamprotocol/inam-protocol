import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { InamClient } from "./client.js";
import { fromHex, toBase64 } from "./crypto/keys.js";
import { ethAddressFromUncompressedPublicKey, ethPersonalSignDigest } from "./crypto/secp256k1.js";

/** `inam link-wallet`: a seller proves control of its payTo wallet from a browser wallet, no key export.
 * The registry needs the wallet's public key *before* it issues a challenge, and `personal_sign` only
 * reveals an address, so the page signs twice: an intro message (public key recovered from it), then the challenge. */

export const introMessage = (did: string) => `INAM: link this wallet to ${did}`;

/** Recovers the uncompressed public key from a 65-byte wallet signature (r||s||v) over a personal_sign message. */
export function recoverWalletKey(message: string, signatureHex: string): Uint8Array {
  const sig = fromHex(signatureHex.replace(/^0x/, ""));
  if (sig.length !== 65) throw new Error("expected a 65-byte wallet signature");
  const recovered = Uint8Array.of(sig[64] >= 27 ? sig[64] - 27 : sig[64], ...sig.slice(0, 64));
  const compressed = secp256k1.recoverPublicKey(recovered, ethPersonalSignDigest(new TextEncoder().encode(message)), { prehash: false });
  return secp256k1.Point.fromBytes(compressed).toBytes(false);
}

/** Serves a one-time localhost page (random path token), resolves with the linked wallet address, then shuts down. */
export function linkWallet(inam: InamClient, onReady: (url: string) => void): Promise<string> {
  const token = randomBytes(16).toString("hex");
  const intro = introMessage(inam.did);
  let pending: { challengeId: string; address: string } | null = null;
  let server: Server;
  const reply = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        if (req.url === `/${token}` && req.method === "GET") return reply(res, 200, PAGE.replaceAll("__TOKEN__", token).replace("__INTRO__", JSON.stringify(intro)), "text/html");
        if (req.method !== "POST" || !req.url?.startsWith(`/${token}/`)) return reply(res, 404, {});
        let raw = "";
        for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        if (req.url === `/${token}/challenge`) {
          const pubkey = recoverWalletKey(intro, String(body.signature));
          const address = ethAddressFromUncompressedPublicKey(pubkey);
          if (address !== String(body.address).toLowerCase()) throw new Error("signature does not match the connected account");
          const ch = await inam.requestLinkChallenge("erc8004_id", toBase64(pubkey), "secp256k1");
          pending = { challengeId: ch.challengeId, address };
          return reply(res, 200, { challenge: ch.challenge });
        }
        if (req.url === `/${token}/complete` && pending) {
          const sig = fromHex(String(body.signature).replace(/^0x/, ""));
          await inam.completeLink("erc8004_id", pending.address, pending.challengeId, toBase64(sig.slice(0, 64)));
          reply(res, 200, { linked: pending.address });
          server.close();
          return resolve(pending.address);
        }
        reply(res, 404, {});
      } catch (e) {
        reply(res, 400, { error: (e as Error).message });
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => onReady(`http://127.0.0.1:${(server.address() as { port: number }).port}/${token}`));
  });
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>INAM link-wallet</title>
<body style="font:15px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem">
<h3>Prove you control your payTo wallet</h3>
<p>Two signatures, no transaction, no gas. Select the wallet account that is your x402 <code>payTo</code>.</p>
<button id="go">Connect wallet and sign</button>
<pre id="out" style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:.5rem"></pre>
<script>
const out = document.getElementById("out");
const post = async (p, b) => {
  const r = await fetch("/__TOKEN__/" + p, { method: "POST", body: JSON.stringify(b) }), j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
};
document.getElementById("go").onclick = async () => {
  try {
    if (!window.ethereum) throw new Error("no browser wallet found (window.ethereum)");
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const hex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
    out.textContent = "Signature 1 of 2: confirm in your wallet...";
    const signature = await window.ethereum.request({ method: "personal_sign", params: [hex(__INTRO__), address] });
    const { challenge } = await post("challenge", { address, signature });
    out.textContent = "Signature 2 of 2: confirm in your wallet...";
    const proof = await window.ethereum.request({ method: "personal_sign", params: ["0x" + challenge, address] });
    const done = await post("complete", { signature: proof });
    out.textContent = "Linked " + done.linked + ". You can close this tab; see your terminal.";
  } catch (e) { out.textContent = "FAILED: " + (e.message || JSON.stringify(e)); }
};
</script>`;
