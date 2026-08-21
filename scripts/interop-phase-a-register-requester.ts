import { writeFileSync } from "node:fs";
import { generateKeypair, toBase64 } from "../src/crypto/keys.js";
import { InamClient } from "../src/sdk/client.js";

/**
 * Phase A of the TS↔Python cross-language demo: a TypeScript-side "requester"
 * agent registers itself, then saves its identity to a handoff file so a
 * later TS process (phase C) can reload the exact same keypair and
 * countersign work submitted by a Python-side worker in between.
 */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
const HANDOFF_PATH = process.env.INAM_HANDOFF ?? ".interop-tmp/requester-identity.json";

async function main() {
  const keypair = generateKeypair();
  const client = new InamClient(BASE_URL, keypair);
  const record = await client.registerAgent(["job.posting"], { name: "TS Requester (interop demo)" });

  writeFileSync(
    HANDOFF_PATH,
    JSON.stringify({ did: keypair.did, privateKeyHex: Buffer.from(keypair.privateKey).toString("hex") }, null, 2),
  );

  console.log(`[phase A / TypeScript] Registered requester ${record.id}`);
  console.log(`[phase A / TypeScript] Identity saved to ${HANDOFF_PATH} for phase C to reload`);
}

main().catch((err) => {
  console.error("Phase A failed:", err);
  process.exitCode = 1;
});
