/**
 * inam-log: Claude Code PostToolUse hook that appends one Ed25519-signed, hash-chained entry per
 * tool call to a local file. Only the tool name and sha256 of input/output are stored, never content.
 *   hook:   reads the hook JSON on stdin, appends an entry (always exits 0, never blocks a tool call)
 *   verify: checks the whole chain offline; exit 1 on the first problem
 * ponytail: tail truncation is undetectable (no external anchor); publish the latest `head` hash to pin it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { fromHex, fromBase64, generateKeypair, keypairFromPrivateKey, sha256Hex, sign, toBase64, toHex, verify, type Keypair } from "../../sdk-js/src/crypto/keys.js";

const GENESIS = "0".repeat(64);
export const logDir = () => process.env.INAM_LOG_DIR || path.join(homedir(), ".inam-log");

export interface Entry { v: 1; seq: number; ts: string; tool: string; inputHash: string; outputHash: string; prev: string; did: string; sig: string }

const hashOf = (e: Entry) => sha256Hex(canonicalize(e));
const body = (e: Entry) => { const { sig: _s, ...rest } = e; return new TextEncoder().encode(canonicalize(rest)); };

function loadKey(dir: string): Keypair {
  const file = path.join(dir, "key");
  if (existsSync(file)) return keypairFromPrivateKey(fromHex(readFileSync(file, "utf8").trim()));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kp = generateKeypair();
  writeFileSync(file, toHex(kp.privateKey), { mode: 0o600 });
  return kp;
}

const readEntries = (file: string): Entry[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];

export function append(input: { tool_name?: string; tool_input?: unknown; tool_response?: unknown }, dir = logDir(), now = new Date()): Entry {
  const kp = loadKey(dir);
  const file = path.join(dir, "log.jsonl");
  const last = readEntries(file).at(-1);
  const e: Entry = {
    v: 1, seq: last ? last.seq + 1 : 0, ts: now.toISOString(), tool: String(input.tool_name ?? "unknown"),
    inputHash: sha256Hex(canonicalize(input.tool_input ?? null)), outputHash: sha256Hex(canonicalize(input.tool_response ?? null)),
    prev: last ? hashOf(last) : GENESIS, did: kp.did, sig: "",
  };
  e.sig = toBase64(sign(body(e), kp.privateKey));
  appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
  return e;
}

/** Walks the whole chain; returns the first problem found. */
export function verifyLog(dir = logDir()): { ok: true; entries: number; did?: string; head?: string } | { ok: false; error: string } {
  let entries: Entry[];
  try { entries = readEntries(path.join(dir, "log.jsonl")); } catch { return { ok: false, error: "log is not valid JSONL" }; }
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i) return { ok: false, error: `entry ${i}: bad seq ${e.seq}` };
    if (e.prev !== prev) return { ok: false, error: `entry ${i}: chain broken` };
    if (e.did !== entries[0].did) return { ok: false, error: `entry ${i}: signer changed` };
    let good = false;
    try { good = verify(fromBase64(e.sig), body(e), e.did); } catch { /* malformed */ }
    if (!good) return { ok: false, error: `entry ${i}: bad signature` };
    prev = hashOf(e);
  }
  return { ok: true, entries: entries.length, did: entries[0]?.did, head: entries.length ? prev : undefined };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "hook") {
    try {
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      append(JSON.parse(raw));
    } catch { /* a logging failure must never break the tool call */ }
  } else if (cmd === "verify") {
    const r = verifyLog(process.argv[3]);
    console.log(r.ok ? `OK ${r.entries} entries${r.did ? ` signed by ${r.did}, head ${r.head}` : ""}` : `FAIL ${r.error}`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    console.error("usage: inam-log hook | verify [dir]");
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
