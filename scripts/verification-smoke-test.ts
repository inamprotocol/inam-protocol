import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { buildSignableContent } from "../sdk-js/src/core/receiptContent.js";
import { buildSignableVerificationContent } from "../sdk-js/src/core/verificationContent.js";
import type { Keypair } from "../sdk-js/src/crypto/keys.js";

/** Exercises /v1/verifications over real HTTP — routing, zod validation,
 * signed-request middleware, and idempotency, for the part of the
 * Verification resource (SPEC.md §12) the unit tests only reach through the
 * service layer directly. Runnable against either backend (INAM_URL), so the
 * exact same script proves Node/Worker behavioral parity, same as
 * worker-smoke-test.ts / job-smoke-test.ts / link-challenge-smoke-test.ts. */
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
  return call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}:${Date.now()}`, body: { capabilities } });
}

async function finalizeReceipt(requester: Keypair, provider: Keypair) {
  const now = new Date().toISOString();
  const input = {
    jobId: `job_verify_smoke_${Date.now()}`,
    task: { capability: "x", specHash: "sha256:spec_smoke", createdAt: now },
    result: { outputHash: "sha256:out_smoke", completedAt: now },
    verification: { method: "payer_confirmation" as const, outcome: "success" as const },
  };
  const content = buildSignableContent(requester.did, provider.did, input);
  const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
  const draftRes = await call("POST", "/v1/receipts", {
    keypair: provider,
    idempotencyKey: `receipt:${input.jobId}`,
    body: { ...input, agentAId: requester.did, signature: draftSig },
  });
  const receipt = draftRes.json as { receiptId: string };

  const counterContent = { ...content, dispute: undefined, receiptId: receipt.receiptId };
  const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), requester.privateKey));
  const finalizeRes = await call("POST", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/countersign`, {
    keypair: requester,
    idempotencyKey: `countersign:${receipt.receiptId}`,
    body: { signature: counterSig },
  });
  return finalizeRes.json as { receiptId: string; jobId: string; agentB: { id: string }; result: { outputHash: string } };
}

async function main() {
  const requester = generateKeypair();
  const provider = generateKeypair();
  const verifier = generateKeypair();
  await register(requester, ["job.posting"]);
  await register(provider, ["x"]);
  await register(verifier, ["verification"]);

  const receipt = await finalizeReceipt(requester, provider);
  check("receipt finalized before verifying", !!receipt.receiptId);

  const input = {
    receiptId: receipt.receiptId,
    jobId: receipt.jobId,
    provider: provider.did,
    verifier: verifier.did,
    method: "deterministic" as const,
    outputHash: receipt.result.outputHash,
    result: "verified" as const,
  };
  const content = buildSignableVerificationContent(input);
  const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), verifier.privateKey));

  const submitRes = await call("POST", "/v1/verifications", {
    keypair: verifier,
    idempotencyKey: `verification:${content.verificationId}`,
    body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
  });
  check("verification submitted -> 201", submitRes.status === 201 && (submitRes.json as { result: string }).result === "verified");
  const verificationId = (submitRes.json as { verificationId: string }).verificationId;

  const getRes = await call("GET", `/v1/verifications/${encodeURIComponent(verificationId)}`);
  check("verification fetchable by id", getRes.status === 200 && (getRes.json as { verificationId: string }).verificationId === verificationId);

  const listRes = await call("GET", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/verifications`);
  check(
    "verification listed under its receipt",
    listRes.status === 200 && (listRes.json as { verifications: { verificationId: string }[] }).verifications.some((v) => v.verificationId === verificationId),
  );

  const selfVerifyRes = await call("POST", "/v1/verifications", {
    keypair: provider,
    idempotencyKey: `verification-self:${Date.now()}`,
    body: { receiptId: receipt.receiptId, verifier: provider.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified", signature: "irrelevant-rejected-before-sig-check" },
  });
  check("provider verifying own work -> 400 SELF_VERIFICATION", selfVerifyRes.status === 400 && (selfVerifyRes.json as { error: { code: string } }).error.code === "SELF_VERIFICATION");

  const dupRes = await call("POST", "/v1/verifications", {
    keypair: verifier,
    idempotencyKey: `verification-dup:${Date.now()}`,
    body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
  });
  check("resubmitting identical content -> 409 DUPLICATE_VERIFICATION", dupRes.status === 409 && (dupRes.json as { error: { code: string } }).error.code === "DUPLICATE_VERIFICATION");

  console.log(failures === 0 ? "\nAll verification HTTP smoke checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
});
