import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveActiveEmbeddedRunSessionId,
  queueAgentHarnessMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * lma-steer
 * ---------
 * Lets the LMA (openclaw-lark-multi-agent) bridge inject a queued user message
 * into the *active* OpenClaw run at the next tool-call boundary, instead of
 * making the user wait for the whole run to finish.
 *
 * Why a plugin (not the native `chat.send` + queue.mode=steer):
 *   - native `chat.send` only acks `{status:"started"}` — it can NOT tell the
 *     bridge whether the message actually steered into the active run, was
 *     queued as a followup, or was rejected.
 *   - this plugin uses the runtime primitives `resolveActiveEmbeddedRunSessionId`
 *     + `queueAgentHarnessMessage`, which DO expose that distinction, so the
 *     bridge can render an accurate Feishu reaction (e.g. "Get" = inserted).
 *
 * The plugin is deliberately thin: it does NOT detect tool-call boundaries
 * itself (the OpenClaw runtime already drains the steer queue between tool
 * calls — proxy turn loop). It just resolves the active run and queues with an
 * observable outcome.
 *
 * Gateway method: `lma.steer`
 *   params:  { sessionKey: string, text: string, steeringMode?: "all" }
 *   result:  { status: "steered" | "no_active_run" | "rejected",
 *              sessionId?: string }
 *
 *   - "steered"      -> message was queued into the active embedded run; it will
 *                       be picked up at the next model/tool boundary. (Feishu: Get)
 *   - "no_active_run"-> no active run for this session; the bridge should fall
 *                       back to its normal "send as a new message" path.
 *   - "rejected"     -> there was an active run but the runtime refused the
 *                       injection (e.g. compacting / not streaming). Bridge falls
 *                       back to normal queue.
 */

type SteerStatus = "steered" | "no_active_run" | "rejected";

const ERR_INVALID = "INVALID_REQUEST";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default definePluginEntry({
  id: "lma-steer",
  name: "LMA Steer",
  description: "Steer a queued message into the active OpenClaw run at the next tool-call boundary, with an observable outcome for the LMA bridge.",
  register(api) {
    api.registerGatewayMethod("lma.steer", async ({ params, respond }) => {
      const sessionKey = readString(params.sessionKey);
      const text = readString(params.text);
      if (!sessionKey) {
        respond(false, undefined, { code: ERR_INVALID, message: "lma.steer requires a non-empty sessionKey" });
        return;
      }
      if (!text) {
        respond(false, undefined, { code: ERR_INVALID, message: "lma.steer requires a non-empty text" });
        return;
      }

      try {
        // Is there an active embedded run for this session right now?
        const sessionId = resolveActiveEmbeddedRunSessionId(sessionKey);
        if (!sessionId) {
          const result: { status: SteerStatus } = { status: "no_active_run" };
          respond(true, result);
          return;
        }

        // Queue the message into the active run. The runtime drains this at the
        // next tool-call boundary. `queueAgentHarnessMessage` returns whether the
        // message was accepted into the run's steering queue.
        const queued = queueAgentHarnessMessage(sessionId, text, { steeringMode: "all" });
        const result: { status: SteerStatus; sessionId: string } = {
          status: queued ? "steered" : "rejected",
          sessionId,
        };
        respond(true, result);
      } catch (err) {
        respond(false, undefined, {
          code: "INTERNAL",
          message: `lma.steer failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  },
});
