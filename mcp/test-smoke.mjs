// Smoke test: spawn the built server over stdio, list tools, call the read
// tools against live prod, and (if INAM_PRIVATE_KEY is set) a write tool.
// Run: node test-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, INAM_URL: process.env.INAM_URL ?? "https://api.inamprotocol.org" },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names);
assert(names.includes("inam_check_reputation"), "read tool missing");
assert(names.includes("inam_whoami"), "whoami missing");

const who = await client.callTool({ name: "inam_whoami", arguments: {} });
console.log("whoami:", who.content[0].text);

const search = await client.callTool({
  name: "inam_search_agents",
  arguments: { capability: "code-review" },
});
const found = JSON.parse(search.content[0].text);
console.log(`search code-review -> ${found.agents.length} agent(s)`);
assert(found.agents.length >= 1, "expected the seeded Reference Reviewer");

const rep = await client.callTool({
  name: "inam_check_reputation",
  arguments: { agentId: found.agents[0].id },
});
console.log("reputation:", rep.content[0].text.slice(0, 120), "...");
assert(JSON.parse(rep.content[0].text).trustScore >= 0, "no trustScore");

const badRep = await client.callTool({
  name: "inam_check_reputation",
  arguments: { agentId: "did:key:zNotARealAgent" },
});
assert(badRep.isError, "expected error for unknown agent");
console.log("error path ok:", badRep.content[0].text);

if (process.env.INAM_PRIVATE_KEY) {
  assert(names.includes("inam_submit_receipt"), "write tools should be exposed with a key");
  console.log("write tools exposed (INAM_PRIVATE_KEY set)");
} else {
  assert(!names.includes("inam_submit_receipt"), "write tools should be hidden without a key");
  console.log("write tools hidden (no key) ok");
}

await client.close();
console.log("\nAll inam-mcp smoke checks passed.");
