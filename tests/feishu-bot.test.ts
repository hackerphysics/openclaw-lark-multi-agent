import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore } from "../src/message-store.js";
import type { BotConfig } from "../src/config.js";

class MockOpenClaw {
  chatCalls: any[] = [];
  replies: string[] = [];
  resolvers: Array<(value: string) => void> = [];
  sessionCallbacks = new Map<string, (text: string) => void>();
  async getSessionInfo() { return { session: { totalTokens: 0 } }; }
  async ensureModel() { return false; }
  async createSession() {}
  async patchSession() {}
  async subscribeSession(sessionKey: string, onMessage: (text: string) => void) { this.sessionCallbacks.set(sessionKey, onMessage); }
  onToolEvent() {}
  muteProactiveDelivery = vi.fn(() => vi.fn());
  async chatSendWithContext(params: any) {
    this.chatCalls.push(params);
    if (this.replies.length > 0) return this.replies.shift()!;
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
    store.upsertChatInfo({ chatId, chatType, chatName: chatType, members: "", memberNames: "", ownerBot: chatType === "p2p" ? name : "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 3, updatedAt: Date.now() });
  };
  (bot as any).ensureSession = async (chatId: string) => bot.getSessionKey(chatId);
  (bot as any).addReaction = vi.fn(async () => {});
  (bot as any).removeReaction = vi.fn(async () => {});
  (bot as any).replyMessage = vi.fn(async () => {});
  (bot as any).sendMessage = vi.fn(async () => {});
  return { bot, store, openclaw, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FeishuBot routing and queue behavior", () => {
  it("does not respond to unmentioned group messages by default", async () => {
    const h = makeHarness();
    try {
      await (h.bot as any).handleMessage(event({ text: "hello" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("atomically deduplicates concurrent duplicate Feishu events", async () => {
    const h = makeHarness("GPT");
    try {
      let releaseFetch!: () => void;
      (h.bot as any).fetchAndCacheChatInfo = vi.fn(() => new Promise<void>((resolve) => { releaseFetch = resolve; }));
      const evt = event({ text: "@_all ping", messageId: "dup-event" });
      const p1 = (h.bot as any).handleMessage(evt);
      const p2 = (h.bot as any).handleMessage(evt);
      await Promise.resolve();
      releaseFetch();
      await Promise.all([p1, p2]);
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getRecent("chat1").filter((m) => m.messageId === "dup-event")).toHaveLength(1);
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

  it("routes mention-only messages as triggers with previous context", async () => {
    const h = makeHarness("Claude");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "请分析上一条", messageId: "prev" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（Claude）",
        messageId: "mention-only",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude" } }],
      }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("请回复上面最近一条用户消息。");
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content)).toContain("请分析上一条");
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

  it("handles /discuss commands locally", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-on" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(true);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-on", expect.stringContaining("Discuss 已开启"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss rounds 2", messageId: "discuss-rounds" }));
      expect(h.store.getChatInfo("chat1")?.discussMaxRounds).toBe(2);

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss off", messageId: "discuss-off" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(false);
    } finally { h.cleanup(); }
  });

  it("discuss mode takes over plain human messages and runs free participants", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      // The production app shares one MessageStore instance across bots.
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setBotMode("GPT", "chat1", "free");
      gpt.store.setBotMode("Claude", "chat1", "free");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 1);

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic" }));
      await vi.waitUntil(() => gpt.openclaw.chatCalls.length === 1 && claude.openclaw.chatCalls.length === 1, { timeout: 1000 });
      expect(gpt.openclaw.chatCalls[0].currentMessage).toContain("多智能体结构化讨论");
      expect(claude.openclaw.chatCalls[0].currentMessage).toContain("多智能体结构化讨论");
      expect(gpt.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      expect(gpt.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });

  it("lets targeted mentions fall through while discuss mode is enabled", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.setDiscussMode("chat1", true);
      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（GPT） 你好",
        messageId: "targeted-discuss",
        mentions: [{ name: "万万（GPT）", id: { app_id: "app-GPT", open_id: "gpt-open-id" } }],
      }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("targeted-discuss", "mock reply");
    } finally { h.cleanup(); }
  });

  it("adds discussion round markers once and keeps raw text for the next round", async () => {
    const h = makeHarness("Claude");
    try {
      h.openclaw.replies.push("观点正文\n\n—— 第 1/3 轮 · Claude");
      const result = await (h.bot as any).runDiscussionTurn("chat1", "prompt", { round: 1, maxRounds: 3 });
      expect(result.text).toBe("观点正文");
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
      const sent = (h.bot as any).sendMessage.mock.calls[0][1];
      expect(sent.match(/—— 第 1\/3 轮 · Claude/g)).toHaveLength(1);
      expect(h.openclaw.muteProactiveDelivery).toHaveBeenCalledWith("lma-claude-chat1");
    } finally { h.cleanup(); }
  });

  it("cancels pending queued messages when they are recalled", async () => {
    const h = makeHarness("GPT");
    try {
      const rowId = h.store.insert({ chatId: "chat1", messageId: "recall-me", senderType: "human", senderName: "u", content: "queued", timestamp: 1 });
      h.store.markPendingTrigger("GPT", "chat1", rowId);
      (h.bot as any).pendingAckMessages.set("chat1", [{ messageId: "recall-me", emoji: "Typing", rowId }]);
      await (h.bot as any).handleMessageRecalled({ chat_id: "chat1", message_id: "recall-me", recall_time: "123", recall_type: "message_owner" });
      expect(h.store.getPendingTriggerIds("GPT", "chat1").has(rowId)).toBe(false);
      expect(h.store.isMessageRecalled("recall-me")).toBe(true);
      expect((h.bot as any).pendingAckMessages.get("chat1")).toEqual([]);
      expect((h.bot as any).removeReaction).toHaveBeenCalledWith("recall-me", "Typing");
    } finally { h.cleanup(); }
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

  it("toggles free mode per bot per chat", async () => {
    const gpt = makeHarness("GPT");
    const gemini = makeHarness("Gemini");
    try {
      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free", messageId: "free-on" }));
      expect(gpt.store.getBotMode("GPT", "chat1")).toBe("free");
      expect(gpt.store.getBotMode("Gemini", "chat1")).toBe("normal");
      expect(gemini.store.getBotMode("Gemini", "chat1")).toBe("normal");
      expect((gpt.bot as any).replyMessage).toHaveBeenCalledWith("free-on", expect.stringContaining("GPT 已切换到 free 模式"));
      expect((gpt.bot as any).replyMessage).toHaveBeenCalledWith("free-on", expect.not.stringContaining("连续 Bot 回复超过"));
      expect((gpt.bot as any).replyMessage).toHaveBeenCalledWith("free-on", expect.stringContaining("/discuss on"));
      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free", messageId: "free-off" }));
      expect(gpt.store.getBotMode("GPT", "chat1")).toBe("normal");
    } finally { gpt.cleanup(); gemini.cleanup(); }
  });

  it("does not let free mode respond to messages mentioning another bot", async () => {
    const claude = makeHarness("Claude");
    try {
      FeishuBot.getAllBots().set("app-GPT", { config: { appId: "app-GPT", name: "GPT" }, botOpenId: "gpt-open-id" } as any);
      claude.store.setBotMode("Claude", "chat1", "free");
      await (claude.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（GPT） hello",
        messageId: "mention-gpt",
        mentions: [{ name: "万万（GPT）", id: { app_id: "app-GPT", open_id: "gpt-open-id" } }],
      }));
      expect(claude.openclaw.chatCalls).toHaveLength(0);
      expect(claude.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      claude.cleanup();
    }
  });

  it("does not let free mode respond to messages mentioning a human", async () => {
    const h = makeHarness("Claude");
    try {
      h.store.setBotMode("Claude", "chat1", "free");
      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "@张三 hello",
        messageId: "mention-human",
        mentions: [{ name: "张三", id: { open_id: "ou_human" } }],
      }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("lets free mode respond to plain human messages", async () => {
    const h = makeHarness("Claude");
    try {
      h.store.setBotMode("Claude", "chat1", "free");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "plain question", messageId: "plain" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("does not let free discussion execute commands addressed to another bot", async () => {
    const claude = makeHarness("Claude");
    try {
      FeishuBot.getAllBots().set("app-GPT", { config: { appId: "app-GPT", name: "GPT" }, botOpenId: "gpt-open-id" } as any);
      claude.store.setBotMode("Claude", "chat1", "free");
      await (claude.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（GPT） /free",
        messageId: "free-gpt",
        mentions: [{ name: "万万（GPT）", id: { app_id: "app-GPT", open_id: "gpt-open-id" } }],
      }));
      expect(claude.store.getBotMode("Claude", "chat1")).toBe("free");
      expect((claude.bot as any).replyMessage).not.toHaveBeenCalled();
      expect(claude.openclaw.chatCalls).toHaveLength(0);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      claude.cleanup();
    }
  });

  it("mutes bot without forwarding direct mentions to OpenClaw", async () => {
    const h = makeHarness("Gemini");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /mute", messageId: "mute-on" }));
      expect(h.store.getBotMode("Gemini", "chat1")).toBe("mute");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("mute-on", expect.stringContaining("Gemini 已切换到 mute 模式"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all hello", messageId: "all-muted" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（Gemini） hello",
        messageId: "direct-muted",
        mentions: [{ name: "万万（Gemini）", id: { app_id: "app-Gemini" } }],
      }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("direct-muted", expect.stringContaining("Gemini 当前处于 mute 模式"));
    } finally { h.cleanup(); }
  });

  it("reports mode locally", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.setBotMode("GPT", "chat1", "mute");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /mode", messageId: "mode" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("mode", expect.stringContaining("当前模式：mute"));
    } finally { h.cleanup(); }
  });

  it("does not let bridge /status clear older pending triggers", async () => {
    const h = makeHarness("GLM");
    try {
      const pendingRow = h.store.insert({ chatId: "chat1", messageId: "old-pending", senderType: "human", senderName: "u", content: "还没处理的问题", timestamp: Date.now() });
      h.store.markPendingTrigger("GLM", "chat1", pendingRow);
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/status", messageId: "status-after-fail" }));
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(pendingRow)).toBe(true);
    } finally { h.cleanup(); }
  });

  it("startup drain starts all pending chats without waiting for the first one to finish", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.upsertChatInfo({ chatId: "chat-a", chatType: "group", chatName: "A", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 3, updatedAt: 1 });
      h.store.upsertChatInfo({ chatId: "chat-b", chatType: "group", chatName: "B", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 3, updatedAt: 2 });
      const rowA = h.store.insert({ chatId: "chat-a", messageId: "a", senderType: "human", senderName: "u", content: "a", timestamp: 1 });
      const rowB = h.store.insert({ chatId: "chat-b", messageId: "b", senderType: "human", senderName: "u", content: "b", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat-a", rowA);
      h.store.markPendingTrigger("GPT", "chat-b", rowB);
      let releaseA!: () => void;
      const calls: string[] = [];
      (h.bot as any).processQueue = vi.fn((chatId: string) => {
        calls.push(chatId);
        if (chatId === "chat-a") return new Promise<void>((resolve) => { releaseA = resolve; });
        return Promise.resolve();
      });
      const drain = (h.bot as any).drainOnStartup();
      await vi.waitUntil(() => calls.includes("chat-b"), { timeout: 1000 });
      releaseA();
      await drain;
      expect(calls).toEqual(expect.arrayContaining(["chat-a", "chat-b"]));
    } finally { h.cleanup(); }
  });

  it("processes pending triggers even if sync cursor moved past them", async () => {
    const h = makeHarness("GPT");
    try {
      const pendingRow = h.store.insert({ chatId: "chat1", messageId: "old-pending", senderType: "human", senderName: "u", content: "old pending", timestamp: 1 });
      h.store.markPendingTrigger("GPT", "chat1", pendingRow);
      const laterRow = h.store.insert({ chatId: "chat1", messageId: "later-status", senderType: "human", senderName: "u", content: "/status", timestamp: 2 });
      h.store.markSynced("GPT", "chat1", laterRow);
      await (h.bot as any).processQueue("chat1");
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("old pending");
      expect(h.store.getPendingTriggerIds("GPT", "chat1").has(pendingRow)).toBe(false);
    } finally { h.cleanup(); }
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

  it("delays runtime failure notices and cancels them when a real proactive reply arrives", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).scheduleDelayedFailure("chat1", "runtime-fail", "⚠️ Agent 未正常完成\n状态: unknown\n原因: rpc\n请重试，或用 /reset 重置会话", 123);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("runtime-fail", expect.any(String));
      (h.bot as any).cancelDelayedFailure("chat1");
      await vi.advanceTimersByTimeAsync(31_000);
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("runtime-fail", expect.any(String));
    } finally { h.cleanup(); }
  });

  it("suppresses delayed runtime failure if a real reply was just delivered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const h = makeHarness("Claude");
    try {
      (h.bot as any).lastRealDeliveryAt.set("chat1", Date.now());
      (h.bot as any).scheduleDelayedFailure("chat1", "runtime-fail", "⚠️ Agent 未正常完成\n状态: unknown\n原因: rpc\n请重试，或用 /reset 重置会话", 123);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("runtime-fail", expect.any(String));
    } finally { h.cleanup(); }
  });

  it("delivers delayed runtime failure notices if no real reply arrives", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).scheduleDelayedFailure("chat1", "runtime-fail", "⚠️ Agent 未正常完成\n状态: unknown\n原因: rpc\n请重试，或用 /reset 重置会话", 123);
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("runtime-fail", expect.stringContaining("原因: rpc"));
    } finally { h.cleanup(); }
  });

  it("deduplicates proactive and final delivery for the same active trigger", async () => {
    const h = makeHarness("GPT");
    try {
      const release = (h.bot as any).setActiveDeliveryTarget("chat1", 42, "reply-42");
      const activeTarget = (h.bot as any).activeDeliveryTargets.get("chat1");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "proactive-active", "same answer", [], activeTarget.messageId, `trigger:${activeTarget.triggerId}`);
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "visible-final", "same answer", [], "reply-42", "trigger:42");
      release();
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(1);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-42", "same answer");
    } finally { h.cleanup(); }
  });

  it("deduplicates assistant delivery across repeated enqueue attempts", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-a", "same text", [], "reply-1", "trigger:1");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-b", "same text", [], "reply-1", "trigger:1");
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(1);
      expect(h.store.getPendingDeliveries("chat1", "GPT")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("uses short-window content dedupe for source-only proactive duplicates", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-a", "same proactive text", []);
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-b", "same proactive text", []);
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });

  it("uses short-window containment dedupe for chat-final plus proactive overlap", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-a", "我来处理。最终结果是 OK。", []);
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-b", "最终结果是 OK。", []);
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });

  it("notifies the group when provider errors happen", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      (h.openclaw as any).chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        throw new Error("You have exceeded the 5-hour usage quota. It will reset at 2026-05-11 21:57:42 +0800 CST.");
      });
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "需要回答", messageId: "quota-error" }));
      const rowId = h.store.getMessageId("quota-error")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(rowId)).toBe(false);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("quota-error", expect.stringContaining("额度已用尽"));
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("quota-error", "FAIL");
    } finally { h.cleanup(); }
  });

  it("keeps truly empty replies pending instead of marking DONE", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      h.openclaw.replies.push("");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "需要回答的问题", messageId: "empty-reply" }));
      const rowId = h.store.getMessageId("empty-reply")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(rowId)).toBe(true);
      expect((h.bot as any).addReaction).not.toHaveBeenCalledWith("empty-reply", "DONE");
      expect(h.store.getChatInfo("chat1")).toBeTruthy();
    } finally { h.cleanup(); }
  });

  it("does not mark queued mid-run messages DONE or synced before processing", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      let releaseFirst!: (value: string) => void;
      (h.openclaw as any).chatSendWithContext = vi.fn((params: any) => {
        h.openclaw.chatCalls.push(params);
        if (h.openclaw.chatCalls.length === 1) {
          return new Promise<string>((resolve) => { releaseFirst = resolve; });
        }
        return Promise.resolve("second reply");
      });

      const first = (h.bot as any).handleMessage(event({ chatType: "group", text: "第一条", messageId: "busy-1" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "第二条", messageId: "busy-2" }));

      const secondRow = h.store.getMessageId("busy-2")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(secondRow)).toBe(true);
      releaseFirst("first reply");
      await first;
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 2, { timeout: 1500 });
      expect(h.openclaw.chatCalls[1].currentMessage).toBe("第二条");
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("busy-2", "Typing");
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("busy-2", "DONE");
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

  it("falls back to sending markdown as a file when Feishu doc creation is unavailable", async () => {
    const h = makeHarness("Claude");
    const dir = mkdtempSync(join(tmpdir(), "olma-md-fallback-"));
    try {
      const filePath = join(dir, "doc.md");
      writeFileSync(filePath, "# hello\n");
      (h.bot as any).validateBridgeAttachmentPath = () => filePath;
      (h.bot as any).sendMessage = vi.fn(async () => {});
      (h.bot as any).client = {
        docx: { document: { create: vi.fn(async () => { throw Object.assign(new Error("Request failed with status code 400"), { response: { data: { code: 99991672, msg: "Access denied" } } }); }) } },
        im: {
          file: { create: vi.fn(async () => ({ data: { file_key: "file-key" } })) },
          message: { create: vi.fn(async () => ({})) },
        },
      };
      await (h.bot as any).sendBridgeAttachment("chat1", { type: "document", path: filePath, caption: "文档" });
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("飞书文档创建失败"));
      expect((h.bot as any).client.im.file.create).toHaveBeenCalled();
      expect((h.bot as any).client.im.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ msg_type: "file" }) }));
    } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("surfaces attachment delivery failures to the triggering message", async () => {
    const h = makeHarness("Claude");
    try {
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => { throw new Error("upload exploded"); });
      await expect((h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-attachment", "", [{ type: "file", path: "/tmp/missing" }], "reply-to", "trigger:attachment")).rejects.toThrow("upload exploded");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-to", expect.stringContaining("附件发送失败"));
    } finally { h.cleanup(); }
  });

  it("strips bridge attachment markers and sends parsed attachments", async () => {
    const h = makeHarness();
    try {
      const attachmentPath = resolve(tmpdir(), "olma-test-attachments", "test.md");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `正文说明\n<LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"document","path":"${attachmentPath}","caption":"文档"}]}</LMA_BRIDGE_ATTACHMENTS>`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "写 md 文档并发给我", messageId: "m1" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "正文说明");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", {
        type: "document",
        path: attachmentPath,
        caption: "文档",
      });
      expect(h.store.getRecent("chat1").some((m) => m.senderType === "bot" && m.content.includes("[Attachment: document"))).toBe(true);
    } finally { h.cleanup(); }
  });
});
