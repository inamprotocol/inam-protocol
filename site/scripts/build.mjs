// Static build for inamprotocol.org — templates public/index.html with the
// current protocol/package versions so the landing page can't silently drift
// out of sync the way it did before (SPEC.md moved v0.17 -> v0.21, and three
// package versions, while this page kept showing v0.17/0.6.9/0.3.6/0.4.4 --
// audit #15, doc/version drift). Same fix as docs-site/scripts/build.mjs,
// applied here since this page hardcoded its own separate copies.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.join(HERE, "..");
const ROOT = path.join(SITE_ROOT, "..");
const DIST = path.join(SITE_ROOT, "dist");

const specMd = readFileSync(path.join(ROOT, "SPEC.md"), "utf-8");
const specVersionMatch = specMd.match(/Specification (v[\d.]+) \((\w+)\)/);
if (!specVersionMatch) {
  throw new Error("Could not extract version from SPEC.md's title line — landing page would go stale silently.");
}
const [, SPEC_VERSION, SPEC_STATUS] = specVersionMatch;

const REGISTRY_VERSION = JSON.parse(readFileSync(path.join(ROOT, "worker", "package.json"), "utf-8")).version;
const JS_VERSION = JSON.parse(readFileSync(path.join(ROOT, "sdk-js", "package.json"), "utf-8")).version;
const pyVersionMatch = readFileSync(path.join(ROOT, "sdk-python", "pyproject.toml"), "utf-8").match(/^version = "([^"]+)"/m);
if (!pyVersionMatch) {
  throw new Error("Could not extract version from sdk-python/pyproject.toml.");
}
const PY_VERSION = pyVersionMatch[1];

mkdirSync(DIST, { recursive: true });

let html = readFileSync(path.join(SITE_ROOT, "public", "index.html"), "utf-8");
html = html
  .replaceAll("{{SPEC_VERSION}}", SPEC_VERSION)
  .replaceAll("{{SPEC_STATUS_LOWER}}", SPEC_STATUS.toLowerCase())
  .replaceAll("{{REGISTRY_VERSION}}", REGISTRY_VERSION)
  .replaceAll("{{JS_VERSION}}", JS_VERSION)
  .replaceAll("{{PY_VERSION}}", PY_VERSION);
writeFileSync(path.join(DIST, "index.html"), html);

cpSync(path.join(SITE_ROOT, "public", "use-cases.html"), path.join(DIST, "use-cases.html"));

console.log(`Built site/dist — spec ${SPEC_VERSION} ${SPEC_STATUS}, registry ${REGISTRY_VERSION}, js ${JS_VERSION}, py ${PY_VERSION}`);
