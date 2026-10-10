import { keccak_256 } from "@noble/hashes/sha3.js";
import { decideTrust } from "./trust.js";
import { decideX402, INAM_X402_EXTENSION } from "./x402.js";
import { DIRECTORY_PATH, verifyDirectoryResponse } from "./webBotAuth.js";
import type { AgentRecord, ReputationResult } from "./types.js";

/** `inam check <url | 0x wallet | did:key>`: a pre-payment check built from public signals.
 *
 * Useful with no INAM data at all: it reads the x402 402 response, asks ERC-8004 (on-chain
 * through a public RPC, plus the 8004scan indexer for the reverse lookup by owner), looks for a
 * Web Bot Auth key directory and the domain's RDAP registration date, and adds INAM's wallet
 * link and receipts when they exist. It reports what it found, not a score. */

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface CheckItem {
  id: string;
  status: CheckStatus;
  label: string;
  detail?: string;
}
export interface PaymentOption {
  scheme?: string;
  network: string;
  chainId: number | null;
  asset?: string;
  amount?: string;
  /** Human price when the asset is a known 6-decimal USD stablecoin. */
  price?: string;
  payTo: string;
  testnet: boolean;
}
export interface CheckReport {
  target: string;
  kind: "url" | "wallet" | "did";
  /** Worst status among the checks: any fail is "fail", any warn is "caution". */
  verdict: "pass" | "caution" | "fail";
  checkedAt: string;
  payment?: { x402Version?: number; status: number; resource?: string; description?: string; accepts: PaymentOption[]; inamDid?: string };
  checks: CheckItem[];
}
export interface CheckOptions {
  registryUrl?: string;
  /** ERC-8004 indexer used for the reverse lookup by owner (no on-chain index exists). */
  indexerUrl?: string;
  /** chainId -> JSON-RPC URL; merged over the public defaults. */
  rpc?: Record<number, string>;
  method?: string;
  timeoutMs?: number;
  /** wallet (lowercase) -> INAM ID, if the caller already listed linked agents (the bulk scan does). */
  linkedWallets?: Map<string, string>;
  /** Skip the RDAP domain-age lookup. */
  noRdap?: boolean;
  /** Retries after HTTP 429 from the indexer and RDAP (default 1). The bulk scan raises it. */
  retries?: number;
  /** fetch used for every outbound request (default: global fetch). The hosted check injects one that signs with Web Bot Auth. */
  fetch?: typeof fetch;
}

export const ERC8004 = {
  identity: { mainnet: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", testnet: "0x8004A818BFB912233c491871b3d84c89A494BD9e" },
  reputation: { mainnet: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", testnet: "0x8004B663056A597Dffe9eCcC1965A193B7388713" },
};
/** Keyless public RPCs. Other chains are covered by the indexer only, or by `rpc` / INAM_RPC_<chainId>. */
export const DEFAULT_RPC: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
};
const TESTNET_CHAINS = new Set([84532, 11155111, 80002, 43113, 421614, 11155420]);
const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 8453: "Base", 84532: "Base Sepolia", 137: "Polygon", 43114: "Avalanche", 11155111: "Sepolia" };
// x402 v1 network names.
const V1_NETWORKS: Record<string, number> = { base: 8453, "base-sepolia": 84532, ethereum: 1, sepolia: 11155111, polygon: 137, "polygon-amoy": 80002, avalanche: 43114, "avalanche-fuji": 43113 };
const USDC_ASSETS = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]);
export const SHARED_HOSTING = /(^|\.)(workers\.dev|pages\.dev|vercel\.app|netlify\.app|onrender\.com|herokuapp\.com|fly\.dev|railway\.app|replit\.app|repl\.co|github\.io|deno\.dev|run\.app|azurewebsites\.net|ngrok-free\.app|ngrok\.app|trycloudflare\.com|amazonaws\.com|cloudfront\.net|web\.app|firebaseapp\.com|supabase\.co|modal\.run|lovable\.app|up\.railway\.app|ngrok-free\.dev|ondigitalocean\.app|convex\.site|chatgpt\.site|hstgr\.cloud|zuplo\.dev|deno\.net|val\.run|duckdns\.org|ddns\.net|servehttp\.com|contaboserver\.net|sslip\.io|nip\.io)$/i;
const UA = "inam-check/1 (+https://github.com/inamprotocol/inam-protocol)";
const STATUS_RANK: Record<CheckStatus, number> = { info: 0, pass: 0, warn: 1, fail: 2 };

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const chainIdOf = (network: string): number | null => {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : (V1_NETWORKS[network.toLowerCase()] ?? null);
};
const chainName = (id: number) => CHAIN_NAMES[id] ?? `chain ${id}`;
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);

type Fetch = typeof fetch;
function timedFetch(url: string, init: RequestInit = {}, timeoutMs = 10000, f: Fetch = fetch) {
  return f(url, { ...init, headers: { "user-agent": UA, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeoutMs) });
}
/** GET JSON; on 429 waits (Retry-After, else 15 s, doubling) and retries up to `retries` times. */
async function getJson(url: string, timeoutMs?: number, retries = 1, f?: Fetch): Promise<any> {
  for (let i = 0; ; i++) {
    const res = await timedFetch(url, { headers: { accept: "application/json" } }, timeoutMs, f);
    if (res.ok) return res.json();
    if (res.status !== 429 || i >= retries) throw new Error(`GET ${url} -> ${res.status}`);
    await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 15 * 2 ** i) * 1000));
  }
}

// ---------- x402 ----------

/** Payment requirements from a 402: the v2 PAYMENT-REQUIRED header, or the v1 JSON body. */
export function parsePaymentRequired(headers: Headers, body: string): any | null {
  const h = headers.get("payment-required");
  if (h) {
    try {
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h), (c) => c.charCodeAt(0))));
    } catch {}
  }
  try {
    const j = JSON.parse(body);
    return Array.isArray(j?.accepts) ? j : null;
  } catch {
    return null;
  }
}

export function paymentOptions(required: any): PaymentOption[] {
  return (required?.accepts ?? [])
    .filter((a: any) => typeof a?.payTo === "string")
    .map((a: any) => {
      const network = String(a.network ?? "unknown");
      const chainId = chainIdOf(network);
      const amount = a.amount ?? a.maxAmountRequired;
      const stable = /^(usdc|usd coin|usdt|tether usd|usdt0)$/i.test(a.extra?.name ?? "") || USDC_ASSETS.has(isEvmAddress(a.asset ?? "") ? a.asset.toLowerCase() : a.asset);
      const testnet = (chainId !== null && TESTNET_CHAINS.has(chainId)) || /sepolia|devnet|testnet|fuji|amoy/i.test(network);
      return {
        scheme: a.scheme,
        network,
        chainId,
        asset: a.asset,
        amount: amount === undefined ? undefined : String(amount),
        price: stable && amount !== undefined && Number.isFinite(Number(amount)) ? `${Number(amount) / 1e6} ${a.extra?.name ?? "USDC"}` : undefined,
        payTo: a.payTo,
        testnet,
      };
    });
}

// ---------- ERC-8004 ----------

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uintWord = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const selector = (sig: string) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
function strTail(s: string) {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return uintWord(s.length) + (hex ? hex.padEnd(Math.ceil(hex.length / 64) * 64, "0") : "");
}

async function ethCall(rpc: string, to: string, data: string, timeoutMs?: number, f?: Fetch): Promise<string> {
  const res = await timedFetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: `0x${data}` }, "latest"] }) }, timeoutMs, f);
  const j: any = await res.json();
  if (j.error || typeof j.result !== "string") throw new Error(`eth_call: ${j.error?.message ?? res.status}`);
  return j.result.slice(2);
}
const readWord = (hex: string, i: number) => BigInt(`0x${hex.slice(i * 64, i * 64 + 64) || "0"}`);

export async function erc8004Balance(rpc: string, chainId: number, wallet: string, timeoutMs?: number, f?: Fetch): Promise<number> {
  const reg = TESTNET_CHAINS.has(chainId) ? ERC8004.identity.testnet : ERC8004.identity.mainnet;
  return Number(readWord(await ethCall(rpc, reg, selector("balanceOf(address)") + word(wallet), timeoutMs, f), 0));
}

/** Feedback on one agent from the Reputation Registry: all of it, and the part tagged as INAM-receipt-backed (SPEC.md §11.1). */
export async function erc8004Feedback(rpc: string, chainId: number, agentId: number, timeoutMs?: number, f?: Fetch): Promise<{ total: number; receiptBacked: number }> {
  const reg = TESTNET_CHAINS.has(chainId) ? ERC8004.reputation.testnet : ERC8004.reputation.mainnet;
  const raw = await ethCall(rpc, reg, selector("getClients(uint256)") + uintWord(agentId), timeoutMs, f);
  const n = Number(readWord(raw, 1));
  const clients = Array.from({ length: n }, (_, i) => `0x${raw.slice((2 + i) * 64 + 24, (3 + i) * 64)}`);
  if (!clients.length) return { total: 0, receiptBacked: 0 };
  const summary = async (tag1: string) => {
    const arr = uintWord(clients.length) + clients.map(word).join("");
    const t1 = strTail(tag1);
    const t2 = strTail("");
    const head = uintWord(agentId) + uintWord(128) + uintWord(128 + arr.length / 2) + uintWord(128 + arr.length / 2 + t1.length / 2);
    return Number(readWord(await ethCall(rpc, reg, selector("getSummary(uint256,address[],string,string)") + head + arr + t1 + t2, timeoutMs, f), 0));
  };
  const [total, receiptBacked] = await Promise.all([summary(""), summary("inam-receipt")]);
  return { total, receiptBacked };
}

export interface Erc8004Agent {
  chainId: number;
  agentId: number;
  name?: string;
  feedbacks: number;
  testnet: boolean;
}

/** Agents a wallet owns, from the indexer (on-chain ERC-721 has no enumeration by owner). */
export async function erc8004AgentsByOwner(indexerUrl: string, wallet: string, timeoutMs?: number, retries?: number, f?: Fetch): Promise<Erc8004Agent[]> {
  const j = await getJson(`${indexerUrl}/api/v1/agents?owner_address=${wallet.toLowerCase()}&limit=100`, timeoutMs, retries, f);
  return (j.items ?? [])
    .filter((i: any) => String(i.owner_address).toLowerCase() === wallet.toLowerCase())
    .map((i: any) => ({ chainId: Number(i.chain_id), agentId: Number(i.token_id), name: i.name, feedbacks: Number(i.total_feedbacks ?? 0), testnet: Boolean(i.is_testnet) }));
}

export interface WalletErc8004 {
  agents: Erc8004Agent[] | null;
  onchain: { chainId: number; balance: number } | null;
  feedback: { total: number; receiptBacked: number; source: "onchain" | "indexer" } | null;
  errors: string[];
}

export async function walletErc8004(wallet: string, chainId: number | null, opts: CheckOptions = {}): Promise<WalletErc8004> {
  const indexer = opts.indexerUrl ?? "https://api.8004scan.io";
  const rpcs = { ...DEFAULT_RPC, ...opts.rpc };
  const chain = chainId ?? 8453;
  const rpc = (typeof process !== "undefined" && process.env?.[`INAM_RPC_${chain}`]) || rpcs[chain];
  const errors: string[] = [];
  const [agents, balance] = await Promise.all([
    erc8004AgentsByOwner(indexer, wallet, opts.timeoutMs, opts.retries, opts.fetch).catch((e) => (errors.push(`indexer: ${e.message}`), null)),
    rpc ? erc8004Balance(rpc, chain, wallet, opts.timeoutMs, opts.fetch).catch((e) => (errors.push(`rpc ${chainName(chain)}: ${e.message}`), null)) : null,
  ]);
  let feedback: WalletErc8004["feedback"] = null;
  const onChain = (agents ?? []).filter((a) => a.chainId === chain).slice(0, 3); // ponytail: first 3 agents on the payment chain
  if (rpc && onChain.length) {
    try {
      const rows = await Promise.all(onChain.map((a) => erc8004Feedback(rpc, chain, a.agentId, opts.timeoutMs, opts.fetch)));
      feedback = { total: rows.reduce((s, r) => s + r.total, 0), receiptBacked: rows.reduce((s, r) => s + r.receiptBacked, 0), source: "onchain" };
    } catch (e) {
      errors.push(`rpc feedback: ${(e as Error).message}`);
    }
  }
  if (!feedback && agents?.length) feedback = { total: agents.reduce((s, a) => s + a.feedbacks, 0), receiptBacked: 0, source: "indexer" };
  return { agents, onchain: balance === null ? null : { chainId: chain, balance }, feedback, errors };
}

function erc8004Items(wallet: string, r: WalletErc8004): CheckItem[] {
  const owned = Math.max(r.agents?.length ?? 0, r.onchain?.balance ?? 0);
  const chains = [...new Set((r.agents ?? []).map((a) => chainName(a.chainId)))];
  const where = r.onchain ? ` (on-chain on ${chainName(r.onchain.chainId)}: ${r.onchain.balance})` : "";
  if (r.agents === null && r.onchain === null) return [{ id: "erc8004.identity", status: "info", label: "ERC-8004 identity: could not check", detail: r.errors.join("; ") }];
  if (!owned)
    return [{ id: "erc8004.identity", status: "warn", label: `No ERC-8004 identity owned by ${short(wallet)}${where}`, detail: "Only ownership is reverse-indexed; an agent that set this as agentWallet without owning it is not found." }];
  const items: CheckItem[] = [{ id: "erc8004.identity", status: "pass", label: `ERC-8004: owns ${owned} agent${owned > 1 ? "s" : ""}${chains.length ? ` on ${chains.slice(0, 4).join(", ")}${chains.length > 4 ? "…" : ""}` : ""}${where}`, detail: (r.agents ?? []).slice(0, 5).map((a) => `${a.chainId}:${a.agentId}${a.name ? ` ${a.name}` : ""}`).join(", ") || undefined }];
  const f = r.feedback;
  if (!f) items.push({ id: "erc8004.feedback", status: "info", label: "ERC-8004 feedback: not checked", detail: r.errors.join("; ") || undefined });
  else if (f.receiptBacked > 0) items.push({ id: "erc8004.feedback", status: "pass", label: `ERC-8004 feedback: ${f.total}, of which ${f.receiptBacked} backed by a signed INAM receipt` });
  else if (f.total > 0) items.push({ id: "erc8004.feedback", status: "warn", label: `ERC-8004 feedback: ${f.total}, none tied to a task receipt`, detail: "Bare scores: any wallet can send them, nothing links them to delivered work." });
  else items.push({ id: "erc8004.feedback", status: "warn", label: "ERC-8004 feedback: none" });
  return items;
}

// ---------- INAM ----------

/** Every INAM agent with a proven EVM wallet (`linked.erc8004_id`), keyed by lowercase wallet. The registry has no lookup by wallet. */
export async function inamLinkedWallets(registryUrl = "https://api.inamprotocol.org", timeoutMs?: number, f?: Fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 200) {
    const page = await getJson(`${registryUrl}/v1/agents/search?supports=erc8004_id&include_demo=true&include_revoked=true&limit=200&offset=${offset}`, timeoutMs, 1, f);
    for (const a of page.agents ?? []) if (a.linked?.erc8004_id) out.set(String(a.linked.erc8004_id).toLowerCase(), a.id);
    if (!page.hasMore) return out;
  }
}

async function agentAndReputation(registryUrl: string, did: string, f?: Fetch): Promise<[AgentRecord, ReputationResult] | null> {
  const base = `${registryUrl}/v1/agents/${encodeURIComponent(did)}`;
  try {
    return await Promise.all([getJson(base, undefined, 0, f), getJson(`${base}/reputation`, undefined, 0, f)]);
  } catch {
    return null;
  }
}

function reputationItem(agent: AgentRecord, rep: ReputationResult): CheckItem {
  const d = decideTrust(agent, rep);
  const c = rep.components;
  const label = `INAM reputation: evidence ${rep.evidenceLevel}, ${c.finalizedReceipts} countersigned receipt${c.finalizedReceipts === 1 ? "" : "s"}, ${c.attestedReceipts} independently verified, trustScore ${rep.trustScore}`;
  return { id: "inam.reputation", status: d.decision === "allow" ? "pass" : d.decision === "escrow" ? "warn" : "fail", label, detail: [`decision: ${d.decision}`, ...d.reasons, ...(rep.flags.length ? [`flags: ${rep.flags.join(", ")}`] : [])].join("; ") };
}

async function walletInam(wallet: string, opts: CheckOptions): Promise<CheckItem[]> {
  const registry = opts.registryUrl ?? "https://api.inamprotocol.org";
  let linked: Map<string, string>;
  try {
    linked = opts.linkedWallets ?? (await inamLinkedWallets(registry, opts.timeoutMs, opts.fetch));
  } catch (e) {
    return [{ id: "inam.link", status: "info", label: "INAM wallet link: registry unreachable", detail: (e as Error).message }];
  }
  const did = linked.get(wallet.toLowerCase());
  if (!did) return [{ id: "inam.link", status: "warn", label: `${short(wallet)} is not linked to any INAM ID`, detail: "No INAM ID proved control of this wallet, so there are no receipts to read." }];
  const items: CheckItem[] = [{ id: "inam.link", status: "pass", label: `${short(wallet)} is proven by INAM ID ${did}` }];
  const ar = await agentAndReputation(registry, did, opts.fetch);
  if (ar) items.push(reputationItem(...ar));
  return items;
}

// ---------- web: directory, domain ----------

export async function directoryItem(origin: string, timeoutMs?: number, f?: Fetch): Promise<CheckItem> {
  const host = new URL(origin).host;
  try {
    const res = await timedFetch(`${origin}${DIRECTORY_PATH}`, { headers: { accept: "application/http-message-signatures-directory+json, application/json" }, redirect: "manual" }, timeoutMs, f);
    if (res.status !== 200) return { id: "webbotauth.directory", status: "info", label: `No Web Bot Auth key directory (HTTP ${res.status})`, detail: "Common for sellers: Web Bot Auth mostly identifies callers." };
    const v = verifyDirectoryResponse(host, res.headers, await res.text());
    if (!v.keys) return { id: "webbotauth.directory", status: "info", label: "No Web Bot Auth key directory (HTTP 200, but not a JWKS of Ed25519 keys)" };
    return v.valid
      ? { id: "webbotauth.directory", status: "pass", label: `Web Bot Auth key directory: ${v.keys} key${v.keys === 1 ? "" : "s"}, signature valid`, detail: `keyid ${v.keyid}` }
      : { id: "webbotauth.directory", status: "warn", label: "Web Bot Auth key directory present but not validly signed", detail: v.reason };
  } catch (e) {
    return { id: "webbotauth.directory", status: "info", label: "Web Bot Auth key directory: could not fetch", detail: (e as Error).message };
  }
}

/** Last two labels, or three under a two-letter ccTLD's co/com/org/net/ac/gov/edu. */
// ponytail: not the Public Suffix List; good enough to pick an RDAP query, wrong for rare suffixes.
export function registrableDomain(host: string): string {
  const p = host.toLowerCase().split(".");
  const n = p.length >= 3 && p.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(p.at(-2)!) ? 3 : 2;
  return p.slice(-n).join(".");
}

export async function domainItem(host: string, timeoutMs?: number, retries?: number, f?: Fetch): Promise<CheckItem> {
  if (/^(localhost|[\d.]+|\[.*\])$/.test(host)) return { id: "domain.age", status: "info", label: `Domain age: n/a for ${host}` };
  if (SHARED_HOSTING.test(host)) return { id: "domain.age", status: "info", label: `${host} is a subdomain of a shared hosting platform`, detail: "Anyone can create one in minutes; the platform domain's age says nothing about the seller." };
  const domain = registrableDomain(host);
  try {
    const j = await getJson(`https://rdap.org/domain/${domain}`, timeoutMs, retries, f);
    const reg = (j.events ?? []).find((e: any) => e.eventAction === "registration")?.eventDate;
    if (!reg) return { id: "domain.age", status: "info", label: `Domain age: RDAP has no registration date for ${domain}` };
    const days = Math.floor((Date.now() - Date.parse(reg)) / 86400000);
    return { id: "domain.age", status: days < 30 ? "warn" : "pass", label: `${domain} registered ${String(reg).slice(0, 10)} (${days} days ago)` };
  } catch (e) {
    const noService = /-> 404$/.test((e as Error).message);
    return { id: "domain.age", status: "info", label: noService ? `Domain age: no public RDAP record for ${domain} (common for .io, .co, .ch, .ru)` : `Domain age: RDAP lookup failed for ${domain}`, detail: (e as Error).message };
  }
}

// ---------- targets ----------

function finish(target: string, kind: CheckReport["kind"], checks: CheckItem[], payment?: CheckReport["payment"]): CheckReport {
  const worst = Math.max(0, ...checks.map((c) => STATUS_RANK[c.status]));
  return { target, kind, verdict: worst === 2 ? "fail" : worst === 1 ? "caution" : "pass", checkedAt: new Date().toISOString(), ...(payment ? { payment } : {}), checks };
}

export async function checkWallet(wallet: string, opts: CheckOptions & { chainId?: number | null } = {}): Promise<CheckReport> {
  if (!isEvmAddress(wallet)) return finish(wallet, "wallet", [{ id: "target", status: "fail", label: "Not an EVM address (0x + 40 hex)" }]);
  const [erc, inam] = await Promise.all([walletErc8004(wallet, opts.chainId ?? null, opts), walletInam(wallet, opts)]);
  return finish(wallet, "wallet", [...erc8004Items(wallet, erc), ...inam]);
}

export async function checkDid(did: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const ar = await agentAndReputation(opts.registryUrl ?? "https://api.inamprotocol.org", did, opts.fetch);
  if (!ar) return finish(did, "did", [{ id: "inam.agent", status: "fail", label: "INAM ID not found in the registry" }]);
  const [agent, rep] = ar;
  const checks: CheckItem[] = [agent.revokedAt ? { id: "inam.agent", status: "fail", label: `INAM ID revoked at ${agent.revokedAt}` } : { id: "inam.agent", status: "pass", label: `INAM ID registered ${agent.createdAt ?? ""}`.trim() }, reputationItem(agent, rep)];
  const wallet = agent.linked?.erc8004_id;
  if (wallet) {
    checks.push({ id: "inam.link", status: "pass", label: `Proven EVM wallet ${wallet}` });
    checks.push(...erc8004Items(wallet, await walletErc8004(wallet, null, opts)));
  } else checks.push({ id: "inam.link", status: "info", label: "No proven EVM wallet: an x402 payee using this ID cannot be bound to its payTo" });
  return finish(did, "did", checks);
}

export async function checkUrl(url: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const u = new URL(url);
  const checks: CheckItem[] = [];
  const local = /^(localhost|127\.|\[::1\])/.test(u.hostname);
  const method = (opts.method ?? "GET").toUpperCase();
  const side = Promise.all([directoryItem(u.origin, opts.timeoutMs, opts.fetch), opts.noRdap ? null : domainItem(u.hostname, opts.timeoutMs, undefined, opts.fetch)]);

  let res: Response;
  let body = "";
  try {
    res = await timedFetch(url, { method, headers: { accept: "application/json", ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }) }, body: method === "GET" || method === "HEAD" ? undefined : "{}" }, opts.timeoutMs ?? 15000, opts.fetch);
    body = await res.text().catch(() => "");
  } catch (e) {
    if (u.protocol !== "https:" && !local) checks.push({ id: "tls", status: "fail", label: "Not HTTPS: the 402 and its payTo can be rewritten in transit" });
    checks.push({ id: "x402.response", status: "fail", label: "Endpoint unreachable", detail: (e as Error).message });
    const [dir, dom] = await side;
    return finish(url, "url", [...checks, dir, ...(dom ? [dom] : [])]);
  }
  const final = new URL(res.url || url);
  if (final.protocol === "https:") checks.push(u.protocol === "https:" ? { id: "tls", status: "pass", label: "HTTPS, certificate accepted" } : { id: "tls", status: "warn", label: `Listed as http; redirects to ${final.origin}`, detail: "The first request is unprotected; use the https URL." });
  else if (!local) checks.push({ id: "tls", status: "fail", label: "Not HTTPS: the 402 and its payTo can be rewritten in transit" });
  const required = res.status === 402 ? parsePaymentRequired(res.headers, body) : null;
  const accepts = paymentOptions(required);
  if (res.status !== 402) checks.push({ id: "x402.response", status: "fail", label: `Not an x402 paywall: HTTP ${res.status}${method === "GET" ? " (try --method POST)" : ""}` });
  else if (!accepts.length) checks.push({ id: "x402.response", status: "fail", label: "402 without readable payment requirements (no PAYMENT-REQUIRED header or accepts[].payTo)" });
  else checks.push({ id: "x402.response", status: "pass", label: `402 with ${accepts.length} payment option${accepts.length > 1 ? "s" : ""} (x402 v${required.x402Version ?? "?"})` });
  if (accepts.length && accepts.every((a) => a.testnet)) checks.push({ id: "x402.testnet", status: "info", label: "Testnet-only payment options" });

  const inamDid = typeof required?.extensions?.[INAM_X402_EXTENSION]?.info?.did === "string" ? (required.extensions[INAM_X402_EXTENSION].info.did as string) : undefined;
  const payment = required
    ? { x402Version: required.x402Version, status: res.status, resource: required.resource?.url ?? required.resource ?? required.accepts?.[0]?.resource, description: required.resource?.description ?? required.accepts?.[0]?.description, accepts, ...(inamDid ? { inamDid } : {}) }
    : { status: res.status, accepts };

  const registry = opts.registryUrl ?? "https://api.inamprotocol.org";
  const linked = opts.linkedWallets ?? (await inamLinkedWallets(registry, opts.timeoutMs, opts.fetch).catch(() => undefined));
  // One check per distinct payTo; the last entry wins, so sort the chains we can read on-chain last.
  const rpcs = { ...DEFAULT_RPC, ...opts.rpc };
  const payTos = [...new Map([...accepts].sort((a, b) => Number(Boolean(rpcs[a.chainId ?? -1])) - Number(Boolean(rpcs[b.chainId ?? -1]))).map((a) => [isEvmAddress(a.payTo) ? a.payTo.toLowerCase() : a.payTo, a])).values()];
  const perPayTo = await Promise.all(
    payTos.map(async (a): Promise<CheckItem[]> => {
      if (!isEvmAddress(a.payTo)) return [{ id: "payto.nonevm", status: "info", label: `payTo ${short(a.payTo)} on ${a.network}: not an EVM address, so ERC-8004 and INAM wallet links do not apply` }];
      const [erc, inam] = await Promise.all([walletErc8004(a.payTo, a.chainId, opts), linked ? walletInam(a.payTo, { ...opts, linkedWallets: linked }) : walletInam(a.payTo, opts)]);
      return [...erc8004Items(a.payTo, erc), ...inam];
    }),
  );
  checks.push(...perPayTo.flat());

  if (inamDid) {
    const ar = await agentAndReputation(registry, inamDid, opts.fetch);
    if (!ar) checks.push({ id: "inam.extension", status: "fail", label: `402 names INAM ID ${inamDid}, which the registry does not know` });
    else {
      const d = decideX402(ar[0], ar[1], accepts.map((a) => a.payTo), { minEvidence: "none" });
      checks.push(d.allow ? { id: "inam.extension", status: "pass", label: `402 names INAM ID ${inamDid} and payTo is its proven wallet` } : { id: "inam.extension", status: "fail", label: `402 names INAM ID ${inamDid}: ${d.reason}`, detail: "A seller can name a reputable ID while routing the money elsewhere; do not pay." });
      if (!checks.some((c) => c.id === "inam.reputation")) checks.push(reputationItem(...ar));
    }
  }
  const [dir, dom] = await side;
  checks.push(dir, ...(dom ? [dom] : []));
  return finish(url, "url", checks, payment);
}

export function checkTarget(target: string, opts: CheckOptions = {}): Promise<CheckReport> {
  if (/^https?:\/\//i.test(target)) return checkUrl(target, opts);
  if (isEvmAddress(target)) return checkWallet(target, opts);
  if (/^did:key:z/.test(target)) return checkDid(target, opts);
  throw new Error(`unrecognized target ${JSON.stringify(target)}: expected an http(s) URL, a 0x wallet address, or a did:key`);
}

const NEXT: Record<string, string> = {
  target: "Pass an http(s) URL, a 0x wallet address (40 hex), or a did:key.",
  tls: "Do not pay over plain HTTP; ask the seller for an https endpoint.",
  "x402.response": "Confirm the URL is an x402 paywall (retry with method=POST if it expects one) before paying.",
  "inam.extension": "Do not pay: the INAM ID named in the 402 does not prove this payTo wallet.",
  "inam.agent": "This INAM ID is unknown or revoked; do not rely on it.",
  "inam.reputation": "Read the INAM reputation reasons; pay through escrow or start with a small payment.",
  "inam.link": "Ask the seller to link payTo to an INAM ID so signed receipts can back it, or start with a small payment.",
  "erc8004.identity": "Ask the seller to register an ERC-8004 identity owned by payTo, or start with a small payment.",
  "erc8004.feedback": "Feedback is not tied to delivered work; start with a small payment and record a receipt.",
  "domain.age": "The domain is under 30 days old; start with a small payment.",
  "webbotauth.directory": "The seller's key directory signature is invalid; treat its Web Bot Auth identity as unverified.",
};

/** One short next step for an agent, from the first check with the worst status. */
export function nextStep(r: CheckReport): string {
  const rank = Math.max(0, ...r.checks.map((c) => STATUS_RANK[c.status]));
  if (!rank) return "Nothing failed; proceed, and record a signed INAM receipt after the job so the next buyer can see it.";
  const worst = r.checks.find((c) => STATUS_RANK[c.status] === rank)!;
  return NEXT[worst.id] ?? `Read the ${worst.status} line "${worst.label}" before paying.`;
}

const MARK: Record<CheckStatus, string> = { pass: "[ ok ]", warn: "[warn]", fail: "[FAIL]", info: "[info]" };
const VERDICT: Record<CheckReport["verdict"], string> = {
  pass: "PASS     nothing failed and nothing needs a second look",
  caution: "CAUTION  nothing failed, but some signals are missing; read the [warn] lines before paying",
  fail: "FAIL     a key check failed; do not pay this endpoint as it stands",
};

export function formatReport(r: CheckReport): string {
  const out = [`inam check ${r.target}`, "", `  verdict  ${VERDICT[r.verdict]}`];
  if (r.payment?.accepts.length) {
    out.push("", "  payment requirements");
    if (r.payment.resource) out.push(`    resource  ${r.payment.resource}`);
    if (r.payment.description) out.push(`    about     ${String(r.payment.description).slice(0, 100)}`);
    for (const a of r.payment.accepts) out.push(`    payTo     ${a.payTo}  ${a.price ?? `${a.amount ?? "?"} of ${a.asset ? short(a.asset) : "?"}`} on ${a.chainId ? `${chainName(a.chainId)} (${a.network})` : a.network}`);
    if (r.payment.inamDid) out.push(`    inam      ${r.payment.inamDid}`);
  }
  out.push("", "  checks");
  for (const c of r.checks) {
    out.push(`    ${MARK[c.status]} ${c.label}`);
    if (c.detail && c.status !== "pass") out.push(`           ${c.detail}`);
  }
  return out.join("\n");
}
