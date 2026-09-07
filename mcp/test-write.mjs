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
  arguments: { capability: "code-review", specHash: "sha256:write_smoke_spec" },
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
    specHash: "sha256:write_smoke_spec",
    outputHash: "sha256:write_smoke_output",
    amount: "10.00",
    currency: "USDC",
  },
});
assert(!receipt.isError, `submit_receipt failed: ${receipt.content[0].text}`);
const receiptId = JSON.parse(receipt.content[0].text).receiptId;
console.log("draft receipt:", receiptId, JSON.parse(receipt.content[0].text).status);

const fin = await c2.callTool({ name: "inam_countersign_receipt", arguments: { receiptId } });
assert(!fin.isError, `countersign failed: ${fin.content[0].text}`);
assert(JSON.parse(fin.content[0].text).status === "finalized", "receipt not finalized");
console.log("countersigned -> finalized");

await client.close();
await c2.close();
console.log("\nAll inam-mcp write-path smoke checks passed.");
