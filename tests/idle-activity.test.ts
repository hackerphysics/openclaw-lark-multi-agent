import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawClient } from "../src/openclaw-client.js";

const KEY = "agent:main:idle-activity";
let c: any;
let notice: ReturnType<typeof vi.fn>;
const emit = (stream: string, data: any, runId: string | undefined = "r", extra: any = {}) => {
  c.agentEvents.get(KEY).push({ sessionKey: KEY, runId, stream, data, ...extra });
};
const start = (options: any = {}, target: string | undefined = KEY) => c.collectReply("r", 1000, target, { onWaitPaused: notice, ...options });
const finish = async (p: Promise<string>) => {
  emit("chatFinal", { text: "real final" });
  emit("lifecycle", { phase: "end", livenessState: "working" });
  await vi.advanceTimersByTimeAsync(50);
  expect(await p).toBe("real final");
  expect(c.rpc.mock.calls.some(([method]: string[]) => method === "chat.abort" || method === "chat.send")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
  c = new OpenClawClient({ baseUrl: "ws://offline.invalid", token: "test" });
  c.agentEvents.set(KEY, []);
  c.rpc = vi.fn(async (method: string) => method === "sessions.describe"
    ? { session: { status: "running" } } : { runId: "r", status: "timeout" });
  notice = vi.fn();
});
afterEach(async () => { await c.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("collector effective activity (reply matching is unchanged)", () => {
  it.each([
    ["assistant", { delta: "new text" }],
    ["assistant", { text: "new full snapshot" }],
    ["chatDelta", { deltaText: "new text" }],
    ["transcriptAssistant", { deltaText: "new text", replace: true }],
    ["item", { kind: "tool", name: "write", itemId: "t", phase: "start" }],
    ["item", { kind: "tool", name: "write", itemId: "t", phase: "end" }],
    ["tool", { name: "write", toolCallId: "t", phase: "start" }],
    ["tool", { name: "write", toolCallId: "t", phase: "result" }],
    ["tool", { name: "write", toolCallId: "t", phase: "result", isError: true }],
    ["lifecycle", { phase: "start" }],
  ])("extends silence for new owned %s progress %j", async (stream, data) => {
    const p = start(); await vi.advanceTimersByTimeAsync(900);
    emit(stream, data); await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(999); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(notice).toHaveBeenCalledOnce();
    await finish(p);
  });

  it.each([
    ["tick", {}], ["usage", { totalTokens: 100 }], ["assistant", { usage: { outputTokens: 200 } }],
    ["assistant", { delta: "  " }], ["tool", { phase: "update", toolCallId: "t" }],
    ["lifecycle", { phase: "heartbeat", status: "running" }],
    ["sessionUser", { text: "question" }],
    ["agent.wait", { status: "running", updatedAt: 999 }],
    ["status", { status: "running" }],
  ])("does not extend silence for %s noise %j", async (stream, data) => {
    const p = start(); await vi.advanceTimersByTimeAsync(900);
    emit(stream, data); await vi.advanceTimersByTimeAsync(100);
    expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it.each(["item", "tool", "assistant", "chatDelta", "transcriptAssistant", "lifecycle"])(
    "does not let repeated %s events or changing usage prolong silence", async stream => {
      const data = stream === "item" ? { kind: "tool", itemId: "t", name: "write", phase: "end" }
        : stream === "tool" ? { toolCallId: "t", name: "write", phase: "result" }
        : stream === "lifecycle" ? { phase: "start" }
        : { delta: "same", replace: stream === "transcriptAssistant" };
      const p = start(); emit(stream, data, "r", { seq: 1 }); await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(850);
      emit(stream, { ...data, usage: { totalTokens: 999 } }, "r", { seq: 1 });
      await vi.advanceTimersByTimeAsync(149); expect(notice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(notice).toHaveBeenCalledOnce(); await finish(p);
    },
  );

  it.each([false, true])("deduplicates tool/item completion mirrors (error=%s)", async error => {
    const p = start();
    emit("tool", { toolCallId: "t", name: "write", phase: "result", isError: error });
    await vi.advanceTimersByTimeAsync(900);
    emit("item", { itemId: "t", name: "write", kind: "tool", phase: error ? "error" : "end" });
    await vi.advanceTimersByTimeAsync(150); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it("deduplicates replacement snapshots with new seq, and cross-stream text mirrors", async () => {
    const p = start(); emit("assistant", { delta: "same output" }, "r", { seq: 1 });
    await vi.advanceTimersByTimeAsync(900);
    emit("chatDelta", { deltaText: "same output" }, "r", { seq: 2 });
    emit("transcriptAssistant", { deltaText: "same output", replace: true });
    emit("assistant", { delta: "same output", replace: true }, "r", { seq: 3 });
    emit("assistant", { text: "same output" }, "r", { seq: 4 });
    await vi.advanceTimersByTimeAsync(150); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it("counts identical incremental text with distinct sequence identity as new output", async () => {
    const p = start(); emit("assistant", { delta: "ha" }, "r", { seq: 1 });
    await vi.advanceTimersByTimeAsync(900);
    emit("assistant", { delta: "ha" }, "r", { seq: 2 });
    await vi.advanceTimersByTimeAsync(150); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it.each(["legacy session fallback", "anchored foreign run", "missing run identity", "unanchored stale run"])(
    "does not reset idle through %s, without tightening reply assembly", async mode => {
      const anchored = mode.includes("anchored");
      const p = start(anchored ? { expectedUserText: "question" } : {});
      if (mode === "anchored foreign run") emit("sessionUser", { text: "question" });
      await vi.advanceTimersByTimeAsync(900);
      emit("item", { kind: "tool", name: "write", itemId: "foreign", phase: "end" }, "other", mode === "missing run identity" ? { runId: undefined } : {});
      await vi.advanceTimersByTimeAsync(100); expect(notice).toHaveBeenCalledOnce(); await finish(p);
    },
  );

  it.each(["owned before anchor", "short session key", "run-only matching", "anchored continuation"])(
    "counts verified progress in the existing %s matching mode", async mode => {
      const p = mode === "run-only matching" ? c.collectReply("r", 1000, undefined, { onWaitPaused: notice })
        : start(mode === "short session key" ? {} : { expectedUserText: "question" }, mode === "short session key" ? "idle-activity" : KEY);
      if (mode === "anchored continuation") {
        emit("sessionUser", { text: "question" });
        emit("lifecycle", { phase: "start" }, "continuation");
      }
      await vi.advanceTimersByTimeAsync(900);
      emit("item", { kind: "tool", name: "write", itemId: "t", phase: "end" }, mode === "anchored continuation" ? "continuation" : "r");
      await vi.advanceTimersByTimeAsync(150); expect(notice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(900); expect(notice).toHaveBeenCalledOnce(); await finish(p);
    },
  );

  it.each(["running", "idle", "unknown"])("pauses local silence once with an honest %s status", async status => {
    c.rpc = vi.fn(async (method: string) => method === "sessions.describe" ? { session: { status } } : { runId: "r", status: "timeout" });
    const p = start(); await vi.advanceTimersByTimeAsync(1000);
    expect(notice).toHaveBeenCalledOnce(); expect(notice.mock.calls[0][0].snapshot.status).toBe(status);
    // Background status/wait replies do not constitute new effective activity.
    await vi.advanceTimersByTimeAsync(120000); expect(notice).toHaveBeenCalledOnce();
    await finish(p);
  });

  it("processes progress received just before expiry rather than freezing ahead of the 50ms poll", async () => {
    const p = start(); await vi.advanceTimersByTimeAsync(999);
    emit("tool", { name: "write", toolCallId: "boundary", phase: "result" });
    await vi.advanceTimersByTimeAsync(1000); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it.each(["agent.wait", "sessions.describe"])("new activity invalidates an in-flight idle %s decision", async method => {
    let release!: (value: any) => void;
    const normal = c.rpc;
    c.rpc = vi.fn((name: string, ...args: any[]) => name === method
      ? new Promise(resolve => { release = resolve; }) : normal(name, ...args));
    const p = start(); await vi.advanceTimersByTimeAsync(1000);
    emit("tool", { name: "write", toolCallId: "fresh", phase: "result" });
    await vi.advanceTimersByTimeAsync(50);
    release(method === "agent.wait" ? { runId: "r", status: "timeout" } : { session: { status: "running" } });
    c.rpc = normal;
    await vi.advanceTimersByTimeAsync(999); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it.each(["chatError", "lifecycle"])("repeated recoverable %s errors do not reset effective silence", async stream => {
    const p = start(); await vi.advanceTimersByTimeAsync(900);
    emit(stream, { phase: "error", error: "Context overflow: prompt too large" });
    await vi.advanceTimersByTimeAsync(100); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it("different tool call ids with identical output are real progress, not duplicates", async () => {
    const p = start(); emit("tool", { name: "write", toolCallId: "one", phase: "result", result: "done" });
    await vi.advanceTimersByTimeAsync(900);
    emit("tool", { name: "write", toolCallId: "two", phase: "result", result: "done" });
    await vi.advanceTimersByTimeAsync(150); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it("conservatively ignores repeated no-seq fragments and unidentified call replays", async () => {
    const p = start();
    emit("assistant", { delta: "same" }); emit("tool", { name: "write", phase: "result" });
    await vi.advanceTimersByTimeAsync(900);
    emit("assistant", { delta: "same" }); emit("tool", { name: "write", phase: "result", usage: { totalTokens: 100 } });
    await vi.advanceTimersByTimeAsync(150); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it("does not pause on a stale terminal-timeout classification when new progress arrived", async () => {
    let release!: (value: any) => void;
    c.rpc = vi.fn(async () => ({ runId: "r", status: "timeout", endedAt: Date.now() }));
    c.getSessionRuntimeStatus = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const p = start(); await vi.advanceTimersByTimeAsync(1000);
    emit("assistant", { delta: "new output" }); await vi.advanceTimersByTimeAsync(50);
    release({ status: "running", running: true, checkedAt: Date.now() });
    c.getSessionRuntimeStatus = vi.fn(async () => ({ status: "running", running: true, checkedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(999); expect(notice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(notice).toHaveBeenCalledOnce(); await finish(p);
  });

  it.each(["final", "error", "stop"])("cleans observation after %s while idle status is pending", async outcome => {
    let release!: (value: any) => void;
    c.getSessionRuntimeStatus = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const p = start().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    if (outcome === "final") {
      emit("chatFinal", { text: "real final" }); emit("lifecycle", { phase: "end" });
    } else if (outcome === "error") emit("lifecycle", { phase: "error", error: "validation failed" });
    else c.forceAbortedSessions.add(KEY);
    await vi.advanceTimersByTimeAsync(50); await p;
    release({ status: "running", running: true, checkedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(notice).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(c.runStateChecks.size).toBe(0);
  });
});
