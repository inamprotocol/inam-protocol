import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testOperatorKeypair } from "./testOperator.js";

// Point the file-backed store at a fresh temp directory per test run so tests
// never read or write the real data/ directory used by `npm run dev`/`npm run demo`.
process.env.INAM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inam-test-"));

// Config.ts reads this once at import time, so it must be set before any test
// file imports a service module -- vitest's setupFiles run before test files,
// same guarantee INAM_DATA_DIR above already relies on.
process.env.INAM_OPERATOR_DID = testOperatorKeypair.did;
