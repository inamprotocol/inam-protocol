import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { chainIdOf, directoryItem, domainItem, inamLinkedWallets, isEvmAddress, registrableDomain, walletErc8004, type WalletErc8004 } from "../sdk-js/src/check.js";

/** x402 scan: the `inam check` signals across every seller in an x402 Bazaar snapshot.
 *
 * Read-only, nothing is paid. Reuses the Agent Trust Index snapshot (scripts/trust-index.ts writes a
 * fresh one). Per distinct payTo: ERC-8004 identity (8004scan owner index + on-chain balanceOf on the
 * listing's chain) and feedback (on-chain Reputation Registry where a keyless RPC exists, else the
 * indexer's count), and the INAM wallet link. Per host: Web Bot Auth key directory. Per registrable
 * domain: RDAP registration date.
 *
 *   npx tsx scripts/x402-scan.ts
 *   SNAPSHOT=data/trust-index/<file>.json.gz RDAP=0 LIMIT=50 npx tsx scripts/x402-scan.ts
 */
const SNAPSHOT = process.env.SNAPSHOT ?? "data/trust-index/bazaar-facilitator.payai.network-2026-10-09.json.gz";
const LIMIT = Number(process.env.LIMIT ?? 0); // 0 = every payTo/host; >0 = a small sample for a quick run
const RDAP = process.env.RDAP !== "0";
const DATE = new Date().toISOString().slice(0, 10);
const DIR = "data/x402-scan";
const OUT = process.env.OUT ?? `${DIR}/x402-scan-${DATE}${LIMIT ? `-sample${LIMIT}` : ""}`;

type Accept = { network?: string; payTo?: string };
type Item = { resource: string; accepts?: Accept[]; extensions?: Record<string, unknown> };

const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const norm = (a: string) => (isEvmAddress(a) ? a.toLowerCase() : a);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>, label: string): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (let i; (i = next++) < items.length; ) {
      out[i] = await fn(items[i]);
      if (++done % 50 === 0) console.error(`${label}: ${done}/${items.length}`);
    }
  }));
  return out;
}

async function main() {
  const startedAt = new Date().toISOString();
  const raw = readFileSync(SNAPSHOT);
  const snap = JSON.parse((SNAPSHOT.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  const items: Item[] = [...new Map((snap.items as Item[]).map((i) => [i.resource, i])).values()];

  // payTo -> listing count and the chain it is most often paid on.
  const payTo = new Map<string, { listings: number; chains: Map<number, number> }>();
  const hosts = new Set<string>();
  for (const it of items) {
    const h = hostOf(it.resource);
    if (h && /^https?:/.test(it.resource)) hosts.add(h);
    for (const a of it.accepts ?? []) {
      if (!a.payTo) continue;
      const p = payTo.get(norm(a.payTo)) ?? { listings: 0, chains: new Map() };
      p.listings++;
      const c = chainIdOf(a.network ?? "");
      if (c !== null) p.chains.set(c, (p.chains.get(c) ?? 0) + 1);
      payTo.set(norm(a.payTo), p);
    }
  }
  let wallets = [...payTo.keys()];
  let hostList = [...hosts].sort();
  if (LIMIT) { wallets = wallets.slice(0, LIMIT); hostList = hostList.slice(0, LIMIT); }
  const evm = wallets.filter(isEvmAddress);

  const linked = await inamLinkedWallets();
  const erc = await pool(evm, 4, async (w) => {
    const chains = [...payTo.get(w)!.chains].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const chain = chains.find((c) => c === 8453) ?? chains[0] ?? 8453;
    let r: WalletErc8004 = await walletErc8004(w, chain);
    if (r.errors.length) r = await walletErc8004(w, chain); // one retry: public RPCs and the indexer rate-limit
    return { wallet: w, chain, listings: payTo.get(w)!.listings, inam: linked.get(w) ?? null, ...r };
  }, "payTo");

  const dirs = await pool(hostList, 8, async (h) => ({ host: h, ...(await directoryItem(`https://${h}`, 8000)) }), "directory");
  // One RDAP query per registrable domain; a shared-platform domain (workers.dev, ...) answers without a query.
  const byDomain = new Map<string, string[]>();
  for (const h of hostList) byDomain.set(registrableDomain(h), [...(byDomain.get(registrableDomain(h)) ?? []), h]);
  const domains = RDAP ? [...byDomain.keys()] : [];
  const domainRows = await pool(domains, 2, async (dom) => ({ domain: dom, hosts: byDomain.get(dom)!.length, ...(await domainItem(byDomain.get(dom)![0], 10000)) }), "rdap");
  const sharedHosts = domainRows.filter((d) => /shared hosting/.test(d.label)).reduce((s, d) => s + d.hosts, 0);
  const owns = (r: (typeof erc)[number]) => Math.max(r.agents?.length ?? 0, r.onchain?.balance ?? 0) > 0;
  const checked = erc.filter((r) => r.agents !== null || r.onchain !== null);
  const withId = checked.filter(owns);
  const noFeedback = withId.filter((r) => (r.feedback?.total ?? 0) === 0);
  const bareFeedback = withId.filter((r) => (r.feedback?.total ?? 0) > 0 && (r.feedback?.receiptBacked ?? 0) === 0);
  const receiptBacked = withId.filter((r) => (r.feedback?.receiptBacked ?? 0) > 0);
  const inamLinked = erc.filter((r) => r.inam);
  const noIdentity = checked.filter((r) => !owns(r) && !r.inam);
  const listingsOf = (rs: { listings: number }[]) => rs.reduce((s, r) => s + r.listings, 0);
  const totalListings = listingsOf(erc);
  const dirValid = dirs.filter((d) => d.status === "pass");
  const dirInvalid = dirs.filter((d) => d.status === "warn");
  const aged = domainRows.flatMap((d) => { const m = /\((\d+) days ago\)/.exec(d.label); return m ? [{ days: Number(m[1]), hosts: d.hosts }] : []; });
  const hostAges = aged.flatMap((a) => Array<number>(a.hosts).fill(a.days)).sort((a, b) => a - b);
  const summary = {
    title: "x402 scan: inam check across an x402 Bazaar",
    methodology: {
      generatedAt: new Date().toISOString(),
      startedAt,
      snapshot: SNAPSHOT,
      bazaarFetchedAt: snap.fetchedAt,
      catalog: snap.source,
      sample: LIMIT || null,
      definitions: {
        erc8004Identity: "The payTo owns at least one ERC-8004 agent NFT: 8004scan's owner index (all chains) or balanceOf on the Identity Registry of the listing's chain. Agents that only set payTo as agentWallet are not reverse-indexed and count as no identity.",
        feedback: "Reputation Registry getSummary over getClients, on-chain on Base / Base Sepolia / Ethereum (keyless public RPCs); other chains use 8004scan's total_feedbacks.",
        taskTiedFeedback: "Feedback whose tag1 is inam-receipt (SPEC.md §11.1): it carries a signed two-party INAM receipt. ERC-8004 has no other field that ties feedback to a delivered task.",
        noIdentity: "No ERC-8004 agent owned and no INAM ID proved control of the wallet.",
        directory: "GET https://<host>/.well-known/http-message-signatures-directory, valid if signed by a listed key for that authority (verifyDirectoryResponse).",
        domainAge: "RDAP registration date of the registrable domain (last two labels, three under co/com/org/... ccTLDs). Hosts on shared platforms (workers.dev, vercel.app, ...) are counted separately.",
      },
    },
    payTo: {
      distinct: payTo.size,
      scanned: wallets.length,
      evm: evm.length,
      nonEvm: wallets.length - evm.length,
      erc8004Checked: checked.length,
      lookupErrors: erc.length - checked.length,
      noIdentity: noIdentity.length,
      noIdentitySharePct: pct(noIdentity.length, checked.length),
      noIdentityListingSharePct: pct(listingsOf(noIdentity), totalListings),
      withErc8004Identity: withId.length,
      withErc8004IdentitySharePct: pct(withId.length, checked.length),
      erc8004NoFeedback: noFeedback.length,
      erc8004FeedbackNoneTaskTied: bareFeedback.length,
      erc8004WithTaskTiedFeedback: receiptBacked.length,
      erc8004WithoutTaskTiedFeedbackSharePct: pct(withId.length - receiptBacked.length, withId.length),
      linkedToInamId: inamLinked.length,
      inamAgentsWithLinkedWallet: linked.size,
    },
    hosts: {
      scanned: hostList.length,
      webBotAuthDirectoryValid: dirValid.length,
      webBotAuthDirectoryInvalid: dirInvalid.length,
      validDirectoryHosts: dirValid.map((d) => d.host),
    },
    domains: RDAP
      ? {
          registrableDomains: domains.length,
          hostsOnSharedPlatforms: sharedHosts,
          hostsOnSharedPlatformsSharePct: pct(sharedHosts, hostList.length),
          domainsWithAge: aged.length,
          domainsUnder30Days: aged.filter((a) => a.days < 30).length,
          domainsUnder90Days: aged.filter((a) => a.days < 90).length,
          medianHostDomainAgeDays: hostAges[Math.floor(hostAges.length / 2)] ?? null,
        }
      : null,
    erc8004Payees: withId.map((r) => ({ payTo: r.wallet, listings: r.listings, chain: r.chain, agents: r.agents?.length ?? null, onchainBalance: r.onchain?.balance ?? null, feedback: r.feedback })),
    rows: erc.map((r) => ({ payTo: r.wallet, listings: r.listings, chain: r.chain, inam: r.inam, agents: r.agents?.map((a) => `${a.chainId}:${a.agentId}`) ?? null, onchain: r.onchain, feedback: r.feedback, errors: r.errors })),
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${OUT}.json`, JSON.stringify(summary, null, 2) + "\n");

  const p = summary.payTo;
  const d = summary.domains;
  const md = `# x402 scan, ${DATE}

\`inam check\` run across ${LIMIT ? `a ${LIMIT}-row sample of ` : ""}the x402 Bazaar snapshot \`${SNAPSHOT}\` (${snap.source}, fetched ${String(snap.fetchedAt).slice(0, 10)}). Read-only; nothing was paid. Script: \`scripts/x402-scan.ts\`. Full numbers and per-wallet rows: \`${OUT}.json\`.

## payTo wallets

| | |
| --- | --- |
| Distinct payTo scanned | ${p.scanned} (${p.evm} EVM, ${p.nonEvm} Solana/other) |
| EVM payTo checked (lookups succeeded) | ${p.erc8004Checked} (${p.lookupErrors} lookup errors) |
| **No identity at all** (no ERC-8004 agent, no INAM link) | **${p.noIdentity} (${p.noIdentitySharePct}%)**, covering ${p.noIdentityListingSharePct}% of EVM listings |
| Own an ERC-8004 agent | ${p.withErc8004Identity} (${p.withErc8004IdentitySharePct}%) |
| ...with no feedback | ${p.erc8004NoFeedback} |
| ...with feedback, none task-tied | ${p.erc8004FeedbackNoneTaskTied} |
| ...with task-tied (INAM-receipt-backed) feedback | ${p.erc8004WithTaskTiedFeedback} |
| **ERC-8004 identity but no task-tied feedback** | **${p.withErc8004Identity - p.erc8004WithTaskTiedFeedback} of ${p.withErc8004Identity} (${p.erc8004WithoutTaskTiedFeedbackSharePct}%)** |
| Proven by an INAM ID | ${p.linkedToInamId} (registry has ${p.inamAgentsWithLinkedWallet} agents with a linked wallet) |

Non-EVM payTo addresses cannot hold an ERC-8004 identity or an INAM wallet link today.

## Hosts

| | |
| --- | --- |
| Hosts scanned | ${summary.hosts.scanned} |
| Valid Web Bot Auth key directory | ${summary.hosts.webBotAuthDirectoryValid} |
| Directory present but not validly signed | ${summary.hosts.webBotAuthDirectoryInvalid} |
${d ? `| Hosts on shared platforms (workers.dev, vercel.app, ...) | ${d.hostsOnSharedPlatforms} (${d.hostsOnSharedPlatformsSharePct}%) |
| Registrable domains with an RDAP date | ${d.domainsWithAge} of ${d.registrableDomains} |
| Registered under 30 / 90 days ago | ${d.domainsUnder30Days} / ${d.domainsUnder90Days} |
| Median domain age per host | ${d.medianHostDomainAgeDays} days |
` : ""}
## Method

${Object.entries(summary.methodology.definitions).map(([k, v]) => `- **${k}:** ${v}`).join("\n")}
`;
  writeFileSync(`${OUT}.md`, md);
  console.log(md);
}

if (!existsSync("package.json")) throw new Error("run from the repo root");
await main();
