import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { join } from "node:path";
import { checkTool } from "./policy.js";
import { GoPolicyRegistry } from "./registry.js";
export default definePluginEntry({
  id: "lma-go", name: "LMA Go", description: "Exact-identity persisted Go tool enforcement",
  register(api) {
    const registry = new GoPolicyRegistry(join(resolveStateDir(), "lma-go", "bindings.json"), api.pluginConfig?.bindings ?? []);
    api.on("before_tool_call", (event, ctx) => checkTool(registry.list(), event, ctx), { priority: 10000 });
    api.registerGatewayMethod("lma.go.bind", ({ params, respond }) => {
      try { registry.bind(params.binding); respond(true, { persisted: true, binding: params.binding }); }
      catch (e) { respond(false, undefined, { code: "INVALID_REQUEST", message: (e as Error).message }); }
    }, { scope: "operator.admin" });
    api.registerGatewayMethod("lma.go.capabilities", ({ respond }) => {
      respond(true, { mode: "independent", checkerToolsIsolated: true, taskQuery: true,
        atomicSnapshot: false, nativeGoalAuthority: false });
    }, { scope: "operator.read" });
    api.registerGatewayMethod("lma.go.snapshot", ({ params, respond }) => {
      if (typeof params.sessionKey !== "string" || typeof params.sessionId !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "exact session identity required" }); return;
      }
      const tasks = api.runtime.tasks.runs.bindSession({ sessionKey: params.sessionKey }).list();
      respond(true, { sessionKey: params.sessionKey, requestedSessionId: params.sessionId, tasks,
        queryAvailable: true, atomicSnapshot: false,
        boundaries: ["tasks scoped to canonical key; adapter pins generation and run ids", "LMA checks its own queue and delivery ledger"] });
    }, { scope: "operator.read" });
  },
});
