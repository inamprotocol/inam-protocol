// AER-1 chain + chain-commitment reader, written from draft-zambo-aer1-26 Sections 7.1-7.3 only.
// Usage: node interop/aer1/chain.mjs <dir filled by fetch.mjs>
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BS = String.fromCharCode(92); // one reverse solidus
// Section 7.1 string escaping (Python json.dumps, ensure_ascii=True).
const esc = (s) => '"' + [...s].map((ch) => {
  const c = ch.codePointAt(0);
  if (c === 0x22) return BS + '"'; if (c === 0x5c) return BS + BS;
  if (c === 8) return BS + "b"; if (c === 9) return BS + "t"; if (c === 10) return BS + "n"; if (c === 12) return BS + "f"; if (c === 13) return BS + "r";
  if (c >= 0x20 && c <= 0x7e) return ch;
  const u = (n) => BS + "u" + n.toString(16).padStart(4, "0");
  return c > 0xffff ? u(ch.charCodeAt(0)) + u(ch.charCodeAt(1)) : u(c);
}).join("") + '"';
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

function entryDigest(e) {
  const outputHash = sha(Buffer.from(e.canonical_bytes, "base64"));
  return sha(Buffer.from(`{"close":${e.close === true},"id":${esc(e.id)},"job_id":${esc(e.job_id)},"output_hash":"${outputHash}","prev_digest":${esc(e.prev_digest)},"provenance_class":${esc(e.provenance_class)},"seq":${e.seq},"tool":${esc(e.tool)}}`, "utf8"));
}

/** Returns null when the timeline verifies, else the reason. */
export function verifyChain(t) {
  if (!Array.isArray(t) || t.length === 0) return "timeline is not a non-empty array";
  const digests = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (!e || typeof e !== "object") return `entry ${i} is not an object`;
    for (const k of ["job_id", "id", "tool", "provenance_class"]) if (!nonEmpty(e[k])) return `entry ${i}: missing ${k}`;
    if (typeof e.prev_digest !== "string") return `entry ${i}: prev_digest is not a string`;
    if (typeof e.seq !== "number" || !Number.isInteger(e.seq)) return `entry ${i}: seq is not an integer`;
    if (typeof e.canonical_bytes !== "string" || !B64.test(e.canonical_bytes)) return `entry ${i}: canonical_bytes is not valid base64`;
    if (e.close !== undefined && typeof e.close !== "boolean") return `entry ${i}: close is not a boolean`;
    if (e.seq !== i + 1) return `entry ${i}: seq breaks contiguity from 1`;
    if (e.job_id !== t[0].job_id) return `entry ${i}: mixes jobs`;
    if (e.close === true && i !== t.length - 1) return `entry ${i}: close:true before the last entry`;
    if (i === 0 && e.prev_digest !== "0".repeat(64)) return "entry 0 prev_digest is not 64 zero characters";
    if (i > 0 && e.prev_digest !== digests[i - 1]) return `entry ${i} prev_digest does not match the digest of entry ${i - 1}`;
    digests.push(entryDigest(e));
  }
  if (t[t.length - 1].close !== true) return "last entry is not a closing entry";
  return null;
}

const calendarOk = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s ?? ""); if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number); const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return mo >= 1 && mo <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] && h < 24 && mi < 60 && se < 60;
};

export function verifyCommitment(t, c) {
  const ce = verifyChain(t); if (ce) return "chain: " + ce;
  if (!c || typeof c !== "object" || Array.isArray(c)) return "commitment is not an object";
  if (typeof c.final_entry_digest !== "string" || !/^[0-9a-f]{64}$/.test(c.final_entry_digest)) return "final_entry_digest is not 64 lowercase hex";
  if (typeof c.entry_count !== "number" || !Number.isInteger(c.entry_count)) return "entry_count is not an integer-valued number";
  if (typeof c.job_id !== "string") return "job_id is not a string";
  if (typeof c.published_at !== "string" || !calendarOk(c.published_at)) return "published_at is not a valid RFC 3339 timestamp";
  if (c.final_entry_digest !== entryDigest(t[t.length - 1])) return "final_entry_digest does not match the recomputed last entry digest";
  if (c.entry_count !== t.length) return "entry_count does not match the timeline length";
  if (c.job_id !== t[0].job_id) return "job_id does not match the timeline";
  return null;
}

const dir = process.argv[2]; const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, "base", f), "utf8"));
for (const [file, fn] of [["chain-vectors-v07.json", (v) => verifyChain(v.timeline)], ["commitment-vectors.json", (v) => verifyCommitment(v.timeline, v.commitment)]]) {
  let agree = 0; const vs = load(file).vectors;
  for (const v of vs) {
    let why; try { why = fn(v); } catch (e) { why = "threw: " + e.message; }
    const ok = (why === null) === (v.expected_verdict === "valid"); if (ok) agree++;
    console.log(`${ok ? "AGREE   " : "DISAGREE"} ${v.name}: mine=${why ?? "valid"} | corpus=${v.expected_verdict}${v.expected_failure ? " (" + v.expected_failure + ")" : ""}`);
  }
  console.log(`${file}: ${agree}/${vs.length} agree\n`);
}
