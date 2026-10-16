import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveActiveEmbeddedRunSessionId,
  queueAgentHarnessMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * lma-core :: steer module
 * ------------------------
 * Lets the LMA (openclaw-lark-multi-agent) bridge inject a queued user message
 * into the *active* OpenClaw run at the next tool-call boundary, instead of
 * making the user wait for the whole run to finish.
 *
 * Gateway method: `lma.steer`  (name kept identical to the former standalone
 * lma-steer plugin so the bridge needs zero changes)
 *   params:  { sessionKey: string, text: string, steeringMode?: "all" }
 *   result:  { status: "steered" | "no_active_run" | "rejected", sessionId?: string }
 */

type SteerStatus = "steered" | "no_active_run" | "rejected";

const ERR_INVALID = "INVALID_REQUEST";

// A run can be accepted but not yet resolvable/streaming (cold-start window).
// Wait up to STEER_WAIT_MS (polling every STEER_POLL_MS) for it to become
// steerable before falling back to no_active_run. Env-tunable.
const STEER_WAIT_MS = Number(process.env.LMA_STEER_WAIT_MS || 3000);
const STEER_POLL_MS = Number(process.env.LMA_STEER_POLL_MS || 300);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Candidate session keys to try, in order. OpenClaw registers active runs under
 * the fully-qualified key `agent:<agentId>:<key>`, but callers such as the LMA
 * bridge pass the bare key. Try the key as given first, then the
 * agent:main:-qualified form, so both conventions resolve to the same run.
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

export function registerSteer(api: any): void {
  api.registerGatewayMethod("lma.steer", async ({ params, respond }: any) => {
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
      const deadline = Date.now() + STEER_WAIT_MS;
      let { sessionId, resolvedKey } = resolveActiveSessionId(sessionKey);
      let waited = 0;
      while (!sessionId && Date.now() < deadline) {
        await sleep(STEER_POLL_MS);
        waited += STEER_POLL_MS;
        ({ sessionId, resolvedKey } = resolveActiveSessionId(sessionKey));
      }
      if (!sessionId) {
        console.log(`[lma-core] steer: no_active_run for ${sessionKey} after ${waited}ms wait`);
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
      console.log(`[lma-core] steer: ${queued ? "steered" : "rejected"} ${sessionKey} (resolved=${resolvedKey}) sid=${sessionId} after ${waited}ms`);
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
}
