import { canonicalize } from "./crypto/canonical.js";
import { sha256Hex, sign, toBase64, type Keypair } from "./crypto/keys.js";
import { buildSignableContent, type ReceiptContentInput } from "./core/receiptContent.js";
import { buildSignableVerificationContent, type VerificationContentInput } from "./core/verificationContent.js";
import type {
  AgentRecord,
  ExecutionReceipt,
  ExternalKeyType,
  JobOffer,
  JobRecord,
  LinkChallenge,
  ReputationResult,
  VerificationRecord,
} from "./types.js";

/**
 * Minimal reference client — the seed of the future `@inamprotocol/agent-sdk`
 * package. Everything here is transport plumbing plus the two signature
 * schemes (HTTP request signing, receipt content signing); an agent
 * framework's tool-calling layer would wrap these same calls as
 * `search_jobs` / `verify_agent` / `submit_work`-style tools.
 */
export class InamClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keypair: Keypair,
  ) {}

  get did(): string {
    return this.keypair.did;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T> {
    const rawBody = body !== undefined ? JSON.stringify(body) : "";
    const timestamp = Date.now().toString();
    const bodyHash = sha256Hex(rawBody);
    const signingString = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
    const signature = toBase64(sign(new TextEncoder().encode(signingString), this.keypair.privateKey));

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "inam-agent": this.keypair.did,
      "inam-timestamp": timestamp,
      "inam-signature": signature,
    };
    if (opts?.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? rawBody : undefined,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    }
    return json as T;
  }

  registerAgent(capabilities: string[], metadata?: Record<string, unknown>): Promise<AgentRecord> {
    return this.request("POST", "/v1/agents", { capabilities, metadata }, { idempotencyKey: `register:${this.keypair.did}` });
  }

  getAgent(id: string): Promise<AgentRecord> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}`);
  }

  /** Links `a2a_endpoint` — the one protocol that isn't a key-derived
   * identity, so there's nothing to prove control of beyond this request's
   * own INAM signature. For `agentpass_id` / `aitp_id` / `passport_id`, use
   * `requestLinkChallenge` + `completeLink` instead. */
  linkIdentity(protocol: string, value: string): Promise<AgentRecord> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(this.did)}/link`, { protocol, value }, {
      idempotencyKey: `link:${protocol}:${value}`,
    });
  }

  /** Step 1 of linking a key-derived external identity: request a single-use,
   * ~60s challenge that must be signed with the *external* private key
   * corresponding to `externalPublicKey` (not this INAM keypair). */
  requestLinkChallenge(protocol: string, externalPublicKey: string, keyType: ExternalKeyType): Promise<LinkChallenge> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(this.did)}/link/challenge`, { protocol, externalPublicKey, keyType }, {
      idempotencyKey: `link-challenge:${protocol}:${externalPublicKey}:${Date.now()}`,
    });
  }

  /** Step 2: submit the signed challenge to complete the link. `proofSignature`
   * must be a signature over the raw bytes of `challenge.challenge` (hex-decoded)
   * produced by the external private key, base64-encoded. */
  completeLink(protocol: string, value: string, challengeId: string, proofSignature: string): Promise<AgentRecord> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(this.did)}/link`, { protocol, value, challengeId, proofSignature }, {
      idempotencyKey: `link:${protocol}:${challengeId}`,
    });
  }

  searchAgents(query: { capability?: string; minReputation?: number; supports?: string }): Promise<{ agents: AgentRecord[] }> {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.minReputation !== undefined) params.set("min_reputation", String(query.minReputation));
    if (query.supports) params.set("supports", query.supports);
    return this.request("GET", `/v1/agents/search?${params.toString()}`);
  }

  getReputation(id: string): Promise<ReputationResult> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}/reputation`);
  }

  getReceipt(receiptId: string): Promise<ExecutionReceipt> {
    return this.request("GET", `/v1/receipts/${encodeURIComponent(receiptId)}`);
  }

  listReceipts(agentId: string): Promise<{ receipts: ExecutionReceipt[] }> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/receipts`);
  }

  /** Called by the worker (agent_b) once a job is complete, off-network. */
  async submitWork(agentAId: string, input: ReceiptContentInput): Promise<ExecutionReceipt> {
    // receiptId is content-addressed (hash of everything below), so the
    // client computes the exact same id the server will, and signs a payload
    // that already includes it — no round-trip needed before signing.
    const content = buildSignableContent(agentAId, this.did, input);
    const signingBytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
    const signature = toBase64(sign(signingBytes, this.keypair.privateKey));
    return this.request("POST", "/v1/receipts", { ...input, agentAId, signature }, { idempotencyKey: `receipt:${input.jobId}` });
  }

  /** Called by the requester (agent_a) to accept the worker's submitted result. */
  async acceptWork(receipt: ExecutionReceipt): Promise<ExecutionReceipt> {
    const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined };
    const signingBytes = new TextEncoder().encode(canonicalize(content));
    const signature = toBase64(sign(signingBytes, this.keypair.privateKey));
    return this.request("POST", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/countersign`, { signature }, {
      idempotencyKey: `countersign:${receipt.receiptId}`,
    });
  }

  disputeReceipt(receiptId: string, reason: string): Promise<ExecutionReceipt> {
    return this.request("POST", `/v1/receipts/${encodeURIComponent(receiptId)}/dispute`, { reason }, {
      idempotencyKey: `dispute:${receiptId}`,
    });
  }

  // ---- Jobs (SPEC.md §3) — optional pre-work discovery/offer/accept ----

  postJob(input: { capability: string; specHash: string; budget?: { amount?: string; currency?: string }; expiresAt?: string }): Promise<JobRecord> {
    return this.request("POST", "/v1/jobs", input, { idempotencyKey: `job:${input.capability}:${input.specHash}:${Date.now()}` });
  }

  getJob(id: string): Promise<JobRecord> {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }

  searchJobs(query: { capability?: string; status?: string }): Promise<{ jobs: JobRecord[] }> {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.status) params.set("status", query.status);
    return this.request("GET", `/v1/jobs/search?${params.toString()}`);
  }

  submitOffer(jobId: string, message?: string): Promise<JobRecord> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/offers`, { message }, {
      idempotencyKey: `offer:${jobId}:${this.did}`,
    });
  }

  listOffers(jobId: string): Promise<{ offers: JobOffer[] }> {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/offers`);
  }

  /** Called by the job's poster to accept one offer. */
  acceptOffer(jobId: string, agentId: string): Promise<JobRecord> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/accept`, { agentId }, {
      idempotencyKey: `accept:${jobId}:${agentId}`,
    });
  }

  /** Called by the job's poster to cancel a not-yet-completed job. */
  cancelJob(jobId: string): Promise<JobRecord> {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, {
      idempotencyKey: `cancel:${jobId}`,
    });
  }

  // ---- Verification (SPEC.md §12) — independent attestation of a finalized receipt ----

  /** Called by the verifier (who must not be the receipt's own provider/agentB).
   * `jobId`/`provider` are derived from the referenced receipt (fetched here)
   * rather than taken as caller input — the server independently derives the
   * same values and would reject a signature built over the wrong ones, so
   * there's no correct way for a caller to supply them manually anyway. */
  async submitVerification(input: Omit<VerificationContentInput, "verifier" | "jobId" | "provider">): Promise<VerificationRecord> {
    const receipt = await this.getReceipt(input.receiptId);
    const content = buildSignableVerificationContent({ ...input, jobId: receipt.jobId, provider: receipt.agentB.id, verifier: this.did });
    const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), this.keypair.privateKey));
    return this.request(
      "POST",
      "/v1/verifications",
      { receiptId: input.receiptId, verifier: this.did, method: input.method, outputHash: input.outputHash, result: input.result, score: input.score, evidenceUri: input.evidenceUri, signature },
      { idempotencyKey: `verification:${content.verificationId}` },
    );
  }

  getVerification(id: string): Promise<VerificationRecord> {
    return this.request("GET", `/v1/verifications/${encodeURIComponent(id)}`);
  }

  listReceiptVerifications(receiptId: string): Promise<{ verifications: VerificationRecord[] }> {
    return this.request("GET", `/v1/receipts/${encodeURIComponent(receiptId)}/verifications`);
  }
}
