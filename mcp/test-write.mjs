// Write-path smoke test against a LOCAL dev server (npm run dev, :4021).
// Generates a throwaway key, registers, posts a job, submits a receipt.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeypair, toHex } from "inamprotocol";
import assert from "node:assert";

const kp = generateKeypair();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, INAM_URL: "http://localhost:4021", INAM_PRIVATE_KEY: toHex(kp.privateKey) },
});
const client = new Client({ name: "smoke-write", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
assert(names.includes("inam_register_agent"), "register tool missing with key set");
assert(names.includes("inam_submit_receipt"), "submit tool missing with key set");
assert(names.includes("inam_revoke_agent"), "revoke tool missing with key set");

const reg = await client.callTool({
  name: "inam_register_agent",
  arguments: { capabilities: ["code-review"], name: "Write Smoke" },
});
assert(!reg.isError, `register failed: ${reg.content[0].text}`);
console.log("registered:", JSON.parse(reg.content[0].text).id);

// need a requester + job for the receipt; register a second identity directly
const kp2 = generateKeypair();
const t2 = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, INAM_URL: "http://localhost:4021", INAM_PRIVATE_KEY: toHex(kp2.privateKey) },
});
const c2 = new Client({ name: "smoke-write-2", version: "0" });
await c2.connect(t2);
await c2.callTool({ name: "inam_register_agent", arguments: { capabilities: ["job.posting"] } });
const job = await c2.callTool({
  name: "inam_post_job",
  arguments: { capability: "code-review", specHash: "sha256:2fd7dff51ee482b31f4e22da61007cfa4ac69a7ad6947bbf305516b7e9787db0" },
});
assert(!job.isError, `post_job failed: ${job.content[0].text}`);
const jobId = JSON.parse(job.content[0].text).jobId;
console.log("job posted:", jobId);

const offer = await client.callTool({ name: "inam_submit_offer", arguments: { jobId, message: "on it" } });
assert(!offer.isError, `submit_offer failed: ${offer.content[0].text}`);
const accept = await c2.callTool({ name: "inam_accept_offer", arguments: { jobId, agentId: kp.did } });
assert(!accept.isError, `accept_offer failed: ${accept.content[0].text}`);
console.log("offer accepted");

const receipt = await client.callTool({
  name: "inam_submit_receipt",
  arguments: {
    requesterId: kp2.did,
    jobId,
    capability: "code-review",
    specHash: "sha256:2fd7dff51ee482b31f4e22da61007cfa4ac69a7ad6947bbf305516b7e9787db0",
    outputHash: "sha256:c545b78d8dd39e42805780ec79dcdd68d0f19bb14642453a07e9433842d28149",
    amount: "10.00",
    currency: "USDC",
  },
});
assert(!receipt.isError, `submit_receipt failed: ${receipt.content[0].text}`);
const receiptId = JSON.parse(receipt.content[0].text).receiptId;
console.log("draft receipt:", receiptId, JSON.parse(receipt.content[0].text).status);

const fin = await c2.callTool({
  name: "inam_countersign_receipt",
  arguments: { receiptId, expectedJobId: jobId, expectedOutputHash: "sha256:c545b78d8dd39e42805780ec79dcdd68d0f19bb14642453a07e9433842d28149" },
});
assert(!fin.isError, `countersign failed: ${fin.content[0].text}`);
assert(JSON.parse(fin.content[0].text).status === "finalized", "receipt not finalized");
console.log("countersigned -> finalized");

const rev = await client.callTool({ name: "inam_revoke_agent", arguments: { reason: "smoke test cleanup" } });
assert(!rev.isError, `revoke failed: ${rev.content[0].text}`);
assert(JSON.parse(rev.content[0].text).revokedAt, "revoke did not set revokedAt");
console.log("revoked:", JSON.parse(rev.content[0].text).id);

const search = await c2.callTool({ name: "inam_search_agents", arguments: { capability: "code-review" } });
assert(!search.isError, `search failed: ${search.content[0].text}`);
const results = JSON.parse(search.content[0].text).agents ?? JSON.parse(search.content[0].text);
assert(
  !JSON.stringify(results).includes(kp.did),
  "revoked agent still appears in default search results",
);
console.log("revoked agent correctly absent from default search");

await client.close();
await c2.close();
console.log("\nAll inam-mcp write-path smoke checks passed.");
