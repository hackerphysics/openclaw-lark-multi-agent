import { describe, expect, it, vi } from "vitest";
import { LiveStatusController } from "../src/live-status.js";

describe("LiveStatusController", () => {
  it("marks the status message done on complete", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();

    expect(edits).toEqual(["✅ Claude 已完成"]);
    vi.useRealTimers();
  });

  it("marks the status message interrupted on fail", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.fail();

    expect(edits).toEqual(["⚠️ Claude 执行中断"]);
    vi.useRealTimers();
  });

  it("does not let a late progress edit run after complete()", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.complete();
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });

    expect(edits).toEqual(["✅ Claude 已完成"]);
    vi.useRealTimers();
  });

  it("updates only on tool start events and ignores verbose/tool-end noise", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async (text) => { created.push(text); return "msg1"; }),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toEqual(["Claude 正在执行"]);

    await live.progress({ kind: "assistant_note", text: "I will inspect the code" });
    await live.progress({ kind: "lifecycle", text: "thinking" });
    await live.progress({ kind: "tool", phase: "end", name: "read", text: "read end: ok" });
    expect(edits).toEqual([]);

    await live.progress({ kind: "tool", phase: "start", name: "read", text: "read start: src/live-status.ts" });
    expect(edits).toEqual(["Claude 正在执行：read: src/live-status.ts"]);
    vi.useRealTimers();
  });

  it("forces creation immediately when the first tool start arrives before delay", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async (text) => { created.push(text); return "msg1"; }),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 800 });

    live.start();
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });

    expect(created).toEqual(["Claude 正在执行：exec: npm test"]);
    expect(edits).toEqual([]);
    vi.useRealTimers();
  });

  it("reserves the final edit for completion after showing an update-limit notice", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0, maxEdits: 20 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 25; i++) {
      await live.progress({ kind: "tool", phase: "start", name: "tool", text: `tool start: step ${i}` });
    }

    expect(edits).toHaveLength(19);
    expect(edits[0]).toBe("Claude 正在执行：tool: step 1");
    expect(edits[17]).toBe("Claude 正在执行：tool: step 18");
    expect(edits[18]).toBe("Claude 已达更新限制，正在持续执行中");

    await live.complete();
    expect(edits).toHaveLength(20);
    expect(edits[19]).toBe("✅ Claude 已完成");
    vi.useRealTimers();
  });

  it("clips long tool details", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0, maxChars: 24 });

    live.start();
    await vi.advanceTimersByTimeAsync(0);
    await live.progress({ kind: "tool", phase: "start", name: "exec", text: `exec start: ${"x".repeat(80)}` });

    expect(edits[0]).toBe(`Claude 正在执行：exec: ${"x".repeat(17)}…`);
    vi.useRealTimers();
  });
});
