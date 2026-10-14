// node actions/check/test.mjs : runs check.sh against a mock server for pass/caution/fail/error. Needs bash, curl, jq.
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check.sh", import.meta.url));
const rep = (verdict) => ({ verdict, checks: [{ id: "x", status: verdict === "pass" ? "pass" : "warn", label: "a | b", detail: "d" }] });
const routes = {
  "0xpass": [200, rep("pass")], "0xcaution": [200, rep("caution")], "0xfail": [200, rep("fail")],
  "0x400": [400, { error: { message: "bad target" } }], "0x500": [500, "oops"], "0xjunk": [200, "not json"], "0xnoverdict": [200, { checks: [] }],
};
const srv = http.createServer((req, res) => {
  const [code, body] = routes[new URL(req.url, "http://x").searchParams.get("target")] ?? [404, {}];
  res.writeHead(code, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));
}).listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  // async spawn: a sync one would block the mock server's event loop
  const run = (target, failOn = "fail", apiBase = base) =>
    new Promise((resolve) => {
      const p = spawn("bash", [script], { env: { ...process.env, INAM_TARGET: target, INAM_FAIL_ON: failOn, INAM_API_BASE: apiBase, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" } });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const cases = [
    ["pass", "fail", 0], ["pass", "caution", 0], ["caution", "fail", 0], ["caution", "caution", 1], ["fail", "fail", 1], ["fail", "caution", 1],
    ["400", "fail", 2], ["500", "fail", 2], ["junk", "fail", 2], ["noverdict", "fail", 2], ["pass", "bogus", 2],
  ];
  for (const [t, f, want] of cases) {
    const r = await run(`0x${t}`, f);
    assert.equal(r.status, want, `${t}/${f}: got ${r.status}\n${r.stdout}${r.stderr}`);
    console.log(`ok  ${t} fail-on=${f} -> exit ${want}`);
  }
  const r = await run("0xpass", "fail", "http://127.0.0.1:1");
  assert.equal(r.status, 2, "network error must not pass"); console.log("ok  network error -> exit 2");
  assert.match((await run("0xcaution")).stdout, /\| warn \| a \/ b \| d \|/); console.log("ok  summary table");
  srv.close();
});
