#!/usr/bin/env node
import { checkTarget, formatReport } from "./check.js";
import { linkWallet } from "./linkWallet.js";
import { InamClient } from "./client.js";
import { generateKeypair, keypairFromPrivateKey, fromHex, toHex } from "./crypto/keys.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `Usage: inam link-wallet [--registry URL]   (sellers: prove you control your x402 payTo wallet, see SELLER.md)
       inam check <target> [--json] [--strict] [--method POST] [--registry URL] [--no-rdap]

  <target>   an x402 resource URL, an EVM wallet (0x...), or an INAM did:key

Checks public signals before you pay: the 402's payment requirements, ERC-8004 identity
and feedback for payTo, the INAM wallet link and receipts, a Web Bot Auth key directory,
and the domain's registration date. No API keys.

Exit codes: 0 pass or caution, 1 a key check failed (or caution with --strict), 2 usage or crash.
Env: INAM_RPC_<chainId> overrides the public JSON-RPC for that chain.`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args.splice(i, 2)[1] ?? "");
};
const bool = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 && (args.splice(i, 1), true);
};

if (bool("--help") || bool("-h")) {
  console.log(USAGE);
  process.exit(0);
}

if (args[0] === "link-wallet") {
  const registry = flag("--registry") ?? "https://api.inamprotocol.org";
  if (args.length > 1) {
    // an unknown flag must never start the wallet flow (it registers an ID and opens a local server)
    console.error(`inam link-wallet: unexpected argument ${JSON.stringify(args[1])}

${USAGE}`);
    process.exit(2);
  }
  try {
    const dir = join(homedir(), ".inam");
    const keyFile = join(dir, "seller-key.json");
    if (!existsSync(keyFile)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(keyFile, JSON.stringify({ privateKeyHex: toHex(generateKeypair().privateKey) }), { mode: 0o600 });
    }
    const inam = new InamClient(registry, keypairFromPrivateKey(fromHex(JSON.parse(readFileSync(keyFile, "utf8")).privateKeyHex)));
    await inam.getAgent(inam.did).catch(() => inam.registerAgent(["x402.seller"], { name: "x402 seller" }));
    console.log(`Your INAM ID: ${inam.did}
Key file: ${keyFile} (keep it; it is your seller identity)`);
    const wallet = await linkWallet(inam, (url) => console.log(`Open this in the browser with your wallet (expires in ~10 min):
  ${url}`));
    console.log(`
Linked ${wallet}. Anyone can now check it:
  ${registry}/v1/check?target=${wallet}
Next: add the inam extension to your 402 (SELLER.md).`);
    process.exit(0);
  } catch (e) {
    console.error(`inam link-wallet: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (args[0] !== "check" || !args[1]) {
  console.error(USAGE);
  process.exit(args.length ? 2 : 0);
}
const json = bool("--json");
const strict = bool("--strict");
const noRdap = bool("--no-rdap");
const method = flag("--method") ?? flag("-X");
const registryUrl = flag("--registry");
try {
  const report = await checkTarget(args[1], { method, registryUrl, noRdap });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.verdict === "fail" || (strict && report.verdict === "caution") ? 1 : 0);
} catch (e) {
  console.error(`inam check: ${(e as Error).message}`);
  process.exit(2);
}
