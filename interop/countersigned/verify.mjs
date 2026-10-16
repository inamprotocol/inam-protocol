// Offline check of INAM receipts carried as ERC-8004 feedback (SPEC §11.1) over an HTTP call (SPEC §15).
// Node built-ins only, no INAM server, no npm install:   node interop/countersigned/verify.mjs
// Prints PASS/FAIL per case; exits 1 if any case does not behave as vectors.json says.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// Sorted keys, no whitespace: INAM canonical() (SPEC §4.2).
const canonical = (v) =>
  v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

// Keccak-256 (Ethereum's, not NIST SHA3-256: padding byte 0x01, not 0x06). Node has no built-in for it.
const M = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M);
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
function keccak256(data) {
  const s = new Array(25).fill(0n);
  const p = Buffer.concat([data, Buffer.alloc(136 - (data.length % 136))]);
  p[data.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  for (let o = 0; o < p.length; o += 136) {
    for (let i = 0; i < 17; i++) s[i] ^= p.readBigUInt64LE(o + i * 8);
    for (const rc of RC) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n); for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D; }
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], BigInt(ROT[x][y]));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & M & B[(x + 2) % 5 + 5 * y]);
      s[0] ^= rc;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out.toString("hex");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function didKeyToPublicKey(did) {
  let n = 0n;
  for (const c of did.slice(9)) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const hex = n.toString(16).padStart(68, "0");
  if (!did.startsWith("did:key:z") || !hex.startsWith("ed01") || hex.length !== 68) throw new Error("not an Ed25519 did:key");
  return Buffer.from(hex.slice(4), "hex");
}
function sigOk(did, message, b64) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), didKeyToPublicKey(did)]), format: "der", type: "spki" });
  return edVerify(null, message, key, Buffer.from(b64, "base64"));
}

const OUTCOME_VALUE = { success: 100, partial: 50, failed: 0 };

/** One feedback file + its on-chain event, checked against the bytes the requester observed. accepted === every check true. */
export function verifyCase(c, v) {
  const file = JSON.parse(c.feedbackFile);
  const r = file.inam.receipt;
  const { signatures, receiptVersion, receiptId, ...idContent } = r;
  const message = Buffer.from(canonical({ ...idContent, receiptVersion, receiptId }));
  const sender = c.onchainEvent.clientAddress.toLowerCase();
  const { request, response } = v.observed;
  const head = Buffer.from(`${request.method.toUpperCase()} ${new URL(request.url).pathname}${new URL(request.url).search}\n`);
  const checks = {
    feedbackHashMatchesFile: `0x${keccak256(Buffer.from(c.feedbackFile))}` === c.onchainEvent.feedbackHash.toLowerCase(),
    receiptIdRecomputes: receiptId === `sha256:${sha256(canonical(idContent))}`,
    workerSignature: sigOk(r.agentB.id, message, signatures.agentB),
    requesterSignature: sigOk(r.agentA.id, message, signatures.agentA),
    valueMatchesOutcome: c.onchainEvent.value === OUTCOME_VALUE[r.verification.outcome],
    fileClientAddressMatchesSender: file.clientAddress.split(":").pop().toLowerCase() === sender,
    // Stand-in for the registry lookup of the requester's proven linked.erc8004_id.
    senderIsRequesterWallet: v.parties.requester.erc8004Address.toLowerCase() === sender,
    specHashMatchesObservedBytes: r.task.specHash === `sha256:${sha256(Buffer.concat([head, Buffer.from(request.body)]))}`,
    outputHashMatchesObservedBytes: r.result.outputHash === `sha256:${sha256(Buffer.from(response.body))}`,
  };
  const failedChecks = Object.keys(checks).filter((k) => !checks[k]);
  return { accepted: failedChecks.length === 0, failedChecks };
}

export function runCases() {
  const v = JSON.parse(readFileSync(dir + "vectors.json", "utf8"));
  return v.cases.map((c) => {
    const got = verifyCase(c, v);
    const ok = got.accepted === c.expected.accepted && JSON.stringify(got.failedChecks) === JSON.stringify(c.expected.failedChecks);
    return { name: `${c.id}: ${c.description}`, ok, got };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failed = 0;
  for (const c of runCases()) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  " + JSON.stringify(c.got)}`);
  }
  process.exit(failed ? 1 : 0);
}
