// Downloads the AER-1 conformance corpus into <dir> and checks every file's sha256 and the set digest.
// The corpus is data from zambo.dev; it is not part of this repository. The kit's runners are not downloaded.
// Usage: node interop/aer1/fetch.mjs <dir>
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";

const dir = process.argv[2];
if (!dir) { console.error("usage: node fetch.mjs <dir>"); process.exit(2); }
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

const index = JSON.parse((await get("https://zambo.dev/aer1/corpus.json")).toString("utf8"));
let bad = 0, lines = "";
for (const f of [...index.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
  if (f.path.includes("..") || path.isAbsolute(f.path)) throw new Error("refusing path " + f.path);
  const bytes = await get(index.base_url + f.path);
  const h = sha(bytes);
  if (h !== f.sha256) { bad++; console.log("sha256 mismatch:", f.path); }
  const out = path.join(dir, f.path); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, bytes);
  lines += f.path + "\0" + h + "\n"; // the index's digest_algorithm
}
const set = "sha256:" + sha(lines);
console.log(`kit ${index.kit_version}, ${index.draft}: ${index.files.length} files, ${index.vector_count} vectors`);
console.log(`file hash mismatches: ${bad}`);
console.log(`set digest: ${set} ${set === index.evaluated_set_digest ? "(matches the index)" : "(DIFFERS from the index: " + index.evaluated_set_digest + ")"}`);
if (bad || set !== index.evaluated_set_digest) process.exit(1);
