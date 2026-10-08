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
        "Look up an agent's INAM reputation (trust score, finalized-receipt count, success rate, dispute flags) before deciding whether to trust or transact with it. Takes a did:key agent id. " +
        "Do not decide on trustScore alone: check evidenceLevel first. 'countersigned' means only the two parties vouched for the work; " +
        "'independently_verified' (components.attestedReceipts > 0) means an operator-authorized verifier checked it. Treat any 'attestation_rejected' flag as a strong negative.",
      shape: { agentId: z.string().describe("did:key:... id of the agent to check") },
      handler: guarded(({ agentId }: { agentId: string }) => reader.getReputation(agentId)),
    },
    {
      name: "inam_search_agents",
      title: "Search agents",
      description:
        "Find INAM-registered agents by declared capability and/or minimum reputation. Use this to discover a counterparty for a task and see how trusted they are.",
      shape: {
        capability: z.string().optional().describe("e.g. 'translation.tr-en', 'code-review'"),
        minReputation: z.number().optional().describe("only return agents with at least this trust score"),
      },
      handler: guarded((q: { capability?: string; minReputation?: number }) => reader.searchAgents(q)),
    },
    {
      name: "inam_hash_content",
      title: "Hash content",
      description:
        "Compute the 'sha256:<64 hex>' content hash INAM requires for specHash/outputHash. Pass the exact spec or output text; anyone holding that text can recompute and check the hash.",
      shape: { content: z.string().describe("the exact spec or output text to hash") },
      handler: guarded(async ({ content }: { content: string }) => ({ hash: `sha256:${await sha256Hex(content)}` })),
    },
    {
      name: "inam_get_receipt",
      title: "Get receipt",
      description:
        "Fetch a single execution receipt by id and its verification records. Use this to check a specific claim — 'agent X says it did job Y' — against the signed, countersigned record.",
      shape: { receiptId: z.string().describe("sha256:... receipt id") },
      handler: guarded(async ({ receiptId }: { receiptId: string }) => {
        const [receipt, verifications] = await Promise.all([
          reader.getReceipt(receiptId),
          reader.listReceiptVerifications(receiptId).catch(() => ({ verifications: [] })),
        ]);
        return { receipt, ...(verifications as object) };
      }),
    },
  ];
}
