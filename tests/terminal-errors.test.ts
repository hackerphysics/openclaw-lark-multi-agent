import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectError, announceCandidate, errorIdentity, type ErrorProvenance, type TaskEvidence } from "../src/terminal-errors.js";
import { OpenClawClient } from "../src/openclaw-client.js";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore } from "../src/message-store.js";

const sessionKey = "agent:main:lma-gpt-chat1";
const childRun = "e5e3091c-a67e-47c3-9cb6-0a28d3f4d2eb";
const failedChild = "2dd34b8a-eda0-4379-b468-8d306c525080";
const childSessionKey = "agent:main:dashboard:325efdb5-85e2-43e6-b0bc-8f3f33274535";
const directRun = `announce:v1:${childSessionKey}:${childRun}`;
const wake = (id = childRun, suffix = "") => `announce:requester-settle:main:${sessionKey}:${id}:yield-1${suffix}`;
const provenance = (runId = directRun, extra: Partial<ErrorProvenance> = {}): ErrorProvenance => ({ sessionKey, runId, source: "chat", state: "aborted", ...extra });
const task = (extra: Partial<TaskEvidence> = {}): TaskEvidence => ({ id: "task-1", kind: "subagent", runId: childRun, sourceId: childRun, sessionKey, ownerKey: sessionKey, childSessionKey, status: "completed", deliveryStatus: "pending", ...extra });
const generic = "The agent run failed before producing a reply.";
function memoryRPC(tasks: TaskEvidence[]) {
  return vi.fn(async (method: string, params: any) => {
    if (method === "tasks.list") return { tasks };
    if (method === "tasks.get") return { task: tasks.find(t => t.id === params.taskId) };
    if (method === "agent.wait") return { runId: params.runId, status: "timeout" };
    throw new Error(`Unexpected RPC ${method}`);
  });
}
const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T00:00:00Z")); });
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.clearAllTimers(); vi.useRealTimers(); });

async function harness(tasks: TaskEvidence[] = [task()], dbPath?: string) {
  const dir = dbPath ? undefined : mkdtempSync(join(tmpdir(), "lma-notices-"));
  const path = dbPath || join(dir!, "messages.db");
  const store = new MessageStore(path);
  const client: any = new OpenClawClient({ baseUrl: "ws://offline", token: "test" } as any);
  const rpc = memoryRPC(tasks);
  client.rpc = rpc;
  client.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 0 } }));
  client.ensureModel = vi.fn(async () => false);
  const pending: Promise<any>[] = [];
  client.subscribeSession = vi.fn(async (_key: string, callback: any) => {
    client.sessionMessageCallbacks.set(sessionKey, (text: string, meta: any) => { pending.push(callback(text, meta)); });
  });
  const bot: any = new FeishuBot({ name: "GPT", appId: "offline", appSecret: "test", model: "test-model" }, client, store);
  bot.readSessionStatus = vi.fn(async () => ({ status: "running" }));
  bot.sendFinalMessage = vi.fn(async () => {});
  bot.replyFinalMessage = vi.fn(async () => {});
  bot.sendBridgeAttachment = vi.fn(async () => {});
  bot.cancelDelayedFailure = vi.fn();
  await bot.ensureSession("chat1");
  const close = () => {
    for (const t of bot.errorNoticeTimers.values()) clearTimeout(t);
    for (const t of bot.deliveryRetryTimers.values()) clearTimeout(t);
    for (const t of client.suppressedSessionTimers.values()) clearTimeout(t);
    bot.errorNoticeTimers.clear(); bot.deliveryRetryTimers.clear();
    store.close();
  };
  let closed = false;
  const stop = () => { if (!closed) { closed = true; close(); } };
  cleanups.push(() => { stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const event = async (runId: string, state = "aborted", extra: any = {}) => {
    client.trackChatEventSession(sessionKey, state, { runId, ...extra }); await flush();
  };
  const transcript = async (runId: string, stopReason?: string, text = generic) => {
    client.handleProactiveSessionMessage(sessionKey, { role: "assistant", content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) }, runId);
    await flush();
  };
  const row = (runId = directRun) => store.getErrorNotice("GPT", "chat1", errorIdentity(sessionKey, runId));
  return { store, client, bot, rpc, tasks, event, transcript, row, path, stop, flush };
}

describe("public task evidence, never session-wide guesses", () => {
  it.each([directRun, wake(), wake(childRun, ":retry-1"), wake(childRun, ":retry-2")])("validates captured attempt form %s against public metadata", async run => {
    expect(announceCandidate(provenance(run))?.runId).toBe(childRun);
    const rpc = memoryRPC([task({ deliveryStatus: "delivered" })]);
    expect(await inspectError(provenance(run), rpc)).toMatchObject({ state: "suppressed", task: { id: "task-1" } });
    expect(rpc.mock.calls.map(c => c[0])).toEqual(["tasks.list", "tasks.get"]);
  });
  it.each(["queued", "running"])("%s exact task remains silent", async status => {
    expect((await inspectError(provenance(), memoryRPC([task({ status })]))).state).toBe("pending");
  });
  it.each(["pending", "session_queued"])("%s delivery remains silent even for failed child", async deliveryStatus => {
    expect((await inspectError(provenance(), memoryRPC([task({ status: "failed", deliveryStatus })]))).state).toBe("pending");
  });
  it.each(["ownerKey", "sessionKey", "runId", "childSessionKey"])("rejects mismatching %s", async field => {
    expect((await inspectError(provenance(), memoryRPC([task({ [field]: "different", status: "failed", deliveryStatus: "failed" })]))).state).toBe("pending");
  });
  it("does not join tasks just because sourceId, parentTaskId or session agree", async () => {
    expect((await inspectError(provenance(), memoryRPC([task({ runId: failedChild, sourceId: childRun, parentTaskId: "task-1", deliveryStatus: "delivered" })]))).state).toBe("pending");
  });
  it("rejects unsupported batch identity without treating retry-2 as exhaustion", async () => {
    const rpc = memoryRPC([task()]);
    const p = provenance(`announce:requester-settle:main:${sessionKey}:${childRun},${failedChild}:yield-1:retry-2`);
    expect((await inspectError(p, rpc)).state).toBe("pending"); expect(rpc).not.toHaveBeenCalled();
  });
  it("bounds pagination and treats incomplete pages as unknown", async () => {
    const rpc = vi.fn(async () => ({ tasks: [task()], nextCursor: "more" }));
    expect((await inspectError(provenance(), rpc)).state).toBe("pending"); expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("revalidates task identity in get, not stale list metadata", async () => {
    const rpc = vi.fn(async (method: string) => method === "tasks.list" ? { tasks: [task()] } : { task: task({ runId: failedChild, deliveryStatus: "delivered" }) });
    expect((await inspectError(provenance(), rpc)).reason).toBe("task_lineage_changed");
  });
  it.each(["RPC unsupported", "Gateway disconnected", "RPC timeout"])("%s is not a final error", async message => {
    const rpc = vi.fn(async () => { throw new Error(message); });
    expect((await inspectError(provenance(), rpc)).state).toBe("pending");
  });
  it.each(["running", "killed"])("uncorrelated session %s and short wait timeout are inconclusive", async status => {
    const rpc = vi.fn(async (_method: string, p: any) => ({ runId: p.runId, status: "timeout", session: { status } }));
    expect((await inspectError(provenance("ordinary-abort"), rpc)).state).toBe("pending");
    expect(rpc.mock.calls[0][0]).toBe("agent.wait");
  });
  it("an exact agent.wait terminal error differs from wait-only timeout", async () => {
    const rpc = vi.fn(async () => ({ runId: "ordinary-abort", status: "error", endedAt: Date.now() }));
    expect((await inspectError(provenance("ordinary-abort"), rpc)).state).toBe("terminal");
  });
  it("does not call a delivery-only blockage an execution failure", async () => {
    const verdict = await inspectError(provenance(), memoryRPC([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]));
    expect(verdict).toMatchObject({ state: "terminal", reason: "matching_completion_delivery_blocked" });
    expect(verdict.text).toContain("并非任务执行失败");
  });
  it("bare delivery failed is not proof of requester-settle retry exhaustion", async () => {
    expect((await inspectError(provenance(wake(childRun, ":retry-2")), memoryRPC([task({ deliveryStatus: "failed" })]))).state).toBe("pending");
  });
});

describe("client → bot → persistent notice → guarded outbox", () => {
  it("aborted → retry → success yields zero error messages and keeps final delivery", async () => {
    const h = await harness();
    await h.event(wake()); await h.event(wake(childRun, ":retry-1"));
    h.tasks[0].deliveryStatus = "session_queued";
    await h.event(wake(childRun, ":retry-2"));
    expect(h.bot.sendFinalMessage).not.toHaveBeenCalled(); expect(h.bot.cancelDelayedFailure).not.toHaveBeenCalled();
    h.tasks[0].deliveryStatus = "delivered";
    await h.event(directRun, "final", { stopReason: "stop", message: { content: [{ type: "text", text: "真实结果" }] } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.bot.sendFinalMessage.mock.calls[0][1]).toBe("真实结果");
    expect(h.row(wake())?.status).toBe("suppressed");
  });
  it("confirmed exhausted/blocked delivery emits one terminal notice across retries and duplicates", async () => {
    const h = await harness();
    await h.event(wake()); await h.event(wake(childRun, ":retry-1"));
    h.tasks[0].deliveryStatus = "failed"; h.tasks[0].terminalOutcome = "blocked";
    await h.event(wake(childRun, ":retry-2")); await h.event(wake(childRun, ":retry-2"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.bot.cancelDelayedFailure).not.toHaveBeenCalled();
    const key = h.row(wake(childRun, ":retry-2"))!.verdict!.terminalKey!;
    const outbox = h.store.getDeliveryByKey("GPT", "chat1", key)!;
    expect(outbox.sourceType).toBe("run_error"); expect(outbox.deliveryKey).not.toMatch(/^trigger:/);
    expect(JSON.parse(outbox.deliveryMetaJson!).provenance).toMatchObject({ error: { sessionKey, runId: wake(childRun, ":retry-2") }, terminalEvidence: { task: { id: "task-1" } } });
  });
  it("same-session successful e5 child cannot hide failed 2dd child", async () => {
    const h = await harness([task({ deliveryStatus: "delivered" }), task({ id: "failed-task", runId: failedChild, status: "failed", deliveryStatus: "delivered" })]);
    await h.event(directRun);
    await h.event(wake(failedChild, ":retry-2"));
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.bot.sendFinalMessage.mock.calls[0][1]).toContain("failed-task");
  });
  it.each(["final", "transcript"])("late typed generic %s error after matching success is silent", async surface => {
    const h = await harness([task({ deliveryStatus: "delivered" })]);
    if (surface === "final") await h.event(directRun, "final", { stopReason: "error", message: { content: [{ type: "text", text: generic }] } });
    else await h.transcript(directRun, "error");
    expect(h.bot.sendFinalMessage).not.toHaveBeenCalled(); expect(h.row()?.provenance.stopReason).toBe("error");
  });
  it("untyped late generic text uses only persisted exact-run error provenance", async () => {
    const h = await harness([task({ deliveryStatus: "delivered" })]);
    await h.event(directRun);
    await h.event(directRun, "final", { message: { content: [{ type: "text", text: generic }] } });
    expect(h.bot.sendFinalMessage).not.toHaveBeenCalled();
    await h.event("other-run", "final", { message: { content: [{ type: "text", text: generic }] } });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
  });
  it.each(["stop", undefined])("normal identical-text assistant with stopReason=%s is not globally filtered", async stopReason => {
    const h = await harness();
    await h.event("normal-run", "final", { ...(stopReason ? { stopReason } : {}), message: { content: [{ type: "text", text: generic }] } });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1); expect(h.bot.sendFinalMessage.mock.calls[0][1]).toBe(generic);
  });
  it("explicit stop metadata stays diagnostic and emits no abort cascade", async () => {
    const h = await harness(); h.client.forceAbortedSessions.add(sessionKey);
    await h.event("stopped-run"); await h.event("stopped-run-2");
    expect(h.bot.sendFinalMessage).not.toHaveBeenCalled(); expect(h.row("stopped-run")?.status).toBe("stopped");
  });
  it.each(["authentication rejected", "invalid argument", "tool execution failed"])("ordinary terminal %s remains visible once", async detail => {
    const h = await harness();
    await h.event("ordinary-run", "error", { errorMessage: detail }); await h.event("ordinary-run", "error", { errorMessage: detail });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1); expect(h.bot.sendFinalMessage.mock.calls[0][1]).toContain(detail);
    expect(h.bot.cancelDelayedFailure).not.toHaveBeenCalled();
  });
  it("a notice cannot claim the active trigger key or complete its pending card", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    const liveStatus = { complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    h.bot.activeDeliveryTargets.set("chat1", { triggerId: 7, messageId: "human-7", token: Symbol(), liveStatus });
    await h.event(directRun);
    expect(h.store.getDeliveryByKey("GPT", "chat1", "trigger:7")).toBeNull(); expect(liveStatus.complete).not.toHaveBeenCalled();
    await h.event("real-main-run", "final", { message: { content: [{ type: "text", text: "真正主答案" }] } });
    expect(h.store.getDeliveryByKey("GPT", "chat1", "trigger:7")?.content).toBe("真正主答案");
  });
  it("durable pending survives restart, checks a fresh task and never replays an old final", async () => {
    const h = await harness(); await h.event(directRun); const path = h.path; h.stop();
    const recovered = await harness([task({ deliveryStatus: "delivered" })], path);
    await vi.advanceTimersByTimeAsync(16_000); await recovered.bot.reconcileErrorNotices("chat1");
    expect(recovered.row()?.status).toBe("suppressed"); expect(recovered.bot.sendFinalMessage).not.toHaveBeenCalled();
  });
  it("persistent terminal dedupe survives restart and different retry IDs", async () => {
    const t = task({ deliveryStatus: "failed", terminalOutcome: "blocked" });
    const h = await harness([t]); await h.event(directRun); expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    h.stop(); const next = await harness([t], h.path); await next.event(wake(childRun, ":retry-2"));
    expect(next.bot.sendFinalMessage).not.toHaveBeenCalled();
  });
  it("lookup failure parks durably after six checks; duplicate events never reset the budget", async () => {
    const h = await harness(); h.rpc.mockRejectedValue(new Error("unsupported"));
    await h.event(directRun); await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.rpc).toHaveBeenCalledTimes(6); expect(h.row()?.status).toBe("parked");
    await h.event(directRun); await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.rpc).toHaveBeenCalledTimes(6); expect(h.bot.sendFinalMessage).not.toHaveBeenCalled();
    expect(h.bot.errorNoticeTimers.size).toBe(0);
  });
  it("final success seen during send-time task query withdraws notice without touching result", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    let gets = 0;
    const base = memoryRPC(h.tasks);
    h.rpc.mockImplementation(async (method: string, params: any) => {
      if (method === "tasks.get" && ++gets === 2) h.tasks[0].deliveryStatus = "delivered", h.tasks[0].terminalOutcome = "succeeded";
      return base(method, params);
    });
    await h.event(directRun); expect(h.bot.sendFinalMessage).not.toHaveBeenCalled(); expect(h.row()?.status).toBe("suppressed");
    await h.event(directRun, "final", { stopReason: "stop", message: { content: [{ type: "text", text: "actual result" }] } });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
  });
  it("already enqueued exact-run final defers error before send, then confirmed receipt suppresses it", async () => {
    const h = await harness();
    h.store.enqueueDelivery({ sessionKey, chatId: "chat1", botName: "GPT", sourceType: "assistant_visible", sourceId: "final", deliveryKey: "real-final-key", contentHash: "final", content: "answer", attachmentsJson: "[]", replyToMessageId: "", deliveryMetaJson: JSON.stringify({ provenance: { sessionKey, runId: "same-run", final: true } }) });
    await h.event("same-run", "error", { errorMessage: "late error" });
    expect(h.row("same-run")?.verdict?.reason).toBe("exact_run_final_delivery_pending");
    await h.bot.dispatchPendingDeliveries("chat1"); await vi.advanceTimersByTimeAsync(16_000);
    expect(h.row("same-run")?.status).toBe("suppressed"); expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.store.getDeliveryByKey("GPT", "chat1", "real-final-key")?.status).toBe("delivered");
  });
  it("notice platform retry rechecks finality, not historical replay", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    h.bot.sendFinalMessage.mockRejectedValueOnce(new Error("network"));
    await h.event(directRun); expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    h.tasks[0].deliveryStatus = "delivered"; h.tasks[0].terminalOutcome = "succeeded";
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1); expect(h.row()?.status).toBe("suppressed");
  });
  it("normal same-run identical text with an explicit successful stop is not filtered", async () => {
    const h = await harness(); await h.event(directRun);
    await h.event(directRun, "final", { stopReason: "stop", message: { content: [{ type: "text", text: generic }] } });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
  });
  it("ordinary transcript error stays provisional until stronger gateway error arrives", async () => {
    const h = await harness(); await h.transcript("ordinary-run", "error");
    expect(h.bot.sendFinalMessage).not.toHaveBeenCalled();
    await h.event("ordinary-run", "error", { errorMessage: "authentication failed" });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.bot.sendFinalMessage.mock.calls[0][1]).toContain("authentication failed");
  });
  it("stronger terminal envelope wakes parked ordinary abort once, not on duplicates", async () => {
    const h = await harness(); await h.event("ordinary-run"); await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.row("ordinary-run")?.status).toBe("parked");
    await h.event("ordinary-run", "error", { errorMessage: "terminal auth failure" });
    await h.event("ordinary-run", "error", { errorMessage: "terminal auth failure" });
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
  });
  it("send-time unknown resumes bounded checks, keeping the same task delivery key", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    const base = memoryRPC(h.tasks); let gets = 0;
    h.rpc.mockImplementation(async (method: string, params: any) => {
      if (method === "tasks.get" && ++gets === 2) throw new Error("disconnect before send");
      return base(method, params);
    });
    await h.event(directRun); expect(h.bot.sendFinalMessage).not.toHaveBeenCalled();
    expect(h.row()?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
    expect(h.row()?.status).toBe("terminal");
    expect(h.store.getDeliveryByKey("GPT", "chat1", h.row()!.verdict!.terminalKey!)?.status).toBe("delivered");
  });
  it("startup restores pending observations but does not replay a delivered final", async () => {
    const h = await harness();
    h.store.upsertChatInfo({ chatId: "chat1", chatType: "p2p", chatName: "offline", members: "", memberNames: "", ownerBot: "GPT", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: Date.now() });
    await h.event(directRun, "final", { stopReason: "stop", message: { content: [{ type: "text", text: "delivered result" }] } });
    h.store.observeRunError("GPT", "chat1", provenance());
    h.stop(); const next = await harness([], h.path);
    await next.bot.drainOnStartup();
    expect(next.row()?.status).toBe("suppressed");
    expect(next.bot.sendFinalMessage).not.toHaveBeenCalled(); expect(next.rpc).not.toHaveBeenCalled();
  });
  it("pending notice delivery resumed after a platform failure may become unknown and still gets a timer", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    h.bot.sendFinalMessage.mockRejectedValueOnce(new Error("platform unavailable"));
    await h.event(directRun);
    h.tasks[0].deliveryStatus = "session_queued";
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.row()?.status).toBe("pending"); expect(h.bot.errorNoticeTimers.size).toBe(1);
    h.tasks[0].deliveryStatus = "delivered"; h.tasks[0].terminalOutcome = "succeeded";
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.row()?.status).toBe("suppressed"); expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(1);
  });
  it("exhausting notice platform retries does not produce another error about the notice", async () => {
    const h = await harness([task({ deliveryStatus: "failed", terminalOutcome: "blocked" })]);
    h.bot.sendFinalMessage.mockRejectedValue(new Error("platform unavailable"));
    h.bot.sendMessage = vi.fn(); h.bot.replyMessage = vi.fn();
    await h.event(directRun); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.bot.sendFinalMessage).toHaveBeenCalledTimes(5);
    expect(h.bot.sendMessage).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("nested typed error provenance wins over a conflicting final-envelope stop reason", async () => {
    const h = await harness([task({ deliveryStatus: "delivered" })]);
    await h.event(directRun, "final", { stopReason: "stop", message: { stopReason: "error", content: [{ type: "text", text: generic }] } });
    expect(h.row()?.provenance.stopReason).toBe("error"); expect(h.bot.sendFinalMessage).not.toHaveBeenCalled();
  });

});
