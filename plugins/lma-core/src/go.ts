import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { join } from "node:path";
import { checkTool } from "./go-policy.js";
import { GoPolicyRegistry } from "./go-registry.js";

/**
 * lma-core :: go module
 * ---------------------
 * Exact-identity persisted Go tool enforcement for the independent LMA Go
 * Checker (message-review checkers may not invoke tools).
 *
 * Gateway methods (names kept identical to the former standalone lma-go
 * plugin): `lma.go.bind`, `lma.go.capabilities`, `lma.go.snapshot`.
 * The persisted registry path is also unchanged
 * (`<stateDir>/lma-go/bindings.json`) so existing bindings carry over.
 */
export function registerGo(api: any): void {
  const registry = new GoPolicyRegistry(join(resolveStateDir(), "lma-go", "bindings.json"), api.pluginConfig?.bindings ?? []);
  api.on("before_tool_call", (event: any, ctx: any) => checkTool(registry.list(), event, ctx), { priority: 10000 });
  api.registerGatewayMethod("lma.go.bind", ({ params, respond }: any) => {
    try { registry.bind(params.binding); respond(true, { persisted: true, binding: params.binding }); }
    catch (e) { respond(false, undefined, { code: "INVALID_REQUEST", message: (e as Error).message }); }
  }, { scope: "operator.admin" });
  api.registerGatewayMethod("lma.go.capabilities", ({ respond }: any) => {
    respond(true, { mode: "independent", checkerToolsIsolated: true, taskQuery: true,
      atomicSnapshot: false, nativeGoalAuthority: false });
  }, { scope: "operator.read" });
  api.registerGatewayMethod("lma.go.snapshot", ({ params, respond }: any) => {
    if (typeof params.sessionKey !== "string" || typeof params.sessionId !== "string") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "exact session identity required" }); return;
    }
    const tasks = api.runtime.tasks.runs.bindSession({ sessionKey: params.sessionKey }).list();
    respond(true, { sessionKey: params.sessionKey, requestedSessionId: params.sessionId, tasks,
      queryAvailable: true, atomicSnapshot: false,
      boundaries: ["tasks scoped to canonical key; adapter pins generation and run ids", "LMA checks its own queue and delivery ledger"] });
  }, { scope: "operator.read" });
}
