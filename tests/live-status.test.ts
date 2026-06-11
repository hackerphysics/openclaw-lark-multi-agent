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
    }, { botName: "Claude", delayMs: 0, throttleMs: 0 });

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
    }, { botName: "Claude", delayMs: 0, throttleMs: 0 });

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
    }, { botName: "Claude", delayMs: 0, throttleMs: 0 });

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
    }, { botName: "Claude", delayMs: 0, throttleMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();
    await live.progress("late progress");

    // complete() deleted the message; the late progress must not edit anything.
    expect(edits).toEqual([]);
    vi.useRealTimers();
  });

  it("auto-refreshes elapsed time on a tick even without new progress", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
      remove: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 0, throttleMs: 0, tickMs: 1000 });

    live.start("等待 OpenClaw 回复");
    await vi.advanceTimersByTimeAsync(0); // fire create timer
    // No progress() calls at all — only the ticker should refresh.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // At least two tick edits happened, and elapsed advanced (0:01, 0:02 ...).
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.some((t) => /0:0[12]/.test(t))).toBe(true);
    // Colorful round spinner present.
    expect(edits.every((t) => /[\uD83D\uDD35\uD83D\uDFE2\uD83D\uDFE1\uD83D\uDFE0\uD83D\uDD34\uD83D\uDFE3]/.test(t))).toBe(true);

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
    }, { botName: "Claude", delayMs: 0, throttleMs: 0, tickMs: 1000 });

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
