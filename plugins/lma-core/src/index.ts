import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSteer } from "./steer.js";
import { registerGo } from "./go.js";
import { registerCompaction } from "./compaction.js";

/**
 * lma-core — the single consolidated LMA gateway plugin
 * ------------------------------------------------------
 * Replaces the former standalone plugins:
 *   - lma-steer (0.1.1)  -> steer module   (`lma.steer`)
 *   - lma-go    (0.1.0)  -> go module      (`lma.go.*`, before_tool_call guard)
 * plus the new compaction R&D module (`lma.core.capabilities`).
 *
 * One manifest, one allowlist entry, one upgrade path. All gateway method
 * names and the persisted go-bindings path are unchanged, so the LMA bridge
 * and existing state migrate with zero changes.
 */
export default definePluginEntry({
  id: "lma-core",
  name: "LMA Core",
  description: "Consolidated LMA plugin: mid-run steer injection, Go checker tool enforcement, custom compaction R&D.",
  register(api) {
    registerSteer(api);
    registerGo(api);
    registerCompaction(api);
    console.log("[lma-core] registered: steer (lma.steer), go (lma.go.*), compaction (lma.core.capabilities)");
  },
});
