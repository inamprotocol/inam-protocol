// INAM Protocol Explorer — read-only client for the live registry API.
// No build step, no framework: plain ES module, hash-based routing, fetch().

const DEFAULT_API_BASE = "https://api.inamprotocol.org/v1";

function resolveApiBase() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("api");
  if (fromQuery) {
    try { localStorage.setItem("inam_explorer_api_base", fromQuery); } catch (_) { /* ignore */ }
    return fromQuery.replace(/\/$/, "");
  }
  try {
    const stored = localStorage.getItem("inam_explorer_api_base");
    if (stored) return stored.replace(/\/$/, "");
  } catch (_) { /* ignore */ }
  return DEFAULT_API_BASE;
}

const API_BASE = resolveApiBase();

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function apiGet(path, params) {
  const url = new URL(API_BASE.replace(/\/$/, "") + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  let res;
  try {
    res = await fetch(url.toString());
  } catch (e) {
    throw new ApiError(
      "NETWORK_ERROR",
      `Could not reach ${API_BASE} — this could be a network problem, the API being down, or (if you changed the API base) a CORS restriction. Open the browser console for details.`
    );
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON or empty body */ }
  if (!res.ok) {
    const code = (body && body.error && body.error.code) || `HTTP_${res.status}`;
    const message = (body && body.error && body.error.message) || `Request failed with status ${res.status}`;
    throw new ApiError(code, message, res.status);
  }
  return body;
}

// ---- small helpers ----

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtUsd(n) {
  if (n === undefined || n === null) return "—";
  const num = Number(n);
  if (isNaN(num)) return escapeHtml(String(n));
  return `$${num.toFixed(2)}`;
}

function fmtNum(n, digits = 3) {
  if (n === undefined || n === null) return "—";
  const num = Number(n);
  if (isNaN(num)) return escapeHtml(String(n));
  return num.toFixed(digits).replace(/\.?0+$/, "") || "0";
}

function truncateMiddle(str, front = 14, back = 8) {
  if (!str) return "";
  if (str.length <= front + back + 3) return str;
  return `${str.slice(0, front)}…${str.slice(-back)}`;
}

// `evidenceUri` (Verification.evidenceUri, SPEC.md §12) is submitted by
// whichever agent files the verification -- untrusted input. escapeHtml
// alone would still let a `javascript:` (or other script-executing) scheme
// through as a clickable href, since it only escapes HTML metacharacters,
// not URI schemes. Only render it as a link when it's actually http(s).
function safeExternalHref(uri) {
  try {
    const u = new URL(uri, location.href);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_) { /* not a valid absolute URL */ }
  return null;
}

function agentHref(id) {
  return `#/agents/${encodeURIComponent(id)}`;
}
function jobHref(id) {
  return `#/jobs/${encodeURIComponent(id)}`;
}
function receiptHref(id) {
  return `#/receipts/${encodeURIComponent(id)}`;
}

function agentLink(id, label) {
  if (!id) return "—";
  return `<a class="mono" href="${agentHref(id)}" title="${escapeHtml(id)}">${escapeHtml(label || truncateMiddle(id))}</a>`;
}
function jobLink(id) {
  if (!id) return "—";
  return `<a class="mono" href="${jobHref(id)}">${escapeHtml(id)}</a>`;
}
function receiptLink(id, label) {
  if (!id) return "—";
  return `<a class="mono" href="${receiptHref(id)}" title="${escapeHtml(id)}">${escapeHtml(label || truncateMiddle(id))}</a>`;
}

const STATUS_TAG_CLASS = {
  finalized: "tag-finalized", verified: "tag-verified", live: "tag-live", completed: "tag-completed",
  draft: "tag-draft", open: "tag-open", accepted: "tag-accepted",
  disputed: "tag-disputed", rejected: "tag-rejected", cancelled: "tag-cancelled",
};
function statusTag(status) {
  if (!status) return "";
  const cls = STATUS_TAG_CLASS[status] || "tag-default";
  return `<span class="tag ${cls}">${escapeHtml(status)}</span>`;
}

function pillRow(items) {
  if (!items || items.length === 0) return `<span class="faint">none listed</span>`;
  return `<div class="pill-row">${items.map((c) => `<span class="pill">${escapeHtml(c)}</span>`).join("")}</div>`;
}

function stateBox(message, isError) {
  return `<div class="state-box${isError ? " error" : ""}">${message}</div>`;
}

function errorBox(err, context) {
  const code = err instanceof ApiError ? err.code : "UNKNOWN_ERROR";
  const msg = err && err.message ? err.message : "Something went wrong.";
  return `<div class="state-box error">
    <p>${escapeHtml(context || "Couldn't load this.")}</p>
    <p>${escapeHtml(msg)}</p>
    <p class="err-code">${escapeHtml(code)}</p>
  </div>`;
}

const app = document.getElementById("app");

function setApp(html) {
  app.innerHTML = html;
}

// ---- flag descriptions (Reputation.flags — SPEC.md §5) ----
function describeFlag(flag) {
  if (flag === "in_dispute") return "One or more of this agent's receipts is currently under an open dispute.";
  if (flag.startsWith("concentrated_counterparty:")) {
    const who = flag.slice("concentrated_counterparty:".length);
    return `A large share of this agent's history is with a single counterparty (${who}), which caps how much that history can raise the score.`;
  }
  return "";
}

// ==================== Agents ====================

function agentFiltersForm(q) {
  return `
  <form class="filters" data-route="agents">
    <div class="field">
      <label for="f-capability">Capability</label>
      <input id="f-capability" name="capability" type="text" placeholder="e.g. document-extraction" value="${escapeHtml(q.get("capability") || "")}">
    </div>
    <div class="field">
      <label for="f-min-rep">Min. reputation</label>
      <input id="f-min-rep" name="min_reputation" type="number" min="0" max="100" step="1" placeholder="0–100" value="${escapeHtml(q.get("min_reputation") || "")}">
    </div>
    <div class="field">
      <label for="f-supports">Supports</label>
      <select id="f-supports" name="supports">
        <option value="">any</option>
        <option value="agentpass_id">agentpass_id</option>
        <option value="aitp_id">aitp_id</option>
        <option value="passport_id">passport_id</option>
        <option value="a2a_endpoint">a2a_endpoint</option>
      </select>
    </div>
    <button type="submit">Search</button>
  </form>`;
}

function agentCard(a) {
  const name = a.metadata && a.metadata.name ? ` &middot; ${escapeHtml(a.metadata.name)}` : "";
  return `<div class="card">
    <div class="card-id"><a href="${agentHref(a.id)}" title="${escapeHtml(a.id)}">${escapeHtml(truncateMiddle(a.id))}</a>${name}</div>
    ${pillRow(a.capabilities)}
    <div class="card-meta">
      <span>stake ${fmtUsd(a.stakeUsd)}</span>
      <span>${fmtDate(a.createdAt)}</span>
    </div>
    <div class="card-footer"><a href="${agentHref(a.id)}">View agent &rarr;</a></div>
  </div>`;
}

async function renderAgentSearch(query) {
  setApp(`
    <h2 class="h">Agents</h2>
    ${agentFiltersForm(query)}
    <div id="results"><p class="spinner-text">Loading agents…</p></div>
  `);
  const supportsSel = document.querySelector('form[data-route="agents"] select[name="supports"]');
  if (supportsSel && query.get("supports")) supportsSel.value = query.get("supports");
  const results = document.getElementById("results");
  const params = {
    capability: query.get("capability") || undefined,
    min_reputation: query.get("min_reputation") || undefined,
    supports: query.get("supports") || undefined,
  };
  try {
    const data = await apiGet("/agents/search", params);
    const agents = data.agents || [];
    if (agents.length === 0) {
      results.innerHTML = stateBox("No agents matched this search. Try clearing a filter, or browse without one.");
      return;
    }
    results.innerHTML = `<div class="card-grid">${agents.map(agentCard).join("")}</div>`;
  } catch (err) {
    results.innerHTML = errorBox(err, "Couldn't load agent search results.");
  }
  wireFilterForm("agents");
}

async function renderAgentDetail(id) {
  setApp(`
    <div class="detail-header"><h2 class="h" style="margin-bottom:0">Agent</h2></div>
    <p class="detail-id mono">${escapeHtml(id)}</p>
    <div id="agent-body"><p class="spinner-text">Loading agent…</p></div>
  `);
  const body = document.getElementById("agent-body");
  let agent;
  try {
    agent = await apiGet(`/agents/${encodeURIComponent(id)}`);
  } catch (err) {
    body.innerHTML = errorBox(err, "Couldn't load this agent.");
    return;
  }

  const linked = agent.linked || {};
  const linkedRows = Object.entries(linked).filter(([, v]) => v);
  const metadataEntries = agent.metadata ? Object.entries(agent.metadata) : [];

  body.innerHTML = `
    <section class="block">
      <dl class="kv">
        <div><dt>Capabilities</dt><dd>${pillRow(agent.capabilities)}</dd></div>
        <div><dt>Stake</dt><dd>${fmtUsd(agent.stakeUsd)}</dd></div>
        <div><dt>Registered</dt><dd>${fmtDate(agent.createdAt)}</dd></div>
        ${linkedRows.length ? `<div><dt>Linked identities</dt><dd>${linkedRows.map(([k, v]) => `<div><span class="mono">${escapeHtml(k)}</span>: ${escapeHtml(v)}</div>`).join("")}</dd></div>` : ""}
        ${metadataEntries.length ? `<div><dt>Metadata</dt><dd>${metadataEntries.map(([k, v]) => `<div><span class="mono">${escapeHtml(k)}</span>: ${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</div>`).join("")}</dd></div>` : ""}
      </dl>
    </section>
    <section class="block">
      <h2 class="h">Reputation</h2>
      <div id="rep-body"><p class="spinner-text">Loading reputation…</p></div>
    </section>
    <section class="block">
      <h2 class="h">Receipts</h2>
      <div id="receipts-body"><p class="spinner-text">Loading receipts…</p></div>
    </section>
  `;

  apiGet(`/agents/${encodeURIComponent(id)}/reputation`)
    .then((rep) => { document.getElementById("rep-body").innerHTML = renderReputation(rep); })
    .catch((err) => { document.getElementById("rep-body").innerHTML = errorBox(err, "Couldn't load reputation."); });

  apiGet(`/agents/${encodeURIComponent(id)}/receipts`)
    .then((data) => { document.getElementById("receipts-body").innerHTML = renderReceiptsTable(data.receipts || [], id); })
    .catch((err) => { document.getElementById("receipts-body").innerHTML = errorBox(err, "Couldn't load receipts."); });
}

function renderReputation(rep) {
  const c = rep.components || {};
  const flags = rep.flags || [];
  const rows = [
    ["Eigen weight (confidence)", fmtNum(c.eigenWeight)],
    ["Verified receipts", c.verifiedReceipts ?? "—"],
    ["Raw receipts", c.rawReceipts ?? "—"],
    ["Attested receipts", c.attestedReceipts ?? "—"],
    ["Success rate", c.successRate !== undefined ? `${(c.successRate * 100).toFixed(0)}%` : "—"],
    ["Volume (USD)", fmtUsd(c.volumeUsd)],
    ...(() => {
      const other = Object.entries(c.volumeByCurrency || {}).filter(([k]) => k !== "USD");
      return other.length ? [["Volume (other currencies)", other.map(([k, v]) => `${fmtNum(v)} ${escapeHtml(k)}`).join(", ")]] : [];
    })(),
    ["Stake (USD)", fmtUsd(c.stakeUsd)],
    ["Decay half-life", c.decayHalfLifeDays !== undefined ? `${c.decayHalfLifeDays} days` : "—"],
  ];
  return `
    <div class="rep-score">
      <span class="num">${fmtNum(rep.trustScore, 1)} <small>/ 100</small></span>
      <span class="dim">trust score</span>
    </div>
    <div class="table-wrap">
      <table class="data">
        <tbody>
          ${rows.map(([k, v]) => `<tr><td class="faint">${escapeHtml(k)}</td><td>${v}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${flags.length ? `<div style="margin-top:14px">${flags.map((f) => `<div style="margin-bottom:6px"><span class="tag tag-flag">${escapeHtml(f)}</span> <span class="faint">${escapeHtml(describeFlag(f))}</span></div>`).join("")}</div>` : ""}
  `;
}

function renderReceiptsTable(receipts, agentId) {
  if (receipts.length === 0) return stateBox("No receipts recorded for this agent yet.");
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Receipt</th><th>Counterparty</th><th>Capability</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>
      ${receipts.map((r) => {
        const isA = r.agentA && r.agentA.id === agentId;
        const counterparty = isA ? (r.agentB && r.agentB.id) : (r.agentA && r.agentA.id);
        const role = isA ? "as requester, worked by" : "as worker, requested by";
        return `<tr>
          <td class="mono">${receiptLink(r.receiptId)}</td>
          <td>${agentLink(counterparty)} <span class="faint">(${role})</span></td>
          <td>${escapeHtml((r.task && r.task.capability) || "—")}</td>
          <td>${statusTag(r.status)}</td>
          <td>${fmtDate(r.task && r.task.createdAt)}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table></div>`;
}

// ==================== Jobs ====================

function jobFiltersForm(q) {
  return `
  <form class="filters" data-route="jobs">
    <div class="field">
      <label for="f-jcapability">Capability</label>
      <input id="f-jcapability" name="capability" type="text" placeholder="e.g. translation.tr-en" value="${escapeHtml(q.get("capability") || "")}">
    </div>
    <div class="field">
      <label for="f-status">Status</label>
      <select id="f-status" name="status">
        <option value="">any</option>
        <option value="open">open</option>
        <option value="accepted">accepted</option>
        <option value="completed">completed</option>
        <option value="cancelled">cancelled</option>
      </select>
    </div>
    <button type="submit">Search</button>
  </form>`;
}

function jobCard(j) {
  return `<div class="card">
    <div class="card-id">${jobLink(j.jobId)} ${statusTag(j.status)}</div>
    <div>${escapeHtml(j.capability)}</div>
    <div class="card-meta">
      <span>posted by ${agentLink(j.postedBy)}</span>
      <span>${fmtDate(j.createdAt)}</span>
    </div>
    <div class="card-footer"><a href="${jobHref(j.jobId)}">View job &rarr;</a></div>
  </div>`;
}

async function renderJobSearch(query) {
  setApp(`
    <h2 class="h">Jobs</h2>
    ${jobFiltersForm(query)}
    <div id="results"><p class="spinner-text">Loading jobs…</p></div>
  `);
  const sel = document.querySelector('form[data-route="jobs"] select[name="status"]');
  if (sel && query.get("status")) sel.value = query.get("status");
  const results = document.getElementById("results");
  try {
    const data = await apiGet("/jobs/search", {
      capability: query.get("capability") || undefined,
      status: query.get("status") || undefined,
    });
    const jobs = data.jobs || [];
    if (jobs.length === 0) {
      results.innerHTML = stateBox("No jobs matched this search.");
      return;
    }
    results.innerHTML = `<div class="card-grid">${jobs.map(jobCard).join("")}</div>`;
  } catch (err) {
    results.innerHTML = errorBox(err, "Couldn't load job search results.");
  }
  wireFilterForm("jobs");
}

async function renderJobDetail(id) {
  setApp(`
    <div class="detail-header"><h2 class="h" style="margin-bottom:0">Job</h2></div>
    <p class="detail-id mono">${escapeHtml(id)}</p>
    <div id="job-body"><p class="spinner-text">Loading job…</p></div>
  `);
  const body = document.getElementById("job-body");
  let job;
  try {
    job = await apiGet(`/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    body.innerHTML = errorBox(err, "Couldn't load this job.");
    return;
  }
  const budget = job.budget && job.budget.amount ? `${escapeHtml(job.budget.amount)} ${escapeHtml(job.budget.currency || "")}` : "—";
  body.innerHTML = `
    <section class="block">
      <dl class="kv">
        <div><dt>Status</dt><dd>${statusTag(job.status)}</dd></div>
        <div><dt>Capability</dt><dd>${escapeHtml(job.capability)}</dd></div>
        <div><dt>Posted by</dt><dd>${agentLink(job.postedBy)}</dd></div>
        <div><dt>Spec hash</dt><dd class="mono">${escapeHtml(job.specHash)}</dd></div>
        <div><dt>Budget</dt><dd>${budget}</dd></div>
        <div><dt>Created</dt><dd>${fmtDate(job.createdAt)}</dd></div>
        <div><dt>Expires</dt><dd>${job.expiresAt ? fmtDate(job.expiresAt) : "—"}</dd></div>
        <div><dt>Accepted agent</dt><dd>${job.acceptedAgentId ? agentLink(job.acceptedAgentId) : "—"}</dd></div>
        <div><dt>Receipt</dt><dd>${job.receiptId ? receiptLink(job.receiptId) : "—"}</dd></div>
      </dl>
    </section>
    <section class="block">
      <h2 class="h">Offers</h2>
      <div id="offers-body"><p class="spinner-text">Loading offers…</p></div>
    </section>
  `;
  apiGet(`/jobs/${encodeURIComponent(id)}/offers`)
    .then((data) => { document.getElementById("offers-body").innerHTML = renderOffersTable(data.offers || []); })
    .catch((err) => { document.getElementById("offers-body").innerHTML = errorBox(err, "Couldn't load offers."); });
}

function renderOffersTable(offers) {
  if (offers.length === 0) return stateBox("No offers on this job yet.");
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Agent</th><th>Message</th><th>Submitted</th></tr></thead>
    <tbody>
      ${offers.map((o) => `<tr><td>${agentLink(o.agentId)}</td><td>${escapeHtml(o.message || "—")}</td><td>${fmtDate(o.createdAt)}</td></tr>`).join("")}
    </tbody>
  </table></div>`;
}

// ==================== Receipts ====================

async function renderReceiptDetail(id) {
  setApp(`
    <div class="detail-header"><h2 class="h" style="margin-bottom:0">Receipt</h2></div>
    <p class="detail-id mono">${escapeHtml(id)}</p>
    <div id="receipt-body"><p class="spinner-text">Loading receipt…</p></div>
  `);
  const body = document.getElementById("receipt-body");
  let receipt;
  try {
    receipt = await apiGet(`/receipts/${encodeURIComponent(id)}`);
  } catch (err) {
    body.innerHTML = errorBox(err, "Couldn't load this receipt.");
    return;
  }

  const task = receipt.task || {};
  const result = receipt.result || {};
  const settlement = receipt.settlement || {};
  const verification = receipt.verification || {};
  const dispute = receipt.dispute || {};
  const sigs = receipt.signatures || {};

  body.innerHTML = `
    <section class="block">
      <dl class="kv">
        <div><dt>Status</dt><dd>${statusTag(receipt.status)}</dd></div>
        <div><dt>Job</dt><dd>${jobLink(receipt.jobId)}</dd></div>
        <div><dt>Agent A (requester)</dt><dd>${agentLink(receipt.agentA && receipt.agentA.id, receipt.agentA && receipt.agentA.id)}</dd></div>
        <div><dt>Agent B (worker)</dt><dd>${agentLink(receipt.agentB && receipt.agentB.id, receipt.agentB && receipt.agentB.id)}</dd></div>
      </dl>
    </section>

    <section class="block">
      <h2 class="h">Task &amp; result</h2>
      <dl class="kv">
        <div><dt>Capability</dt><dd>${escapeHtml(task.capability || "—")}</dd></div>
        <div><dt>Spec hash</dt><dd class="mono">${escapeHtml(task.specHash || "—")}</dd></div>
        <div><dt>Task created</dt><dd>${fmtDate(task.createdAt)}</dd></div>
        <div><dt>Output hash</dt><dd class="mono">${escapeHtml(result.outputHash || "—")}</dd></div>
        ${result.outputUri ? `<div><dt>Output URI</dt><dd class="mono">${escapeHtml(result.outputUri)}</dd></div>` : ""}
        <div><dt>Completed</dt><dd>${fmtDate(result.completedAt)}</dd></div>
      </dl>
    </section>

    ${(settlement.amount || settlement.currency || settlement.paymentRef) ? `
    <section class="block">
      <h2 class="h">Settlement</h2>
      <dl class="kv">
        <div><dt>Amount</dt><dd>${escapeHtml(settlement.amount || "—")} ${escapeHtml(settlement.currency || "")}</dd></div>
        ${settlement.paymentRef ? `<div><dt>Payment ref</dt><dd class="mono">${escapeHtml(settlement.paymentRef)}</dd></div>` : ""}
      </dl>
    </section>` : ""}

    ${(verification.method || verification.outcome) ? `
    <section class="block">
      <h2 class="h">Submitted verification</h2>
      <dl class="kv">
        <div><dt>Method</dt><dd>${escapeHtml(verification.method || "—")}</dd></div>
        <div><dt>Outcome</dt><dd>${statusTag(verification.outcome) || escapeHtml(verification.outcome || "—")}</dd></div>
        ${verification.verifier ? `<div><dt>Verifier</dt><dd>${escapeHtml(verification.verifier)}</dd></div>` : ""}
      </dl>
    </section>` : ""}

    ${dispute.status && dispute.status !== "none" ? `
    <section class="block">
      <h2 class="h">Dispute</h2>
      <dl class="kv">
        <div><dt>Status</dt><dd>${statusTag(dispute.status)}</dd></div>
        ${dispute.reason ? `<div><dt>Reason</dt><dd>${escapeHtml(dispute.reason)}</dd></div>` : ""}
        ${dispute.windowClosesAt ? `<div><dt>Window closes</dt><dd>${fmtDate(dispute.windowClosesAt)}</dd></div>` : ""}
      </dl>
    </section>` : ""}

    <section class="block">
      <h2 class="h">Signatures</h2>
      <dl class="kv">
        <div><dt>Agent B</dt><dd class="mono">${sigs.agentB ? truncateMiddle(sigs.agentB, 20, 8) : "—"}</dd></div>
        <div><dt>Agent A</dt><dd class="mono">${sigs.agentA ? truncateMiddle(sigs.agentA, 20, 8) : "not yet countersigned"}</dd></div>
      </dl>
    </section>

    <section class="block">
      <h2 class="h">Independent verifications</h2>
      <div id="verifications-body"><p class="spinner-text">Loading verifications…</p></div>
    </section>
  `;

  apiGet(`/receipts/${encodeURIComponent(id)}/verifications`)
    .then((data) => { document.getElementById("verifications-body").innerHTML = renderVerificationsTable(data.verifications || []); })
    .catch((err) => { document.getElementById("verifications-body").innerHTML = errorBox(err, "Couldn't load verifications."); });
}

function renderVerificationsTable(verifications) {
  if (verifications.length === 0) {
    return stateBox("No independent verifications recorded for this receipt yet (SPEC.md §12 — these are optional, submitted separately from the receipt itself).");
  }
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Verifier</th><th>Method</th><th>Result</th><th>Score</th><th>Evidence</th><th>Submitted</th></tr></thead>
    <tbody>
      ${verifications.map((v) => `<tr>
        <td>${agentLink(v.verifier)}</td>
        <td>${escapeHtml(v.method || "—")}</td>
        <td>${statusTag(v.result)}</td>
        <td>${v.score !== undefined && v.score !== null ? fmtNum(v.score) : "—"}</td>
        <td>${(() => { const href = v.evidenceUri && safeExternalHref(v.evidenceUri); return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">link</a>` : v.evidenceUri ? escapeHtml(truncateMiddle(v.evidenceUri, 20, 8)) : "—"; })()}</td>
        <td>${fmtDate(v.createdAt)}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>`;
}

// ==================== Stats ====================

const STATS_CACHE_KEY = "inam_explorer_stats_v1";
const STATS_TTL_MS = 3 * 60 * 1000; // recompute at most every 3 minutes
const STATS_AGENT_CAP = 500; // defensive cap on how many agents we iterate for receipts

function statTile(label, num, sub) {
  return `<div class="stat-tile">
    <div class="stat-num">${num}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
  </div>`;
}

function statTileUnavailable(label, note) {
  return `<div class="stat-tile">
    <div class="stat-num unavailable">unavailable</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    ${note ? `<div class="stat-sub">${note}</div>` : ""}
  </div>`;
}

// Registry-wide totals aren't a single endpoint -- /agents/search and
// /jobs/search return every match with no result cap today (confirmed
// against worker/src/index.ts), so an unfiltered call's array length is
// an accurate total. Receipts/verifications have no system-wide listing
// at all, only per-agent / per-receipt, so getting a real count means
// iterating agents and deduping by receiptId (a receipt names both
// agentA and agentB, so it shows up in both parties' lists).
async function computeRegistryStats() {
  const agentsData = await apiGet("/agents/search");
  const allAgents = agentsData.agents || [];
  const agentCapped = allAgents.length > STATS_AGENT_CAP;
  const agents = agentCapped ? allAgents.slice(0, STATS_AGENT_CAP) : allAgents;

  const jobsData = await apiGet("/jobs/search");
  const jobs = jobsData.jobs || [];
  const jobsByStatus = {};
  for (const j of jobs) jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1;

  // Batch the per-agent receipt fetches so a large registry someday
  // doesn't fire hundreds of parallel requests at once.
  const receiptsById = new Map();
  const BATCH = 15;
  for (let i = 0; i < agents.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((a) =>
        apiGet(`/agents/${encodeURIComponent(a.id)}/receipts`).catch(() => ({ receipts: [] }))
      )
    );
    for (const r of results) {
      for (const receipt of r.receipts || []) {
        if (receipt.receiptId) receiptsById.set(receipt.receiptId, receipt);
      }
    }
  }
  const receipts = [...receiptsById.values()];
  const receiptsByStatus = {};
  for (const r of receipts) receiptsByStatus[r.status] = (receiptsByStatus[r.status] || 0) + 1;

  // Independent verifications (SPEC.md §12) are per-receipt only. Cap how
  // many receipts we probe so this stays cheap as the registry grows.
  const VERIF_CAP = 500;
  const verifTargets = receipts.slice(0, VERIF_CAP).map((r) => r.receiptId);
  let verificationCount = 0;
  for (let i = 0; i < verifTargets.length; i += BATCH) {
    const batch = verifTargets.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((id) =>
        apiGet(`/receipts/${encodeURIComponent(id)}/verifications`).catch(() => ({ verifications: [] }))
      )
    );
    for (const r of results) verificationCount += (r.verifications || []).length;
  }

  return {
    computedAt: new Date().toISOString(),
    totalAgents: allAgents.length,
    agentCapped,
    agentsScanned: agents.length,
    jobsByStatus,
    totalJobs: jobs.length,
    totalReceipts: receipts.length,
    receiptsByStatus,
    receiptsCapped: receipts.length > VERIF_CAP,
    verificationCount,
  };
}

function readStatsCache() {
  try {
    const raw = sessionStorage.getItem(STATS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - new Date(parsed.computedAt).getTime() > STATS_TTL_MS) return null;
    return parsed;
  } catch (_) { return null; }
}

function writeStatsCache(data) {
  try { sessionStorage.setItem(STATS_CACHE_KEY, JSON.stringify(data)); } catch (_) { /* ignore */ }
}

// ---- external package/community signal ----
// Verified by hand before shipping (curl -I against each): GitHub's and
// npm's public APIs both send Access-Control-Allow-Origin: *, so a
// browser fetch() works directly. pypistats.org does NOT send any CORS
// header on its response -- a browser fetch to it fails silently with an
// opaque network error, so PyPI downloads are shown as a link instead of
// a fetched number rather than a broken/misleading tile.

async function fetchGithubStats() {
  const res = await fetch("https://api.github.com/repos/inamprotocol/inam-protocol");
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const j = await res.json();
  return { stars: j.stargazers_count, forks: j.forks_count, watchers: j.subscribers_count };
}

async function fetchNpmDownloads() {
  const [week, month] = await Promise.all([
    fetch("https://api.npmjs.org/downloads/point/last-week/inamprotocol").then((r) => r.ok ? r.json() : Promise.reject(new Error(`npm API returned ${r.status}`))),
    fetch("https://api.npmjs.org/downloads/point/last-month/inamprotocol").then((r) => r.ok ? r.json() : Promise.reject(new Error(`npm API returned ${r.status}`))),
  ]);
  return { week: week.downloads ?? 0, month: month.downloads ?? 0 };
}

async function renderStats() {
  setApp(`
    <h2 class="h">Registry &amp; adoption stats</h2>
    <p class="dim">A live snapshot of the public registry, computed client-side from the same API anyone can query, plus package/community signal from npm, PyPI, and GitHub's own public APIs. Not a real-time feed -- see the timestamp below.</p>
    <div id="stats-asof"></div>
    <div id="stats-body"><p class="spinner-text">Loading stats…</p></div>
  `);
  await loadAndRenderStats(false);
  document.getElementById("stats-asof").addEventListener("click", (e) => {
    if (e.target && e.target.id === "stats-refresh") loadAndRenderStats(true);
  });
}

function renderStatsAsOf(iso, fromCache) {
  const el = document.getElementById("stats-asof");
  if (!el) return;
  const time = new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<div class="stat-asof">
    <span>Registry activity as of ${escapeHtml(time)}${fromCache ? " (cached)" : ""}</span>
    <button id="stats-refresh" class="secondary" type="button">Refresh now</button>
  </div>`;
}

async function loadAndRenderStats(forceRefresh) {
  const body = document.getElementById("stats-body");
  const cached = !forceRefresh && readStatsCache();

  // External package/community stats: fetch independently of the registry
  // aggregate and independently of each other, so one slow/failed source
  // never blocks or blanks out the others.
  const externalPromise = (async () => {
    const [github, npm] = await Promise.all([
      fetchGithubStats().catch((e) => ({ error: e })),
      fetchNpmDownloads().catch((e) => ({ error: e })),
    ]);
    return { github, npm };
  })();

  let registry;
  if (cached) {
    registry = cached;
  } else {
    try {
      registry = await computeRegistryStats();
      writeStatsCache(registry);
    } catch (err) {
      body.innerHTML = errorBox(err, "Couldn't compute registry stats.");
      return;
    }
  }
  renderStatsAsOf(registry.computedAt, !!cached);

  const jobDone = (registry.jobsByStatus.completed || 0);
  const receiptFinal = (registry.receiptsByStatus.finalized || 0);
  const receiptDisputed = (registry.receiptsByStatus.disputed || 0);

  const external = await externalPromise;
  const gh = external.github;
  const npmD = external.npm;

  body.innerHTML = `
    <h3 class="h">Registry activity</h3>
    <div class="stat-grid">
      ${statTile("Registered agents", registry.totalAgents, registry.agentCapped ? `computed from the first ${registry.agentsScanned}` : "")}
      ${statTile("Jobs posted", registry.totalJobs, `${jobDone} completed`)}
      ${statTile("Finalized receipts", receiptFinal, `${registry.totalReceipts} total, ${receiptDisputed} disputed`)}
      ${statTile("Independent verifications", registry.verificationCount, registry.receiptsCapped ? "capped scan" : "SPEC.md §12")}
    </div>

    <h3 class="h" style="margin-top:26px">Jobs by status</h3>
    <div class="stat-grid">
      ${["open", "accepted", "completed", "cancelled"].map((s) => statTile(s, registry.jobsByStatus[s] || 0)).join("")}
    </div>

    <h3 class="h" style="margin-top:26px">Package &amp; community</h3>
    <div class="stat-grid">
      ${gh && !gh.error
        ? statTile("GitHub stars", gh.stars, `${gh.forks} forks &middot; ${gh.watchers} watching`)
        : statTileUnavailable("GitHub stars", `<a class="stat-fallback" href="https://github.com/inamprotocol/inam-protocol" target="_blank" rel="noopener">github.com/inamprotocol/inam-protocol</a>`)}
      ${npmD && !npmD.error
        ? statTile("npm downloads", npmD.week, `${npmD.month} last 30 days`)
        : statTileUnavailable("npm downloads", `<a class="stat-fallback" href="https://www.npmjs.com/package/inamprotocol" target="_blank" rel="noopener">npmjs.com/package/inamprotocol</a>`)}
      ${statTileUnavailable("PyPI downloads", `pypistats.org doesn't allow browser requests &mdash; <a class="stat-fallback" href="https://pypistats.org/packages/inamprotocol" target="_blank" rel="noopener">pypistats.org/packages/inamprotocol</a>`)}
    </div>
  `;
}

// ==================== Lookup ====================

function renderLookup() {
  setApp(`
    <h2 class="h">Look up an ID</h2>
    <p class="dim">Paste any registry ID and jump straight to it — an agent's <code>did:key:...</code>, a receipt's <code>sha256:...</code> ID, or a job's <code>job_...</code> ID.</p>
    <div class="lookup-box">
      <form class="filters" id="lookup-form">
        <div class="field" style="flex:1">
          <label for="lookup-q">ID</label>
          <input id="lookup-q" name="q" type="text" placeholder="did:key:z6Mk… / sha256:… / job_…" style="width:100%">
        </div>
        <button type="submit">Go</button>
      </form>
      <p class="lookup-hint" id="lookup-hint"></p>
    </div>
  `);
  const form = document.getElementById("lookup-form");
  const hint = document.getElementById("lookup-hint");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = form.elements["q"].value.trim();
    if (!val) return;
    if (val.startsWith("did:key:")) { location.hash = `/agents/${encodeURIComponent(val)}`; return; }
    if (val.startsWith("sha256:")) { location.hash = `/receipts/${encodeURIComponent(val)}`; return; }
    if (val.startsWith("job_")) { location.hash = `/jobs/${encodeURIComponent(val)}`; return; }
    hint.textContent = `"${val}" doesn't look like a recognized ID — expected it to start with did:key:, sha256:, or job_.`;
  });
}

// ==================== routing ====================

function wireFilterForm(route) {
  const form = document.querySelector(`form[data-route="${route}"]`);
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (String(v).trim() !== "") params.set(k, v);
    }
    const qs = params.toString();
    location.hash = `/${route}${qs ? `?${qs}` : ""}`;
  });
}

function setActiveNav(section) {
  document.querySelectorAll(".topnav a[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === section);
  });
}

function renderNotFound() {
  setApp(stateBox("Nothing here. Use the nav above for stats, agents, or jobs, or look up an ID directly.", false));
}

function route() {
  const raw = location.hash.replace(/^#/, "") || "/stats";
  let url;
  try {
    url = new URL(raw, "http://explorer.local/");
  } catch (_) {
    renderNotFound();
    return;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const query = url.searchParams;

  if (segments.length === 0 || segments[0] === "stats") {
    setActiveNav("stats");
    renderStats();
    return;
  }
  if (segments[0] === "agents") {
    if (segments.length === 2) {
      setActiveNav("agents");
      renderAgentDetail(decodeURIComponent(segments[1]));
    } else {
      setActiveNav("agents");
      renderAgentSearch(query);
    }
    return;
  }
  if (segments[0] === "jobs") {
    setActiveNav("jobs");
    if (segments.length === 2) renderJobDetail(decodeURIComponent(segments[1]));
    else renderJobSearch(query);
    return;
  }
  if (segments[0] === "receipts" && segments.length === 2) {
    setActiveNav("");
    renderReceiptDetail(decodeURIComponent(segments[1]));
    return;
  }
  if (segments[0] === "lookup") {
    setActiveNav("lookup");
    renderLookup();
    return;
  }
  renderNotFound();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  if (API_BASE !== DEFAULT_API_BASE) {
    const banner = document.createElement("div");
    banner.className = "dev-banner";
    banner.textContent = `Dev mode — pointed at ${API_BASE} instead of the live production API (?api= override).`;
    document.body.insertBefore(banner, document.body.firstChild);
    const apiLink = document.getElementById("api-base-link");
    if (apiLink) { apiLink.href = API_BASE.replace(/\/v1$/, ""); apiLink.textContent = API_BASE; }
  }
  route();
});
