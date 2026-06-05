import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { GATEWAY_PROTOCOL_MAX, GATEWAY_PROTOCOL_MIN, OpenClawClient } from "../src/openclaw-client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBridgeAttachmentsDir } from "../src/paths.js";

describe("OpenClawClient protocol compatibility", () => {
  it("declares compatibility with gateway protocol 3 through 4", () => {
    expect(GATEWAY_PROTOCOL_MIN).toBe(3);
    expect(GATEWAY_PROTOCOL_MAX).toBe(4);
  });
});

describe("OpenClawClient collectReply", () => {
  it("collects terminal events from short and full session key buckets", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const fullKey = "agent:main:s1";
    const shortKey = "s1";
    events.set(fullKey, []);
    events.set(shortKey, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(shortKey)!.push({
      runId: "chat-run",
      sessionKey: shortKey,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "aborted", stopReason: "rpc" },
    });

    await expect(replyPromise).resolves.toContain("Agent 未正常完成");
  });

  it("ignores empty lifecycle end and waits for later real text", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({
      runId: "other-runtime-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "working" },
    });
    setTimeout(() => {
      events.get(key)!.push({
        runId: "real-agent-run",
        sessionKey: key,
        stream: "assistant",
        data: { delta: "real reply" },
      });
      events.get(key)!.push({
        runId: "real-agent-run",
        sessionKey: key,
        stream: "lifecycle",
        data: { phase: "end", livenessState: "working" },
      });
    }, 50);

    await expect(replyPromise).resolves.toBe("real reply");
  });

  it("treats empty final as NO_REPLY when requested", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1", { emptyFinalAsNoReply: true });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "chatFinal", data: { text: "" } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end" } });

    await expect(replyPromise).resolves.toBe("NO_REPLY");
  });

  it("ignores empty chatFinal fallback and waits for later real text", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({
      runId: "other-runtime-run",
      sessionKey: key,
      stream: "chatFinal",
      data: { text: "" },
    });
    setTimeout(() => {
      events.get(key)!.push({
        runId: "real-agent-run",
        sessionKey: key,
        stream: "assistant",
        data: { delta: "later text" },
      });
      events.get(key)!.push({
        runId: "real-agent-run",
        sessionKey: key,
        stream: "lifecycle",
        data: { phase: "end", livenessState: "working" },
      });
    }, 50);

    await expect(replyPromise).resolves.toBe("later text");
  });

  it("ignores stale replay events before the expected user anchor", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("current-chat-run", 1000, "s1", { expectedUserText: "current question" });
    events.get(key)!.push({ runId: "old-runtime", sessionKey: key, stream: "lifecycle", data: { phase: "start" } });
    events.get(key)!.push({ runId: "old-runtime", sessionKey: key, stream: "sessionUser", data: { text: "Continue the OpenClaw runtime event." } });
    events.get(key)!.push({ runId: "old-runtime", sessionKey: key, stream: "chatFinal", data: { text: "" } });
    events.get(key)!.push({ runId: "old-runtime", sessionKey: key, stream: "lifecycle", data: { phase: "end", replayInvalid: true, livenessState: "working" } });
    setTimeout(() => {
      events.get(key)!.push({ runId: "current-chat-run", sessionKey: key, stream: "sessionUser", data: { text: "current question" } });
      events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "lifecycle", data: { phase: "start" } });
      events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "assistant", data: { delta: "current answer" } });
      events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "lifecycle", data: { phase: "end", livenessState: "working" } });
    }, 50);

    await expect(replyPromise).resolves.toBe("current answer");
  });

  it("trusts exact runId events even when the user anchor is missing", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("current-chat-run", 1000, "s1", { expectedUserText: "current question" });
    events.get(key)!.push({ runId: "current-chat-run", sessionKey: key, stream: "assistant", data: { delta: "exact run answer" } });
    events.get(key)!.push({ runId: "current-chat-run", sessionKey: key, stream: "chatFinal", data: { text: "exact run answer" } });
    events.get(key)!.push({ runId: "current-chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end", livenessState: "working" } });

    await expect(replyPromise).resolves.toBe("exact run answer");
  });

  it("buffers current run events that arrive just before the expected user anchor", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("current-chat-run", 1000, "s1", { expectedUserText: "current question" });
    events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "lifecycle", data: { phase: "start" } });
    events.get(key)!.push({ runId: "current-chat-run", sessionKey: key, stream: "sessionUser", data: { text: "current question" } });
    events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "assistant", data: { delta: "anchored answer" } });
    events.get(key)!.push({ runId: "real-run", sessionKey: key, stream: "lifecycle", data: { phase: "end", livenessState: "working" } });

    await expect(replyPromise).resolves.toBe("anchored answer");
  });

  it("keeps visible transcript text when final is empty and replay later aborts", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({
      sessionKey: key,
      stream: "assistant",
      data: { deltaText: "real transcript reply", delta: "real transcript reply", replace: true },
    });
    events.get(key)!.push({ runId: "runtime-replay", sessionKey: key, stream: "chatFinal", data: { text: "" } });
    events.get(key)!.push({
      runId: "runtime-replay",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
    });

    await expect(replyPromise).resolves.toBe("real transcript reply");
  });

  it("does not surface replayInvalid before the idle timeout and includes last activity when it times out", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 250, "s1");
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "item",
      data: { kind: "tool", phase: "end", name: "exec", meta: "curl timed out after 300s; received 788MB/1.12GB" },
    });
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });

    const reply = await replyPromise;
    expect(reply).toContain("Agent 未正常完成");
    expect(reply).toContain("状态: abandoned, replayInvalid");
    expect(reply).toContain("最后活动: 工具 end exec: curl timed out after 300s; received 788MB/1.12GB");
    expect(reply).toContain("没有收到新的工具输出或最终回复");
  });

  it("clears a pending replayInvalid failure when later tool activity arrives", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 800, "s1");
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });
    setTimeout(() => {
      events.get(key)!.push({
        runId: "chat-run",
        sessionKey: key,
        stream: "item",
        data: { kind: "tool", phase: "start", name: "exec", meta: "curl -C - retry" },
      });
      events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "assistant", data: { delta: "download resumed" } });
      events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end", livenessState: "working" } });
    }, 150);

    await expect(replyPromise).resolves.toBe("download resumed");
  });

  it("defers cancelled/rpc lifecycle failures until idle timeout and keeps later real text", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 800, "s1");
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "cancelled", stopReason: "rpc" },
    });
    setTimeout(() => {
      events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "assistant", data: { delta: "late real reply" } });
      events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end", livenessState: "working" } });
    }, 120);

    await expect(replyPromise).resolves.toBe("late real reply");
  });

  it("surfaces cancelled/rpc lifecycle only after idle timeout if no real reply arrives", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 250, "s1");
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end", livenessState: "cancelled", stopReason: "rpc" },
    });

    const reply = await replyPromise;
    expect(reply).toContain("Agent 未正常完成");
    expect(reply).toContain("状态: cancelled");
    expect(reply).toContain("原因: rpc");
    expect(reply).toContain("没有收到新的工具输出或最终回复");
  });

  it("extracts visible assistant text from text-only transcript messages", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    expect((client as any).extractVisibleAssistantText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }] })).toBe("visible");
    expect((client as any).extractVisibleAssistantText({ role: "assistant", content: [{ type: "text", text: "draft" }, { type: "toolCall", name: "read" }] })).toBe("");
    expect((client as any).extractVisibleAssistantText({ role: "assistant", content: [{ type: "text", text: "draft" }, { type: "toolCall", name: "read" }] }, { allowMixedToolText: true })).toBe("draft");
  });

  it("collects v4 chatDelta deltaText and respects replace semantics", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "chatDelta",
      data: { deltaText: "hel" },
    });
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "chatDelta",
      data: { deltaText: "hello", replace: true },
    });
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "chatDelta",
      data: { deltaText: " world" },
    });
    events.get(key)!.push({
      runId: "chat-run",
      sessionKey: key,
      stream: "lifecycle",
      data: { phase: "end" },
    });

    await expect(replyPromise).resolves.toBe("hello world");
  });

  it("does not double-count mirrored assistant and chatDelta streams", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "assistant", data: { delta: "hello" } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "chatDelta", data: { deltaText: "hello" } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end" } });

    await expect(replyPromise).resolves.toBe("hello");
  });
  it("does not concatenate transcript mirrors with streaming deltas", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events = new Map<string, any[]>();
    (client as any).agentEvents = events;
    const key = "agent:main:s1";
    events.set(key, []);

    const replyPromise = (client as any).collectReply("chat-run", 1000, "s1");
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "assistant", data: { delta: "prefix" } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "transcriptAssistant", data: { deltaText: "prefix full final", replace: true } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "assistant", data: { delta: " full final" } });
    events.get(key)!.push({ runId: "chat-run", sessionKey: key, stream: "lifecycle", data: { phase: "end" } });

    await expect(replyPromise).resolves.toBe("prefix full final");
  });


  it("limits concurrent maintenance RPCs", async () => {
    const previous = process.env.OPENCLAW_LARK_MULTI_AGENT_MAINTENANCE_CONCURRENCY;
    process.env.OPENCLAW_LARK_MULTI_AGENT_MAINTENANCE_CONCURRENCY = "1";
    try {
      const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
      let active = 0;
      let maxActive = 0;
      (client as any).rpc = vi.fn(async (method: string) => {
        expect(method).toBe("sessions.compact");
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return { ok: true };
      });

      await Promise.all([
        client.compactSession("s1"),
        client.compactSession("s2"),
        client.compactSession("s3"),
      ]);

      expect(maxActive).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_LARK_MULTI_AGENT_MAINTENANCE_CONCURRENCY;
      else process.env.OPENCLAW_LARK_MULTI_AGENT_MAINTENANCE_CONCURRENCY = previous;
    }
  });
});

describe("OpenClawClient proactive delivery mute", () => {
  it("drops muted proactive assistant messages and resumes after release", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("s1", callback);
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);

    const release = client.muteProactiveDelivery("s1");
    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: "hidden" })).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    release();
    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: "visible" })).toBe(true);
    expect(callback).toHaveBeenCalledWith("visible");
  });

  it("buffers verbose assistant stream text while normal mode stays quiet", async () => {
    vi.useFakeTimers();
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("s1", callback);
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { text: "普通模式不投" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalled();

    client.setVerboseTranscriptDelivery("s1", true);
    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { text: "工具前文本" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalled();
    (client as any).flushVerboseAssistantState("agent:main:s1");
    expect(callback).toHaveBeenCalledWith("工具前文本", { sourceType: "verbose_transcript" });
    vi.useRealTimers();
  });

  it("sends only new verbose assistant text when flushed and clears buffer when disabled", async () => {
    vi.useFakeTimers();
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    client.setVerboseTranscriptDelivery("s1", true);
    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { delta: "工具" } });
    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { delta: "前文本" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalled();
    (client as any).flushVerboseAssistantState("agent:main:s1");
    expect(callback).toHaveBeenCalledWith("工具前文本", { sourceType: "verbose_transcript" });

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { text: "工具前文本，继续处理" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalledWith("，继续处理", { sourceType: "verbose_transcript" });
    (client as any).flushVerboseAssistantState("agent:main:s1");
    expect(callback).toHaveBeenCalledWith("，继续处理", { sourceType: "verbose_transcript" });
    expect(callback).not.toHaveBeenCalledWith("工具前文本，继续处理");

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { text: "关闭后不应投递" } });
    client.setVerboseTranscriptDelivery("s1", false);
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalledWith("关闭后不应投递");
    vi.useRealTimers();
  });

  it("flushes pending verbose assistant text before clearing state on tool start", async () => {
    vi.useFakeTimers();
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    client.setVerboseTranscriptDelivery("s1", true);

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { delta: "我会先看一下，避免" } });
    (client as any).flushVerboseAssistantState("agent:main:s1");
    (client as any).clearVerboseAssistantState("agent:main:s1");
    expect(callback).toHaveBeenCalledWith("我会先看一下，避免", { sourceType: "verbose_transcript" });

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { delta: "误重启别的东西" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(callback).not.toHaveBeenCalledWith("误重启别的东西", { sourceType: "verbose_transcript" });
    (client as any).flushVerboseAssistantState("agent:main:s1");
    expect(callback).toHaveBeenCalledWith("误重启别的东西", { sourceType: "verbose_transcript" });
    vi.useRealTimers();
  });

  it("flushes verbose assistant text on lifecycle end for tool-free replies", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    client.setVerboseTranscriptDelivery("s1", true);

    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { delta: "这是一段纯文本 verbose 回复" } });
    (client as any).flushVerboseAssistantState("agent:main:s1");
    (client as any).clearVerboseAssistantState("agent:main:s1");

    expect(callback).toHaveBeenCalledWith("这是一段纯文本 verbose 回复", { sourceType: "verbose_transcript" });
  });

  it("force-flushes very long verbose assistant text to avoid oversized Feishu messages", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    client.setVerboseTranscriptDelivery("s1", true);

    const longText = "长".repeat(3000);
    (client as any).handleVerboseAssistantStream({ sessionKey: "agent:main:s1", data: { text: longText } });

    expect(callback).toHaveBeenCalledWith(longText, { sourceType: "verbose_transcript" });
  });

  it("keeps proactive transcript suppressed in verbose mode while chatSend owns delivery", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("s1", callback);
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    (client as any).suppressedSessions.add("s1");
    (client as any).suppressedSessions.add("agent:main:s1");
    client.setVerboseTranscriptDelivery("s1", true);

    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: [{ type: "text", text: "我先看代码" }, { type: "toolCall", name: "read" }] })).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("drops proactive assistant messages while chatSend owns delivery", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("s1", callback);
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);
    (client as any).suppressedSessions.add("s1");
    (client as any).suppressedSessions.add("agent:main:s1");

    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: "hidden" })).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("drops transcript messages while external chat is streaming but emits final", () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const callback = vi.fn();
    (client as any).sessionMessageCallbacks.set("s1", callback);
    (client as any).sessionMessageCallbacks.set("agent:main:s1", callback);

    (client as any).trackChatEventSession("agent:main:s1", "delta", { deltaText: "draft" });
    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: "hidden" })).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    (client as any).trackChatEventSession("agent:main:s1", "final", { message: { content: [{ type: "text", text: "final answer" }] } });
    expect(callback).toHaveBeenCalledWith("final answer");
    expect((client as any).handleProactiveSessionMessage("agent:main:s1", { role: "assistant", content: "final answer" })).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});


describe("OpenClawClient chat.send concurrency", () => {
  it("limits concurrent chat.send RPCs", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    (client as any).chatSendConcurrency = 2;
    (client as any).collectReply = async (runId: string) => `reply:${runId}`;
    let active = 0;
    let maxActive = 0;
    (client as any).rpc = async (method: string, _params: any) => {
      expect(method).toBe("chat.send");
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return { runId: `run-${Math.random().toString(36).slice(2)}` };
    };

    const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => client.chatSend({ sessionKey: `s${i}`, message: `m${i}` })));
    expect(replies).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("OpenClawClient bridge attachment hint", () => {
  function clientWithCapturedChatSend() {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const chatSend = vi.fn(async (params: any) => params.message);
    (client as any).chatSend = chatSend;
    return { client, chatSend };
  }

  it("calls onSendAttempt before chat.send RPC", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events: string[] = [];
    (client as any).rpc = vi.fn(async () => {
      events.push("rpc");
      return { runId: "run-1" };
    });
    (client as any).collectReply = vi.fn(async () => "done");

    await client.chatSend({
      sessionKey: "s1",
      message: "hello",
      onSendAttempt: () => events.push("attempt"),
    });

    expect(events).toEqual(["attempt", "rpc"]);
  });

  it("calls onSubmitted immediately after chat.send accepts the run", async () => {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const events: string[] = [];
    (client as any).rpc = vi.fn(async () => {
      events.push("rpc");
      return { runId: "run-1" };
    });
    (client as any).collectReply = vi.fn(async () => {
      events.push("collectReply");
      return "done";
    });

    const result = await client.chatSend({
      sessionKey: "s1",
      message: "hello",
      onSubmitted: (runId) => events.push(`submitted:${runId}`),
    });

    expect(result).toBe("done");
    expect(events).toEqual(["rpc", "submitted:run-1", "collectReply"]);
  });

  it("does not inject the bridge attachment hint into ordinary messages", async () => {
    const { client, chatSend } = clientWithCapturedChatSend();
    const result = await client.chatSendWithContext({
      sessionKey: "s1",
      unsyncedMessages: [],
      currentMessage: "今天聊聊模型能力",
      currentSenderName: "Stephen",
    });
    expect(chatSend).toHaveBeenCalledOnce();
    expect(result).not.toContain("LMA_BRIDGE_ATTACHMENTS");
  });


  it("uses neutral catch-up wording rather than group-chat wording", async () => {
    const { client, chatSend } = clientWithCapturedChatSend();
    const result = await client.chatSendWithContext({
      sessionKey: "s1",
      unsyncedMessages: [{
        id: 1,
        chatId: "c",
        messageId: "m0",
        senderType: "human",
        senderName: "Alice",
        content: "上一条",
        timestamp: 1,
      }],
      currentMessage: "当前问题",
      currentSenderName: "Alice",
    });
    expect(chatSend).toHaveBeenCalledOnce();
    expect(result).toContain("群里其他成员");
    expect(result).toContain("你还没看到");
  });

  it("writes oversized catch-up context to a local file and instructs the agent to read it", async () => {
    const { client, chatSend } = clientWithCapturedChatSend();
    const messages = Array.from({ length: 1001 }, (_, i) => ({
      id: i + 1,
      chatId: "chat1",
      messageId: `m${i + 1}`,
      senderType: i % 2 === 0 ? "human" as const : "bot" as const,
      senderName: i % 2 === 0 ? "Stephen" : "GPT",
      content: `message ${i + 1}`,
      timestamp: 1778890000000 + i,
    }));

    const result = await client.chatSendWithContext({
      sessionKey: "s1",
      unsyncedMessages: messages,
      currentMessage: "你怎么看？",
      currentSenderName: "Stephen",
    });

    expect(chatSend).toHaveBeenCalledOnce();
    expect(result).toContain("已写入本地文件");
    expect(result).toContain("如需参考历史，请使用 read 工具读取这个文件");
    expect(result.indexOf("你怎么看？")).toBeLessThan(result.indexOf("已写入本地文件"));
    expect(result).not.toContain("群聊历史");
    const filePath = result.match(/文件路径：([^\n]+)/)?.[1]?.trim();
    expect(filePath).toBeTruthy();
    expect(existsSync(filePath!)).toBe(true);
    const file = readFileSync(filePath!, "utf8");
    expect(file).toContain("Messages: 1001");
    expect(file).toContain("message 1");
    expect(file).toContain("message 1001");
  });


  it("does not inject catch-up context or attachment hint when disabled", async () => {
    const { client, chatSend } = clientWithCapturedChatSend();
    const result = await client.chatSendWithContext({
      sessionKey: "s1",
      unsyncedMessages: [{
        id: 1,
        chatId: "c",
        messageId: "m0",
        senderType: "human",
        senderName: "Alice",
        content: "请发送图片文件",
        timestamp: 1,
      }],
      currentMessage: "/status",
      currentSenderName: "Alice",
      includeContext: false,
      includeBridgeAttachmentHint: false,
    });
    expect(chatSend).toHaveBeenCalledOnce();
    expect(result).toBe("/status");
    expect(chatSend.mock.calls[0][0].message).toBe("/status");
  });

  it("attaches images without injecting a media note into message text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "olma-image-"));
    try {
      const imagePath = join(dir, "shot.png");
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const { client, chatSend } = clientWithCapturedChatSend();
      const result = await client.chatSendWithContext({
        sessionKey: "s1",
        unsyncedMessages: [],
        currentMessage: `[Image: ${imagePath}] 这张图说明什么？`,
        currentSenderName: "Stephen",
        includeBridgeAttachmentHint: false,
      });
      expect(chatSend).toHaveBeenCalledOnce();
      expect(result).not.toContain("Media note");
      expect(result).toContain("这张图说明什么？");
      expect(chatSend.mock.calls[0][0].attachments).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects the bridge attachment hint only for likely attachment requests", async () => {
    const { client, chatSend } = clientWithCapturedChatSend();
    const result = await client.chatSendWithContext({
      sessionKey: "s1",
      unsyncedMessages: [],
      currentMessage: "写一份 md 文档并发到飞书",
      currentSenderName: "Stephen",
    });
    expect(chatSend).toHaveBeenCalledOnce();
    expect(result).toContain("Bridge attachment capability hint");
    expect(result).toContain(`${getBridgeAttachmentsDir()}/`);
    expect(result).toContain("LMA_BRIDGE_ATTACHMENTS");
    expect(result).toContain("Do NOT call message, sessions_send");
    expect(result).toContain("NEVER use placeholder paths");
    expect(result).toContain("replace-with-actual-created-file.png");
    expect(result).not.toContain("path\":\"/absolute/path");
    expect(result).not.toContain("path\":\"/real/path");
    expect(result).toContain("type=document for Markdown documents");
  });
});
