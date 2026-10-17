#!/usr/bin/env node
// Read-only "doors that opened" radar: issues/discussions touched since a date in watched repos
// that mention INAM-relevant keywords. Uses the gh CLI (already authenticated); never posts.
// usage: node scripts/radar.mjs [--since YYYY-MM-DD]   (default: 7 days ago)
import { execFileSync } from "node:child_process";

const REPOS = [
  "x402-foundation/x402", "coinbase/agentkit", "agentic-commerce-protocol/agentic-commerce-protocol",
  "google-agentic-commerce/AP2", "google-agentic-commerce/a2a-x402", "juspay/hyperswitch",
  "stripe/ai", "a2aproject/A2A", "visa/trusted-agent-protocol", "dodopayments/skills",
];
const KEYWORDS = ["agent identity", "receipt", "dispute", "pre-payment", "attestation", "reputation", "KYA", "countersign"];

const i = process.argv.indexOf("--since");
const sinceArg = i > 0 ? process.argv[i + 1] : undefined;
if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) throw new Error("--since must be YYYY-MM-DD");
const since = sinceArg ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const sinceTs = Date.parse(since + "T00:00:00Z");

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }));
const why = (text) => KEYWORDS.filter((k) => new RegExp("\\b" + k, "i").test(text));
const hits = [];

for (const repo of REPOS) {
  try {
    for (const it of gh(["api", `repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${since}T00:00:00Z&per_page=100`])) {
      if (it.pull_request) continue;
      const w = why(`${it.title}\n${it.body ?? ""}`);
      if (w.length) hits.push({ repo, kind: "issue", n: it.number, title: it.title, url: it.html_url, w, updated: it.updated_at });
    }
  } catch (e) { console.error(`# ${repo} issues: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`); }
  try {
    const [owner, name] = repo.split("/");
    const q = "query($o:String!,$n:String!){repository(owner:$o,name:$n){discussions(first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url body updatedAt}}}}";
    const d = gh(["api", "graphql", "-f", `query=${q}`, "-F", `o=${owner}`, "-F", `n=${name}`]);
    for (const it of d.data?.repository?.discussions?.nodes ?? []) {
      if (Date.parse(it.updatedAt) < sinceTs) continue;
      const w = why(`${it.title}\n${it.body ?? ""}`);
      if (w.length) hits.push({ repo, kind: "discussion", n: it.number, title: it.title, url: it.url, w, updated: it.updatedAt });
    }
  } catch { /* discussions disabled or no access: skip silently */ }
}

console.log(`## Doors that opened since ${since}\n`);
if (!hits.length) console.log("(none)");
for (const h of hits.sort((a, b) => b.updated.localeCompare(a.updated)))
  console.log(`- ${h.repo}#${h.n} (${h.kind}) ${h.title}\n  ${h.url}\n  matched: ${h.w.join(", ")}`);
