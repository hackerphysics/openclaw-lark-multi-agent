import { describe, expect, it, vi } from "vitest";
import { OpenClawClient } from "../src/openclaw-client.js";
import { getBridgeAttachmentsDir } from "../src/paths.js";

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
