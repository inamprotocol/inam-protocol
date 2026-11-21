// Second pass: the draft-only reader plus rules INFERRED from the corpus vectors' own rejected_by strings
// (not from the draft text). Shows which undocumented rules account for the disagreements.
// Usage: node interop/aer1/inferred.mjs <dir filled by fetch.mjs>
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { verifyRecord } from "./reader.mjs";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sortDeep = (v) => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v;
const ge04 = (v) => { const [a, b = 0] = v.split(".").map(Number); return a > 0 || b >= 4; };

function inferred(text) {
  const base = verifyRecord(text);
  const R1 = "without metadata_hash";
  if (!base.verdict.startsWith("pass") && !base.verdict.includes(R1)) return { verdict: base.verdict, rule: "draft" };
  const r = JSON.parse(text);
  // I6 uppercase T/Z only
  const ts = r.created_at ?? r.timestamp; if (/[tz]/.test(ts)) return { verdict: "rejected", rule: "I6 lowercase t/z" };
  // I3 tool strings non-empty; bare string only beside a tool_context object
  if (typeof r.tool === "string") { if (!r.tool_context || typeof r.tool_context !== "object") return { verdict: "rejected", rule: "I3b bare-string tool without tool_context" }; }
  else if (!r.tool.name || !r.tool.version || !r.tool.scope) return { verdict: "rejected", rule: "I3a empty tool string" };
  // I4 verification_status
  if (!["verified", "not_verified"].includes(r.verification_status)) return { verdict: "rejected", rule: "I4 verification_status" };
  // I2 payload binding
  let p = null; try { p = JSON.parse(Buffer.from(r.canonical_bytes, "base64").toString("utf8")); } catch {}
  const obj = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const inner = obj.receipt_schema_version, innerProv = obj.issuer_claims?.provenance_class;
  if (ge04(r.receipt_schema_version)) {
    if (inner !== r.receipt_schema_version) return { verdict: "rejected", rule: "I2a payload receipt_schema_version != outer" };
    if (innerProv !== r.provenance_class) return { verdict: "rejected", rule: "I2b payload issuer_claims.provenance_class != outer" };
  } else if (inner !== undefined && inner !== r.receipt_schema_version) return { verdict: "rejected", rule: "I2c downgrade: payload version != outer" };
  // I5 input_hash over sorted-key compact JSON of payload.inputs
  if (r.input_hash !== undefined && "sha256:" + sha(JSON.stringify(sortDeep(obj.inputs))) !== r.input_hash) return { verdict: "verification failed", rule: "I5 input_hash" };
  return { verdict: "pass", rule: base.verdict.includes(R1) ? "I1 0.4 without metadata_hash accepted" : "draft" };
}

const root = path.join(process.argv[2], "base", "test-vectors"); let agree = 0, total = 0; const used = {};
for (const dir of ["valid", "invalid"]) for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
  const res = inferred(fs.readFileSync(path.join(root, dir, f), "utf8")); total++;
  const ok = (res.verdict === "pass") === (dir === "valid"); if (ok) agree++; else console.log("DISAGREE", dir + "/" + f, res.verdict, res.rule);
  if (res.rule !== "draft") (used[res.rule] ??= []).push(dir + "/" + f.replace(".json", ""));
}
console.log(`with inferred rules: ${agree}/${total} agree`);
for (const [k, v] of Object.entries(used)) console.log(`${k}: ${v.length}\n    ${v.join(", ")}`);
