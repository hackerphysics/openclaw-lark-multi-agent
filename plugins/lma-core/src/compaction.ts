/**
 * lma-core :: compaction module (Phase 1: capability surface)
 * -----------------------------------------------------------
 * Home of the custom compaction R&D (user directive 2026-10-10: tool-trim —
 * drop tool payload, keep text — via the gateway's sanctioned internals
 * instead of external storage writes).
 *
 * Phase 1 ships:
 *  - `lma.core.capabilities`: module inventory + compaction strategy report.
 *  - Registration-time api-surface probe (env LMA_CORE_LOG_API=1): logs the
 *    plugin api's enumerable surface so Phase 2 can target the real
 *    llm-input / compaction hook names instead of guessing.
 *
 * Phase 2 (next): tool-trim projection using the discovered hooks
 * (candidates from the SDK: runAgentHarnessLlmInputHook,
 * Before/AfterCompactionHook, ContextEngine projections).
 */
export function registerCompaction(api: any): void {
  if (process.env.LMA_CORE_LOG_API === "1") {
    try {
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(api) ?? {})
        .concat(Object.keys(api ?? {}));
      const unique = Array.from(new Set(surface)).sort();
      console.log(`[lma-core] compaction probe: plugin api surface (${unique.length}): ${unique.join(", ")}`);
    } catch (err) {
      console.warn(`[lma-core] compaction probe failed:`, (err as Error).message);
    }
  }
  api.registerGatewayMethod("lma.core.probe", ({ respond }: any) => {
    // Phase-2 R&D: dump the live plugin api + runtime surface (names only,
    // no values — nothing sensitive) so toolTrim targets real methods.
    const surface = (obj: unknown, depth = 0): unknown => {
      if (!obj || typeof obj !== "object" || depth > 2) return typeof obj;
      const out: Record<string, unknown> = {};
      let keys: string[] = [];
      try { keys = Object.keys(obj); } catch { return "inaccessible"; }
      try {
        const proto = Object.getPrototypeOf(obj);
        if (proto && proto !== Object.prototype) {
          keys = Array.from(new Set([...Object.getOwnPropertyNames(proto), ...keys]));
        }
      } catch { /* ignore */ }
      for (const k of keys.slice(0, 120)) {
        let v: unknown;
        try { v = (obj as Record<string, unknown>)[k]; } catch { out[k] = "getter-threw"; continue; }
        out[k] = typeof v === "function" ? "fn" : surface(v, depth + 1);
      }
      return out;
    };
    respond(true, { api: surface(api), version: "0.1.0" });
  }, { scope: "operator.read" });
  api.registerGatewayMethod("lma.core.capabilities", ({ respond }: any) => {
    respond(true, {
      plugin: "lma-core",
      modules: ["steer", "go", "compaction"],
      methods: ["lma.steer", "lma.go.bind", "lma.go.capabilities", "lma.go.snapshot", "lma.core.capabilities"],
      compaction: {
        rpcStrategies: ["semantic (LLM summarize)", "maxLines (transcript tail truncate)"],
        toolTrim: {
          status: "phase-1-probe",
          target: "projection-style: keep transcript intact, filter tool payload from model context",
          candidateHooks: ["llmInputHook", "beforeCompactionHook", "contextEngineProjection"],
        },
      },
      version: "0.1.0",
    });
  }, { scope: "operator.read" });
}
