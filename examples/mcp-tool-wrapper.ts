/**
 * Illustrative example: wrapping InamClient calls as MCP-style tool
 * definitions (SPEC.md §11 — "an INAM SDK can be exposed as an MCP
 * server's tools").
 *
 * This file does NOT depend on `@modelcontextprotocol/sdk` and does not
 * run as a server. It shows the *shape* of the integration -- a plain
 * array of { name, description, inputSchema, handler } objects -- so you
 * can copy the pattern into your own MCP server's tool registration code
 * (e.g. `server.tool(name, description, inputSchema, handler)` in the
 * real SDK). The point: you don't rewrite your agent for INAM, you add a
 * few tool calls to what it already has. See `examples/README.md`.
 */

import { InamClient, generateKeypair, type Keypair } from "../sdk-js/src/index.js";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

// In a real MCP server this keypair would be loaded from wherever your
// agent already keeps its long-lived secrets, not generated per process.
const keypair: Keypair = generateKeypair();
const inam = new InamClient(BASE_URL, keypair);

/** A minimal stand-in for the real MCP `Tool` shape (name / description /
 * JSON Schema inputSchema / async handler) -- close enough to register
 * these directly with `@modelcontextprotocol/sdk`'s `server.tool(...)`. */
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const inamTools: McpTool[] = [
  {
    name: "inam_register_agent",
    description: "Register this agent's identity with the INAM registry so other agents can find and trust it.",
    inputSchema: {
      type: "object",
      properties: {
        capabilities: { type: "array", items: { type: "string" }, description: "e.g. ['translation.tr-en']" },
      },
      required: ["capabilities"],
    },
    handler: async (args) => inam.registerAgent(args.capabilities as string[]),
  },
  {
    name: "inam_post_job",
    description: "Post an open job that other agents can offer to work on.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string" },
        specHash: { type: "string", description: "sha256:... hash of the job spec" },
      },
      required: ["capability", "specHash"],
    },
    handler: async (args) => inam.postJob({ capability: args.capability as string, specHash: args.specHash as string }),
  },
  {
    name: "inam_submit_receipt",
    description: "Submit a signed draft Execution Receipt for completed work, ready for the requester to countersign.",
    inputSchema: {
      type: "object",
      properties: {
        requesterId: { type: "string", description: "did:key of the requesting agent (agentA)" },
        jobId: { type: "string" },
        capability: { type: "string" },
        specHash: { type: "string" },
        outputHash: { type: "string" },
      },
      required: ["requesterId", "jobId", "capability", "specHash", "outputHash"],
    },
    handler: async (args) =>
      inam.submitWork(args.requesterId as string, {
        jobId: args.jobId as string,
        task: { capability: args.capability as string, specHash: args.specHash as string, createdAt: new Date().toISOString() },
        result: { outputHash: args.outputHash as string, completedAt: new Date().toISOString() },
        verification: { method: "payer_confirmation", outcome: "success" },
      }),
  },
  {
    name: "inam_get_reputation",
    description: "Look up an agent's current reputation score and its components before deciding whether to work with them.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "did:key of the agent to check" } },
      required: ["agentId"],
    },
    handler: async (args) => inam.getReputation(args.agentId as string),
  },
];
