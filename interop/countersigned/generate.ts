// Regenerates vectors.json: signed fixtures for the counterparty-countersigned grounding method
// (receipt over a real HTTP call, SPEC §15, published as ERC-8004 feedback, SPEC §11.1).
//   npx tsx interop/countersigned/generate.ts
// Output is byte-identical on every run (fixed test keys, deterministic Ed25519, fixed timestamps);
// tests/countersignedInterop.test.ts checks that.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { buildSignableContent, canonicalize, keypairFromPrivateKey, sign, toBase64, type ExecutionReceipt } from "../../sdk-js/src/index.js";
import { buildErc8004Feedback } from "../../sdk-js/src/erc8004.js";
import { httpOutputHash, httpSpecHash } from "../../sdk-js/src/http.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { toHex } from "../../sdk-js/src/crypto/keys.js";
import type { AgentRecord } from "../../sdk-js/src/types.js";

const dir = fileURLToPath(new URL(".", import.meta.url));

// TEST KEYS ONLY. Derived from public strings, so anyone can sign as these DIDs.
const testKey = (label: string) => keypairFromPrivateKey(sha256(new TextEncoder().encode(`INAM interop TEST KEY, never use for real: ${label}`)));
const worker = testKey("countersigned worker");
const requester = testKey("countersigned requester");

// Made-up EVM addresses, not derived from any key. The requester's is the wallet its INAM ID proved control of.
export const REQUESTER_ADDRESS = "0x1111111111111111111111111111111111111111";
export const PROVIDER_ADDRESS = "0x2222222222222222222222222222222222222222";
export const OTHER_WALLET = "0x3333333333333333333333333333333333333333";
const TARGET = { agentRegistry: "eip155:8453:0x8004000000000000000000000000000000000000", agentId: 7 };

const enc = (s: string) => new TextEncoder().encode(s);
const REQUEST = { method: "POST", url: "https://worker.example/translate", body: '{"text":"merhaba dünya","to":"en"}' };
const RESPONSE = { status: 200, body: '{"text":"hello world"}' };
// One byte of the response differs: what a provider that signed a different output than it served would have hashed.
const ALTERED_RESPONSE_BODY = '{"text":"hello wor1d"}';

function signedReceipt(outputBody: string, outcome: "success" | "failed" = "success"): ExecutionReceipt {
  const content = buildSignableContent(requester.did, worker.did, {
    jobId: "http:countersigned-vectors-v0.1",
    task: { capability: "translation.tr-en", specHash: httpSpecHash(REQUEST.method, REQUEST.url, enc(REQUEST.body)), createdAt: "2026-10-01T10:00:00.000Z" },
    result: { outputHash: httpOutputHash(enc(outputBody)), completedAt: "2026-10-01T10:00:01.000Z" },
    verification: { method: "payer_confirmation", outcome },
  });
  const bytes = enc(canonicalize({ ...content, dispute: undefined }));
  return {
    ...content,
    dispute: { status: "none", windowClosesAt: "2026-10-04T10:00:01.000Z" },
    signatures: { agentB: toBase64(sign(bytes, worker.privateKey)), agentA: toBase64(sign(bytes, requester.privateKey)) },
    status: "finalized",
    visibility: "public",
  } as ExecutionReceipt;
}

const requesterRecord = { id: requester.did, linked: { erc8004_id: REQUESTER_ADDRESS } } as unknown as AgentRecord;
const keccak = (text: string) => `0x${toHex(keccak_256(enc(text)))}`;

export function generate() {
  const good = signedReceipt(RESPONSE.body);
  const fb = buildErc8004Feedback(good, requesterRecord, TARGET, "2026-10-03T00:00:00.000Z");
  const event = (clientAddress: string, feedbackHash: string) => ({ clientAddress, feedbackHash, value: 100 });

  // Edit result.outputHash inside the carried receipt; feedbackHash is recomputed so the file still matches its event.
  const edited = JSON.parse(fb.fileText);
  edited.inam.receipt.result.outputHash = httpOutputHash(enc(ALTERED_RESPONSE_BODY));
  const editedText = canonicalize(edited);

  // Provider signed a draft over an output different from what it served; a requester that did not recompute countersigned it.
  const careless = signedReceipt(ALTERED_RESPONSE_BODY);
  const carelessFb = buildErc8004Feedback(careless, requesterRecord, TARGET, "2026-10-03T00:00:00.000Z");

  const caseOf = (id: string, description: string, fileText: string, ev: ReturnType<typeof event>, expectedAccepted: boolean, expectedFailedChecks: string[]) => ({
    id, description, feedbackFile: fileText, onchainEvent: ev, expected: { accepted: expectedAccepted, failedChecks: expectedFailedChecks },
  });

  const vectors = {
    suite: "inam-countersigned-grounding-v0.1",
    method: "counterparty-countersigned",
    note: "Test keys and made-up addresses only. Checks: feedbackHash, receiptId, both signatures, value, sender, specHash/outputHash against the bytes the requester observed.",
    parties: {
      requester: { did: requester.did, erc8004Address: REQUESTER_ADDRESS },
      provider: { did: worker.did, erc8004Address: PROVIDER_ADDRESS },
    },
    observed: {
      request: REQUEST,
      response: RESPONSE,
      expectedSpecHash: httpSpecHash(REQUEST.method, REQUEST.url, enc(REQUEST.body)),
      expectedOutputHash: httpOutputHash(enc(RESPONSE.body)),
    },
    cases: [
      caseOf("POSITIVE", "Genuine feedback: sent from the requester's proven wallet, both signatures valid, hashes match the observed bytes.", fb.fileText, event(REQUESTER_ADDRESS, fb.feedbackHash), true, []),
      caseOf("WRONG-WALLET-COPY", "The genuine file, byte for byte, sent from a wallet that is not the requester's proven erc8004_id (the Sybil copy).", fb.fileText, event(OTHER_WALLET, fb.feedbackHash), false, ["fileClientAddressMatchesSender", "senderIsRequesterWallet"]),
      caseOf("TAMPERED-OUTPUT-HASH", "result.outputHash edited inside the carried receipt; feedbackHash recomputed over the edited file, sent from the right wallet.", editedText, event(REQUESTER_ADDRESS, keccak(editedText)), false, ["receiptIdRecomputes", "workerSignature", "requesterSignature", "outputHashMatchesObservedBytes"]),
      caseOf("OUTPUT-NOT-WHAT-WAS-SERVED", "Both signatures are valid, but the provider's outputHash commits to different bytes than the requester received. A requester that recomputes (SPEC §15 step 3) refuses to countersign this.", carelessFb.fileText, event(REQUESTER_ADDRESS, carelessFb.feedbackHash), false, ["outputHashMatchesObservedBytes"]),
    ],
  };
  return { "vectors.json": JSON.stringify(vectors, null, 2) + "\n" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, text] of Object.entries(generate())) writeFileSync(dir + name, text);
  console.log("wrote vectors.json");
}
