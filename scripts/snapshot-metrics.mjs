#!/usr/bin/env node
// Appends one dated line of /v1/stats counters to a markdown log. Idempotent per UTC day.
// usage: node scripts/snapshot-metrics.mjs [metrics.md path]   (INAM_STATS_URL overrides the endpoint)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_FILE = "C:/Users/User/Desktop/MeramProjeler/MeramProjeler/mobile applist/visibilityOS/inam-launch/metrics.md";
const file = process.argv[2] ?? DEFAULT_FILE;
const url = new URL(process.env.INAM_STATS_URL ?? "https://api.inamprotocol.org/v1/stats");
if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error(`refusing non-https stats URL: ${url.origin}`);

const res = await fetch(url, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`${url.origin}${url.pathname} -> HTTP ${res.status}`);
const s = await res.json();

const day = new Date().toISOString().slice(0, 10);
const header = "# INAM metrics (30-day rule)\n\n| date | nonOperatorAgents | linkedWallets nonOperator/operator | independent countersigned receipts | agents registered | countersigned (all) | 30d finalized log |\n|---|---|---|---|---|---|---|\n";
const row = `| ${day} | ${s.nonOperatorAgents ?? "n/a"} | ${s.linkedWallets?.nonOperator ?? "n/a"}/${s.linkedWallets?.operator ?? "n/a"} | ${s.countersignedReceiptsBetweenIndependentParties ?? "n/a"} | ${s.agents?.registered} | ${s.receipts?.countersigned} | ${s.transparencyLog?.last30Days} |\n`;

if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, header + row);
} else if (readFileSync(file, "utf8").split("\n").some((l) => l.startsWith(`| ${day} |`))) {
  console.log(`already recorded for ${day}`);
  process.exit(0);
} else {
  const text = readFileSync(file, "utf8");
  appendFileSync(file, (text.endsWith("\n") ? "" : "\n") + row);
}
console.log(row.trim());
