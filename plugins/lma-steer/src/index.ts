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

// A run can be accepted but not yet resolvable/streaming (cold-start window).
// Wait up to STEER_WAIT_MS (polling every STEER_POLL_MS) for it to become
// steerable before falling back to no_active_run. Env-tunable.
const STEER_WAIT_MS = Number(process.env.LMA_STEER_WAIT_MS || 8000);
const STEER_POLL_MS = Number(process.env.LMA_STEER_POLL_MS || 300);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Candidate session keys to try, in order. OpenClaw registers active runs under
 * the fully-qualified key `agent:<agentId>:<key>` (e.g. agent:main:lma-claude-
 * oc_xxx), but callers such as the LMA bridge pass the bare key (lma-claude-
 * oc_xxx). Try the key as given first, then the agent:main:-qualified form, so
 * both conventions resolve to the same active run.
 */
function sessionKeyCandidates(sessionKey: string): string[] {
  const out = [sessionKey];
  if (!/^agent:/.test(sessionKey)) out.push(`agent:main:${sessionKey}`);
  return out;
}

function resolveActiveSessionId(sessionKey: string): { sessionId?: string; resolvedKey?: string } {
  for (const key of sessionKeyCandidates(sessionKey)) {
    const sessionId = resolveActiveEmbeddedRunSessionId(key);
    if (sessionId) return { sessionId, resolvedKey: key };
  }
  return {};
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
        // A run may be accepted (chat.send returned a runId) but still in its
        // cold-start/queued window where it is not yet resolvable or streaming.
        // The LMA bridge only calls steer when it believes a run is active, so
        // briefly wait for the run to become steerable instead of giving up on
        // the first miss. Total wait is bounded so we never hang the caller.
        // We also try both the bare and agent:main:-qualified session key, since
        // the bridge passes the bare key while runs register under the qualified one.
        const deadline = Date.now() + STEER_WAIT_MS;
        let { sessionId, resolvedKey } = resolveActiveSessionId(sessionKey);
        let waited = 0;
        while (!sessionId && Date.now() < deadline) {
          await sleep(STEER_POLL_MS);
          waited += STEER_POLL_MS;
          ({ sessionId, resolvedKey } = resolveActiveSessionId(sessionKey));
        }
        if (!sessionId) {
          console.log(`[lma-steer] no_active_run for ${sessionKey} after ${waited}ms wait`);
          const result: { status: SteerStatus } = { status: "no_active_run" };
          respond(true, result);
          return;
        }

        // Queue the message into the active run. queueAgentHarnessMessage only
        // succeeds once the run is actually streaming; if the run resolved but is
        // not streaming yet, retry within the remaining budget.
        let queued = queueAgentHarnessMessage(sessionId, text, { steeringMode: "all" });
        while (!queued && Date.now() < deadline) {
          await sleep(STEER_POLL_MS);
          waited += STEER_POLL_MS;
          const re = resolveActiveSessionId(sessionKey);
          sessionId = re.sessionId || sessionId;
          queued = queueAgentHarnessMessage(sessionId, text, { steeringMode: "all" });
        }
        console.log(`[lma-steer] ${queued ? "steered" : "rejected"} ${sessionKey} (resolved=${resolvedKey}) sid=${sessionId} after ${waited}ms`);
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
