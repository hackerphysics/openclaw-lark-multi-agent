import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawClient } from "../src/openclaw-client.js";
import { LiveStatusController } from "../src/live-status.js";
import { FOREGROUND_WAIT_MS, SessionWaitPaused } from "../src/session-status.js";

// Exercise the real WS event normalization, never a network connection.
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter {
    send = vi.fn();
    close() { this.emit("close"); }
  } };
});
const KEY = "agent:main:yield-test";
let c: any;
let notice: ReturnType<typeof vi.fn>;
const wire = (event: string, payload: any) => c.ws.emit("message", Buffer.from(JSON.stringify({ type: "event", event, payload })));
const agent = (stream: string, data: any, runId = "r") => wire("agent", { sessionKey: KEY, runId, stream, data });
const chat = (payload: any = {}, runId = "r") => wire("chat", { sessionKey: KEY, runId, seq: 1, state: "final", ...payload });
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const start = async (extra: any = {}) => {
  let settled = false;
  const result = c.chatSend({ sessionKey: KEY, message: "original question", onWaitPaused: notice, ...extra }).then(
    (text: string) => { settled = true; return { text }; },
    (error: Error) => { settled = true; return { error }; },
  );
  await vi.advanceTimersByTimeAsync(0);
  return { result, settled: () => settled };
};
const final = async (text = "actual final") => {
  chat({ message: message(text), seq: 10 });
  agent("lifecycle", { phase: "end", livenessState: "working" });
  await vi.advanceTimersByTimeAsync(100);
};
const noAbort = () => expect(c.rpc.mock.calls.some(([method]: string[]) => method === "chat.abort")).toBe(false);
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  c = new OpenClawClient({ baseUrl: "ws://offline.invalid", token: "test" });
  const connected = c.connect();
  c.ws.emit("message", Buffer.from(JSON.stringify({ type: "res", ok: true, payload: { type: "hello-ok", protocol: 4 } })));
  await connected;
  c.rpc = vi.fn(async (method: string) => method === "chat.send" ? { runId: "r" }
    : method === "sessions.describe" ? { session: { status: "running" } } : { runId: "r", status: "timeout" });
  notice = vi.fn();
});
afterEach(async () => { await c.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Gateway-confirmed yield foreground handoff", () => {
  it("immediately notices an empty yielded final once, retains ownership and never aborts", async () => {
    const run = await start();
    chat({ yielded: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(notice).toHaveBeenCalledOnce();
    const pause = notice.mock.calls[0][0] as SessionWaitPaused;
    expect(pause.reason).toBe("yield");
    expect(pause.snapshot.running).toBe(false); // no invented child/running evidence
    expect(pause.message).toContain("若有后续结果");
    expect(pause.message).not.toMatch(/超时|时间已到|子任务/);
    expect(run.settled()).toBe(false);
    expect(c.ownedDeliveryRuns.has("r")).toBe(true);
    expect(c.rpc.mock.calls.map(([method]: string[]) => method)).toEqual(["chat.send"]);
    await vi.advanceTimersByTimeAsync(FOREGROUND_WAIT_MS + 60000);
    expect(notice).toHaveBeenCalledOnce();
    expect(run.settled()).toBe(false);
    noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" }); noAbort();
  });

  it.each([false, true])("does not complete lifecycle-first paused turns (discussion=%s), even past 5s", async emptyFinalAsNoReply => {
    const run = await start({ emptyFinalAsNoReply });
    agent("lifecycle", { phase: "end", livenessState: "paused", stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(run.settled()).toBe(false); expect(notice).not.toHaveBeenCalled();
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    expect(notice).toHaveBeenCalledOnce(); expect(run.settled()).toBe(false); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it("cancels the working-lifecycle 5s fallback before it can return a truncated delta", async () => {
    const run = await start();
    agent("assistant", { delta: "N" });
    agent("lifecycle", { phase: "end", livenessState: "working" });
    await vi.advanceTimersByTimeAsync(4900);
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(6100);
    expect(run.settled()).toBe(false); expect(notice).toHaveBeenCalledOnce(); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it("lets a yielded final beat lifecycle-only empty discussion completion within the 5s window", async () => {
    const run = await start({ emptyFinalAsNoReply: true });
    agent("lifecycle", { phase: "end", livenessState: "working" });
    await vi.advanceTimersByTimeAsync(4900); expect(run.settled()).toBe(false);
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(6100);
    expect(run.settled()).toBe(false); expect(notice).toHaveBeenCalledOnce(); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it("still completes ordinary lifecycle-only silent discussion after the bounded window", async () => {
    const run = await start({ emptyFinalAsNoReply: true });
    agent("lifecycle", { phase: "end", livenessState: "working" });
    await vi.advanceTimersByTimeAsync(5100);
    expect(await run.result).toEqual({ text: "NO_REPLY" }); expect(notice).not.toHaveBeenCalled(); noAbort();
  });

  it("deduplicates repeated yields, blank finals and lifecycle ends without salvaging interim prose", async () => {
    const run = await start();
    agent("assistant", { delta: "intermediate preface" });
    chat({ yielded: true, message: message("buffered preface, not a verified acknowledgment") });
    chat({ yielded: true });
    agent("lifecycle", { phase: "end", livenessState: "paused", stopReason: "end_turn" });
    chat();
    await vi.advanceTimersByTimeAsync(10000);
    expect(notice).toHaveBeenCalledOnce(); expect(run.settled()).toBe(false);
    expect(notice.mock.calls[0][0].message).not.toContain("preface"); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it.each(["yield-first", "final-first"])("gives an already-arrived actual final priority (%s)", async order => {
    const run = await start();
    if (order === "yield-first") chat({ yielded: true });
    chat({ message: message("real final") });
    if (order === "final-first") chat({ yielded: true });
    agent("lifecycle", { phase: "end", livenessState: "working" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toEqual({ text: "real final" }); expect(notice).not.toHaveBeenCalled(); noAbort();
  });

  it("returns a late final without lifecycle or aborting the yielded original", async () => {
    const run = await start(); chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    chat({ message: message("late final") }); await vi.advanceTimersByTimeAsync(5100);
    expect(await run.result).toEqual({ text: "late final" }); noAbort();
  });

  it.each(["assistant", "transcript"])("retains resumed same-run %s final collection without a chat final", async source => {
    const run = await start(); chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    agent("lifecycle", { phase: "start" });
    if (source === "assistant") agent("assistant", { delta: "resumed actual final" });
    else wire("session.message", { sessionKey: KEY, runId: "r", message: message("resumed actual final") });
    agent("lifecycle", { phase: "end", livenessState: "working" });
    // Existing transcript-only completion uses the lifecycle's 5s grace window.
    await vi.advanceTimersByTimeAsync(5100);
    expect(await run.result).toEqual({ text: "resumed actual final" }); expect(notice).toHaveBeenCalledOnce(); noAbort();
  });

  it("keeps tools-only continuation and another yield pending until real text", async () => {
    const run = await start({ emptyFinalAsNoReply: true });
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    agent("lifecycle", { phase: "start" });
    agent("item", { kind: "tool", phase: "start", name: "exec", itemId: "tool:1" });
    agent("item", { kind: "tool", phase: "end", name: "exec", itemId: "tool:1", output: "raw child output" });
    agent("lifecycle", { phase: "end", livenessState: "paused", stopReason: "end_turn" });
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(6000);
    expect(notice).toHaveBeenCalledOnce(); expect(run.settled()).toBe(false);
    expect(notice.mock.calls[0][0].message).not.toContain("raw child output"); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it.each([
    ["sessions_yield", "end", { status: "yielded", acknowledgment: "unverified public-looking ack", message: "PRIVATE_CONTEXT" }],
    ["sessions_spawn", "end", { status: "accepted" }],
    ["sessions_yield", "error", { status: "error", error: "Aborted" }],
    ["agents_wait", "end", { status: "completed" }],
  ])("does not infer handoff from %s %s tool evidence", async (name, phase, output) => {
    const run = await start();
    agent("item", { kind: "tool", name, phase, itemId: "tool:1", output, yielded: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(notice).not.toHaveBeenCalled(); expect(run.settled()).toBe(false);
    await final(); expect(await run.result).toEqual({ text: "actual final" }); noAbort();
  });

  it("redacts private yield tool inputs/results before confirmation without triggering a handoff", async () => {
    const progress = vi.fn(); const tools = vi.fn();
    c.toolEventCallbacks.set(KEY, tools);
    const run = await start({ onProgress: progress });
    agent("item", { kind: "tool", name: "sessions_yield", phase: "start", itemId: "tool:yield", meta: { message: "PRIVATE_CONTEXT", acknowledgment: "UNVERIFIED_ACK" } });
    agent("item", { kind: "tool", name: "sessions_yield", phase: "end", itemId: "tool:yield", output: JSON.stringify({ message: "PRIVATE_CONTEXT", status: "yielded" }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/PRIVATE_CONTEXT|UNVERIFIED_ACK/);
    expect(JSON.stringify(tools.mock.calls)).not.toMatch(/PRIVATE_CONTEXT|UNVERIFIED_ACK/);
    expect(notice).not.toHaveBeenCalled();
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    expect(JSON.stringify(notice.mock.calls.map(call => call[0].message))).not.toMatch(/PRIVATE_CONTEXT|UNVERIFIED_ACK/);
    await final(); expect(await run.result).toEqual({ text: "actual final" }); noAbort();
  });

  it.each([undefined, false, "true"])("ignores unconfirmed chat yield value %s", async yielded => {
    const run = await start(); chat({ yielded }); await vi.advanceTimersByTimeAsync(6000);
    expect(notice).not.toHaveBeenCalled(); expect(run.settled()).toBe(false); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it("does not infer handoff from an aborted chat envelope or lifecycle error", async () => {
    const run = await start();
    chat({ state: "aborted", yielded: true, errorMessage: "Aborted" });
    agent("lifecycle", { phase: "error", error: "Aborted", yielded: true });
    await vi.advanceTimersByTimeAsync(100);
    expect((await run.result).error?.message).toContain("Aborted"); expect(notice).not.toHaveBeenCalled();
  });

  it("lets a genuine same-batch error beat a yield notice", async () => {
    const run = await start(); chat({ yielded: true });
    agent("lifecycle", { phase: "error", error: "tool validation failed" });
    await vi.advanceTimersByTimeAsync(100);
    expect((await run.result).error?.message).toContain("tool validation failed");
    expect(notice).not.toHaveBeenCalled();
  });

  it("honors explicit stop after yield without a resend or second notice", async () => {
    const run = await start(); chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    await c.abortChat(KEY); await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toEqual({ text: "NO_REPLY" }); expect(notice).toHaveBeenCalledOnce();
    expect(c.rpc.mock.calls.filter(([method]: string[]) => method === "chat.abort")).toHaveLength(1);
    expect(c.rpc.mock.calls.filter(([method]: string[]) => method === "chat.send")).toHaveLength(1);
  });

  it("keeps ordinary ten-minute timeout semantics separate", async () => {
    const run = await start(); await vi.advanceTimersByTimeAsync(FOREGROUND_WAIT_MS - 1);
    expect(notice).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
    expect(notice).toHaveBeenCalledOnce(); expect(notice.mock.calls[0][0].reason).toBe("timeout");
    expect(notice.mock.calls[0][0].message).toContain("时间已到"); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it.each([false, true])("retains a new-run proactive route without consuming it as the old final (anchored lifecycle=%s)", async anchored => {
    const proactive = vi.fn(); c.sessionMessageCallbacks.set(KEY, proactive);
    const run = await start();
    if (anchored) wire("session.message", { sessionKey: KEY, runId: "r", message: { role: "user", content: "original question" } });
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    if (anchored) agent("lifecycle", { phase: "start" }, "announce:requester-settle:new-run");
    chat({ message: message("requester continuation result") }, "announce:requester-settle:new-run");
    await vi.advanceTimersByTimeAsync(6000);
    expect(proactive).toHaveBeenCalledExactlyOnceWith("requester continuation result", { runId: "announce:requester-settle:new-run" });
    expect(run.settled()).toBe(false); expect(c.ownedDeliveryRuns.has("r")).toBe(true); noAbort();
    await final(); expect(await run.result).toEqual({ text: "actual final" });
  });

  it("preserves the explicitly muted discussion collector's anchored new-run continuation", async () => {
    const release = c.muteProactiveDelivery(KEY);
    const proactive = vi.fn(); c.sessionMessageCallbacks.set(KEY, proactive);
    const run = await start({ emptyFinalAsNoReply: true });
    wire("session.message", { sessionKey: KEY, runId: "r", message: { role: "user", content: "original question" } });
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    agent("lifecycle", { phase: "start" }, "continuation");
    agent("item", { kind: "tool", phase: "end", name: "exec", itemId: "tool:1" }, "continuation");
    chat({ yielded: true }, "continuation"); await vi.advanceTimersByTimeAsync(6000);
    expect(run.settled()).toBe(false); expect(notice).toHaveBeenCalledOnce();
    chat({ message: message("discussion continuation result") }, "continuation");
    agent("lifecycle", { phase: "end", livenessState: "working" }, "continuation");
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toEqual({ text: "discussion continuation result" });
    // Existing mute applies to transcript mirrors, not external chat-final
    // callbacks; preserve that independent route (no new session-wide mute).
    expect(proactive).toHaveBeenCalledExactlyOnceWith("discussion continuation result", { runId: "continuation" });
    noAbort(); release(0);
  });

  it("freezes card ticker and tool edits at yield but permits the final one-time summary", async () => {
    const edit = vi.fn(async () => {});
    const live = new LiveStatusController({ create: async () => "card", edit }, { botName: "GPT", delayMs: 0 });
    live.start(); await vi.advanceTimersByTimeAsync(0);
    notice.mockImplementation((pause: SessionWaitPaused) => live.showWaitingForResult(pause.message));
    const run = await start({ onProgress: (ev: any) => live.progress(ev) });
    chat({ yielded: true }); await vi.advanceTimersByTimeAsync(50);
    const count = edit.mock.calls.length;
    agent("item", { kind: "tool", name: "exec", phase: "start", itemId: "tool:1" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(edit).toHaveBeenCalledTimes(count); expect(run.settled()).toBe(false);
    await final(); expect(await run.result).toEqual({ text: "actual final" });
    await live.complete(); expect(edit).toHaveBeenCalledTimes(count + 1); noAbort();
  });
});
