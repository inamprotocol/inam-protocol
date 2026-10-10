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
import { readTools, ok, fail, READ_ONLY } from "./readTools.js";

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
const server = new McpServer({ name: "inam-mcp", version: "0.5.1" });

// --- read tools (always available; shared with the hosted endpoint) --------

for (const t of readTools(inam)) server.tool(t.name, t.description, t.shape, { ...READ_ONLY, title: t.title }, t.handler);

server.tool(
  "inam_whoami",
  "Returns this MCP server's own INAM identity (did:key), the registry URL it is connected to, and whether signed writes (register / post job / submit receipt) are enabled.",
  {},
  async () => ok({ did: keypair.did, registryUrl: INAM_URL, writeEnabled }),
);

// --- write tools (only with INAM_PRIVATE_KEY) ------------------------------

if (writeEnabled) {
  server.tool(
    "inam_register_agent",
    "Registers this server's identity in the INAM registry with the given capabilities and optional name and description, making it discoverable in agent search. Idempotent.",
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
    "Posts an open job to the INAM registry for a capability and spec hash. Other agents can discover the job and submit offers on it.",
    {
      capability: z.string().describe("capability the job needs"),
      specHash: z.string().describe("sha256:<64 hex> of the job spec text"),
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
    "Submits an offer, as the worker, to work on an open job. A receipt for the job can be submitted only after the job's poster accepts the offer.",
    {
      jobId: z.string(),
      message: z.string().optional().describe("optional note shown to the job poster"),
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
    "Accepts another agent's offer on a job this identity posted. Acceptance binds the two parties to the job and enables the worker to submit a receipt.",
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
    "Countersigns a draft receipt as the requester, finalizing it. A receipt counts toward reputation only once both parties have signed. " +
      "The draft is fetched and its jobId and result.outputHash are compared with expectedJobId and expectedOutputHash; on any mismatch " +
      "nothing is signed and an error is returned. The check protects against signing a draft whose content differs from the job the requester posted.",
    {
      receiptId: z.string().describe("sha256:... id of the draft receipt to finalize"),
      expectedJobId: z.string().describe("the jobId the receipt is expected to belong to; compared with the draft before signing"),
      expectedOutputHash: z.string().describe("the result.outputHash the receipt is expected to carry; compared with the draft before signing"),
    },
    async ({ receiptId, expectedJobId, expectedOutputHash }) => {
      try {
        const draft = await inam.getReceipt(receiptId);
        return ok(await inam.acceptWork(draft, { jobId: expectedJobId, outputHash: expectedOutputHash }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "inam_submit_receipt",
    "Submits a draft execution receipt, signed by this identity as the worker, for a completed job. The receipt records the task, the output hash and optional settlement, and becomes final when the requester countersigns it.",
    {
      requesterId: z.string().describe("did:key of the requesting agent (agentA)"),
      jobId: z.string().describe("id of the job this receipt settles"),
      capability: z.string(),
      specHash: z.string().describe("sha256:<64 hex> of the job spec text"),
      outputHash: z.string().describe("sha256:<64 hex> of the work output"),
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

  server.tool(
    "inam_revoke_agent",
    "Retires this server's own INAM identity (one-way). A revoked identity is excluded from default search results and can make no further " +
      "signed writes; its past finalized receipts remain on record and verifiable, and its reputation carries the revoked flag.",
    { reason: z.string().describe("reason recorded with the revocation, e.g. 'demo run complete'") },
    async ({ reason }) => {
      try {
        return ok(await inam.revoke(reason));
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
