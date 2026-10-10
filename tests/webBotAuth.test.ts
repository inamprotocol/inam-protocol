import { describe, expect, it } from "vitest";
import { InamClient } from "../sdk-js/src/client.js";
import { keypairFromPrivateKey, verifyRawEd25519 } from "../sdk-js/src/crypto/keys.js";
import { inamFetch } from "../sdk-js/src/http.js";
import { httpMessageSignaturesDirectory, jwkThumbprint, webBotAuthHeaders } from "../sdk-js/src/webBotAuth.js";

// RFC 9421 Appendix B.1.4 test-key-ed25519.
const key = keypairFromPrivateKey(new Uint8Array(Buffer.from("n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU", "base64url")));

describe("Web Bot Auth", () => {
  it("matches draft-meunier-web-bot-auth-architecture-05 A.2.3 (sf-string Signature-Agent, Cloudflare's form)", () => {
    expect(jwkThumbprint(key.publicKey)).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
    const h = webBotAuthHeaders("https://example.com/", key.privateKey, {
      signatureAgent: "https://signature-agent.test",
      created: 1735689600,
      expiresIn: 3600,
      nonce: "e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==",
      label: "sig2",
    });
    expect(h["Signature-Agent"]).toBe('"https://signature-agent.test"');
    expect(h["Signature-Input"]).toBe(
      'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U"' +
        ';alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=="' +
        ';tag="web-bot-auth"',
    );
    expect(h.Signature).toBe("sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:");
  });

  it("directory JWKS carries only kty/crv/x", () => {
    expect(httpMessageSignaturesDirectory([key.did])).toEqual({
      keys: [{ kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" }],
    });
  });

  it("rejects a non-https signatureAgent", () => {
    expect(() => webBotAuthHeaders("https://example.com/", key.privateKey, { signatureAgent: "http://x.test" })).toThrow();
  });

  it("inamFetch signs only when opted in, and the signature verifies", async () => {
    const client = new InamClient("https://registry.invalid", key);
    const seen: Request[] = [];
    const base = (async (req: Request) => (seen.push(req), new Response("ok"))) as typeof fetch;

    await inamFetch(client, { fetch: base }).fetch("https://Origin.Example:443/a?b=1");
    expect(seen[0].headers.get("signature")).toBeNull();

    await inamFetch(client, { fetch: base, webBotAuth: { signatureAgent: "https://agent.example" } }).fetch("https://Origin.Example:443/a?b=1");
    const h = seen[1].headers;
    const params = h.get("signature-input")!.replace(/^sig1=/, "");
    const base64 = h.get("signature")!.match(/^sig1=:(.+):$/)![1];
    const sigBase = `"@authority": origin.example\n"signature-agent": "https://agent.example"\n"@signature-params": ${params}`;
    expect(verifyRawEd25519(new Uint8Array(Buffer.from(base64, "base64")), new TextEncoder().encode(sigBase), key.publicKey)).toBe(true);
    expect(params).toMatch(/;tag="web-bot-auth"$/);

    const dir = client.webBotAuthDirectory("agent.example");
    expect(dir.headers["Content-Type"]).toBe("application/http-message-signatures-directory+json");
    expect(dir.headers["Signature-Input"]).toMatch(/^sig1=\("@authority";req\);.*;tag="http-message-signatures-directory"$/);
  });
});
