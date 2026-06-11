import { describe, expect, it, vi } from "vitest";
import { LiveStatusController } from "../src/live-status.js";

describe("LiveStatusController", () => {
  it("deletes the status message on complete when remove is available", async () => {
    vi.useFakeTimers();
    const removed: string[] = [];
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async (id) => { removed.push(id); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();

    expect(removed).toEqual(["msg1"]);
    // No "done" edit needed because delete succeeded.
    expect(edits).toEqual([]);
    vi.useRealTimers();
  });

  it("marks the status message done when delete is unavailable", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      // no remove callback
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();

    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("已完成");
    vi.useRealTimers();
  });

  it("falls back to a done edit when delete fails", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async () => { throw new Error("recall not allowed"); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();

    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("已完成");
    vi.useRealTimers();
  });

  it("does not let a late progress edit run after complete()", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();
    await live.progress("late progress");

    // complete() deleted the message; the late progress must not edit anything.
    expect(edits).toEqual([]);
    vi.useRealTimers();
  });

  it("auto-refreshes on an arithmetic-progression schedule (5s, 10s, 15s ...)", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 0, stepMs: 5000, maxEdits: 20 });

    live.start("等待 OpenClaw 回复");
    await vi.advanceTimersByTimeAsync(0); // fire create timer
    // First refresh gap = 1*5s.
    await vi.advanceTimersByTimeAsync(5000);
    expect(edits.length).toBe(1);
    // Second refresh gap = 2*5s = 10s.
    await vi.advanceTimersByTimeAsync(9000);
    expect(edits.length).toBe(1); // not yet (only 9s elapsed since 1st)
    await vi.advanceTimersByTimeAsync(1000);
    expect(edits.length).toBe(2);

    // Progress bar present, elapsed advanced, edit count shown.
    expect(edits.every((t) => /[\u2588\u2591]/.test(t))).toBe(true);
    expect(edits.some((t) => /\d+\/20/.test(t))).toBe(true);

    await live.complete();
    vi.useRealTimers();
  });

  it("progress() only updates detail; edits are driven by the scheduler", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 0, stepMs: 5000, maxEdits: 20 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    // A burst of progress events must NOT each trigger an edit.
    await live.progress("step a");
    await live.progress("step b");
    await live.progress("step c");
    expect(edits).toEqual([]); // no scheduled tick has fired yet

    // First scheduled refresh at 5s picks up the latest detail.
    await vi.advanceTimersByTimeAsync(5000);
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("step c");

    await live.complete();
    vi.useRealTimers();
  });

  it("stops the ticker after complete()", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const removes: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async (id) => { removes.push(id); }),
    }, { botName: "Claude", delayMs: 0, stepMs: 1000, maxEdits: 20 });

    live.start("working");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const editsAfterOneTick = edits.length;
    await live.complete();
    expect(removes).toEqual(["msg1"]);
    // No more tick edits after complete.
    await vi.advanceTimersByTimeAsync(5000);
    expect(edits.length).toBe(editsAfterOneTick);
    vi.useRealTimers();
  });
});
