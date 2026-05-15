import { describe, expect, it, vi } from "vitest";
import { GATEWAY_PROTOCOL_MAX, GATEWAY_PROTOCOL_MIN, OpenClawClient } from "../src/openclaw-client.js";
import { getBridgeAttachmentsDir } from "../src/paths.js";

describe("OpenClawClient protocol compatibility", () => {
  it("declares compatibility with gateway protocol 3 through 4", () => {
    expect(GATEWAY_PROTOCOL_MIN).toBe(3);
    expect(GATEWAY_PROTOCOL_MAX).toBe(4);
  });
});

describe("OpenClawClient collectReply", () => {
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
    expect(result).toContain("type=document for Markdown documents");
  });
});
