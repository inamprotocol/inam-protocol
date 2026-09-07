#!/usr/bin/env node
/**
 * inam-mcp — an MCP server that exposes the INAM Protocol registry as agent tools.
 *
 * Two things it lets an agent do:
 *   1. Check a counterparty's reputation and receipt history BEFORE trusting it
 *      (read-only, no key needed).
 *   2. Register its own identity and emit a signed execution receipt when work
 *      is done (needs INAM_PRIVATE_KEY).
 *
 * Config (environment):
 *   INAM_URL          registry base URL   (default https://api.inamprotocol.org)
 *   INAM_PRIVATE_KEY  hex-encoded Ed25519 private key. If set, the write tools
 *                     (register / post_job / submit_receipt) are exposed and
 *                     act as that identity. If unset, only the read tools are
 *                     exposed and the server runs with an ephemeral key.
 *
 * Claude Desktop / Cursor config:
 *   {
 *     "mcpServers": {
 *       "inam": {
 *         "command": "npx",
 *         "args": ["-y", "inam-mcp"],
 *         "env": { "INAM_PRIVATE_KEY": "abc123..." }
 *       }
 *     }
 *   }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { InamClient, generateKeypair, keypairFromPrivateKey, fromHex, type Keypair } from "inamprotocol";

const INAM_URL = process.env.INAM_URL ?? "https://api.inamprotocol.org";

let keypair: Keypair;
let writeEnabled = false;
const rawKey = process.env.INAM_PRIVATE_KEY?.trim();
if (rawKey) {
  try {
    keypair = keypairFromPrivateKey(fromHex(rawKey));
    writeEnabled = true;
  } catch (err) {
    process.stderr.write(`inam-mcp: INAM_PRIVATE_KEY is set but invalid (${(err as Error).message}). Exiting.\n`);
    process.exit(1);
  }
} else {
  keypair = generateKeypair();
}

const inam = new InamClient(INAM_URL, keypair);
const server = new McpServer({ name: "inam-mcp", version: "0.1.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `INAM error: ${(err as Error).message}` }],
});

// --- read tools (always available) -----------------------------------------

server.tool(
  "inam_check_reputation",
  "Look up an agent's INAM reputation (trust score, finalized-receipt count, success rate, dispute flags) before deciding whether to trust or transact with it. Takes a did:key agent id.",
  { agentId: z.string().describe("did:key:... id of the agent to check") },
  async ({ agentId }) => {
    try {
      return ok(await inam.getReputation(agentId));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "inam_search_agents",
  "Find INAM-registered agents by declared capability and/or minimum reputation. Use this to discover a counterparty for a task and see how trusted they are.",
  {
    capability: z.string().optional().describe("e.g. 'translation.tr-en', 'code-review'"),
    minReputation: z.number().optional().describe("only return agents with at least this trust score"),
  },
  async ({ capability, minReputation }) => {
    try {
      return ok(await inam.searchAgents({ capability, minReputation }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "inam_get_receipt",
  "Fetch a single execution receipt by id and its verification records. Use this to check a specific claim — 'agent X says it did job Y' — against the signed, countersigned record.",
  { receiptId: z.string().describe("sha256:... receipt id") },
  async ({ receiptId }) => {
    try {
      const [receipt, verifications] = await Promise.all([
        inam.getReceipt(receiptId),
        inam.listReceiptVerifications(receiptId).catch(() => ({ verifications: [] })),
      ]);
      return ok({ receipt, ...verifications });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "inam_whoami",
  "Report this MCP server's own INAM identity (did:key) and whether it can perform signed writes (register / post job / submit receipt).",
  {},
  async () => ok({ did: keypair.did, registryUrl: INAM_URL, writeEnabled }),
);

// --- write tools (only with INAM_PRIVATE_KEY) ------------------------------

if (writeEnabled) {
  server.tool(
    "inam_register_agent",
    "Register this agent's identity in the INAM registry so other agents can discover and trust it. Idempotent — safe to call once at startup.",
    {
      capabilities: z.array(z.string()).min(1).describe("declared capabilities, e.g. ['code-review']"),
      name: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ capabilities, name, description }) => {
      try {
        const metadata: Record<string, unknown> = {};
        if (name) metadata.name = name;
        if (description) metadata.description = description;
        return ok(await inam.registerAgent(capabilities, metadata));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_post_job",
    "Post an open job to the INAM registry that other agents can discover and offer to work on.",
    {
      capability: z.string().describe("capability the job needs"),
      specHash: z.string().describe("sha256:... hash of the job spec / requirements"),
    },
    async ({ capability, specHash }) => {
      try {
        return ok(await inam.postJob({ capability, specHash }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_submit_offer",
    "Offer to work on an open job (as the worker). The job's poster must then accept the offer before a receipt can be submitted.",
    {
      jobId: z.string(),
      message: z.string().optional().describe("optional note to the job poster"),
    },
    async ({ jobId, message }) => {
      try {
        return ok(await inam.submitOffer(jobId, message));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_accept_offer",
    "Accept another agent's offer on a job this agent posted. This commits the two parties and lets the worker submit a receipt.",
    {
      jobId: z.string(),
      agentId: z.string().describe("did:key of the offering agent to accept"),
    },
    async ({ jobId, agentId }) => {
      try {
        return ok(await inam.acceptOffer(jobId, agentId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_countersign_receipt",
    "Countersign a draft receipt (as the requester) to finalize it. A receipt only counts toward reputation once both parties have signed.",
    { receiptId: z.string().describe("sha256:... id of the draft receipt to finalize") },
    async ({ receiptId }) => {
      try {
        const draft = await inam.getReceipt(receiptId);
        return ok(await inam.acceptWork(draft));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_submit_receipt",
    "Emit a signed draft execution receipt for work this agent just completed, for the requester to countersign. This is the proof-of-work-done artifact.",
    {
      requesterId: z.string().describe("did:key of the requesting agent (agentA)"),
      jobId: z.string().describe("id of the job this receipt settles"),
      capability: z.string(),
      specHash: z.string().describe("sha256:... of the job spec"),
      outputHash: z.string().describe("sha256:... of the work output"),
      amount: z.string().optional().describe("settlement amount, e.g. '40.00'"),
      currency: z.string().optional().describe("settlement currency, e.g. 'USDC'"),
    },
    async ({ requesterId, jobId, capability, specHash, outputHash, amount, currency }) => {
      try {
        const now = new Date().toISOString();
        return ok(
          await inam.submitWork(requesterId, {
            jobId,
            task: { capability, specHash, createdAt: now },
            result: { outputHash, completedAt: now },
            ...(amount && currency ? { settlement: { amount, currency } } : {}),
            verification: { method: "payer_confirmation", outcome: "success" },
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `inam-mcp: connected to ${INAM_URL} as ${keypair.did}${writeEnabled ? " (write-enabled)" : " (read-only)"}\n`,
);
