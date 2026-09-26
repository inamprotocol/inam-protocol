import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// An external review found SPEC.md documenting the transparency-log
// endpoints while openapi.yaml (the published API reference) omitted them.
// The Worker's route table is the source of truth; SPEC §6 and openapi.yaml
// must list exactly the same METHOD + path set.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function workerRoutes(): Set<string> {
  const out = new Set<string>();
  for (const m of read("worker/src/index.ts").matchAll(/app\.(get|post)\("\/v1(\/[^"]*)"/g)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

function openapiRoutes(): Set<string> {
  const out = new Set<string>();
  const yaml = read("openapi.yaml").replace(/\r/g, "");
  for (const [, path, body] of yaml.matchAll(/^ {2}(\/\S+):\n((?: {4}.*\n|\n)*)/gm)) {
    for (const [, method] of body.matchAll(/^ {4}(get|post):/gm)) out.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
  }
  return out;
}

function specRoutes(): Set<string> {
  const out = new Set<string>();
  for (const line of read("SPEC.md").split("\n")) {
    if (!line.startsWith("| `")) continue;
    for (const m of line.matchAll(/`(GET|POST) (\/[^`?\s]+)/g)) out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

const sorted = (s: Set<string>) => [...s].sort();

describe("API surface drift", () => {
  it("openapi.yaml lists exactly the Worker's routes", () => {
    expect(sorted(openapiRoutes())).toEqual(sorted(workerRoutes()));
  });
  it("SPEC.md §6 lists exactly the Worker's routes", () => {
    expect(sorted(specRoutes())).toEqual(sorted(workerRoutes()));
  });
});
