import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore } from "../src/message-store.js";
import type { BotConfig } from "../src/config.js";

class MockOpenClaw {
  chatCalls: any[] = [];
  async getSessionInfo() { return { session: { totalTokens: 0 } }; }
  async ensureModel() { return false; }
  async createSession() {}
  async patchSession() {}
  async subscribeSession() {}
  onToolEvent() {}
  async chatSendWithContext(params: any) {
    this.chatCalls.push(params);
    return "mock reply";
  }
  async compactSession() { return "ok"; }
  async resetSession() { return "ok"; }
}

function event(opts: { chatId?: string; chatType?: "p2p" | "group"; text: string; messageId?: string; mentions?: any[]; senderType?: "user" | "app"; openId?: string }) {
  return {
    message: {
      chat_id: opts.chatId || "chat1",
      chat_type: opts.chatType || "group",
      message_type: "text",
      message_id: opts.messageId || `m-${Math.random()}`,
      content: JSON.stringify({ text: opts.text }),
      mentions: opts.mentions || [],
    },
    sender: {
      sender_type: opts.senderType || "user",
      sender_id: { open_id: opts.openId || "user-open-id" },
    },
  };
}

function makeHarness(name = "GPT") {
  const dir = mkdtempSync(join(tmpdir(), "olma-bot-"));
  const store = new MessageStore(join(dir, "messages.db"));
  const openclaw = new MockOpenClaw();
  const config: BotConfig = { name, appId: `app-${name}`, appSecret: "secret", model: `model-${name}` };
  const bot = new FeishuBot(config, openclaw as any, store);
  (bot as any).fetchAndCacheChatInfo = async (chatId: string, chatType: string) => {
    store.upsertChatInfo({ chatId, chatType, chatName: chatType, members: "", memberNames: "", ownerBot: chatType === "p2p" ? name : "", freeDiscussion: false, verbose: false, updatedAt: Date.now() });
  };
  (bot as any).ensureSession = async (chatId: string) => bot.getSessionKey(chatId);
  (bot as any).addReaction = vi.fn(async () => {});
  (bot as any).removeReaction = vi.fn(async () => {});
  (bot as any).replyMessage = vi.fn(async () => {});
  (bot as any).sendMessage = vi.fn(async () => {});
  return { bot, store, openclaw, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("FeishuBot routing and queue behavior", () => {
  it("does not respond to unmentioned group messages by default", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ text: "hello" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("responds to @all text and sends the trigger to OpenClaw", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ text: "@_all ping", messageId: "m1" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("@_all ping");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "mock reply");
      expect(h.store.hasDeliveredReply("GPT", "chat1", h.store.getMessageId("m1")!)).toBe(true);
    } finally { h.cleanup(); }
  });

  it("routes direct bot mentions only to the mentioned bot", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ text: "hi", mentions: [{ id: { app_id: "app-GPT" } }], messageId: "m1" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("ignores mentions for a different bot", async () => {
    const h = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-Gemini", { config: { appId: "app-Gemini", name: "Gemini" } } as any);
      await (h.bot as any).handleMessage(event({ text: "hi", mentions: [{ id: { app_id: "app-Gemini" } }], messageId: "m1" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
    } finally {
      FeishuBot.getAllBots().delete("app-Gemini");
      h.cleanup();
    }
  });

  it("handles bridge /verbose locally and does not forward it", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "/verbose", messageId: "cmd1" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getBotVerbose("GPT", "chat1")).toBe(true);
      expect((h.bot as any).replyMessage).toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it("handles @all-prefixed bridge commands locally", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /reset", messageId: "cmd-reset" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("cmd-reset", expect.stringContaining("Session 已重置"));
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("toggles free discussion per bot per chat", async () => {
    const gpt = makeHarness("GPT");
    const gemini = makeHarness("Gemini");
    try {
      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free on", messageId: "free-on" }));
      expect(gpt.store.getBotFreeDiscussion("GPT", "chat1")).toBe(true);
      expect(gpt.store.getBotFreeDiscussion("Gemini", "chat1")).toBe(false);
      expect(gemini.store.getBotFreeDiscussion("Gemini", "chat1")).toBe(false);
      expect((gpt.bot as any).replyMessage).toHaveBeenCalledWith("free-on", expect.stringContaining("GPT Free Discussion 已开启"));
    } finally { gpt.cleanup(); gemini.cleanup(); }
  });

  it("passes double-slash commands through to OpenClaw as single-slash commands", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "//status", messageId: "m1" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("/status");
    } finally { h.cleanup(); }
  });

  it("passes @all-prefixed double-slash commands through to OpenClaw", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all //status", messageId: "m1" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("/status");
    } finally { h.cleanup(); }
  });

  it("does not store empty or NO_REPLY bot replies", async () => {
    const h = makeHarness();
    try {
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => { h.openclaw.chatCalls.push(params); return "NO_REPLY"; });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "quiet", messageId: "m1" }));
      expect((h.bot as any).replyMessage).not.toHaveBeenCalled();
      expect(h.store.getRecent("chat1").filter((m) => m.senderType === "bot")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("skips duplicate delivered triggers", async () => {
    const h = makeHarness();
    try {
      const id = h.store.insert({ chatId: "chat1", messageId: "m1", senderType: "human", senderName: "u", content: "hello", timestamp: 1 });
      h.store.markPendingTrigger("GPT", "chat1", id);
      h.store.markDeliveredReply("GPT", "chat1", id, "m1");
      await (h.bot as any).processQueue("chat1");
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });
});
