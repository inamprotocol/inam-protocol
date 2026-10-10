// Static build for inamprotocol.org — templates public/index.html with the
// current protocol/package versions so the landing page can't silently drift
// out of sync the way it did before (SPEC.md moved v0.17 -> v0.21, and three
// package versions, while this page kept showing v0.17/0.6.9/0.3.6/0.4.4 --
// audit #15, doc/version drift). Same fix as docs-site/scripts/build.mjs,
// applied here since this page hardcoded its own separate copies.
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

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
// index.html is written after the blog build below, once {{GUIDES}} (links to every live post) is known.

// Everything else in public/ (use-cases.html, robots.txt, sitemap.xml, llms.txt) ships as-is.
cpSync(path.join(SITE_ROOT, "public"), DIST, {
  recursive: true,
  filter: (src) => src !== path.join(SITE_ROOT, "public", "index.html"),
});

// Agent Skills discovery (agentskills.io discovery RFC v0.2.0): publish the plugin's SKILL.md
// with an index whose digest is computed here, so the two can't drift.
{
  const { createHash } = await import("node:crypto");
  const skill = readFileSync(path.join(ROOT, "inam-protocol-plugin", "skills", "inam-protocol", "SKILL.md"));
  const dir = path.join(DIST, ".well-known", "agent-skills");
  mkdirSync(path.join(dir, "inam-protocol"), { recursive: true });
  writeFileSync(path.join(dir, "inam-protocol", "SKILL.md"), skill);
  const description = skill.toString("utf-8").match(/^description: (.+)$/m)[1];
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [{
      name: "inam-protocol",
      type: "skill-md",
      description,
      url: "/.well-known/agent-skills/inam-protocol/SKILL.md",
      digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`,
    }],
  }, null, 2));
}

// Blog: site/blog/<slug>.md (front matter: title, description, date) -> /blog/<slug>.
// visibilityOS's blog publishing provider drops files here; pushing to main deploys them.
// A post dated in the future stays out of the build until that day (UTC); deploy-site.yml
// rebuilds daily so queued posts go live on their date without another push.
const SITE = "https://inamprotocol.org";
const BLOG_SRC = path.join(SITE_ROOT, "blog");
const BLOG_DIST = path.join(DIST, "blog");
mkdirSync(BLOG_DIST, { recursive: true });
const template = readFileSync(path.join(SITE_ROOT, "templates", "page.html"), "utf-8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (v) => template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => v[k] ?? `{{${k}}}`);
// Wide comparison tables scroll sideways on phones instead of widening the page.
marked.use({ renderer: { table(token) { return `<div class="table-wrap">${marked.Renderer.prototype.table.call(this, token)}</div>`; } } });

const posts = readdirSync(BLOG_SRC).filter((n) => n.endsWith(".md")).map((file) => {
  const src = readFileSync(path.join(BLOG_SRC, file), "utf-8").replace(/\r\n/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`blog/${file}: missing front matter`);
  const meta = Object.fromEntries(m[1].split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
  }));
  for (const k of ["title", "description", "date"]) if (!meta[k]) throw new Error(`blog/${file}: front matter needs ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`blog/${file}: date must be YYYY-MM-DD`);
  const slug = file.slice(0, -3);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`blog/${file}: file name must be lowercase-kebab-case`);
  return { ...meta, slug, url: `${SITE}/blog/${slug}`, html: marked.parse(m[2]) };
}).sort((a, b) => b.date.localeCompare(a.date));
const today = new Date().toISOString().slice(0, 10);
const queued = posts.filter((p) => p.date > today).map((p) => `${p.slug} (${p.date})`);
posts.splice(0, posts.length, ...posts.filter((p) => p.date <= today));

const ldScript = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const postItem = (p) => `<li><a class="post-title" href="/blog/${p.slug}">${esc(p.title)}</a><p>${esc(p.description)}</p><div class="post-meta">${p.date}</div></li>`;
for (const p of posts) {
  // Related: front matter `related: slug, slug` picks them; the newest other posts fill the rest.
  const related = (p.related ? p.related.split(",").map((s) => posts.find((q) => q.slug === s.trim())).filter(Boolean) : [])
    .concat(posts.filter((q) => q !== p)).filter((q, i, a) => a.indexOf(q) === i).slice(0, 3);
  const breadcrumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
    { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog/` },
    { "@type": "ListItem", position: 3, name: p.title, item: p.url }] };
  const jsonld = { "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.description,
    datePublished: p.date, dateModified: p.updated ?? p.date, url: p.url, image: `${SITE}/og.png`,
    author: { "@type": "Organization", name: "INAM Protocol", url: SITE }, publisher: { "@type": "Organization", name: "INAM Protocol", logo: `${SITE}/logo-512.png` } };
  writeFileSync(path.join(BLOG_DIST, `${p.slug}.html`), page({
    TITLE: esc(p.title), DESCRIPTION: esc(p.description), URL: p.url, OG_TYPE: "article",
    JSONLD: `${ldScript(jsonld)}\n${ldScript(breadcrumbs)}`,
    BODY: `<div class="masthead"><div class="post-meta"><time datetime="${p.date}">${p.date}</time></div><h1 class="title">${esc(p.title)}</h1><p class="lead">${esc(p.description)}</p></div>\n<article>\n${p.html}\n</article>\n<section><h2 class="h">Related guides</h2><ul class="post-list">\n${related.map(postItem).join("\n")}\n</ul></section>`,
  }));
}
writeFileSync(path.join(BLOG_DIST, "index.html"), page({
  TITLE: "Blog: AI agent reputation and receipts", DESCRIPTION: "Notes on agent reputation, execution receipts, and how INAM fits next to x402, A2A, MCP and ERC-8004.",
  URL: `${SITE}/blog/`, OG_TYPE: "website",
  JSONLD: ldScript({ "@context": "https://schema.org", "@type": "Blog", name: "INAM Protocol Blog", url: `${SITE}/blog/`,
    publisher: { "@type": "Organization", name: "INAM Protocol", url: SITE },
    blogPost: posts.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: p.url, datePublished: p.date })) }),
  BODY: `<div class="masthead"><div class="status-line"><span class="dot"></span>Blog</div><h1 class="title">Blog</h1><p class="lead">Notes on agent reputation, execution receipts, and how INAM fits next to x402, A2A, MCP and ERC-8004.</p></div>\n<ul class="post-list">\n${posts.map(postItem).join("\n")}\n</ul>`,
}));
writeFileSync(path.join(BLOG_DIST, "feed.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>INAM Protocol Blog</title><link>${SITE}/blog/</link><description>Notes on agent reputation and execution receipts.</description>
${posts.map((p) => `<item><title>${esc(p.title)}</title><link>${p.url}</link><guid>${p.url}</guid><pubDate>${new Date(p.date).toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`).join("\n")}
</channel></rss>
`);
// Home lists every post (Guides), so the newest post date is when it and /blog/ last changed.
writeFileSync(path.join(DIST, "index.html"), html.replace("{{GUIDES}}", posts.map((p) =>
  `        <tr><td><a href="/blog/${p.slug}">${esc(p.title)}</a></td><td class="mono dim">${p.date}</td></tr>`).join("\n")));
const newest = posts[0]?.date ?? today;
const sitemap = readFileSync(path.join(DIST, "sitemap.xml"), "utf-8")
  .replace(`<loc>${SITE}/</loc></url>`, `<loc>${SITE}/</loc><lastmod>${newest}</lastmod></url>`).replace("</urlset>",
  [`  <url><loc>${SITE}/blog/</loc><lastmod>${newest}</lastmod></url>`, ...posts.map((p) => `  <url><loc>${p.url}</loc><lastmod>${p.updated ?? p.date}</lastmod></url>`)].join("\n") + "\n</urlset>");
writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);

// A leftover {{PLACEHOLDER}} (e.g. the legal pages' operator name) must never ship.
for (const f of [...readdirSync(DIST).filter((n) => n.endsWith(".html")), ...readdirSync(BLOG_DIST).map((n) => `blog/${n}`)]) {
  const left = readFileSync(path.join(DIST, f), "utf-8").match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`${f} still contains ${left[0]}`);
}

console.log(`Built site/dist — ${posts.length} blog posts${queued.length ? ` (queued: ${queued.join(", ")})` : ""}, spec ${SPEC_VERSION} ${SPEC_STATUS}, registry ${REGISTRY_VERSION}, js ${JS_VERSION}, py ${PY_VERSION}`);
