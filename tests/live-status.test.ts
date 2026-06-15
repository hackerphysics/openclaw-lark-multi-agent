import { describe, expect, it, vi } from "vitest";
import { LiveStatusController, type LiveStatusView } from "../src/live-status.js";

describe("LiveStatusController (interactive card)", () => {
  it("sets title to done on complete", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("等待 OpenClaw 回复");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();

    const last = views[views.length - 1];
    expect(last.title).toBe("✅ Claude 已完成");
    expect(last.state).toBe("done");
    vi.useRealTimers();
  });

  it("sets title to interrupted on fail", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("等待 OpenClaw 回复");
    await vi.advanceTimersByTimeAsync(0);
    await live.fail();

    const last = views[views.length - 1];
    expect(last.title).toBe("⚠️ Claude 执行中断");
    expect(last.state).toBe("failed");
    vi.useRealTimers();
  });

  it("does not let a late progress edit run after complete()", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();
    const countAfterComplete = views.length;
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });

    expect(views.length).toBe(countAfterComplete);
    expect(views[views.length - 1].title).toBe("✅ Claude 已完成");
    vi.useRealTimers();
  });

  it("treats tool start, tool end and intermediate text each as one content line", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, historySize: 3 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);

    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await live.progress({ kind: "assistant_note", text: "looks fine" });
    await live.progress({ kind: "tool", phase: "end", name: "read", text: "read end: ok" });

    const last = views[views.length - 1];
    expect(last.lines.map((l) => l.kind)).toEqual(["tool_start", "text", "tool_end"]);
    expect(last.lines[0].text).toBe("read: a.ts");
    expect(last.lines[1].text).toBe("looks fine");
    expect(last.lines[2].text).toBe("read: ok");
    vi.useRealTimers();
  });

  it("keeps only the most recent N lines (default 3)", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, historySize: 3 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 5; i++) {
      await live.progress({ kind: "tool", phase: "start", name: "tool", text: `tool start: step ${i}` });
    }

    const last = views[views.length - 1];
    expect(last.lines).toHaveLength(3);
    expect(last.lines.map((l) => l.text)).toEqual(["tool: step 3", "tool: step 4", "tool: step 5"]);
    vi.useRealTimers();
  });

  it("ignores tool error events (delivered via the normal path)", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "error", name: "exec", text: "exec error: boom" });

    expect(views).toEqual([]);
    vi.useRealTimers();
  });

  it("exposes elapsed time and model in the footer view", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, model: "phgeek-gw/claude-opus-4.8" });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });

    const last = views[views.length - 1];
    expect(last.model).toBe("phgeek-gw/claude-opus-4.8");
    expect(last.elapsed).toMatch(/^\d+:\d{2}$/);
    vi.useRealTimers();
  });

  it("forces creation immediately when the first tool start arrives before delay", async () => {
    vi.useFakeTimers();
    const created: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async (view) => { created.push(view); return "msg1"; }),
      edit: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 800 });

    live.start();
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });

    expect(created).toHaveLength(1);
    expect(created[0].lines.map((l) => l.text)).toContain("exec: npm test");
    vi.useRealTimers();
  });

  it("does not impose the old text-message 20-edit budget on card patch status", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, historySize: 3 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 25; i++) {
      await live.progress({ kind: "tool", phase: "start", name: "tool", text: `tool start: step ${i}` });
    }

    // 25 distinct progress updates all patched, no 20-edit cap.
    expect(views.length).toBe(25);
    expect(views[views.length - 1].lines.map((l) => l.text)).toEqual(["tool: step 23", "tool: step 24", "tool: step 25"]);

    await live.complete();
    expect(views[views.length - 1].title).toBe("✅ Claude 已完成");
    vi.useRealTimers();
  });

  it("clips long tool details", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, maxChars: 24 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: `exec start: ${"x".repeat(80)}` });

    const last = views[views.length - 1];
    // "exec: " (6) + 17 x's + ellipsis = 24 chars
    expect(last.lines[0].text).toBe(`exec: ${"x".repeat(17)}…`);
    vi.useRealTimers();
  });
});
