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
