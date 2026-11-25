// AER-1 record reader written from the text of draft-zambo-aer1-26 (Sections 3, 3.1, 4, 5, 6, 7.1) only.
// The kit's own runners (conformance.py / .mjs) were not read or run.
// Usage: node interop/aer1/reader.mjs <dir filled by fetch.mjs>
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// JSON parse that reports duplicate member names (Section 6: reject, in any object of the receipt).
function parseNoDup(text) {
  let i = 0; const dups = [];
  const ws = () => { while (" \t\n\r".includes(text[i]) && i < text.length) i++; };
  const str = () => { const s = i; i++; while (text[i] !== '"') { if (text[i] === "\\") i++; i++; if (i > text.length) throw new Error("unterminated string"); } i++; return JSON.parse(text.slice(s, i)); };
  const val = () => {
    ws();
    if (text[i] === "{") { i++; const o = {}; const seen = new Set(); ws(); if (text[i] === "}") { i++; return o; }
      for (;;) { ws(); const k = str(); if (seen.has(k)) dups.push(k); seen.add(k); ws(); if (text[i++] !== ":") throw new Error("expected :"); o[k] = val(); ws(); const c = text[i++]; if (c === "}") return o; if (c !== ",") throw new Error("expected , or }"); } }
    if (text[i] === "[") { i++; const a = []; ws(); if (text[i] === "]") { i++; return a; }
      for (;;) { a.push(val()); ws(); const c = text[i++]; if (c === "]") return a; if (c !== ",") throw new Error("expected , or ]"); } }
    if (text[i] === '"') return str();
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400)); if (!m) throw new Error("bad value at " + i);
    i += m[0].length; return JSON.parse(m[0]);
  };
  const v = val(); ws(); if (i !== text.length) throw new Error("trailing data");
  return { value: v, dups };
}

// RFC 3339 date-time. The ABNF is case-insensitive for "T" and "Z" (RFC 3339 Section 5.6 note); the draft adds:
// valid calendar date and time, seconds 60 rejected.
function checkTimestamp(s) {
  if (typeof s !== "string") return "rejected: timestamp is not a string";
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(s);
  if (!m) return "rejected: not RFC 3339 date-time syntax";
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (se === 60) return "rejected: leap-second timestamp";
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (mo < 1 || mo > 12 || d < 1 || d > dim || h > 23 || mi > 59 || se > 59) return "rejected: not a valid calendar date/time";
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return "rejected: time offset out of range";
  return null;
}

// Section 7.1 string escaping (Python json.dumps ensure_ascii=True), used by the Section 3.1 metadata block.
const esc = (s) => '"' + [...s].map((ch) => {
  const c = ch.codePointAt(0);
  if (ch === '"') return '\\"'; if (ch === "\\") return "\\\\";
  if (c === 8) return "\\b"; if (c === 9) return "\\t"; if (c === 10) return "\\n"; if (c === 12) return "\\f"; if (c === 13) return "\\r";
  if (c >= 0x20 && c <= 0x7e) return ch;
  const u = (n) => "\\u" + n.toString(16).padStart(4, "0");
  return c > 0xffff ? u(ch.charCodeAt(0)) + u(ch.charCodeAt(1)) : u(c);
}).join("") + '"';
const metadataBlock = (r) => `{"created_at":${esc(r.created_at)},"id":${esc(r.id)},"output_hash":${esc(r.output_hash)},"provenance_class":${esc(r.provenance_class)},"receipt_schema_version":${esc(r.receipt_schema_version)},"tool":{"name":${esc(r.tool.name)},"scope":${esc(r.tool.scope)},"version":${esc(r.tool.version)}}}`;

const verGE = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return true; };
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CLASSES = ["EXECUTED BY ZAMBO", "OBSERVED VIA GATEWAY", "LOGGED BY AGENT"];

/** Returns { verdict: "pass" | "pass (legacy)" | "verification failed" | "rejected: ...", notes[] }. */
export function verifyRecord(text) {
  const notes = [];
  let parsed; try { parsed = parseNoDup(text); } catch (e) { return { verdict: "rejected: not JSON (" + e.message + ")", notes }; }
  const r = parsed.value;
  if (parsed.dups.length) return { verdict: "rejected: duplicate member name (" + parsed.dups.join(",") + ")", notes };
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { verdict: "rejected: receipt is not a JSON object", notes };

  const v = r.receipt_schema_version;
  if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v)) return { verdict: "rejected: receipt_schema_version missing or not dot-separated numbers", notes };
  const bound = verGE(v, "0.4");
  const legacyForms = !bound && r.metadata_hash === undefined; // Section 6 step 4: legacy member forms only for such a receipt

  for (const k of ["id", "provenance_class", "canonical_bytes", "output_hash", "verification_status"]) if (r[k] === undefined) return { verdict: "rejected: missing required member " + k, notes };

  if (typeof r.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.id) || /\n/.test(r.id)) return { verdict: "rejected: id is not a lowercase UUID-shaped string", notes };
  if (r.id === "00000000-0000-0000-0000-000000000000") return { verdict: "rejected: nil UUID", notes };

  let created = r.created_at;
  if (created === undefined && legacyForms && r.timestamp !== undefined) { created = r.timestamp; notes.push("legacy form: creation time read from timestamp"); }
  if (created === undefined) return { verdict: "rejected: missing required member created_at", notes };
  const te = checkTimestamp(created); if (te) return { verdict: te, notes };

  let tool = r.tool;
  if (typeof tool === "string" && legacyForms) { notes.push("legacy form: tool is a bare string"); tool = null; }
  else if (!tool || typeof tool !== "object" || Array.isArray(tool) || !["name", "version", "scope"].every((k) => typeof tool[k] === "string")) return { verdict: "rejected: tool is not an object with name/version/scope strings", notes };

  if (typeof r.provenance_class !== "string") return { verdict: "rejected: provenance_class is not a string", notes };
  if (/[\u0000-\u001f\u007f]/.test(r.provenance_class)) return { verdict: "rejected: provenance_class contains a control character", notes };
  if (!CLASSES.includes(r.provenance_class)) return { verdict: "rejected: provenance_class is not one of the three classes", notes };

  if (typeof r.output_hash !== "string" || !DIGEST.test(r.output_hash)) return { verdict: "rejected: output_hash is not sha256: + 64 lowercase hex", notes };

  const cb = r.canonical_bytes;
  if (typeof cb !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cb)) return { verdict: "rejected: canonical_bytes is not padded RFC 4648 base64", notes };
  const bytes = Buffer.from(cb, "base64");
  if (bytes.toString("base64") !== cb) return { verdict: "rejected: canonical_bytes is not the canonical base64 spelling (non-zero pad bits)", notes };
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { verdict: "rejected: canonical_bytes is not valid UTF-8", notes }; }

  if ("sha256:" + sha(bytes) !== r.output_hash) return { verdict: "verification failed: output_hash does not match sha256(canonical_bytes)", notes };

  if (r.metadata_hash !== undefined) {
    if (!tool) return { verdict: "rejected: metadata_hash present but tool is not in object form", notes };
    if (typeof r.created_at !== "string") return { verdict: "rejected: metadata_hash present but created_at absent", notes };
    if ("sha256:" + sha(Buffer.from(metadataBlock(r), "utf8")) !== r.metadata_hash) return { verdict: "verification failed: metadata_hash does not match the Section 3.1 block", notes };
    notes.push("metadata_hash recomputed and matches");
  } else if (bound) {
    return { verdict: 'verification failed: receipt_schema_version "' + v + '" without metadata_hash (Section 6 step 4: MUST fail)', notes };
  }

  // Not rejection grounds in the draft text; reported only.
  if (r.verification_status !== "verified") notes.push('verification_status is "' + r.verification_status + '" (the draft states no rejection rule for it)');
  if (r.input_hash !== undefined) notes.push("input_hash present: not confirmed, no byte layout is published with the record (Section 3.3)");

  if (!bound && r.metadata_hash === undefined) { notes.push("unbound: id, tool name/version/scope, creation time, provenance class"); return { verdict: "pass (legacy)", notes }; }
  return { verdict: "pass", notes };
}

if (process.argv[1] && process.argv[1].endsWith("reader.mjs") && process.argv[2]) {
  const root = path.join(process.argv[2], "base", "test-vectors");
  let agree = 0, total = 0; const rows = [];
  for (const dir of ["valid", "invalid"]) for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
    const text = fs.readFileSync(path.join(root, dir, f), "utf8");
    const res = verifyRecord(text);
    const accepted = res.verdict.startsWith("pass");
    const ok = accepted === (dir === "valid"); total++; if (ok) agree++;
    let theirs = ""; try { const o = JSON.parse(text); theirs = o.rejected_by || o.rejection_outcome || ""; } catch {}
    rows.push({ ok, line: `${ok ? "AGREE   " : "DISAGREE"} ${dir}/${f}\n           mine: ${res.verdict}${res.notes.length ? "  [" + res.notes.join("; ") + "]" : ""}${theirs ? "\n           corpus: " + theirs : ""}` });
  }
  for (const r of rows.filter((r) => !r.ok)) console.log(r.line);
  console.log("---- agreeing vectors ----"); for (const r of rows.filter((r) => r.ok)) console.log(r.line);
  console.log(`\nrecord vectors: ${agree}/${total} agree`);
}
