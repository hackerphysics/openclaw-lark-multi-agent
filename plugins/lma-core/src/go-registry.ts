import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { parseBindings, type Binding } from "./go-policy.js";
/** Atomic persisted restriction registry. Never auto-unbind on restart/stop. */
export class GoPolicyRegistry {
  private bindings: Binding[];
  constructor(private path: string, initial: unknown = []) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; value = initial; }
    this.bindings = parseBindings(value);
  }
  list() { return this.bindings.map(b => ({ ...b })); }
  bind(value: unknown) {
    const [binding] = parseBindings([value]);
    const previous = this.bindings.find(b => b.checkerSessionKey === binding.checkerSessionKey);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("Binding identity conflict");
      return;
    }
    const next = parseBindings([...this.bindings, binding]);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.path);
    this.bindings = next;
  }
}
