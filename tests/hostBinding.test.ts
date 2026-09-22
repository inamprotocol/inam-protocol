import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, sign, toBase64, sha256Hex } from "../sdk-js/src/crypto/keys.js";
import { buildSigningStringV1, buildSigningStringV2 } from "../sdk-js/src/core/signingString.js";
import { InamClient } from "../sdk-js/src/client.js";

// Round-2 sub-finding-7: the v1 signing string had no host component, so a
// signature minted for one hostname verified equally against any other host
// serving the same code. v2 adds the host; the server always verifies
// against its OWN actual incoming Host header, never a client-supplied one.

let server: Server;
let port: number;
let baseUrl: string;
let host: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer().listen(0, resolve);
  });
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  host = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Node's global fetch (undici) refuses to let a caller set the `Host`
 *  header (it's on the Fetch spec's forbidden-header list) -- exactly the
 *  header this test needs to control to simulate "this signed request
 *  arrives at a different host". node:http has no such restriction. */
function rawRequest(reqHost: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, host: reqHost, "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : undefined }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("host-binding signing string (v1/v2)", () => {
  it("still accepts a legacy v1 request (no inam-sig-version header)", async () => {
    const kp = generateKeypair();
    const body = JSON.stringify({ capabilities: ["x"] });
    const timestamp = Date.now().toString();
    const signingString = buildSigningStringV1("POST", "/v1/agents", timestamp, sha256Hex(body));
    const signature = toBase64(sign(new TextEncoder().encode(signingString), kp.privateKey));

    const res = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "inam-agent": kp.did,
        "inam-timestamp": timestamp,
        "inam-signature": signature,
        "idempotency-key": `reg:${kp.did}`,
      },
      body,
    });
    expect(res.status).toBe(201);
  });

  it("accepts a v2 request via InamClient (host derived from baseUrl matches the real Host header)", async () => {
    const kp = generateKeypair();
    const client = new InamClient(baseUrl, kp);
    const record = await client.registerAgent(["x"]);
    expect(record.id).toBe(kp.did);
  });

  it("rejects an unsupported inam-sig-version value", async () => {
    const kp = generateKeypair();
    const body = JSON.stringify({ capabilities: ["x"] });
    const timestamp = Date.now().toString();
    const signingString = buildSigningStringV1("POST", "/v1/agents", timestamp, sha256Hex(body));
    const signature = toBase64(sign(new TextEncoder().encode(signingString), kp.privateKey));

    const res = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "inam-agent": kp.did,
        "inam-timestamp": timestamp,
        "inam-signature": signature,
        "inam-sig-version": "99",
        "idempotency-key": `reg:${kp.did}`,
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNSUPPORTED_SIG_VERSION");
  });

  it("rejects a v2-signed request replayed against a different Host header, even though the signature bytes are valid for the request it was minted for", async () => {
    const kp = generateKeypair();
    const body = JSON.stringify({ capabilities: ["x"] });
    const timestamp = Date.now().toString();
    // Signed for THIS server's real host...
    const signingString = buildSigningStringV2("POST", "/v1/agents", host, timestamp, sha256Hex(body));
    const signature = toBase64(sign(new TextEncoder().encode(signingString), kp.privateKey));
    const headers = {
      "content-type": "application/json",
      "inam-agent": kp.did,
      "inam-timestamp": timestamp,
      "inam-signature": signature,
      "inam-sig-version": "2",
      "idempotency-key": `reg:${kp.did}`,
    };

    // ...replayed with the exact same signature bytes, but a different Host
    // header on the wire (simulating replay against another deployment of
    // this same code, or the Worker's *.workers.dev vs custom-domain pair).
    const replay = await rawRequest("evil.example.com", "/v1/agents", headers, body);
    expect(replay.status).toBe(401);
    expect((replay.json as { error: { code: string } }).error.code).toBe("INVALID_SIGNATURE");

    // Sanity check: the exact same signature IS valid against the host it
    // was actually signed for.
    const real = await rawRequest(host, "/v1/agents", headers, body);
    expect(real.status).toBe(201);
  });
});
