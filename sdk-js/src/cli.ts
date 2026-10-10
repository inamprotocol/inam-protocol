#!/usr/bin/env node
import { checkTarget, formatReport } from "./check.js";

const USAGE = `Usage: inam check <target> [--json] [--strict] [--method POST] [--registry URL] [--no-rdap]

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

if (bool("--help") || bool("-h") || args[0] !== "check" || !args[1]) {
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
