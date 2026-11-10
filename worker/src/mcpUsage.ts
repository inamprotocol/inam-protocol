import type { Env } from "./types.js";

/**
 * Aggregate usage counter for the hosted MCP endpoint.
 *
 * One row per (UTC day, metric, client family) with a count. Nothing else is
 * stored: no IP, no session, no tool arguments, no full user agent.
 *  - metric "connect": a tools/list call (each client session lists tools once).
 *  - metric "tool:<name>": a tools/call of one of our tools (name must match inam_*).
 *  - client: a coarse family from the User-Agent (see clientFamily).
 *
 * Counting never affects the MCP response: it runs in waitUntil and swallows
 * every error (e.g. before migration-add-mcp-usage.sql has run).
 */
export async function countMcpUsage(env: Env, req: Request): Promise<void> {
  try {
    const body = await req.json();
    const msgs = (Array.isArray(body) ? body : [body]) as { method?: unknown; params?: { name?: unknown } }[];
    const client = clientFamily(req.headers.get("user-agent") ?? "");
    const day = new Date().toISOString().slice(0, 10);
    const stmts = [];
    for (const m of msgs) {
      const metric = metricOf(m);
      if (!metric) continue;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO mcp_usage (day, metric, client, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, metric, client) DO UPDATE SET count = count + 1",
        ).bind(day, metric, client),
      );
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch {
    // never let metering break or slow the endpoint
  }
}

function metricOf(m: { method?: unknown; params?: { name?: unknown } }): string | null {
  if (m?.method === "tools/list") return "connect";
  if (m?.method === "tools/call" && typeof m.params?.name === "string" && /^inam_[a-z_]{1,40}$/.test(m.params.name)) return `tool:${m.params.name}`;
  return null;
}

/** Coarse client family; the raw User-Agent is never stored. */
export function clientFamily(ua: string): string {
  if (/^claude-code\/.*\(claude-desktop/.test(ua)) return "claude-desktop";
  if (/^claude-code\/.*\(remote/.test(ua)) return "claude-remote";
  if (/^claude-code\//.test(ua)) return "claude-code";
  if (/^Claude-User/.test(ua)) return "claude-ai";
  return "other";
}

export type McpUsageDay = { day: string; connects: number; toolCalls: number };
export type McpUsage = {
  days: McpUsageDay[];
  byTool: Record<string, number>;
  byClient: Record<string, number>;
  definitions: Record<string, string>;
};

/** Last `days` UTC days (oldest first, gaps filled with zeros), plus totals by tool and client. */
export async function readMcpUsage(env: Env, days = 30, now = new Date()): Promise<McpUsage> {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  let rows: { day: string; metric: string; client: string; count: number }[] = [];
  try {
    rows = (await env.DB.prepare("SELECT day, metric, client, count FROM mcp_usage WHERE day >= ?").bind(since).all<(typeof rows)[number]>()).results;
  } catch {
    rows = []; // table not migrated yet
  }
  const perDay = new Map<string, McpUsageDay>();
  for (let i = 0; i < days; i++) {
    const d = new Date(new Date(since).getTime() + i * 86_400_000).toISOString().slice(0, 10);
    perDay.set(d, { day: d, connects: 0, toolCalls: 0 });
  }
  const byTool: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  for (const r of rows) {
    const d = perDay.get(r.day);
    if (!d) continue;
    if (r.metric === "connect") {
      d.connects += r.count;
      byClient[r.client] = (byClient[r.client] ?? 0) + r.count;
    } else if (r.metric.startsWith("tool:")) {
      d.toolCalls += r.count;
      const name = r.metric.slice(5);
      byTool[name] = (byTool[name] ?? 0) + r.count;
    }
  }
  return {
    days: [...perDay.values()],
    byTool,
    byClient,
    definitions: {
      connects: "tools/list calls to the hosted MCP endpoint (a client lists tools once per session). Not a count of people.",
      toolCalls: "tools/call calls of an inam_* tool.",
      byClient: "connects by client family, from the User-Agent (claude-desktop, claude-remote, claude-code, claude-ai, other). Raw User-Agents and IPs are not stored.",
    },
  };
}

/** Small bar chart (connects per day, tool calls as a darker inner bar) for READMEs and the site. */
export function renderMcpUsageSvg(u: McpUsage): string {
  const W = 640, H = 200, padL = 40, padR = 12, padT = 34, padB = 26;
  const n = u.days.length;
  const max = Math.max(1, ...u.days.map((d) => d.connects));
  const step = (W - padL - padR) / n;
  const bw = Math.max(2, step * 0.7);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const total = u.days.reduce((a, d) => a + d.connects, 0);
  const calls = u.days.reduce((a, d) => a + d.toolCalls, 0);
  const bars = u.days
    .map((d, i) => {
      const x = (padL + i * step + (step - bw) / 2).toFixed(1);
      const t = `${d.day}: ${d.connects} connects, ${d.toolCalls} tool calls`;
      return `<g><title>${t}</title><rect class="c" x="${x}" y="${y(d.connects).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y(d.connects)).toFixed(1)}" rx="1.5"/>` +
        `<rect class="t" x="${x}" y="${y(d.toolCalls).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y(d.toolCalls)).toFixed(1)}" rx="1.5"/></g>`;
    })
    .join("");
  const first = u.days[0]?.day ?? "", last = u.days[n - 1]?.day ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="INAM hosted MCP: ${total} connects and ${calls} tool calls in the last ${n} days">
<style>
text{font:11px "IBM Plex Mono",ui-monospace,"SF Mono",Consolas,monospace;fill:#7b8290}.h{font:600 13px "Public Sans",-apple-system,"Segoe UI",system-ui,sans-serif;fill:#14161b}
.c{fill:#ead3d3}.t{fill:#7a2e2e}.g{stroke:#dde1e7}
@media (prefers-color-scheme:dark){text{fill:#6b7280}.h{fill:#e6e8ec}.c{fill:#3a2222}.t{fill:#d98686}.g{stroke:#262a32}}
</style>
<text class="h" x="${padL}" y="18">Hosted MCP, last ${n} days: ${total.toLocaleString("en-US")} connects, ${calls.toLocaleString("en-US")} tool calls</text>
<rect class="c" x="${W - padR - 150}" y="9" width="9" height="9" rx="1.5"/><text x="${W - padR - 137}" y="17">connects</text>
<rect class="t" x="${W - padR - 69}" y="9" width="9" height="9" rx="1.5"/><text x="${W - padR - 56}" y="17">tool calls</text>
<line class="g" x1="${padL}" x2="${W - padR}" y1="${y(max)}" y2="${y(max)}"/><line class="g" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
<text x="${padL - 6}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${padL - 6}" y="${H - padB + 4}" text-anchor="end">0</text>
${bars}
<text x="${padL}" y="${H - 8}">${first}</text><text x="${W - padR}" y="${H - 8}" text-anchor="end">${last}</text>
</svg>`;
}
