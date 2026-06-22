import { describe, expect, it, vi } from "vitest";
import { CompactProgressController, type CompactProgressView } from "../src/compact-progress.js";

describe("CompactProgressController (compaction progress card)", () => {
  it("creates a running card after the delay, then patches to done", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 100 });

    p.start();
    // Before the delay nothing is sent.
    expect(create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(create).toHaveBeenCalledTimes(1);
    expect(views[0].state).toBe("running");
    expect(views[0].phase).toBe("native");

    await p.done("原生压缩");
    const last = views[views.length - 1];
    expect(last.state).toBe("done");
    expect(last.detail).toBe("原生压缩");
    vi.useRealTimers();
  });

  it("does NOT create a card when compaction finishes before the delay (no flash)", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => "msg1");
    const edit = vi.fn(async () => {});
    const p = new CompactProgressController({ create, edit }, { delayMs: 500 });

    p.start();
    // Finish fast, before the create timer fires.
    await p.done("native");
    await vi.advanceTimersByTimeAsync(500);

    expect(create).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(p.id).toBeUndefined();
    vi.useRealTimers();
  });

  it("flips the phase to tool-trim while running", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 0 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.toToolTrim();

    const running = views.filter((v) => v.state === "running");
    expect(running.some((v) => v.phase === "native")).toBe(true);
    expect(running.some((v) => v.phase === "tool-trim")).toBe(true);
    vi.useRealTimers();
  });

  it("ticks the elapsed footer even with no phase change", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 0, tickMs: 1000 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500); // ~2 ticks
    expect(edit.mock.calls.length).toBeGreaterThan(before);
    p.dispose();
    vi.useRealTimers();
  });

  it("renders a noop terminal state with a reason", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 0 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.noop("no tool content to trim");

    const last = views[views.length - 1];
    expect(last.state).toBe("noop");
    expect(last.detail).toBe("no tool content to trim");
    vi.useRealTimers();
  });

  it("renders a failed terminal state with an error detail", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 0 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.fail("compaction timed out");

    const last = views[views.length - 1];
    expect(last.state).toBe("failed");
    expect(last.detail).toBe("compaction timed out");
    vi.useRealTimers();
  });

  it("is idempotent: a second terminal call does not re-edit", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => "msg1");
    const edit = vi.fn(async () => {});
    const p = new CompactProgressController({ create, edit }, { delayMs: 0 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.done("native");
    const after = edit.mock.calls.length;
    await p.fail("late error");
    await p.done("again");

    expect(edit.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });

  it("stops ticking once finalized", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => "msg1");
    const edit = vi.fn(async () => {});
    const p = new CompactProgressController({ create, edit }, { delayMs: 0, tickMs: 1000 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.done("native");
    const afterDone = edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(edit.mock.calls.length).toBe(afterDone);
    vi.useRealTimers();
  });

  it("disables itself when create returns no message id", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => undefined);
    const edit = vi.fn(async () => {});
    const p = new CompactProgressController({ create, edit }, { delayMs: 0 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await p.toToolTrim();
    await p.done("native");

    expect(p.id).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("formats elapsed as m:ss", async () => {
    vi.useFakeTimers();
    const views: CompactProgressView[] = [];
    const create = vi.fn(async (view: CompactProgressView) => { views.push(view); return "msg1"; });
    const edit = vi.fn(async (_id: string, view: CompactProgressView) => { views.push(view); });
    const p = new CompactProgressController({ create, edit }, { delayMs: 0, tickMs: 1000 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000); // 1:05
    await p.done("native");

    const last = views[views.length - 1];
    expect(last.elapsed).toBe("1:05");
    vi.useRealTimers();
  });
});
