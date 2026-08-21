import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Deliberately minimal persistence: an in-memory Map backed by a single JSON
 * file, rewritten synchronously on every mutation. This is fine for a
 * reference implementation / demo at low write volume. Swap point for a real
 * deployment: replace this class with a Postgres/SQLite-backed repository
 * behind the same get/set/all interface — nothing above this layer needs to
 * change.
 */
export class JsonStore<T> {
  private data = new Map<string, T>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      if (raw.trim().length > 0) {
        const parsed: Record<string, T> = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) this.data.set(k, v);
      }
    } else {
      this.persist();
    }
  }

  get(id: string): T | undefined {
    return this.data.get(id);
  }

  has(id: string): boolean {
    return this.data.has(id);
  }

  set(id: string, value: T): void {
    this.data.set(id, value);
    this.persist();
  }

  all(): T[] {
    return Array.from(this.data.values());
  }

  private persist(): void {
    const obj: Record<string, T> = {};
    for (const [k, v] of this.data.entries()) obj[k] = v;
    writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
  }
}
