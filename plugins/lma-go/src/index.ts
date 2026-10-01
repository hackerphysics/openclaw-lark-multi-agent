import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { checkTool, parseBindings } from "./policy.js";
/** Fixture-ready enforcement component, NOT a capability proof or enabled integration. */
export default definePluginEntry({
  id: "lma-go", name: "LMA Go", description: "Exact-identity Go message-review tool enforcement",
  register(api) {
    const bindings = parseBindings(api.pluginConfig?.bindings ?? []);
    api.on("before_tool_call", (event, ctx) => checkTool(bindings, event, ctx), { priority: 10000 });
  },
});
