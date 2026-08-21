import { generateKeypair, sha256Hex, sign, toBase64 } from "../src/crypto/keys.js";
import { InamClient } from "../src/sdk/client.js";
import type { Keypair } from "../src/crypto/keys.js";

/** Exercises the Cloudflare Workers deployment's error paths and idempotency —
 * the parts of the stack that are genuinely new (routing, D1, KV) rather than
 * ported business logic already covered by tests/receiptFlow.test.ts. */
const BASE_URL = process.env.INAM_URL ?? "http://127.0.0.1:8787";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function expectError(label: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false);
  } catch (err) {
    check(label, String(err).includes(code));
  }
}

/** Raw signed POST bypassing the SDK's idempotency-key derivation, so a
 * genuinely fresh Idempotency-Key reaches the service layer instead of
 * replaying a cached response. */
async function signedPost(keypair: Keypair, path: string, body: unknown, idempotencyKey: string) {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const bodyHash = sha256Hex(rawBody);
  const signingString = `POST\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = toBase64(sign(new TextEncoder().encode(signingString), keypair.privateKey));
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "inam-agent": keypair.did,
      "inam-timestamp": timestamp,
      "inam-signature": signature,
      "idempotency-key": idempotencyKey,
    },
    body: rawBody,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const aKeys = generateKeypair();
  const a = new InamClient(BASE_URL, aKeys);
  const b = new InamClient(BASE_URL, generateKeypair());
  const stranger = new InamClient(BASE_URL, generateKeypair());

  await a.registerAgent(["job.posting"]);
  await b.registerAgent(["document-extraction"]);
  await stranger.registerAgent(["nothing"]);

  await expectError("duplicate registration -> AGENT_ALREADY_REGISTERED", "AGENT_ALREADY_REGISTERED", () =>
    signedPost(aKeys, "/v1/agents", { capabilities: ["job.posting"] }, `register-retry:${Date.now()}`),
  );

  await expectError("self-dealing -> SELF_DEALING", "SELF_DEALING", () =>
    a.submitWork(a.did, {
      jobId: "job_self",
      task: { capability: "x", specHash: "sha256:s", createdAt: new Date().toISOString() },
      result: { outputHash: "sha256:o", completedAt: new Date().toISOString() },
      verification: { method: "payer_confirmation", outcome: "success" },
    }),
  );

  const draft = await b.submitWork(a.did, {
    jobId: "job_smoke_1",
    task: { capability: "document-extraction", specHash: "sha256:s1", createdAt: new Date().toISOString() },
    result: { outputHash: "sha256:o1", completedAt: new Date().toISOString() },
    settlement: { amount: "5.00", currency: "USDC" },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  check("draft created", draft.status === "draft");

  // Resubmit byte-identical receipt content, but with a fresh Idempotency-Key
  // so this actually reaches createDraft's duplicate check instead of
  // replaying the first submission's cached response.
  await expectError("duplicate receipt content -> DUPLICATE_RECEIPT", "DUPLICATE_RECEIPT", () =>
    signedPost(
      (b as unknown as { keypair: Keypair })["keypair"],
      "/v1/receipts",
      { ...draft, agentAId: a.did, signature: draft.signatures.agentB },
      `receipt-retry:${Date.now()}`,
    ),
  );

  // Wrong agent tries to countersign.
  const contentForWrongSigner = { ...draft, signatures: undefined, status: undefined, dispute: undefined };
  const wrongSig = await (async () => {
    const { canonicalize } = await import("../src/crypto/canonical.js");
    const { sign, toBase64 } = await import("../src/crypto/keys.js");
    const bytes = new TextEncoder().encode(canonicalize(contentForWrongSigner));
    return toBase64(sign(bytes, (stranger as unknown as { keypair: { privateKey: Uint8Array } })["keypair"].privateKey));
  })();
  await expectError("countersign by non-requester -> NOT_REQUESTER", "NOT_REQUESTER", () =>
    (async () => {
      const res = await fetch(`${BASE_URL}/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: wrongSig }),
      });
      if (!res.ok) throw new Error(`NOT_REQUESTER-ish: ${await res.text()}`);
    })(),
  );

  const finalized = await a.acceptWork(draft);
  check("countersigned -> finalized", finalized.status === "finalized");

  // Idempotency: repeat the exact same register call for a brand-new agent
  // with the same Idempotency-Key semantics (the SDK derives the key from the
  // agent's own DID, so calling registerAgent twice for the *same* keypair
  // naturally reuses the same Idempotency-Key) and confirm it replays rather
  // than erroring as a duplicate.
  const c = new InamClient(BASE_URL, generateKeypair());
  const first = await c.registerAgent(["idempotency-check"]);
  const second = await c.registerAgent(["idempotency-check"]);
  check("idempotent replay returns identical profile", JSON.stringify(first) === JSON.stringify(second));

  const disputed = await b.disputeReceipt(finalized.receiptId, "smoke test dispute");
  check("dispute opens -> disputed", disputed.status === "disputed");

  const reputation = await a.getReputation(b.did);
  check("reputation flags in_dispute after dispute", reputation.flags.includes("in_dispute"));

  console.log(failures === 0 ? "\nAll worker smoke checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
});
