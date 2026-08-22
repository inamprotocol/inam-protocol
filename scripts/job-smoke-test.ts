import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { buildSignableContent } from "../sdk-js/src/core/receiptContent.js";
import type { Keypair } from "../sdk-js/src/crypto/keys.js";

/** Exercises the new /v1/jobs endpoints over real HTTP — routing, zod
 * validation, signed-request middleware, and idempotency for a resource
 * type the unit tests only reach through the service layer directly. */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function call(method: string, path: string, opts?: { body?: unknown; keypair?: Keypair; idempotencyKey?: string }) {
  const rawBody = opts?.body !== undefined ? JSON.stringify(opts.body) : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.keypair) {
    const timestamp = Date.now().toString();
    const bodyHash = sha256Hex(rawBody);
    const signingString = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
    const signature = toBase64(sign(new TextEncoder().encode(signingString), opts.keypair.privateKey));
    headers["inam-agent"] = opts.keypair.did;
    headers["inam-timestamp"] = timestamp;
    headers["inam-signature"] = signature;
  }
  if (opts?.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: opts?.body !== undefined ? rawBody : undefined });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

async function register(kp: Keypair, capabilities: string[]) {
  return call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}`, body: { capabilities } });
}

async function main() {
  const poster = generateKeypair();
  const worker = generateKeypair();
  await register(poster, ["job.posting"]);
  await register(worker, ["translation.tr-en"]);

  const postRes = await call("POST", "/v1/jobs", {
    keypair: poster,
    idempotencyKey: `job:${Date.now()}`,
    body: { capability: "translation.tr-en", specHash: "sha256:spec_http" },
  });
  check("job posted -> 201, status open", postRes.status === 201 && (postRes.json as { status: string }).status === "open");
  const jobId = (postRes.json as { jobId: string }).jobId;

  const searchRes = await call("GET", `/v1/jobs/search?capability=translation.tr-en&status=open`);
  check("job discoverable via search", (searchRes.json as { jobs: { jobId: string }[] }).jobs.some((j) => j.jobId === jobId));

  const offerRes = await call("POST", `/v1/jobs/${jobId}/offers`, {
    keypair: worker,
    idempotencyKey: `offer:${Date.now()}`,
    body: { message: "I can do this" },
  });
  check("offer submitted -> 201", offerRes.status === 201);

  const selfOfferRes = await call("POST", `/v1/jobs/${jobId}/offers`, {
    keypair: poster,
    idempotencyKey: `offer-self:${Date.now()}`,
    body: {},
  });
  check("poster offering on own job -> 400 SELF_DEALING", selfOfferRes.status === 400 && (selfOfferRes.json as { error: { code: string } }).error.code === "SELF_DEALING");

  const acceptRes = await call("POST", `/v1/jobs/${jobId}/accept`, {
    keypair: poster,
    idempotencyKey: `accept:${Date.now()}`,
    body: { agentId: worker.did },
  });
  check("offer accepted -> status accepted", acceptRes.status === 200 && (acceptRes.json as { status: string }).status === "accepted");

  const now = new Date().toISOString();
  const receiptInput = {
    jobId,
    task: { capability: "translation.tr-en", specHash: "sha256:spec_http", createdAt: now },
    result: { outputHash: "sha256:out_http", completedAt: now },
    verification: { method: "payer_confirmation" as const, outcome: "success" as const },
  };
  const content = buildSignableContent(poster.did, worker.did, receiptInput);
  const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker.privateKey));
  const draftRes = await call("POST", "/v1/receipts", {
    keypair: worker,
    idempotencyKey: `receipt:${jobId}`,
    body: { ...receiptInput, agentAId: poster.did, signature: draftSig },
  });
  check("receipt draft against accepted job -> 201", draftRes.status === 201);
  const receipt = draftRes.json as { receiptId: string };

  const counterContent = { ...content, dispute: undefined, receiptId: receipt.receiptId };
  const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), poster.privateKey));
  const finalizeRes = await call("POST", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/countersign`, {
    keypair: poster,
    idempotencyKey: `countersign:${receipt.receiptId}`,
    body: { signature: counterSig },
  });
  check("receipt finalized", finalizeRes.status === 200 && (finalizeRes.json as { status: string }).status === "finalized");

  const jobAfter = await call("GET", `/v1/jobs/${jobId}`);
  check(
    "job auto-completed by the finalized receipt",
    (jobAfter.json as { status: string; receiptId?: string }).status === "completed" &&
      (jobAfter.json as { receiptId?: string }).receiptId === receipt.receiptId,
  );

  console.log(failures === 0 ? "\nAll job HTTP smoke checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
});
