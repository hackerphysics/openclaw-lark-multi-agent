import { describe, expect, it, vi } from "vitest";
import { OpenClawClient } from "../src/openclaw-client.js";

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
    expect(result).toContain("/home/haipw/.openclaw/openclaw-lark-multi-agent/attachments/");
    expect(result).toContain("LMA_BRIDGE_ATTACHMENTS");
    expect(result).toContain("type=document for Markdown documents");
  });
});
