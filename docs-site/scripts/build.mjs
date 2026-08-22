// Static build for docs.inamprotocol.org — landing page, rendered SPEC.md,
// and a self-hosted Redoc API reference generated from openapi.yaml.
// No CDN dependencies: redoc.standalone.js is copied from node_modules, not
// fetched from unpkg/jsdelivr at request time.
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SITE = path.resolve(__dirname, "..");
const DIST = path.join(SITE, "dist");

if (existsSync(DIST)) {
  try {
    rmSync(DIST, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds a brief lock on dist/ right after a dev server
    // stops; overwriting files in place is fine since every build writes a
    // complete, deterministic set of outputs anyway.
  }
}
mkdirSync(DIST, { recursive: true });
mkdirSync(path.join(DIST, "spec"), { recursive: true });
mkdirSync(path.join(DIST, "api"), { recursive: true });
mkdirSync(path.join(DIST, "assets"), { recursive: true });

const specMd = readFileSync(path.join(ROOT, "SPEC.md"), "utf-8");
const openapiYaml = readFileSync(path.join(ROOT, "openapi.yaml"), "utf-8");

const CSS = `
:root {
  --surface: #f6f7f9; --surface-2: #eceef3; --ink: #161a23; --ink-dim: #4b5468;
  --ink-faint: #7b8399; --accent: #2f6b52; --accent-ink: #1d4a38; --accent-soft: #e1ece6;
  --line: #d7dce3; --code-bg: #eef0f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #10131a; --surface-2: #161b24; --ink: #e7e9f1; --ink-dim: #a3aac0;
    --ink-faint: #727b93; --accent: #5cbd93; --accent-ink: #8fdcb8; --accent-soft: #17281f;
    --line: #262c39; --code-bg: #161b24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--surface); color: var(--ink);
  font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased;
}
code, pre, .mono { font-family: "IBM Plex Mono", ui-monospace, "SF Mono", monospace; }
pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--line); }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
a { color: var(--accent-ink); }
h1, h2, h3, h4 { text-wrap: balance; }
.wrap { max-width: 860px; margin: 0 auto; padding: 0 24px 100px; }
.masthead { border-bottom: 1px solid var(--line); padding: 48px 0 28px; margin-bottom: 40px; }
.eyebrow {
  font-family: "IBM Plex Mono", monospace; font-size: 12px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--accent-ink); display: flex; align-items: center; gap: 10px;
}
.eyebrow::before { content: ""; width: 22px; height: 1px; background: var(--accent); }
nav.top {
  display: flex; gap: 22px; padding: 16px 24px; border-bottom: 1px solid var(--line);
  font-family: "IBM Plex Mono", monospace; font-size: 13px; flex-wrap: wrap;
}
nav.top a { color: var(--ink-dim); text-decoration: none; }
nav.top a:hover, nav.top a.active { color: var(--accent-ink); }
.hero-title { font-family: "IBM Plex Mono", monospace; font-weight: 700; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -0.01em; line-height: 1.05; margin: 0 0 16px; }
.lead { font-size: 1.1rem; color: var(--ink-dim); max-width: 65ch; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 32px 0; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; background: var(--surface-2); text-decoration: none; color: var(--ink); display: block; }
.card:hover { border-color: var(--accent); }
.card .k { font-family: "IBM Plex Mono", monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-ink); display: block; margin-bottom: 6px; }
.not-list { margin: 24px 0; padding: 0; list-style: none; }
.not-list li { padding: 10px 0; border-top: 1px solid var(--line); }
.not-list li:first-child { border-top: none; }
.spec-layout { display: flex; gap: 40px; align-items: flex-start; max-width: 1100px; margin: 0 auto; padding: 0 24px 100px; }
.toc { position: sticky; top: 24px; flex: 0 0 240px; font-size: 13.5px; max-height: calc(100vh - 48px); overflow-y: auto; }
.toc a { display: block; color: var(--ink-dim); text-decoration: none; padding: 3px 0; }
.toc a:hover { color: var(--accent-ink); }
.toc .h3 { padding-left: 14px; font-size: 12.5px; }
.spec-content { flex: 1; min-width: 0; max-width: 74ch; }
.spec-content table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: 14px; }
.spec-content th, .spec-content td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
.spec-content thead th { background: var(--surface-2); }
footer.site { text-align: center; padding: 40px 24px; font-family: "IBM Plex Mono", monospace; font-size: 12px; color: var(--ink-faint); }
@media (max-width: 820px) { .toc { display: none; } }
`;

function page({ title, description, activeNav, body, extraHead = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">
<style>${CSS}</style>
${extraHead}
</head>
<body>
<nav class="top">
  <a href="/" class="${activeNav === "home" ? "active" : ""}">INAM Protocol</a>
  <a href="/spec/" class="${activeNav === "spec" ? "active" : ""}">Specification</a>
  <a href="/api/" class="${activeNav === "api" ? "active" : ""}">API Reference</a>
  <a href="https://github.com/inamprotocol/inam-protocol" target="_blank" rel="noopener">GitHub</a>
  <a href="https://api.inamprotocol.org/v1/health" target="_blank" rel="noopener">Live API</a>
</nav>
${body}
<footer class="site">INAM Protocol — Apache-2.0 — <a href="https://github.com/inamprotocol/inam-protocol">github.com/inamprotocol/inam-protocol</a></footer>
</body>
</html>`;
}

// ---------- Landing page ----------
const landingBody = `
<div class="wrap">
  <div class="masthead">
    <div class="eyebrow">Open Protocol &middot; v0.2 Draft</div>
    <h1 class="hero-title">Trust for the Agent Economy</h1>
    <p class="lead">The open reputation, verification, and economic-history layer for the agent economy. A neutral place for two agents — running anywhere, built by anyone, under any identity standard — to find each other by capability, produce a cryptographically verifiable record that a piece of work actually happened, and accumulate a portable, evidence-based reputation from that record.</p>
  </div>

  <h2>INAM is not</h2>
  <ul class="not-list">
    <li><strong>An agent communication protocol.</strong> Use <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">MCP</a> for agent&harr;tool and <a href="https://a2a-protocol.org" target="_blank" rel="noopener">A2A</a> for agent&harr;agent messaging.</li>
    <li><strong>An identity or authorization replacement.</strong> Use AgentPass, AITP, Passport Alliance, or W3C DID/VC for who an agent is and what it's allowed to do.</li>
    <li><strong>An agent runtime or hosting platform.</strong> Agents run wherever they already run — OpenAI, Claude, Gemini, self-hosted, anywhere with an outbound HTTP connection.</li>
  </ul>

  <h2>Get started</h2>
  <div class="cards">
    <a class="card" href="/spec/"><span class="k">Read</span>Protocol Specification</a>
    <a class="card" href="/api/"><span class="k">Reference</span>REST API (OpenAPI)</a>
    <a class="card" href="https://github.com/inamprotocol/inam-protocol/tree/main/src/sdk" target="_blank" rel="noopener"><span class="k">SDK</span>TypeScript (InamClient)</a>
    <a class="card" href="https://github.com/inamprotocol/inam-protocol/tree/main/sdk-python" target="_blank" rel="noopener"><span class="k">SDK</span>Python (inamprotocol)</a>
    <a class="card" href="https://github.com/inamprotocol/inam-protocol" target="_blank" rel="noopener"><span class="k">Source</span>GitHub Repository</a>
    <a class="card" href="https://api.inamprotocol.org/v1/health" target="_blank" rel="noopener"><span class="k">Live</span>api.inamprotocol.org</a>
  </div>
</div>`;

writeFileSync(
  path.join(DIST, "index.html"),
  page({
    title: "INAM Protocol",
    description: "The open reputation, verification, and economic-history layer for the agent economy.",
    activeNav: "home",
    body: landingBody,
  }),
);

// ---------- Spec page (rendered SPEC.md with a generated TOC) ----------
const headingRe = /^(#{1,3})\s+(.*)$/gm;
const toc = [];
let match;
while ((match = headingRe.exec(specMd))) {
  const level = match[1].length;
  if (level > 3) continue;
  const text = match[2].trim();
  const slug = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  toc.push({ level, text, slug });
}

const renderer = new marked.Renderer();
renderer.heading = (token) => {
  const text = typeof token === "object" ? token.text : token;
  const level = typeof token === "object" ? token.depth : arguments[1];
  const slug = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `<h${level} id="${slug}">${text}</h${level}>\n`;
};
marked.use({ renderer });

const specHtml = marked.parse(specMd);
const tocHtml = toc
  .filter((t) => t.level <= 3 && t.level >= 1)
  .map((t) => (t.level === 1 ? "" : `<a class="${t.level === 3 ? "h3" : ""}" href="#${t.slug}">${t.text}</a>`))
  .join("\n");

const specBody = `
<div class="spec-layout">
  <aside class="toc"><nav>${tocHtml}</nav></aside>
  <article class="spec-content">${specHtml}</article>
</div>`;

writeFileSync(
  path.join(DIST, "spec", "index.html"),
  page({
    title: "Specification — INAM Protocol",
    description: "The full INAM Protocol specification: identity, execution receipts, reputation, REST API, and request signing.",
    activeNav: "spec",
    body: specBody,
  }),
);

// ---------- API reference (Redoc, self-hosted, no CDN) ----------
writeFileSync(path.join(DIST, "api", "openapi.yaml"), openapiYaml);
copyFileSync(
  path.join(SITE, "node_modules/redoc/bundles/redoc.standalone.js"),
  path.join(DIST, "api", "redoc.standalone.js"),
);
// Redoc's search-index web-worker chunk isn't always published to npm
// (missing in this install — only its .map/.LICENSE sidecars were present).
// It's a progressive enhancement (in-page operation search) — the main
// reference renders fine without it, so copy it only if it actually exists.
const bundleDir = path.join(SITE, "node_modules/redoc/bundles");
for (const f of readdirSync(bundleDir)) {
  if (f.endsWith(".worker.js")) copyFileSync(path.join(bundleDir, f), path.join(DIST, "api", f));
}


const apiBody = `<redoc spec-url="/api/openapi.yaml"></redoc>
<script src="/api/redoc.standalone.js"></script>`;

writeFileSync(
  path.join(DIST, "api", "index.html"),
  page({
    title: "API Reference — INAM Protocol",
    description: "Interactive REST API reference for the INAM Protocol Registry, generated from openapi.yaml.",
    activeNav: "api",
    body: "",
    extraHead: "",
  }).replace(
    '<footer class="site">',
    `${apiBody}\n<footer class="site">`,
  ),
);

console.log("Built docs-site to", DIST);
