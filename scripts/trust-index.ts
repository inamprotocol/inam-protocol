import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

/** Agent Trust Index: how many x402 Bazaar sellers have a verifiable track record?
 *
 * Read-only. Pages through the CDP Bazaar discovery list, snapshots it, and
 * asks the public INAM registry which payTo addresses an INAM ID proved
 * control of (SPEC.md §2.1 `linked.erc8004_id`, §11.2). The registry has no
 * reverse lookup by wallet, so we list every agent with a linked erc8004_id
 * (`/v1/agents/search?supports=erc8004_id`) and intersect. Optionally
 * probes a seeded random sample of endpoints without paying, to check
 * liveness and look for an `inam` extension in the 402.
 *
 *   npx tsx scripts/trust-index.ts                      # fetch + compute
 *   SNAPSHOT=data/trust-index/bazaar-facilitator.payai.network-2026-10-09.json.gz npx tsx scripts/trust-index.ts   # recompute from a saved snapshot
 *
 * Env: BAZAAR_URL (any facilitator's /discovery/resources; default CDP), INAM_URL,
 * SAMPLE (default 300, 0 to skip), SEED, OUT, NOTE (free text copied into the methodology). */
const BAZAAR_URL = process.env.BAZAAR_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const INAM_URL = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const SAMPLE = Number(process.env.SAMPLE ?? 300);
const SEED = Number(process.env.SEED ?? 20261008);
const DIR = "data/trust-index";
const OUT = process.env.OUT ?? `${DIR}/trust-index-2026-10.json`;
const UA = "inam-trust-index/1 (+https://github.com/inamprotocol/inam-protocol)";

type Accept = { scheme?: string; network?: string; asset?: string; amount?: string; maxAmountRequired?: string; payTo?: string; extra?: { name?: string } };
type Item = { resource: string; type?: string; x402Version?: number; accepts?: Accept[]; extensions?: Record<string, any>; lastUpdated?: string; method?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, tries = 6): Promise<any> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } }).catch((e) => e as Error);
    if (!(res instanceof Error) && res.ok) return res.json();
    const retryable = res instanceof Error || res.status === 429 || res.status >= 500;
    if (!retryable || i >= tries) throw new Error(`GET ${url} -> ${res instanceof Error ? res.message : res.status}`);
    const after = res instanceof Error ? 0 : Number(res.headers.get("retry-after")) * 1000;
    await sleep(Math.max(after || 0, 1000 * 2 ** i));
  }
}

async function fetchBazaar(): Promise<{ items: Item[]; reportedTotal: number | null; pages: number }> {
  const items: Item[] = [];
  let reportedTotal: number | null = null;
  let pages = 0;
  for (let offset = 0; ; ) {
    const page = await getJson(`${BAZAAR_URL}?limit=100&offset=${offset}`);
    pages++;
    const batch: Item[] = page.items ?? page.resources ?? [];
    reportedTotal = page.pagination?.total ?? reportedTotal;
    items.push(...batch);
    offset += batch.length;
    if (pages % 25 === 0) console.error(`bazaar: ${items.length}/${reportedTotal ?? "?"}`);
    if (batch.length === 0 || (reportedTotal !== null && offset >= reportedTotal)) break;
    await sleep(250); // ponytail: sequential + fixed pause, ~4 req/s; fine for ~350 pages
  }
  return { items, reportedTotal, pages };
}

async function fetchInamAgents(query: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await getJson(`${INAM_URL}/v1/agents/search?${query}&limit=200&offset=${offset}`);
    out.push(...page.agents);
    if (!page.hasMore) return out;
    await sleep(600); // registry allows 120 reads/min per IP
  }
}

const TESTNET = /sepolia|devnet|testnet|^eip155:(84532|80002|11155111|421614|43113)$|^solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1$/i;
const quantile =(sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const normAddr = (a: string) => (isEvm(a) ? a.toLowerCase() : a);
const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const top = (m: Map<string, number>, n = 25) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n));
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };

// Stablecoin amounts are 6-decimal atomic units; anything else is left unpriced.
// USDC by name, or by mint/contract when the name is missing (Base, Base Sepolia, Solana, Solana devnet).
const USDC_ASSETS = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]);
const isUsdStable = (a: Accept) => /^(usdc|usd coin|usdt|tether usd|usdt0)$/i.test(a.extra?.name ?? "") || USDC_ASSETS.has(normAddr(a.asset ?? ""));
const usdPrice = (a: Accept) => (isUsdStable(a) ? Number(a.amount ?? a.maxAmountRequired) / 1e6 : null);

// Seeded PRNG (mulberry32) so the liveness sample is reproducible.
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function decodeB64Json(v: string | null): any {
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { return null; }
}

type Probe = { resource: string; method: string; status: number | null; outcome: string; inamExtension: boolean; extensionKeys: string[] };

async function probe(item: Item): Promise<Probe> {
  const method = String(item.extensions?.bazaar?.info?.input?.method ?? item.method ?? "GET").toUpperCase();
  const base = { resource: item.resource, method, inamExtension: false, extensionKeys: [] as string[] };
  try {
    // No payment header is ever sent, so a working x402 server answers 402 and runs nothing.
    const res = await fetch(item.resource, {
      method,
      headers: { "user-agent": UA, accept: "application/json", ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }) },
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => "");
    let pr = decodeB64Json(res.headers.get("payment-required"));
    if (!pr && res.status === 402) try { pr = JSON.parse(text); } catch {}
    const keys = Object.keys(pr?.extensions ?? {});
    const outcome = res.status === 402 ? "402" : res.status === 404 || res.status === 410 ? "not_found" : res.status >= 500 ? "server_error" : res.status < 400 ? "2xx_3xx" : "other_4xx";
    return { ...base, status: res.status, outcome, inamExtension: keys.includes("inam"), extensionKeys: keys };
  } catch (e) {
    return { ...base, status: null, outcome: (e as Error).name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  let snapshotFile = process.env.SNAPSHOT;
  let fetchMeta: { reportedTotal: number | null; pages: number } | null = null;
  let items: Item[];
  let source = BAZAAR_URL;
  let fetchedAt = startedAt;
  if (snapshotFile) {
    const raw = readFileSync(snapshotFile);
    const snap = JSON.parse((snapshotFile.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
    items = snap.items;
    fetchMeta = snap.fetch;
    source = snap.source;
    fetchedAt = snap.fetchedAt;
  } else {
    const fetched = await fetchBazaar();
    items = fetched.items;
    fetchMeta = { reportedTotal: fetched.reportedTotal, pages: fetched.pages };
    snapshotFile = `${DIR}/bazaar-${new URL(BAZAAR_URL).hostname}-${startedAt.slice(0, 10)}.json.gz`;
    writeFileSync(snapshotFile, gzipSync(JSON.stringify({ source: BAZAAR_URL, fetchedAt: startedAt, fetch: fetchMeta, items })));
  }

  // Dedupe by resource URL (offset paging over a live list can repeat or skip rows).
  const byResource = new Map(items.map((i) => [i.resource, i]));
  const uniq = [...byResource.values()];

  const hosts = new Map<string, number>();
  const networks = new Map<string, number>();
  const assets = new Map<string, number>();
  const types = new Map<string, number>();
  const extKeys = new Map<string, number>();
  const payToListings = new Map<string, number>();
  const prices: number[] = [];
  let unpriced = 0;
  let inamInListing = 0;
  let testnetOnly = 0;
  for (const it of uniq) {
    const h = hostOf(it.resource);
    if (h) count(hosts, h);
    count(types, it.type ?? "unknown");
    for (const k of Object.keys(it.extensions ?? {})) count(extKeys, k);
    if (it.extensions?.inam) inamInListing++;
    const acc = it.accepts ?? [];
    if (acc.length && acc.every((a) => TESTNET.test(a.network ?? ""))) testnetOnly++;
    for (const n of new Set(acc.map((a) => a.network ?? "unknown"))) count(networks, n);
    for (const a of new Set(acc.map((a) => `${a.network}:${a.extra?.name ?? a.asset}`))) count(assets, a);
    for (const p of new Set(acc.filter((a) => a.payTo).map((a) => normAddr(a.payTo!)))) count(payToListings, p);
    const first = acc[0] ? usdPrice(acc[0]) : null;
    if (first === null || !Number.isFinite(first)) unpriced++;
    else prices.push(first);
  }
  prices.sort((a, b) => a - b);
  const payTos = [...payToListings.keys()];
  const evmPayTos = payTos.filter(isEvm);

  // INAM side. Also one direct `extensions=inam` filter query as a cross-check of the listing scan.
  const allAgents = await fetchInamAgents("include_demo=true&include_revoked=true");
  await sleep(600);
  const linkedAgents = await fetchInamAgents("supports=erc8004_id&include_demo=true&include_revoked=true");
  const linkedWallets = new Map(linkedAgents.map((a) => [String(a.linked.erc8004_id).toLowerCase(), a.id]));
  const matched = evmPayTos.filter((p) => linkedWallets.has(p));
  const bazaarInamFilter = await getJson(`${source}?extensions=inam&limit=100`).then((p) => p.pagination?.total ?? (p.items ?? []).length, (e) => `error: ${e.message}`);

  // Liveness + 402 inspection sample.
  let probes: Probe[] = [];
  if (SAMPLE > 0) {
    const httpItems = uniq.filter((i) => (i.type ?? "http") === "http" && /^https?:\/\//.test(i.resource));
    const r = rng(SEED);
    const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    // One random listing per host, then a random SAMPLE of hosts: sellers, not listings, so one bulk host can't dominate.
    const perHost = new Map<string, Item[]>();
    for (const it of httpItems) { const h = hostOf(it.resource)!; perHost.set(h, [...(perHost.get(h) ?? []), it]); }
    const sample = shuffle([...perHost.keys()].sort()).slice(0, SAMPLE).map((h) => shuffle(perHost.get(h)!)[0]);
    const queue = [...sample];
    await Promise.all(Array.from({ length: 4 }, async () => { for (let it; (it = queue.shift()); ) probes.push(await probe(it)); }));
  }
  const outcomes = new Map<string, number>();
  for (const p of probes) count(outcomes, p.outcome);
  const dead = probes.filter((p) => p.outcome === "not_found").length;
  const unreachable = probes.filter((p) => p.outcome === "network_error" || p.outcome === "timeout").length;
  const probeExtKeys = new Map<string, number>();
  for (const p of probes) for (const k of p.extensionKeys) count(probeExtKeys, k);

  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const result = {
    title: "Agent Trust Index #1",
    methodology: {
      generatedAt: new Date().toISOString(),
      catalog: new URL(source).hostname,
      note: process.env.NOTE ?? null,
      bazaarFetchedAt: fetchedAt,
      bazaarSnapshot: snapshotFile,
      sources: {
        bazaar: `${source} (public x402 Bazaar discovery list, GET /discovery/resources paged with limit=100&offset)`,
        inam: `${INAM_URL}/v1/agents/search (public read; supports=erc8004_id lists agents with a linked EVM wallet)`,
      },
      fetch: fetchMeta,
      definitions: {
        listing: "One discovery item, deduplicated by its resource URL.",
        host: "Hostname of the listing's resource URL.",
        payTo: "Every accepts[].payTo across listings; EVM addresses lowercased.",
        price: "First accepts[] entry, read as USD (6 decimals) only when it is USDC/USDT by extra.name or by a known USDC contract/mint; others are unpriced.",
        testnetOnly: "Every accepts[] network is a testnet (Sepolia, devnet, testnet ids).",
        verifiableTrackRecord: "The payTo equals the linked.erc8004_id of an INAM agent, i.e. an INAM ID proved control of that wallet (SPEC.md §2.1). Only EVM addresses can be bound today.",
        inamReverseLookup: "The registry has no query by wallet. We listed every INAM agent with a linked erc8004_id and intersected.",
        dead: "Sample probe returned 404/410. Requests that failed (DNS, connect, TLS) or timed out after 15 s are counted separately as unreachable, because the probing network can cause them.",
        probe: "One unpaid request per sampled endpoint using the method the listing declares (GET if none; '{}' JSON body for non-GET). No payment header is sent.",
      },
      sample: { size: probes.length, seed: SEED, population: "distinct hosts of http listings with an http(s) URL; one random listing probed per sampled host", concurrency: 4 },
    },
    bazaar: {
      listingsReturned: items.length,
      listings: uniq.length,
      reportedTotal: fetchMeta?.reportedTotal ?? null,
      types: Object.fromEntries(types),
      distinctHosts: hosts.size,
      hostsWithOneListing: [...hosts.values()].filter((n) => n === 1).length,
      topHosts: top(hosts, 10),
      distinctPayTo: payTos.length,
      distinctPayToEvm: evmPayTos.length,
      distinctPayToNonEvm: payTos.length - evmPayTos.length,
      payToWithOneListing: [...payToListings.values()].filter((n) => n === 1).length,
      topPayToByListings: top(payToListings, 10),
      networks: top(networks, 30),
      assets: top(assets, 30),
      price: { priced: prices.length, unpriced, minUsd: prices[0] ?? null, medianUsd: quantile(prices, 0.5), p90Usd: quantile(prices, 0.9), maxUsd: prices.at(-1) ?? null },
      extensionKeysInListings: top(extKeys, 20),
      testnetOnlyListings: testnetOnly,
      listingsWithInamExtension: inamInListing,
      bazaarExtensionsInamFilterTotal: bazaarInamFilter,
    },
    inam: {
      agentsInRegistry: allAgents.length,
      agentsInRegistryNonDemo: allAgents.filter((a) => a.metadata?.demo !== true).length,
      agentsWithLinkedErc8004Wallet: linkedAgents.length,
      bazaarPayToProvenByInamAgent: matched.length,
      matchedPayTo: matched.map((p) => ({ payTo: p, did: linkedWallets.get(p) })),
      shareOfDistinctPayTo: pct(matched.length, payTos.length),
    },
    liveness: {
      sampleSize: probes.length,
      outcomes: Object.fromEntries(outcomes),
      deadCount: dead,
      deadSharePct: pct(dead, probes.length),
      unreachableCount: unreachable,
      unreachableSharePct: pct(unreachable, probes.length),
      answered402: outcomes.get("402") ?? 0,
      answered402WithInamExtension: probes.filter((p) => p.inamExtension).length,
      extensionKeysIn402: top(probeExtKeys, 20),
      probes,
    },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  const { probes: _p, ...liveSummary } = result.liveness;
  console.log(JSON.stringify({ bazaar: { ...result.bazaar, topHosts: undefined, topPayToByListings: undefined, assets: undefined }, inam: result.inam, liveness: liveSummary }, null, 2));
}

if (!existsSync("package.json")) throw new Error("run from the repo root");
await main();
