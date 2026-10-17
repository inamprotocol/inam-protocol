import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { append, verifyLog } from "../integrations/claude-code-log/inam-log.js";

const call = (n: number) => ({ tool_name: "Bash", tool_input: { command: `echo secret-${n}` }, tool_response: { stdout: `secret-${n}` } });

describe("inam-log", () => {
  it("chains signed entries, stores only hashes, and verifies offline", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inam-log-"));
    for (let i = 0; i < 3; i++) append(call(i), dir);
    const raw = readFileSync(path.join(dir, "log.jsonl"), "utf8");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("echo");
    expect(verifyLog(dir)).toMatchObject({ ok: true, entries: 3 });
    if (process.platform !== "win32") expect(statSync(path.join(dir, "key")).mode & 0o777).toBe(0o600);
  });

  it("detects edits, reordering and removal of a middle entry", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inam-log-"));
    for (let i = 0; i < 3; i++) append(call(i), dir);
    const file = path.join(dir, "log.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const edit = (ls: string[]) => { writeFileSync(file, ls.join("\n") + "\n"); return verifyLog(dir); };
    expect(edit([lines[0], lines[1].replace('"Bash"', '"Read"'), lines[2]])).toMatchObject({ ok: false });
    expect(edit([lines[0], lines[2], lines[1]])).toMatchObject({ ok: false });
    expect(edit([lines[0], lines[2]])).toMatchObject({ ok: false });
    expect(edit(lines)).toMatchObject({ ok: true });
  });
});
