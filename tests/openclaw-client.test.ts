import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { GATEWAY_PROTOCOL_MAX, GATEWAY_PROTOCOL_MIN, OpenClawClient } from "../src/openclaw-client.js";
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

describe("OpenClawClient bridge attachment hint", () => {
  function clientWithCapturedChatSend() {
    const client = new OpenClawClient({ baseUrl: "ws://localhost", token: "test" } as any);
    const chatSend = vi.fn(async (params: any) => params.message);
    (client as any).chatSend = chatSend;
    return { client, chatSend };
  }

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
    expect(result).toContain("你必须先使用 read 工具读取这个文件");
    const filePath = result.match(/文件路径：([^\n]+)/)?.[1]?.trim();
    expect(filePath).toBeTruthy();
    expect(existsSync(filePath!)).toBe(true);
    const file = readFileSync(filePath!, "utf8");
    expect(file).toContain("Messages: 1001");
    expect(file).toContain("message 1");
    expect(file).toContain("message 1001");
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
