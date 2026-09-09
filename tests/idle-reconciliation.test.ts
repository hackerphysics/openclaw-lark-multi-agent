import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawClient, InactiveRunObservation } from "../src/openclaw-client.js";

const KEY = "agent:main:s1";
let c: any;
let snapshot: any;
let calls: string[];
const emit = (stream: string, data: any, runId = "r") => c.agentEvents.get(KEY).push({ sessionKey: KEY, runId, stream, data });
const start = () => {
  let settled = false;
  const result = c.collectReply("r", 30 * 60_000, "s1").then(
    (text: string) => { settled = true; return { text }; },
    (error: Error) => { settled = true; return { error }; },
  );
  return { result, settled: () => settled };
};
const final = async () => {
  emit("assistant", { delta: "normal reply" });
  emit("lifecycle", { phase: "end", livenessState: "working" });
  await vi.advanceTimersByTimeAsync(1000);
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  c = new OpenClawClient({ baseUrl: "ws://offline.invalid", token: "test" });
  c.agentEvents.set(KEY, []);
  snapshot = { runId: "r", status: "timeout" };
  calls = [];
  c.rpc = vi.fn(async (method: string) => { calls.push(method); return method === "lma.steer" ? { status: "no_active_run" } : snapshot; });
});
afterEach(async () => { await c.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("minimal idle reconciliation preserves ordinary collection", () => {
  it.each([
    { status: "timeout" },
    { status: "pending", timeoutPhase: "queue" },
    { status: "error", pendingError: true, endedAt: 10000 },
    { status: "timeout", timeoutPhase: "gateway_draining", endedAt: 10000 },
    { status: "ok", yielded: true, endedAt: 10000 },
  ])("does not abort or complete a quiet $status observation", async fields => {
    snapshot = { runId: "r", ...fields };
    const run = start();
    await vi.advanceTimersByTimeAsync(32 * 60_000);
    expect(run.settled()).toBe(false);
    expect(calls).not.toContain("chat.abort");
    expect(calls.filter(x => x === "agent.wait").length).toBeLessThanOrEqual(3);
    await final();
    expect(await run.result).toEqual({ text: "normal reply" });
    expect(c.runStateChecks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles a no-active-run steer against the original terminal without waiting 30 minutes", async () => {
    const run = start();
    snapshot = { runId: "r", status: "ok", endedAt: Date.now(), terminalReply: { disposition: "visible", text: "recovered original reply" } };
    expect(await c.steer("s1", "new input")).toEqual({ status: "unavailable" });
    expect(await run.result).toEqual({ text: "recovered original reply" });
    expect(calls).toEqual(["lma.steer", "agent.wait"]);
    expect(c.runStateChecks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a phantom owner only after the plugin and Gateway both confirm no active execution", async () => {
    const run = start();
    c.rpc = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "lma.steer") return { status: "no_active_run" };
      if (method === "chat.history") return { sessionKey: KEY, sessionInfo: { hasActiveRun: false } };
      return { runId: "r", status: "timeout" };
    });
    await c.steer("s1", "new input");
    expect((await run.result).error).toBeInstanceOf(InactiveRunObservation);
    expect(calls).not.toContain("chat.abort");
    expect(c.runStateChecks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, undefined])("does not release an owner when session activity is %s", async hasActiveRun => {
    const run = start();
    c.rpc = vi.fn(async (method: string) => method === "lma.steer" ? { status: "no_active_run" }
      : method === "chat.history" ? { sessionKey: KEY, sessionInfo: { hasActiveRun } } : { runId: "r", status: "timeout" });
    await c.steer("s1", "new input");
    expect(run.settled()).toBe(false);
    await final();
    expect(await run.result).toEqual({ text: "normal reply" });
  });

  it("does not adopt another run's wait response", async () => {
    const run = start();
    snapshot = { runId: "other", status: "ok", endedAt: Date.now(), terminalReply: { disposition: "visible", text: "wrong" } };
    await c.steer("s1", "new input");
    expect(run.settled()).toBe(false);
    await final();
    expect(await run.result).toEqual({ text: "normal reply" });
  });

  it("reports a genuine execution timeout only with the original terminal record", async () => {
    const run = start();
    snapshot = { runId: "r", status: "timeout", endedAt: Date.now(), error: "execution budget exhausted" };
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect((await run.result).error?.message).toContain("execution budget exhausted");
    expect(calls).not.toContain("chat.abort");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains existing user-anchored continuation and live-status callback behavior", async () => {
    const progress = vi.fn(); c.progressCallbacks.set("s1", progress);
    const p = c.collectReply("r", 30 * 60_000, "s1", { expectedUserText: "original" });
    emit("sessionUser", { text: "original" });
    emit("lifecycle", { phase: "start" }, "continuation");
    emit("assistant", { delta: "continued reply" }, "continuation");
    emit("lifecycle", { phase: "end", livenessState: "working" }, "continuation");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe("continued reply");
    expect(c.progressCallbacks.get("s1")).toBe(progress);
    expect(calls).not.toContain("chat.abort");
  });

  it("observes steer consumption that precedes the RPC response", async () => {
    const consumed = vi.fn(() => true);
    c.onSteerConsumed("s1", "fast input", consumed);
    c.rpc = vi.fn(async () => {
      expect(c.handleSteerConsumption(KEY, "fast input")).toBe(true);
      return { status: "steered" };
    });
    const r = await c.steer("s1", "fast input");
    expect(consumed).toHaveBeenCalledOnce();
    expect(c.handleSteerConsumption(KEY, "fast input")).toBe(false);
    r.cancelPending?.();
  });
});
