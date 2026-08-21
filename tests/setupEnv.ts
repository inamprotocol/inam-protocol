import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the file-backed store at a fresh temp directory per test run so tests
// never read or write the real data/ directory used by `npm run dev`/`npm run demo`.
process.env.INAM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inam-test-"));
