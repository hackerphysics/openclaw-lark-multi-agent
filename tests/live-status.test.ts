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

  it("merges consecutive assistant text fragments into one line (no tool between)", async () => {
    // Repro: a long assistant message (e.g. a Markdown table) is flushed as
    // multiple incremental fragments. Without a tool event between them they all
    // belong to one thought and must NOT become separate lines.
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, historySize: 6, maxChars: 500 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "assistant_note", text: "| card patch 频率 | P2/监控 |" });
    await live.progress({ kind: "assistant_note", text: "项" });
    await live.progress({ kind: "assistant_note", text: "| 暂无问题 | | interactive reply 兼容性" });
    await live.progress({ kind: "assistant_note", text: "低风险 | 已实测基本可用 | |" });

    const last = views[views.length - 1];
    const textLines = last.lines.filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(1);
    expect(textLines[0].text).toContain("card patch 频率");
    expect(textLines[0].text).toContain("已实测基本可用");
    vi.useRealTimers();
  });

  it("starts a fresh text line after a tool event", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, historySize: 6 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "assistant_note", text: "先看一下" });
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await live.progress({ kind: "assistant_note", text: "现在明白了" });

    const last = views[views.length - 1];
    expect(last.lines.map((l) => l.kind)).toEqual(["text", "tool_start", "text"]);
    expect(last.lines[0].text).toBe("先看一下");
    expect(last.lines[2].text).toBe("现在明白了");
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

  it("records a relative timestamp (seconds since start) on each line", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await vi.advanceTimersByTimeAsync(12_000);
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });

    const last = views[views.length - 1];
    expect(last.lines[0].at).toBe(0);
    expect(last.lines[1].at).toBe(12);
    vi.useRealTimers();
  });

  it("shows a tool-call + elapsed summary line on complete instead of recent messages", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await live.progress({ kind: "tool", phase: "end", name: "read", text: "read end: ok" });
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });
    await live.complete();

    const last = views[views.length - 1];
    expect(last.state).toBe("done");
    // Content is a single summary line, not the recent activity window.
    expect(last.lines).toHaveLength(1);
    expect(last.lines[0].kind).toBe("summary");
    // Two tool starts (read, exec) => count is 2; tool_end does not count.
    expect(last.lines[0].text).toContain("2");
    expect(last.lines[0].text).toMatch(/共调用工具 2 次/);
    vi.useRealTimers();
  });

  it("does not include a disable hint in the view", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async (view) => { views.push(view); return "msg1"; }),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });

    expect((views[views.length - 1] as any).hint).toBeUndefined();
    vi.useRealTimers();
  });

  it("marks done with a 'no content' summary on noReply()", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("等待 OpenClaw 回复");
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await live.noReply();

    const last = views[views.length - 1];
    expect(last.state).toBe("done");
    expect(last.title).toBe("✅ Claude 已完成");
    expect(last.lines).toHaveLength(1);
    expect(last.lines[0].kind).toBe("summary");
    expect(last.lines[0].text).toContain("模型没有回复内容");
    vi.useRealTimers();
  });

  it("filters out NO_REPLY text so it never shows as an activity line", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const created: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async (v) => { created.push(v); return "msg1"; }),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    await live.progress({ kind: "assistant_note", text: "NO_REPLY" });
    await live.progress({ kind: "assistant_note", text: "no_reply" });

    const allLines = [...created, ...views].flatMap((v) => v.lines.map((l) => l.text));
    expect(allLines.some((t) => /no_reply/i.test(t))).toBe(false);
    vi.useRealTimers();
  });

  it("noReply() does not create a card if one was never shown (fast reply)", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => "msg1");
    const live = new LiveStatusController({
      create,
      edit: vi.fn(async () => {}),
    }, { botName: "Claude", delayMs: 800 });

    live.start("等待 OpenClaw 回复");
    // NO_REPLY arrives before the 800ms create delay elapses.
    await live.noReply();
    await vi.advanceTimersByTimeAsync(1000);

    expect(create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ticker patches the card to advance the elapsed footer without new activity", async () => {
    vi.useFakeTimers();
    const views: LiveStatusView[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, view) => { views.push(view); }),
    }, { botName: "Claude", delayMs: 0, tickMs: 3000 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: a.ts" });
    const countAfterActivity = views.length;

    // No new activity, just time passing: the ticker must still patch so the
    // elapsed footer advances (signature now includes elapsed).
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(views.length).toBeGreaterThan(countAfterActivity);
    const elapsedValues = views.slice(countAfterActivity).map((v) => v.elapsed);
    expect(new Set(elapsedValues).size).toBeGreaterThan(1); // elapsed actually changed
    vi.useRealTimers();
  });
});
