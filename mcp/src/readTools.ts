import { z } from "zod";

/**
 * The read-only tools, shared by the stdio server (index.ts, backed by
 * InamClient over HTTPS) and the hosted endpoint (worker/src/mcp.ts, backed
 * by in-process calls into the registry Worker). Both register the same
 * names, descriptions and schemas, so the two can't drift.
 *
 * Imports only zod: the Worker bundles this file from outside its own
 * package, so it must not pull in the MCP SDK or the `inamprotocol` package.
 */
export interface RegistryReader {
  getReputation(agentId: string): Promise<unknown>;
  searchAgents(query: { capability?: string; minReputation?: number }): Promise<unknown>;
  getReceipt(receiptId: string): Promise<unknown>;
  listReceiptVerifications(receiptId: string): Promise<unknown>;
  verifyReceipt(receiptId: string, given: { spec?: string; output?: string }): Promise<unknown>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
export const fail = (err: unknown): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: `INAM error: ${(err as Error).message}` }],
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Every read tool only reads the INAM registry (or hashes locally): MCP tool
// annotations so clients (and app-directory reviews) can auto-approve them.
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// Each entry is registered as McpServer.tool(name, description, shape, handler).
export type ReadTool = {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args are validated against `shape` by the SDK
  handler: (args: any) => Promise<ToolResult>;
};

export function readTools(reader: RegistryReader): ReadTool[] {
  const guarded =
    <A,>(fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return ok(await fn(args));
      } catch (err) {
        return fail(err);
      }
    };

  return [
    {
      name: "inam_check_reputation",
      title: "Check agent reputation",
      description:
        "Looks up an agent's INAM reputation by did:key id. Returns trustScore, evidenceLevel, components (finalized-receipt count, success rate, " +
        "attested and rejected attestation counts) and flags. evidenceLevel is 'none' (no finalized receipts), 'countersigned' (receipts signed by " +
        "both parties, no independent check) or 'independently_verified' (at least one receipt verified by an operator-authorized verifier, " +
        "components.attestedReceipts > 0). flags include attestation_rejected (a verifier rejected one of the agent's receipts), in_dispute, " +
        "nonperformance_reported, revoked, concentrated_counterparty:<id> and unanchored_counterparty_volume.",
      shape: { agentId: z.string().describe("did:key:... id of the agent to check") },
      handler: guarded(({ agentId }: { agentId: string }) => reader.getReputation(agentId)),
    },
    {
      name: "inam_search_agents",
      title: "Search agents",
      description:
        "Searches INAM-registered agents by declared capability and/or minimum trust score. Returns matching agent records (did:key id, declared capabilities, metadata); revoked agents and self-declared demo agents are excluded.",
      shape: {
        capability: z.string().optional().describe("e.g. 'translation.tr-en', 'code-review'"),
        minReputation: z.number().optional().describe("minimum trust score; agents below it are excluded"),
      },
      handler: guarded((q: { capability?: string; minReputation?: number }) => reader.searchAgents(q)),
    },
    {
      name: "inam_hash_content",
      title: "Hash content",
      description:
        "Computes the 'sha256:<64 hex>' content hash of the given text, the format INAM uses for specHash and outputHash. Hashing is local; anyone holding the same text can recompute the same hash.",
      shape: { content: z.string().describe("the exact spec or output text to hash") },
      handler: guarded(async ({ content }: { content: string }) => ({ hash: `sha256:${await sha256Hex(content)}` })),
    },
    {
      name: "inam_get_receipt",
      title: "Get receipt",
      description:
        "Fetches a single execution receipt by id together with its verification records. The receipt is the record of a job signed by the worker and, once finalized, countersigned by the requester; verification records are verdicts from operator-authorized verifiers.",
      shape: { receiptId: z.string().describe("sha256:... receipt id") },
      handler: guarded(async ({ receiptId }: { receiptId: string }) => {
        const [receipt, verifications] = await Promise.all([
          reader.getReceipt(receiptId),
          reader.listReceiptVerifications(receiptId).catch(() => ({ verifications: [] })),
        ]);
        return { receipt, ...(verifications as object) };
      }),
    },
    {
      name: "inam_verify_receipt",
      title: "Verify receipt",
      description:
        "Runs the registry's integrity checks on one receipt and returns a verdict ('pass' or 'fail') with per-check results: finalized, agent_b_signature, " +
        "agent_a_signature, receipt_id (content-addressed id), transparency_log (leaf present, inclusion proof, logged content matches), spec_hash and " +
        "output_hash (only when the spec or output text is supplied; otherwise 'skipped'), parties_not_revoked and no_active_dispute. Also returns the " +
        "inclusion proof, the net verdict of independent verifications, a short next step, and an Ed25519 attestation over the result by the registry's " +
        "hosted agent key. The work is not re-executed: this is not an independent verification and is not recorded or counted toward reputation.",
      shape: {
        receiptId: z.string().describe("sha256:... receipt id"),
        spec: z.string().optional().describe("exact task spec text; checked against the receipt's task.specHash"),
        output: z.string().optional().describe("exact output text; checked against the receipt's result.outputHash"),
      },
      handler: guarded(({ receiptId, spec, output }: { receiptId: string; spec?: string; output?: string }) => reader.verifyReceipt(receiptId, { spec, output })),
    },
  ];
}
