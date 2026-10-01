import { describe, it, expect } from "vitest";
import { verifyA2ACard, inamA2AExtension, INAM_A2A_EXTENSION_URI } from "../sdk-js/src/a2a.js";
import type { InamClient } from "../sdk-js/src/client.js";

// SPEC.md §11.3: an Agent Card and an INAM ID must name each other.
const DID = "did:key:z6MkagentEXAMPLE";
const EP = "https://agent.example/a2a";

function registry(opts: { endpoint?: string; evidenceLevel?: string; revokedAt?: string; missing?: boolean } = {}) {
  const fail = () => Promise.reject(new Error("404"));
  return {
    getAgent: opts.missing ? fail : async () => ({ id: DID, linked: { a2a_endpoint: opts.endpoint ?? EP }, revokedAt: opts.revokedAt }),
    getReputation: opts.missing ? fail : async () => ({ trustScore: 30, evidenceLevel: opts.evidenceLevel ?? "countersigned" }),
  } as unknown as InamClient;
}
const v1Card = (url = EP, ext: object[] = [inamA2AExtension(DID)]) => ({ name: "a", supportedInterfaces: [{ url, protocolBinding: "JSONRPC" }], capabilities: { extensions: ext } });

describe("A2A Agent Card extension (SPEC.md §11.3)", () => {
  it("is data-only, never required", () => {
    expect(inamA2AExtension(DID)).toMatchObject({ uri: INAM_A2A_EXTENSION_URI, required: false, params: { did: DID } });
  });

  it("accepts a v1.0 card whose endpoint the ID linked (trailing slash ignored)", async () => {
    const d = await verifyA2ACard(v1Card(EP + "/"), registry());
    expect(d).toMatchObject({ allow: true, did: DID });
  });

  it("accepts a v0.3 card (top-level url)", async () => {
    expect((await verifyA2ACard({ url: EP, capabilities: { extensions: [inamA2AExtension(DID)] } }, registry())).allow).toBe(true);
  });

  it("rejects a card that borrows an ID linked to another endpoint", async () => {
    expect((await verifyA2ACard(v1Card("https://impostor.example/a2a"), registry())).reason).toMatch(/no endpoint on this card/);
  });

  it("rejects missing extension, unknown or revoked ID, and weak evidence", async () => {
    expect((await verifyA2ACard(v1Card(EP, []), registry())).reason).toMatch(/names no INAM ID/);
    expect((await verifyA2ACard(v1Card(), registry({ missing: true }))).reason).toMatch(/not found/);
    expect((await verifyA2ACard(v1Card(), registry({ revokedAt: "2026-10-01T00:00:00Z" }))).reason).toMatch(/revoked/);
    expect((await verifyA2ACard(v1Card(), registry({ evidenceLevel: "none" }))).reason).toMatch(/evidence none/);
  });
});
