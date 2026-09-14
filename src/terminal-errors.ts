import { createHash } from "node:crypto";

/** Only gateway envelopes / committed assistant metadata populate this record. */
export interface ErrorProvenance {
  sessionKey: string;
  runId: string;
  source: "chat" | "session.message";
  state: string;
  stopReason?: string;
  detail?: string;
  userStop?: boolean;
}
export interface ProactiveMessageMeta {
  sourceType?: string;
  runId?: string;
  sessionKey?: string;
  final?: boolean;
  error?: ErrorProvenance;
  terminalEvidence?: ErrorVerdict;
  /** Missing stopReason: only a persisted error for this exact run may qualify. */
  genericErrorCandidate?: boolean;
}
export interface TaskEvidence {
  id: string;
  kind?: string;
  runId?: string;
  sourceId?: string;
  sessionKey?: string;
  ownerKey?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  status: string;
  deliveryStatus?: string;
  terminalOutcome?: string;
}
export interface ErrorVerdict {
  state: "pending" | "suppressed" | "terminal" | "stopped";
  reason: string;
  task?: TaskEvidence;
  terminalKey?: string;
  text?: string;
}
export type ReadRPC = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;
export const errorIdentity = (sessionKey: string, runId: string) =>
  createHash("sha256").update(JSON.stringify([sessionKey, runId])).digest("hex");
export const genericFailure = (text: string) => text.trim() === "The agent run failed before producing a reply.";

// These are candidate locators, NOT business identities. Verify every component
// against tasks.list + a fresh tasks.get. Unsupported/batch forms stay unknown.
export function announceCandidate(p: ErrorProvenance): { runId: string; childSessionKey?: string } | undefined {
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const direct = p.runId.match(new RegExp(`^announce:v1:(agent:[^:]+:.+):(${uuid})$`));
  if (direct) return { childSessionKey: direct[1], runId: direct[2] };
  const agent = p.sessionKey.match(/^agent:([^:]+):/)?.[1];
  const prefix = `announce:requester-settle:${agent}:${p.sessionKey}:`;
  if (!agent || !p.runId.startsWith(prefix)) return;
  const wake = p.runId.slice(prefix.length).match(new RegExp(`^(${uuid})(?::yield-\\d+)?(?::retry-\\d+)?$`));
  if (wake) return { runId: wake[1] };
}
function projectTask(t: any): TaskEvidence {
  const out: any = {};
  for (const k of ["id", "kind", "runId", "sourceId", "sessionKey", "ownerKey", "childSessionKey", "parentTaskId", "status", "deliveryStatus", "terminalOutcome"]) {
    if (typeof t?.[k] === "string") out[k] = t[k];
  }
  return out;
}
function matches(t: TaskEvidence, p: ErrorProvenance, c: { runId: string; childSessionKey?: string }): boolean {
  return Boolean(t.id && t.kind === "subagent" && t.runId === c.runId
    && t.sessionKey === p.sessionKey && t.ownerKey === p.sessionKey
    && t.childSessionKey && (!c.childSessionKey || t.childSessionKey === c.childSessionKey));
}

/** Read-only and bounded: no model invocation, replay, cancellation or session-status heuristic. */
export async function inspectError(p: ErrorProvenance, rpc: ReadRPC): Promise<ErrorVerdict> {
  if (p.userStop) return { state: "stopped", reason: "explicit_bridge_stop" };
  const pending = (reason: string, task?: TaskEvidence): ErrorVerdict => ({ state: "pending", reason, task });
  const announce = p.runId.startsWith("announce:");
  if (!p.runId) return pending("missing_run_identity");
  if (!announce) {
    // Ordinary chat.error is a gateway terminal envelope (after gateway retry
    // grace). Do not rewrite normal collector/auth/parameter/tool-error handling.
    if (p.source === "chat" && (p.state === "error" || (p.state === "final" && p.stopReason === "error"))) return {
      state: "terminal", reason: "ordinary_gateway_error", terminalKey: `run-error:${errorIdentity(p.sessionKey, p.runId)}`,
      text: `⚠️ Agent run failed${p.detail ? `: ${p.detail}` : ""}`,
    };
    try {
      const wait = await rpc("agent.wait", { runId: p.runId, timeoutMs: 1 }, 2000);
      if (wait?.runId === p.runId && wait?.status === "error" && typeof wait.endedAt === "number") return {
        state: "terminal", reason: "exact_run_terminal_error", terminalKey: `run-error:${errorIdentity(p.sessionKey, p.runId)}`,
        text: "⚠️ 该次运行已终止，未能完成回复。",
      };
      return pending("wait_not_terminal_failure");
    } catch { return pending("wait_unavailable"); }
  }
  const candidate = announceCandidate(p);
  if (!candidate) return pending("unsupported_announce_lineage");
  try {
    // At most two pages; absence or truncation is never evidence of failure.
    let cursor: string | undefined;
    const matchesFound: TaskEvidence[] = [];
    for (let page = 0; page < 2; page++) {
      const result = await rpc("tasks.list", { sessionKey: p.sessionKey, limit: 100, ...(cursor ? { cursor } : {}) }, 2000);
      if (!Array.isArray(result?.tasks)) return pending("unsupported_task_response");
      for (const raw of result.tasks) {
        const task = projectTask(raw);
        if (matches(task, p, candidate)) matchesFound.push(task);
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    const ids = [...new Set(matchesFound.map(t => t.id))];
    if (ids.length !== 1 || cursor) return pending("task_lineage_missing_ambiguous_or_truncated");
    const task = projectTask((await rpc("tasks.get", { taskId: ids[0] }, 2000))?.task);
    if (task.id !== ids[0] || !matches(task, p, candidate)) return pending("task_lineage_changed");
    if (["queued", "running"].includes(task.status) || ["pending", "session_queued"].includes(task.deliveryStatus || "")) {
      return pending("matching_task_or_delivery_continuing", task);
    }
    if (task.status === "completed" && task.deliveryStatus === "delivered" && task.terminalOutcome !== "blocked") {
      return { state: "suppressed", reason: "matching_task_completed_delivery_confirmed", task };
    }
    const terminalKey = `task-error:${errorIdentity(p.sessionKey, task.id)}`;
    // A failed child is not the whole user request. Do not borrow another child's
    // successful result, or substitute raw child output for the parent answer.
    if (["failed", "timed_out"].includes(task.status) && ["delivered", "failed", "not_applicable"].includes(task.deliveryStatus || "")) {
      return { state: "terminal", reason: "matching_child_terminal_failure", task, terminalKey,
        text: `⚠️ 子任务 ${task.id} ${task.status === "timed_out" ? "已超时终止" : "已失败"}；这不代表同会话其他任务失败。` };
    }
    // Public schema has no requester-settle retry counter. Only the explicit
    // blocked + failed delivery projection proves that continuation is blocked.
    if (task.status === "completed" && task.deliveryStatus === "failed" && task.terminalOutcome === "blocked") {
      return { state: "terminal", reason: "matching_completion_delivery_blocked", task, terminalKey,
        text: `⚠️ 子任务 ${task.id} 已完成，但结果回传已终止，需要人工处理；并非任务执行失败。` };
    }
    return pending("task_does_not_prove_attempt_chain_terminal", task);
  } catch { return pending("task_lookup_unavailable"); }
}
