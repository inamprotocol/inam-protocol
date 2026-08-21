import { canonicalize } from "../crypto/canonical.js";
import { sha256Hex, sign, toBase64, type Keypair } from "../crypto/keys.js";
import { buildSignableContent, type ReceiptContentInput } from "../core/receiptContent.js";
import type { AgentRecord, ExecutionReceipt, ReputationResult } from "../types.js";

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

  linkIdentity(protocol: string, value: string): Promise<AgentRecord> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(this.did)}/link`, { protocol, value }, {
      idempotencyKey: `link:${protocol}:${value}`,
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
}
