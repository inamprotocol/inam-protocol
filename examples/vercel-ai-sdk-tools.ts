/**
 * INAM reputation checks as Vercel AI SDK tools.
 *
 *   npm i ai zod inamprotocol @ai-sdk/anthropic
 *
 * `inamTools()` returns read-only `tool()` definitions an agent can call
 * before it delegates work or pays a counterparty. Descriptions match the
 * hosted MCP server's (mcp/src/readTools.ts), so a model gets the same
 * guidance either way: check `evidenceLevel`, not just `trustScore`.
 *
 * Usage:
 *
 *   import { generateText, stepCountIs } from "ai";
 *   import { anthropic } from "@ai-sdk/anthropic";
 *   import { inamTools } from "./vercel-ai-sdk-tools.js";
 *
 *   const { text } = await generateText({
 *     model: anthropic("claude-sonnet-5-5"),
 *     tools: inamTools(),
 *     stopWhen: stepCountIs(5),
 *     prompt: "Find a code-review agent on INAM and tell me whether its record is strong enough to hire it.",
 *   });
 */
import { tool } from "ai";
import { z } from "zod";
import { InamClient, generateKeypair } from "inamprotocol";

export function inamTools(baseUrl = "https://api.inamprotocol.org") {
  // Reads are public; the client just needs some keypair to sign with.
  const inam = new InamClient(baseUrl, generateKeypair());

  return {
    checkReputation: tool({
      description:
        "Look up an agent's INAM reputation (trust score, finalized-receipt count, success rate, dispute flags) before deciding whether to trust or transact with it. " +
        "Do not decide on trustScore alone: check evidenceLevel first. 'countersigned' means only the two parties vouched for the work; " +
        "'independently_verified' means an operator-authorized verifier checked it. Treat any 'attestation_rejected' flag as a strong negative.",
      inputSchema: z.object({ agentId: z.string().describe("did:key:... id of the agent to check") }),
      execute: ({ agentId }) => inam.getReputation(agentId),
    }),
    searchAgents: tool({
      description: "Find INAM-registered agents by declared capability and/or minimum reputation, to discover a counterparty for a task and see how trusted it is.",
      inputSchema: z.object({
        capability: z.string().optional().describe("e.g. 'translation.tr-en', 'code-review'"),
        minReputation: z.number().optional().describe("only return agents with at least this trust score"),
      }),
      execute: (query) => inam.searchAgents(query),
    }),
    getReceipt: tool({
      description:
        "Fetch one execution receipt by id, with its verification records, to check a specific claim ('agent X says it did job Y') against the signed, countersigned record.",
      inputSchema: z.object({ receiptId: z.string().describe("sha256:... receipt id") }),
      execute: async ({ receiptId }) => {
        const [receipt, { verifications }] = await Promise.all([
          inam.getReceipt(receiptId),
          inam.listReceiptVerifications(receiptId).catch(() => ({ verifications: [] })),
        ]);
        return { receipt, verifications };
      },
    }),
  };
}
