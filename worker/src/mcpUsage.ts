import type { Env } from "./types.js";

/**
 * Aggregate usage counter for the hosted MCP endpoint.
 *
 * One row per (UTC day, metric, client family) with a count. Nothing else is
 * stored: no IP, no session, no tool arguments, no full user agent.
 *  - metric "session:init" / "session:discover": the request that opens a session, by
 *    protocol revision. 2025-era clients send initialize once per session; 2026-07-28
 *    clients have no handshake and open with server/discover. Their sum is the session
 *    count, comparable with the Cloudflare-log estimate below.
 *  - metric "list": a tools/list call. Kept only to check the session count against
 *    (the list/session ratio); not shown.
 *  - metric "connect": a tools/list call. Counted only on 2026-11-10 and 2026-11-11, before
 *    the session metrics replaced it. A client can list tools more than once per session, so
 *    these days are kept as recorded, flagged (listCounted) and left out of the session totals.
 *  - metric "tool:<name>": a tools/call of one of our tools (name must match inam_*).
 *  - metric "connect_est": one-off backfill for days before the counter existed
 *    (migration-backfill-mcp-usage.sql), sessions estimated from Cloudflare logs.
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
  if (m?.method === "initialize") return "session:init";
  if (m?.method === "server/discover") return "session:discover";
  if (m?.method === "tools/list") return "list";
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

export type McpUsageDay = { day: string; connects: number; toolCalls: number; byClient: Record<string, number>; estimated: boolean; listCounted: boolean };
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
    perDay.set(d, { day: d, connects: 0, toolCalls: 0, byClient: {}, estimated: false, listCounted: false });
  }
  const byTool: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  // A day with tools/list rows shows only those (as recorded, flagged); sessions counted later that day are left out.
  const listDays = new Set(rows.filter((r) => r.metric === "connect").map((r) => r.day));
  for (const r of rows) {
    const d = perDay.get(r.day);
    if (!d) continue;
    const listed = listDays.has(r.day);
    if (listed ? r.metric === "connect" : r.metric.startsWith("session:") || r.metric === "connect_est") {
      d.connects += r.count;
      d.byClient[r.client] = (d.byClient[r.client] ?? 0) + r.count;
      if (!listed) byClient[r.client] = (byClient[r.client] ?? 0) + r.count;
      if (r.metric === "connect_est") d.estimated = true;
      if (listed) d.listCounted = true;
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
      connects:
        "MCP sessions on the hosted endpoint: the request that opens a session (initialize for 2025-era clients, server/discover for 2026-07-28 clients), or Cloudflare-log estimates on estimated days. On listCounted days, tools/list calls instead (not sessions, so not comparable). A session is not a person.",
      toolCalls: "tools/call calls of an inam_* tool.",
      byClient: "connects by client family, from the User-Agent (claude-desktop, claude-remote, claude-code, claude-ai, other). Raw User-Agents and IPs are not stored.",
      estimated:
        "true for days before the counter existed (2026-10-11 to 2026-11-09): connects are sessions estimated from Cloudflare request logs (one notifications/initialized per session), and tool calls were not recorded.",
      listCounted:
        "true for 2026-11-10 and 2026-11-11: connects are tools/list calls, not sessions, so these days are not comparable with the others and are left out of byClient.",
    },
  };
}

const FAMILIES: [key: string, label: string][] = [
  ["claude-desktop", "Claude Desktop"],
  ["claude-code", "Claude Code"],
  ["claude-remote", "Claude remote"],
  ["claude-ai", "claude.ai"],
  ["other", "Other"],
];

/** Bar chart for READMEs and the site: connects stacked by client family, tool calls as a narrow inner bar. */
export function renderMcpUsageSvg(u: McpUsage): string {
  // Start at the first day with data (keeping at least 7 days), so the chart is not mostly empty.
  const first = u.days.findIndex((d) => d.connects > 0 || d.toolCalls > 0);
  const days = u.days.slice(first < 0 ? Math.max(0, u.days.length - 7) : Math.min(first, Math.max(0, u.days.length - 7)));
  const W = 640, H = 236, padL = 44, padR = 12, padT = 62, padB = 26;
  const n = days.length;
  const fmt = (v: number) => v.toLocaleString("en-US");
  const fam = (d: McpUsageDay, k: string) =>
    k === "other" ? d.connects - FAMILIES.slice(0, 4).reduce((a, [c]) => a + (d.byClient[c] ?? 0), 0) : d.byClient[k] ?? 0;
  const max = Math.max(1, ...days.map((d) => d.connects));
  const step = (W - padL - padR) / n;
  const bw = Math.max(2, step * 0.72);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const sess = days.filter((d) => !d.listCounted); // tools/list days are not sessions: shown, not totalled
  const total = sess.reduce((a, d) => a + d.connects, 0);
  const calls = days.reduce((a, d) => a + d.toolCalls, 0);
  const claude = sess.reduce((a, d) => a + FAMILIES.slice(0, 4).reduce((b, [k]) => b + fam(d, k), 0), 0);
  const bars = days
    .map((d, i) => {
      const x = padL + i * step + (step - bw) / 2;
      let acc = 0;
      const segs = FAMILIES.map(([k], j) => {
        const v = fam(d, k);
        if (v <= 0) return "";
        const top = y(acc + v), bottom = y(acc);
        acc += v;
        return `<rect class="f${j}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(bottom - top).toFixed(1)}"/>`;
      }).join("");
      const tw = Math.max(1, bw * 0.4);
      const tool = d.toolCalls
        ? `<rect class="t" x="${(x + (bw - tw) / 2).toFixed(1)}" y="${y(d.toolCalls).toFixed(1)}" width="${tw.toFixed(1)}" height="${(H - padB - y(d.toolCalls)).toFixed(1)}"/>`
        : "";
      const parts = FAMILIES.map(([k, l]) => `${l} ${fmt(fam(d, k))}`).join(", ");
      const what = d.listCounted ? "tools/list calls (not sessions, not comparable)" : "sessions";
      const t = `${d.day}${d.estimated ? " (estimated from Cloudflare logs)" : ""}: ${fmt(d.connects)} ${what} (${parts}), ${d.estimated ? "tool calls not recorded" : `${fmt(d.toolCalls)} tool calls`}`;
      const cls = d.estimated ? ' class="e"' : d.listCounted ? ' class="l"' : "";
      return `<g${cls}><title>${t}</title>${segs}${tool}</g>`;
    })
    .join("");
  const cut = days.findIndex((d, i) => i > 0 && !d.estimated && days[i - 1].estimated);
  const sx = padL + cut * step;
  const split =
    cut > 0
      ? `<line class="s" x1="${sx.toFixed(1)}" x2="${sx.toFixed(1)}" y1="${padT - 8}" y2="${H - padB}"/>` +
        `<text x="${(sx - 5).toFixed(1)}" y="${padT - 1}" text-anchor="end">estimated from Cloudflare logs</text>` +
        (W - padR - sx > 60 ? `<text x="${(sx + 5).toFixed(1)}" y="${padT - 1}">counted</text>` : "")
      : "";
  // Days counted as tools/list (about 2 per session): label them where they sit.
  const listNote = days.some((d) => d.listCounted)
    ? `<text x="${W - padR}" y="${padT - 14}" text-anchor="end">dashed: tools/list calls, not sessions, not in total</text>`
    : "";
  let lx = padL;
  const legend = [...FAMILIES.map(([, l], j): [string, string] => [`f${j}`, l]), ["t", "Tool calls"] as [string, string]]
    .map(([c, l]) => {
      const out = `<rect class="${c}" x="${lx}" y="28" width="9" height="9" rx="1.5"/><text x="${lx + 13}" y="36">${l}</text>`;
      lx += 13 + l.length * 6.7 + 12;
      return out;
    })
    .join("");
  const d0 = days[0]?.day ?? "", d1 = days[n - 1]?.day ?? "";
  const pct = total ? Math.round((100 * claude) / total) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="INAM hosted MCP, ${d0} to ${d1}: ${total} sessions, ${pct}% from Claude clients, ${calls} tool calls">
<style>
text{font:11px "IBM Plex Mono",ui-monospace,"SF Mono",Consolas,monospace;fill:#7b8290}.h{font:600 13px "Public Sans",-apple-system,"Segoe UI",system-ui,sans-serif;fill:#14161b}
.f0{fill:#7a2e2e}.f1{fill:#a8574f}.f2{fill:#cf9089}.f3{fill:#e8c3bf}.f4{fill:#c5cad3}.t{fill:#14161b}.g{stroke:#dde1e7}.s{stroke:#7b8290;stroke-dasharray:3 3}.e{opacity:.55}.l rect{fill-opacity:.18;stroke:#7b8290;stroke-dasharray:2 2}
@media (prefers-color-scheme:dark){text{fill:#6b7280}.h{fill:#e6e8ec}.f0{fill:#d98686}.f1{fill:#a8605c}.f2{fill:#7a4040}.f3{fill:#4f2e2e}.f4{fill:#3a3f49}.t{fill:#e6e8ec}.g{stroke:#262a32}.s{stroke:#6b7280}}
</style>
<text class="h" x="${padL}" y="18">Hosted MCP: ${fmt(total)} sessions, ${pct}% from Claude, ${fmt(calls)} tool calls</text>
${legend}
<line class="g" x1="${padL}" x2="${W - padR}" y1="${y(max)}" y2="${y(max)}"/><line class="g" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
<text x="${padL - 6}" y="${y(max) + 4}" text-anchor="end">${fmt(max)}</text><text x="${padL - 6}" y="${H - padB + 4}" text-anchor="end">0</text>
${bars}
${split}
${listNote}
<text x="${padL}" y="${H - 8}">${d0}</text><text x="${W - padR}" y="${H - 8}" text-anchor="end">${d1}</text>
</svg>`;
}
