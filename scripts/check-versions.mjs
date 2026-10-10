#!/usr/bin/env node
// Fails if any mirrored version drifts from its single source of truth:
//   spec version      -> SPEC.md title line
//   registry version  -> worker/package.json
//   inam-mcp version  -> mcp/package.json
//   sdk-python version -> sdk-python/pyproject.toml (worker /v1/health mirrors it and the spec version)
//   plugin version    -> inam-protocol-plugin/.claude-plugin/plugin.json (integrations/* mirror it)
// Pass --built to also check site/dist and docs-site/dist (CI builds both first).
// No dependencies on purpose: runs before any npm install.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf-8");
const json = (p) => JSON.parse(read(p));
const errors = [];
const expect = (what, got, want) => {
  if (got !== want) errors.push(`${what}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
};

const spec = read("SPEC.md").match(/Specification (v[\d.]+) \((\w+)\)/)?.[1];
if (!spec) errors.push("SPEC.md: no 'Specification vX.Y (Status)' title line");
const registry = json("worker/package.json").version;
const mcp = json("mcp/package.json").version;

// Spec mirrors. openapi.yaml's info.version follows SPEC vX.Y as "X.Y.0".
expect("openapi.yaml info.version", read("openapi.yaml").match(/^info:\n(?:  .*\n)*?  version: "([^"]+)"/m)?.[1], `${spec?.slice(1)}.0`);

// Package mirrors that have to stay literal (registry manifests).
expect("package.json (Node reference server) version", json("package.json").version, registry);
const serverJson = json("mcp/server.json");
expect("mcp/server.json version", serverJson.version, mcp);
for (const p of serverJson.packages ?? []) expect(`mcp/server.json packages[${p.identifier}].version`, p.version, mcp);

// Code that reports a version must read it from package.json, not repeat it.
for (const file of ["mcp/src/index.ts", "worker/src/mcp.ts", "worker/src/a2a.ts"]) {
  const src = read(file);
  if (/new McpServer\(\{[^}]*version:\s*["'`]/.test(src) || /^\s+version:\s*["'`]\d/m.test(src))
    errors.push(`${file}: hard-coded version literal; import it from package.json`);
}
// Platform plugin packages mirror the Claude Code plugin's version and share one
// skill text (integrations/openai-plugin is the source; Gemini's GEMINI.md is its body).
const plugin = json("inam-protocol-plugin/.claude-plugin/plugin.json").version;
for (const f of ["integrations/openai-plugin/plugin.json", "integrations/cursor-plugin/.cursor-plugin/plugin.json", "integrations/gemini-cli-extension/gemini-extension.json"])
  expect(`${f} version`, json(f).version, plugin);
const text = (p) => read(p).replace(/\r\n/g, "\n");
const skill = text("integrations/openai-plugin/skills/inam-protocol/SKILL.md");
if (text("integrations/cursor-plugin/skills/inam-protocol/SKILL.md") !== skill)
  errors.push("integrations/cursor-plugin SKILL.md: differs from integrations/openai-plugin's; copy it over");
if (text("integrations/gemini-cli-extension/GEMINI.md").trim() !== skill.split(/^---$/m)[2]?.trim())
  errors.push("integrations/gemini-cli-extension/GEMINI.md: differs from the openai-plugin SKILL.md body; copy it over");

// /v1/health reports spec and sdk-python versions as literals (neither source is JSON-importable).
const health = read("worker/src/index.ts");
expect("worker/src/index.ts SPEC_VERSION", health.match(/const SPEC_VERSION = "([^"]+)"/)?.[1], spec?.slice(1));
expect("worker/src/index.ts SDK_PYTHON_VERSION", health.match(/const SDK_PYTHON_VERSION = "([^"]+)"/)?.[1], read("sdk-python/pyproject.toml").match(/^version = "([^"]+)"/m)?.[1]);

// Static discovery files are templated by site/scripts/build.mjs.
expect("site/public server-card serverInfo.version", json("site/public/.well-known/mcp/server-card.json").serverInfo.version, "{{MCP_VERSION}}");

if (process.argv.includes("--built")) {
  const need = (p) => existsSync(path.join(ROOT, p)) || errors.push(`${p}: missing (build site and docs-site first)`);
  if (need("site/dist/index.html")) {
    const html = read("site/dist/index.html");
    if (!html.includes(spec)) errors.push(`site/dist/index.html: does not show ${spec}`);
    if (/\{\{[A-Z_]+\}\}/.test(html)) errors.push("site/dist/index.html: unreplaced {{PLACEHOLDER}}");
  }
  if (need("site/dist/.well-known/mcp/server-card.json"))
    expect("site/dist server-card serverInfo.version", json("site/dist/.well-known/mcp/server-card.json").serverInfo.version, mcp);
  if (need("site/dist/.well-known/oasf.json")) {
    const oasf = json("site/dist/.well-known/oasf.json");
    expect("site/dist oasf.json version", oasf.version, `v${registry}`);
    const a2a = oasf.modules?.find((m) => m.name === "integration/a2a");
    expect("site/dist oasf.json a2a card version", a2a?.data?.card_data?.version, registry);
  }
  if (need("docs-site/dist/version.json")) expect("docs-site/dist/version.json spec", json("docs-site/dist/version.json").spec, spec);
  if (need("docs-site/dist/index.html") && !read("docs-site/dist/index.html").includes(spec))
    errors.push(`docs-site/dist/index.html: does not show ${spec}`);
}

if (errors.length) {
  console.error(`Version drift (spec ${spec}, registry ${registry}, inam-mcp ${mcp}):\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(`versions ok: spec ${spec}, registry ${registry}, inam-mcp ${mcp}`);
