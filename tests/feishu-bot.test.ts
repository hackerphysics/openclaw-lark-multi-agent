import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  patchSession = vi.fn(async (_params?: any) => ({}));
  async injectAssistantMessage(_params: any) { return { ok: true }; }
  async subscribeSession(sessionKey: string, onMessage: (text: string) => void) { this.sessionCallbacks.set(sessionKey, onMessage); }
  onToolEvent() {}
  setVerboseTranscriptDelivery = vi.fn();
  muteProactiveDelivery = vi.fn(() => vi.fn());
  async chatSendWithContext(params: any) {
    this.chatCalls.push(params);
    if (this.replies.length > 0) return this.replies.shift()!;
    return "mock reply";
  }
  async compactSession() { return "ok"; }
  async resetSession() { return "ok"; }
  abortChat = vi.fn(async () => {});
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

function makeHarness(name = "GPT", opts: { configPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "olma-bot-"));
  const store = new MessageStore(join(dir, "messages.db"));
  const openclaw = new MockOpenClaw();
  const config: BotConfig = { name, appId: `app-${name}`, appSecret: "secret", model: `model-${name}` };
  const bot = new FeishuBot(config, openclaw as any, store, undefined, opts.configPath);
  (bot as any).fetchAndCacheChatInfo = async (chatId: string, chatType: string) => {
    store.upsertChatInfo({ chatId, chatType, chatName: chatType, members: "", memberNames: "", ownerBot: chatType === "p2p" ? name : "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: Date.now() });
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



  it("bridge policy includes chairman non-discuss guidance", async () => {
    const h = makeHarness();
    try {
      const policy = (h.bot as any).lmaBridgePolicy();
      expect(policy).toContain("Chairman");
      expect(policy).toContain("非 /discuss 模式");
      expect(policy).toContain("不要总结、主持、调停、质疑或收束其他 bot");
    } finally { h.cleanup(); }
  });

  it("does not treat @all substrings as @all broadcasts", () => {
    const h = makeHarness("GPT");
    try {
      expect((h.bot as any).isAllMention("@allen 你好", [])).toBe(false);
      expect((h.bot as any).isAllMention("foo@all.example.com", [])).toBe(false);
      expect((h.bot as any).isAllMention("请看 @all", [])).toBe(true);
      expect((h.bot as any).isAllMention("@_all 大家", [])).toBe(true);
    } finally { h.cleanup(); }
  });

  it("delivers identical assistant_visible content for different trigger keys", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-1", "同样的回复内容", [], "m1", "trigger:1");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "source-2", "同样的回复内容", [], "m2", "trigger:2");
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(2);
      expect((h.bot as any).replyMessage).toHaveBeenNthCalledWith(1, "m1", "同样的回复内容");
      expect((h.bot as any).replyMessage).toHaveBeenNthCalledWith(2, "m2", "同样的回复内容");
    } finally { h.cleanup(); }
  });

  it("recovers stale delivering outbox rows on startup", async () => {
    const h = makeHarness("GPT");
    try {
      const id = h.store.enqueueDelivery({
        sessionKey: "s1",
        chatId: "chat1",
        botName: "GPT",
        sourceType: "assistant_visible",
        sourceId: "source-stale",
        deliveryKey: "trigger:stale",
        contentHash: "hash-stale",
        content: "stale reply",
        attachmentsJson: "[]",
        replyToMessageId: "m-stale",
      })!;
      expect(h.store.claimDelivery(id)).toBe(true);
      (h.store as any).db.prepare("UPDATE delivery_outbox SET updated_at = ? WHERE id = ?").run(Date.now() - 600_000, id);
      expect(h.store.resetStaleDeliveries("GPT", 5 * 60_000, 5)).toEqual({ restored: 1, failed: 0 });
      await (h.bot as any).dispatchPendingDeliveries("chat1");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m-stale", "stale reply");
    } finally { h.cleanup(); }
  });

  it("cleans up common Feishu markdown escaping artifacts", () => {
    const h = makeHarness("GPT");
    try {
      const cleaned = (h.bot as any).cleanupFeishuMarkdown(String.raw`# 顺顺安全防护清单（居家 \+ 户外）

核心理念：不可能让孩子零磕碰，但可以把\&\#34;严重伤害\&\#34;的概率降到最低。

- 10\-15 分钟
- \*\*有软质地面\*\*`);
      expect(cleaned).toContain("居家 + 户外");
      expect(cleaned).toContain('把"严重伤害"的概率降到最低');
      expect(cleaned).toContain("10-15 分钟");
      expect(cleaned).toContain("**有软质地面**");
    } finally { h.cleanup(); }
  });

  it("hydrates forwarded Feishu docx links into markdown markers before sending to OpenClaw", async () => {
    const h = makeHarness("GPT");
    try {
      (h.bot as any).client = {
        docs: { v1: { content: { get: vi.fn(async () => ({ data: { content: "# 飞书正文\n\n内容" } })) } } },
        docx: { document: { rawContent: vi.fn() } },
      };
      await (h.bot as any).handleMessage(event({ text: "@_all 请读这个 https://example.feishu.cn/docx/DOCXtoken123", messageId: "docx-msg" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      const msg = h.openclaw.chatCalls[0].currentMessage;
      expect(msg).toContain("[飞书文档已由 LMA 用机器人权限读取并转换为 Markdown 附件");
      const path = msg.match(/\[FeishuDoc: [^\]]+ -> ([^\]]+\.md)\]/)?.[1];
      expect(path).toBeTruthy();
      expect(existsSync(path!)).toBe(true);
      expect(readFileSync(path!, "utf8")).toContain("# 飞书正文");
    } finally { h.cleanup(); }
  });

  it("does not prepend per-message chairman routing notes", async () => {
    const chairman = makeHarness("Claude");
    try {
      chairman.store.setChairmanBot("chat1", "Claude");
      chairman.store.setBotMode("Claude", "chat1", "free");
      await (chairman.bot as any).handleMessage(event({ chatType: "group", text: "@_all 各自给一个观点", messageId: "chair-no-per-message-note" }));
      expect(chairman.openclaw.chatCalls).toHaveLength(1);
      expect(chairman.openclaw.chatCalls[0].currentMessage).toBe("@_all 各自给一个观点");
      expect(chairman.openclaw.chatCalls[0].currentMessage).not.toContain("桥接路由说明");
      expect(chairman.openclaw.chatCalls[0].currentMessage).not.toContain("Bridge routing note");
    } finally { chairman.cleanup(); }
  });

  it("injects LMA bridge policy only when creating a new session", async () => {
    const h = makeHarness();
    try {
      delete (h.bot as any).ensureSession;
      h.openclaw.getSessionInfo = vi.fn(async () => null) as any;
      h.openclaw.createSession = vi.fn(async () => ({})) as any;
      h.openclaw.patchSession = vi.fn(async () => ({})) as any;
      h.openclaw.injectAssistantMessage = vi.fn(async () => ({ ok: true })) as any;

      const key = await (h.bot as any).ensureSession("chat1");
      expect(key).toBe("lma-gpt-chat1");
      expect(h.openclaw.injectAssistantMessage).toHaveBeenCalledOnce();
      expect(h.openclaw.injectAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "lma-gpt-chat1",
        label: "LMA bridge policy",
        message: expect.stringContaining("不要调用 message"),
      }));

      await (h.bot as any).ensureSession("chat1");
      expect(h.openclaw.injectAssistantMessage).toHaveBeenCalledOnce();
    } finally { h.cleanup(); }
  });

  it("does not inject LMA bridge policy for existing sessions", async () => {
    const h = makeHarness();
    try {
      delete (h.bot as any).ensureSession;
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 123 } })) as any;
      h.openclaw.injectAssistantMessage = vi.fn(async () => ({ ok: true })) as any;

      await (h.bot as any).ensureSession("chat1");
      expect(h.openclaw.injectAssistantMessage).not.toHaveBeenCalled();
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

  it("strips read-only docx fields from converted blocks", async () => {
    const h = makeHarness("GPT");
    try {
      const cleaned = (h.bot as any).stripReadOnlyDocxFields([{ table: { cells: [{ merge_info: { row_span: 1 }, text: "x" }] }, merge_info: { col_span: 1 } }]);
      expect(cleaned).toEqual([{ table: { cells: [{ text: "x" }] } }]);
    } finally { h.cleanup(); }
  });

  it("hydrates image keys embedded in rich post text into local image paths", async () => {
    const h = makeHarness("GPT");
    try {
      (h.bot as any).downloadResource = vi.fn(async () => "/tmp/lma-image.png");
      const hydrated = await (h.bot as any).hydrateInlineImageKeys("请看 [Image: img_v3_test]", "m-img");
      expect(hydrated).toBe("请看 [Image: /tmp/lma-image.png]");
      expect((h.bot as any).downloadResource).toHaveBeenCalledWith("m-img", "img_v3_test", "image");
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



  it("supports group /locale and English discuss messages", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/locale en", messageId: "locale-en" }));
      expect(h.store.getChatLocale("chat1")).toBe("en");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("locale-en", "🌐 Locale set to en");

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-en-no-chair" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-en-no-chair", expect.stringContaining("You must set a Chairman"));

      h.store.setChairmanBot("chat1", "GPT");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-en" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-en", expect.stringContaining("Discuss enabled"));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-en", expect.stringContaining("Chairman: GPT"));
    } finally { h.cleanup(); }
  });

  it("routes explicitly mentioned group-level commands to the mentioned bot", async () => {
    const coordinator = makeHarness("GPT");
    const target = makeHarness("Claude");
    try {
      (target.bot as any).store = coordinator.store;
      FeishuBot.getAllBots().set("app-GPT", coordinator.bot as any);
      FeishuBot.getAllBots().set("app-Claude", target.bot as any);

      const localeCmd = event({
        chatType: "group",
        text: "/locale en @_user_1",
        messageId: "locale-target-claude",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      });

      await (coordinator.bot as any).handleMessage(localeCmd);
      expect(coordinator.store.getChatLocale("chat1")).toBe("");
      expect((coordinator.bot as any).replyMessage).not.toHaveBeenCalled();

      await (target.bot as any).handleMessage(localeCmd);
      expect(coordinator.store.getChatLocale("chat1")).toBe("en");
      expect((target.bot as any).replyMessage).toHaveBeenCalledWith("locale-target-claude", "🌐 Locale set to en");
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      coordinator.cleanup();
      target.cleanup();
    }
  });

  it("requires a chairman before enabling discuss mode", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-on-no-chair" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(false);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-on-no-chair", expect.stringContaining("必须先设置 Chairman"));

      h.store.setChairmanBot("chat1", "GPT");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-on-with-chair" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(true);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-on-with-chair", expect.stringContaining("Chairman：GPT"));
    } finally { h.cleanup(); }
  });

  it("handles /discuss commands locally", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.setChairmanBot("chat1", "GPT");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss on", messageId: "discuss-on" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(true);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-on", expect.stringContaining("Discuss 已开启"));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("discuss-on", expect.stringContaining("Chairman：GPT"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss rounds 2", messageId: "discuss-rounds" }));
      expect(h.store.getChatInfo("chat1")?.discussMaxRounds).toBe(2);

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/discuss off", messageId: "discuss-off" }));
      expect(h.store.getChatInfo("chat1")?.discuss).toBe(false);
    } finally { h.cleanup(); }
  });

  it("discuss mode ignores free mode and runs all non-muted participants", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      // The production app shares one MessageStore instance across bots.
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      // Neither bot is free; Discuss should still include both because only mute matters.
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

  it("keeps muted chairman in discuss because chairman outranks mute", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setChairmanBot("chat1", "Claude");
      gpt.store.setBotMode("Claude", "chat1", "mute");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 1);

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic-muted" }));
      await vi.waitUntil(() => gpt.openclaw.chatCalls.length === 1 && claude.openclaw.chatCalls.length === 1, { timeout: 1000 });
      expect(gpt.openclaw.chatCalls[0].currentMessage).toContain("多智能体结构化讨论");
      expect(claude.openclaw.chatCalls[0].currentMessage).toContain("你是本群的 Chairman");
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });



  it("notifies when a new discuss topic preempts an active discussion", async () => {
    const h = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-GPT", h.bot as any);
      h.store.setDiscussMode("chat1", true);
      h.store.setDiscussMaxRounds("chat1", 10);
      let releaseFirstRun!: () => void;
      const firstRunBlocked = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        if (h.openclaw.chatCalls.length === 1) await firstRunBlocked;
        return "mock reply";
      });

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "第一个话题", messageId: "topic-1" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      expect((h.bot as any).sendMessage).not.toHaveBeenCalledWith("chat1", expect.stringContaining("已停止上一轮 Discuss"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "第二个话题", messageId: "topic-2" }));
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("已停止上一轮 Discuss 并开启新讨论"));
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("第一个话题"));
      releaseFirstRun();
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      h.cleanup();
    }
  });

  it("does not let coordinator steal targeted /discuss commands", async () => {
    const gpt = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", { config: { appId: "app-Claude", name: "Claude" }, store: gpt.store, botOpenId: "claude-open-id" } as any);
      gpt.store.setDiscussMaxRounds("chat1", 5);

      await (gpt.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（Claude） /discuss rounds 10",
        messageId: "targeted-discuss-command",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect((gpt.bot as any).replyMessage).not.toHaveBeenCalled();
      expect(gpt.store.getChatInfo("chat1")?.discussMaxRounds).toBe(5);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
    }
  });


  it("strips chairman control markers after a preface", async () => {
    const h = makeHarness("Claude");
    try {
      h.openclaw.replies.push("我认为可以收尾。\n\nFINAL_SUMMARY:\n最终结论");
      const result = await (h.bot as any).runDiscussionTurn("chat1", "prompt", { round: 1, maxRounds: 10 });
      expect(result.text).toContain("FINAL_SUMMARY");
      expect(result.visible).toBe(true);
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("我认为可以收尾。"));
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("最终结论"));
      expect((h.bot as any).sendMessage.mock.calls.some((call: any[]) => String(call[1]).includes("FINAL_SUMMARY"))).toBe(false);
    } finally { h.cleanup(); }
  });

  it("turns discuss off when chairman finalizes", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setBotMode("GPT", "chat1", "free");
      gpt.store.setChairmanBot("chat1", "Claude");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 2);
      gpt.openclaw.replies.push("NO_REPLY");
      claude.openclaw.replies.push("FINAL_SUMMARY: 最终结论");

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic-final" }));
      await vi.waitUntil(() => gpt.store.getChatInfo("chat1")?.discuss === false, { timeout: 1000 });

      expect(gpt.store.getChatInfo("chat1")?.discuss).toBe(false);
      expect((gpt.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("已自动关闭 Discuss 模式"));
      expect((claude.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("最终结论"));
      expect((claude.bot as any).sendMessage.mock.calls.some((call: any[]) => String(call[1]).includes("FINAL_SUMMARY"))).toBe(false);
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

  it("/stop force-clears a stuck run: aborts, unlocks busy, and clears pending", async () => {
    const h = makeHarness();
    try {
      // Simulate a stuck run: busy lock set + queued pending triggers.
      const r1 = h.store.insert({ chatId: "chat1", messageId: "stuck-1", senderType: "human", senderName: "u", content: "q1", timestamp: 1 });
      const r2 = h.store.insert({ chatId: "chat1", messageId: "stuck-2", senderType: "human", senderName: "u", content: "q2", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", r1);
      h.store.markPendingTrigger("GPT", "chat1", r2);
      (h.bot as any).busyChats.set("chat1", Date.now());
      (h.bot as any).pendingAckMessages.set("chat1", [{ messageId: "stuck-1", emoji: "Typing", rowId: r1 }]);

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@万万（GPT） /stop", messageId: "cmd-stop", mentions: [{ name: "万万（GPT）", id: { app_id: "app-GPT" } }] }));

      // Aborted the active run.
      expect(h.openclaw.abortChat).toHaveBeenCalled();
      // Busy lock cleared.
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
      // Every pending trigger cleared.
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      // Stuck reactions cleared.
      expect((h.bot as any).pendingAckMessages.get("chat1")).toEqual([]);
      // User got a confirmation.
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("cmd-stop", expect.stringContaining("已停止"));
    } finally { h.cleanup(); }
  });



  it("recognizes parenthesized bot display names from other deployments", async () => {
    const coordinator = makeHarness("GPT");
    const target = makeHarness("Claude");
    try {
      (target.bot as any).store = coordinator.store;
      FeishuBot.getAllBots().set("app-GPT", coordinator.bot as any);
      FeishuBot.getAllBots().set("app-Claude", target.bot as any);

      const cmd = event({
        chatType: "group",
        text: "/chairman @光子 (Claude)",
        messageId: "chair-photon-claude",
        mentions: [{ name: "光子 (Claude)", id: {} }],
      });
      await (coordinator.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBeFalsy();

      await (target.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBe("Claude");
      expect((target.bot as any).replyMessage).toHaveBeenCalledWith("chair-photon-claude", expect.stringContaining("Chairman 已设置为 Claude"));
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      coordinator.cleanup();
      target.cleanup();
    }
  });

  it("lets the targeted bot handle /chairman @Bot and set itself as chairman", async () => {
    const coordinator = makeHarness("GPT");
    const target = makeHarness("Claude");
    try {
      (target.bot as any).store = coordinator.store;
      FeishuBot.getAllBots().set("app-GPT", coordinator.bot as any);
      FeishuBot.getAllBots().set("app-Claude", target.bot as any);

      const cmd = event({
        chatType: "group",
        text: "/chairman @_user_1",
        messageId: "chair-targeted-claude",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      });

      await (coordinator.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBeFalsy();
      expect((coordinator.bot as any).replyMessage).not.toHaveBeenCalled();

      await (target.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBe("Claude");
      expect((target.bot as any).replyMessage).toHaveBeenCalledWith("chair-targeted-claude", expect.stringContaining("Chairman 已设置为 Claude"));
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      coordinator.cleanup();
      target.cleanup();
    }
  });

  it("falls back to explicit text names for /chairman when mention metadata is unavailable", async () => {
    const coordinator = makeHarness("GPT");
    const target = makeHarness("Claude");
    try {
      (target.bot as any).store = coordinator.store;
      FeishuBot.getAllBots().set("app-GPT", coordinator.bot as any);
      FeishuBot.getAllBots().set("app-Claude", target.bot as any);

      const cmd = event({
        chatType: "group",
        text: "/chairman Claude",
        messageId: "chair-text-claude",
        mentions: [],
      });

      // Coordinator (GPT) must not claim a target resolved purely from text
      // that points at another bot; the targeted bot owns it.
      await (coordinator.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBeFalsy();
      expect((coordinator.bot as any).replyMessage).not.toHaveBeenCalled();

      // The targeted bot resolves itself from the text fallback and sets it.
      await (target.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBe("Claude");
      expect((target.bot as any).replyMessage).toHaveBeenCalledWith("chair-text-claude", expect.stringContaining("Chairman 已设置为 Claude"));
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      coordinator.cleanup();
      target.cleanup();
    }
  });

  it("gives an actionable bot list when /chairman target cannot be resolved at all", async () => {
    const coordinator = makeHarness("GPT");
    const target = makeHarness("Claude");
    try {
      (target.bot as any).store = coordinator.store;
      FeishuBot.getAllBots().set("app-GPT", coordinator.bot as any);
      FeishuBot.getAllBots().set("app-Claude", target.bot as any);

      // Worst case: the user @-ed a bot but the client sent no mention metadata
      // and the placeholder left no readable name in the text.
      const cmd = event({
        chatType: "group",
        text: "/chairman",
        messageId: "chair-noresolve",
        mentions: [],
      });

      await (target.bot as any).handleMessage(cmd);
      // Non-coordinator stays silent; no chairman set from an unresolved target.
      expect(coordinator.store.getChairmanBot("chat1")).toBeFalsy();
      expect((target.bot as any).replyMessage).not.toHaveBeenCalled();

      await (coordinator.bot as any).handleMessage(cmd);
      expect(coordinator.store.getChairmanBot("chat1")).toBeFalsy();
      const reply = (coordinator.bot as any).replyMessage.mock.calls.at(-1)?.[1] || "";
      expect(reply).toContain("/chairman 只用于设置/切换 Chairman");
      expect(reply).toContain("/status");
      expect(reply).toContain("/chairman GPT");
      expect(reply).toContain("/chairman Claude");
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      coordinator.cleanup();
      target.cleanup();
    }
  });

  it("does not use bare /chairman as status or implicit single-bot setup", async () => {
    const h = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-GPT", h.bot as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "/chairman",
        messageId: "chair-single",
        mentions: [],
      }));

      expect(h.store.getChairmanBot("chat1")).toBeFalsy();
      const reply = (h.bot as any).replyMessage.mock.calls.at(-1)?.[1] || "";
      expect(reply).toContain("/chairman 只用于设置/切换 Chairman");
      expect(reply).toContain("/status");
      expect(reply).toContain("/chairman GPT");
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      h.cleanup();
    }
  });

  it("sets a unique chairman and rejects multiple chairman mentions", async () => {
    const h = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-GPT", h.bot as any);
      FeishuBot.getAllBots().set("app-Claude", { config: { appId: "app-Claude", name: "Claude" }, store: h.store, botOpenId: "claude-open-id" } as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "/chairman @万万（GPT）",
        messageId: "chair-gpt",
        mentions: [{ name: "万万（GPT）", id: { app_id: "app-GPT", open_id: "gpt-open-id" } }],
      }));
      expect(h.store.getChairmanBot("chat1")).toBe("GPT");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("chair-gpt", expect.stringContaining("Chairman 已设置为 GPT"));

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "/chairman @万万（GPT） @万万（Claude）",
        messageId: "chair-two",
        mentions: [
          { name: "万万（GPT）", id: { app_id: "app-GPT", open_id: "gpt-open-id" } },
          { name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } },
        ],
      }));
      expect(h.store.getChairmanBot("chat1")).toBe("GPT");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("chair-two", expect.stringContaining("只能设置一个 Chairman"));
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("lets muted chairman answer plain messages when no free bot exists", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setChairmanBot("chat1", "Claude");
      gpt.store.setBotMode("Claude", "chat1", "mute");

      await (claude.bot as any).handleMessage(event({ chatType: "group", text: "无人被@的普通消息", messageId: "plain-muted-chairman" }));

      expect(claude.openclaw.chatCalls).toHaveLength(1);
      expect(claude.openclaw.chatCalls[0].currentMessage).toBe("无人被@的普通消息");
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });

  it("lets chairman answer plain messages only when no free bot exists", async () => {
    const chairman = makeHarness("Claude");
    const free = makeHarness("GPT");
    try {
      (free.bot as any).store = chairman.store;
      FeishuBot.getAllBots().set("app-Claude", chairman.bot as any);
      FeishuBot.getAllBots().set("app-GPT", free.bot as any);
      chairman.store.setChairmanBot("chat1", "Claude");

      await (chairman.bot as any).handleMessage(event({ chatType: "group", text: "plain", messageId: "plain-1" }));
      expect(chairman.openclaw.chatCalls).toHaveLength(1);

      chairman.openclaw.chatCalls = [];
      chairman.store.setBotMode("GPT", "chat1", "free");
      await (chairman.bot as any).handleMessage(event({ chatType: "group", text: "plain again", messageId: "plain-2" }));
      expect(chairman.openclaw.chatCalls).toHaveLength(0);
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      FeishuBot.getAllBots().delete("app-GPT");
      chairman.cleanup();
      free.cleanup();
    }
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


  it("supports idempotent explicit /free on and /free off", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free on", messageId: "free-explicit-on-1" }));
      expect(h.store.getBotMode("GPT", "chat1")).toBe("free");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free on", messageId: "free-explicit-on-2" }));
      expect(h.store.getBotMode("GPT", "chat1")).toBe("free");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free off", messageId: "free-explicit-off-1" }));
      expect(h.store.getBotMode("GPT", "chat1")).toBe("normal");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /free off", messageId: "free-explicit-off-2" }));
      expect(h.store.getBotMode("GPT", "chat1")).toBe("normal");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("free-explicit-off-1", expect.stringContaining("normal 模式"));
    } finally { h.cleanup(); }
  });


  it("does not let free chairman or coordinator steal a targeted bot mention", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setBotMode("GPT", "chat1", "free");
      gpt.store.setChairmanBot("chat1", "GPT");

      await (gpt.bot as any).handleMessage(event({
        chatType: "group",
        text: "@万万（Claude） ping",
        messageId: "target-claude-no-steal",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect(gpt.openclaw.chatCalls).toHaveLength(0);
      expect(gpt.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });


  it("lets all free bots answer plain messages when discuss is off", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      gpt.store.setBotMode("GPT", "chat1", "free");
      gpt.store.setBotMode("Claude", "chat1", "free");

      const msg = event({ chatType: "group", text: "plain question", messageId: "plain-free-all" });
      await (gpt.bot as any).handleMessage(msg);
      await (claude.bot as any).handleMessage(msg);

      expect(gpt.openclaw.chatCalls).toHaveLength(1);
      expect(claude.openclaw.chatCalls).toHaveLength(1);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });

  it("routes @all to all non-muted bots when discuss is off", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);

      const msg = event({ chatType: "group", text: "@_all hello", messageId: "all-normal" });
      await (gpt.bot as any).handleMessage(msg);
      await (claude.bot as any).handleMessage(msg);

      expect(gpt.openclaw.chatCalls).toHaveLength(1);
      expect(claude.openclaw.chatCalls).toHaveLength(1);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      gpt.cleanup();
      claude.cleanup();
    }
  });

  it("does not silently swallow discuss messages when no participants exist", async () => {
    const gpt = makeHarness("GPT");
    try {
      gpt.store.setDiscussMode("chat1", true);
      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "plain topic", messageId: "discuss-empty" }));
      expect((gpt.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("没有可参与者"));
    } finally { gpt.cleanup(); }
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

  it("toggles live status per bot per chat and reports it in status", async () => {
    const h = makeHarness("Claude");
    try {
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/livestatus off", messageId: "live-off" }));
      expect(h.store.getBotLiveStatus("Claude", "chat1")).toBe(false);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-off", expect.stringContaining("Live Status 已关闭"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/status", messageId: "live-status" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-status", expect.stringContaining("📡 Live Status: 📴 关闭"));

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/livestatus on", messageId: "live-on" }));
      expect(h.store.getBotLiveStatus("Claude", "chat1")).toBe(true);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-on", expect.stringContaining("Live Status 已开启"));
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("does not create live status when /livestatus is off", async () => {
    const h = makeHarness("Claude");
    try {
      h.store.setBotLiveStatus("Claude", "chat1", false);
      (h.bot as any).replyTextMessage = vi.fn(async () => "live-status-msg");
      (h.bot as any).editTextMessage = vi.fn(async () => {});
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        await params.onSubmitted?.("run-live-off");
        await params.onProgress?.({ kind: "tool", phase: "start", name: "read", text: "读取文件" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return "最终回复";
      });
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "看一下代码",
        messageId: "live-off-trigger",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect((h.bot as any).replyTextMessage).not.toHaveBeenCalled();
      expect((h.bot as any).editTextMessage).not.toHaveBeenCalled();
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-off-trigger", "最终回复");
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
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

  it("shows chairman status in /status", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.setChairmanBot("chat1", "GPT");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /status", messageId: "status-chair" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("status-chair", expect.stringContaining("👑 Chairman: 👑 是（GPT）"));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("status-chair", expect.stringContaining("🌐 Locale: zh"));
    } finally { h.cleanup(); }
  });


  it("shows group locale in /status when set to English", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.setChatLocale("chat1", "en");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /status", messageId: "status-locale-en" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("status-locale-en", expect.stringContaining("🌐 Locale: en"));
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
      h.store.upsertChatInfo({ chatId: "chat-a", chatType: "group", chatName: "A", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: 1 });
      h.store.upsertChatInfo({ chatId: "chat-b", chatType: "group", chatName: "B", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: 2 });
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


  it("merges consecutive plain human triggers into a single run", async () => {
    const h = makeHarness("GPT");
    try {
      const first = h.store.insert({ chatId: "chat1", messageId: "first-trigger", senderType: "human", senderName: "u", content: "第一条", timestamp: 1 });
      const second = h.store.insert({ chatId: "chat1", messageId: "second-trigger", senderType: "human", senderName: "u", content: "第二条", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", first);
      h.store.markPendingTrigger("GPT", "chat1", second);
      await (h.bot as any).processQueue("chat1");
      // Two consecutive plain messages are delivered together as one run.
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("第一条\n第二条");
      // Neither merged trigger leaks into catch-up context.
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content)).not.toContain("第一条");
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content)).not.toContain("第二条");
      // Both pending triggers are cleared.
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("does not inject pending native commands as catch-up context", async () => {
    const h = makeHarness("GPT");
    try {
      const native = h.store.insert({ chatId: "chat1", messageId: "native-trigger", senderType: "human", senderName: "u", content: "/status", timestamp: 1, triggerKind: "native_command" });
      const normal = h.store.insert({ chatId: "chat1", messageId: "normal-trigger", senderType: "human", senderName: "u", content: "正常问题", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", native);
      h.store.markPendingTrigger("GPT", "chat1", normal);
      await (h.bot as any).processQueue("chat1");
      expect(h.openclaw.chatCalls).toHaveLength(2);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("/status");
      expect(h.openclaw.chatCalls[0].includeContext).toBe(false);
      expect(h.openclaw.chatCalls[1].currentMessage).toBe("正常问题");
      expect(h.openclaw.chatCalls[1].unsyncedMessages.map((m: any) => m.content)).not.toContain("/status");
    } finally { h.cleanup(); }
  });

  it("filters bridge commands and LMA control replies out of catch-up context", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.insert({ chatId: "chat1", messageId: "old-status", senderType: "human", senderName: "u", content: "/status", timestamp: 1, triggerKind: "bridge_command" });
      h.store.insert({ chatId: "chat1", messageId: "old-stop", senderType: "human", senderName: "u", content: "/stop", timestamp: 2, triggerKind: "bridge_command" });
      h.store.insert({ chatId: "chat1", messageId: "old-reset-reply", senderType: "bot", senderName: "Claude", content: "✅ Session reset.", timestamp: 3, triggerKind: "bridge_control_reply" });
      h.store.insert({ chatId: "chat1", messageId: "old-models", senderType: "bot", senderName: "Claude", content: "Models (phgeek-gw · showing 1-20)\nSwitch: /model <provider/model>", timestamp: 4, triggerKind: "bridge_control_reply" });
      h.store.insert({ chatId: "chat1", messageId: "old-normal", senderType: "human", senderName: "u", content: "你好", timestamp: 5 });
      h.store.insert({ chatId: "chat1", messageId: "old-normal-check", senderType: "bot", senderName: "Claude", content: "✅ 赞同，这个方案可以继续。", timestamp: 6 });
      const current = h.store.insert({ chatId: "chat1", messageId: "current-review", senderType: "human", senderName: "u", content: "review当前代码改动", timestamp: 7 });
      h.store.markPendingTrigger("GPT", "chat1", current);
      await (h.bot as any).processQueue("chat1");
      expect(h.openclaw.chatCalls).toHaveLength(1);
      const ctx = h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content);
      expect(ctx).toContain("你好");
      expect(ctx).toContain("✅ 赞同，这个方案可以继续。");
      expect(ctx).not.toContain("/status");
      expect(ctx).not.toContain("/stop");
      expect(ctx).not.toContain("✅ Session reset.");
      expect(ctx.join("\n")).not.toContain("Switch: /model");
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("review当前代码改动");
    } finally { h.cleanup(); }
  });

  it("marks incoming bridge commands and control replies with non-normal trigger kinds", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "@_all /status", messageId: "status-kind" }));
      await (h.bot as any).handleMessage(event({ chatType: "group", senderType: "app", senderName: "Claude", text: "✅ Session reset.", messageId: "reset-kind" }));
      const statusRow = h.store.getMessageByMessageId("status-kind");
      const resetRow = h.store.getMessageByMessageId("reset-kind");
      expect(statusRow?.triggerKind).toBe("bridge_command");
      expect(resetRow?.triggerKind).toBe("bridge_control_reply");
    } finally { h.cleanup(); }
  });

  it("includes other bot replies in catch-up for a later targeted bot run", async () => {
    const h = makeHarness("Claude");
    try {
      h.store.insert({ chatId: "chat1", messageId: "human-before", senderType: "human", senderName: "u", content: "请 GPT review", timestamp: 1 });
      const gptReply = h.store.insert({ chatId: "chat1", messageId: "self-GPT-review", senderType: "bot", senderName: "GPT", content: "GPT 的 review 结论", timestamp: 2 });
      const current = h.store.insert({ chatId: "chat1", messageId: "ask-claude", senderType: "human", senderName: "u", content: "Claude 你看一下 GPT 的 review", timestamp: 3 });
      h.store.markMessagesSynced("Claude", "chat1", [1], "older-context-already-seen");
      h.store.markPendingTrigger("Claude", "chat1", current);

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("Claude 你看一下 GPT 的 review");
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.id)).toContain(gptReply);
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content)).toContain("GPT 的 review 结论");
    } finally { h.cleanup(); }
  });

  it("includes other bot replies stored after the trigger row but excludes later human messages", async () => {
    const h = makeHarness("Claude");
    try {
      const current = h.store.insert({ chatId: "chat1", messageId: "ask-claude", senderType: "human", senderName: "u", content: "Claude 你看一下", timestamp: 1 });
      const lateBotReply = h.store.insert({ chatId: "chat1", messageId: "self-GPT-late", senderType: "bot", senderName: "GPT", content: "GPT 刚发出的可见回复", timestamp: 2 });
      const laterHuman = h.store.insert({ chatId: "chat1", messageId: "later-human", senderType: "human", senderName: "u", content: "下一条人类消息", timestamp: 3 });
      h.store.markPendingTrigger("Claude", "chat1", current);

      await (h.bot as any).processQueue("chat1");

      const ids = h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.id);
      expect(ids).toContain(lateBotReply);
      expect(ids).not.toContain(laterHuman);
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.content)).toContain("GPT 刚发出的可见回复");
    } finally { h.cleanup(); }
  });

  it("marks catch-up context synced once submitted even if the run later returns empty", async () => {
    const h = makeHarness("GPT");
    try {
      const contextId = h.store.insert({ chatId: "chat1", messageId: "old-context", senderType: "human", senderName: "u", content: "旧历史，不应重复投递", timestamp: 1 });
      const currentId = h.store.insert({ chatId: "chat1", messageId: "current-empty", senderType: "human", senderName: "u", content: "当前问题", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", currentId);
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSubmitted?.("run-accepted");
        return "";
      });

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].unsyncedMessages.map((m: any) => m.id)).toContain(contextId);
      expect(h.store.getUnsyncedMessagesForBot("GPT", "chat1", currentId).map((m) => m.id)).not.toContain(contextId);
      expect(h.store.getUnsyncedMessagesForBot("GPT", "chat1", currentId).map((m) => m.id)).not.toContain(currentId);
      expect(h.store.getPendingTriggerIds("GPT", "chat1")).not.toContain(currentId);
    } finally { h.cleanup(); }
  });

  it("does not replay attempted merged triggers even if chat.send RPC throws", async () => {
    const h = makeHarness("GPT");
    try {
      const first = h.store.insert({ chatId: "chat1", messageId: "first-rpc", senderType: "human", senderName: "u", content: "第一条", timestamp: 1 });
      const second = h.store.insert({ chatId: "chat1", messageId: "second-rpc", senderType: "human", senderName: "u", content: "第二条", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", first);
      h.store.markPendingTrigger("GPT", "chat1", second);
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        throw new Error("lost rpc response after send attempt");
      });

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      const unsynced = h.store.getUnsyncedMessagesForBot("GPT", "chat1", second).map((m) => m.id);
      expect(unsynced).not.toContain(first);
      expect(unsynced).not.toContain(second);
    } finally { h.cleanup(); }
  });

  it("does not replay any merged trigger after accepted empty runs", async () => {
    const h = makeHarness("GPT");
    try {
      const first = h.store.insert({ chatId: "chat1", messageId: "first", senderType: "human", senderName: "u", content: "第一条", timestamp: 1 });
      const second = h.store.insert({ chatId: "chat1", messageId: "second", senderType: "human", senderName: "u", content: "第二条", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", first);
      h.store.markPendingTrigger("GPT", "chat1", second);
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSubmitted?.("run-accepted");
        return "";
      });

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      expect(h.store.getUnsyncedMessagesForBot("GPT", "chat1", second).map((m) => m.id)).not.toContain(first);
      expect(h.store.getUnsyncedMessagesForBot("GPT", "chat1", second).map((m) => m.id)).not.toContain(second);
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


  it("passes double-slash native commands without catch-up context or attachment hint", async () => {
    const h = makeHarness();
    try {
      const oldRow = h.store.insert({
        chatId: "chat1",
        messageId: "old-file-request",
        senderType: "human",
        senderName: "u",
        content: "之前请发一个图片文件",
        timestamp: 1,
      });
      // Old message remains unsynced context, but //status must bypass context/hints.
      expect(oldRow).toBeGreaterThan(0);
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "//status", messageId: "native-status-no-context" }));
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("/status");
      expect(h.openclaw.chatCalls[0].unsyncedMessages).toEqual([]);
      expect(h.openclaw.chatCalls[0].includeContext).toBe(false);
      expect(h.openclaw.chatCalls[0].includeBridgeAttachmentHint).toBe(false);
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

  it("keeps verbose transcript dedupe isolated from final trigger delivery", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "verbose_transcript", "verbose-a", "我已经完成了主要分析，结论是可以合并。", []);
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "final-a", "我已经完成了主要分析，结论是可以合并。", [], "reply-1", "trigger:1");
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-1", "我已经完成了主要分析，结论是可以合并。");
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

  it("does not replay accepted truly empty replies", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      h.openclaw.replies.push("");
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "需要回答的问题", messageId: "empty-reply" }));
      const rowId = h.store.getMessageId("empty-reply")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(rowId)).toBe(false);
      expect(h.store.getUnsyncedMessagesForBot("GLM", "chat1", rowId).map((m) => m.id)).not.toContain(rowId);
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("empty-reply", "DONE");
      expect(h.store.getChatInfo("chat1")).toBeTruthy();
    } finally { h.cleanup(); }
  });

  it("uses a live status message in non-verbose mode and finishes it after the final reply", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyTextMessage = vi.fn(async () => "live-status-msg");
      (h.bot as any).editTextMessage = vi.fn(async () => {});
      (h.bot as any).deleteMessageById = vi.fn(async () => {});
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        await params.onSubmitted?.("run-live");
        await params.onProgress?.({ kind: "tool", phase: "start", name: "read", text: "读取 src/feishu-bot.ts" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return "最终回复";
      });
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "看一下代码",
        messageId: "live-trigger",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      await run;

      // Live status placeholder is created as a separate message with a
      // progress bar + edit count + elapsed timer + detail.
      expect((h.bot as any).replyTextMessage).toHaveBeenCalledWith("live-trigger", expect.stringContaining("Claude"));
      const placeholderText = (h.bot as any).replyTextMessage.mock.calls[0][1];
      expect(placeholderText).toMatch(/[\u2B1C]|\uD83D[\uDFE9\uDFE8\uDFE5]/); // colored progress bar cells
      expect(placeholderText).toMatch(/\d+\/20/); // edit budget count
      expect(placeholderText).toMatch(/\d+:\d{2}/); // elapsed mm:ss
      // ...the final reply goes through the normal interactive-card path (renders Markdown)...
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-trigger", "最终回复");
      // ...and the live status message is deleted (not overwritten with the answer).
      expect((h.bot as any).deleteMessageById).toHaveBeenCalledWith("live-status-msg");
      expect((h.bot as any).editTextMessage).not.toHaveBeenCalledWith("live-status-msg", "最终回复");
      expect(h.store.hasDeliveredReply("Claude", "chat1", 1)).toBe(true);
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("does not create live status for fast replies", async () => {
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyTextMessage = vi.fn(async () => "live-status-msg");
      (h.bot as any).editTextMessage = vi.fn(async () => {});
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        await params.onSubmitted?.("run-fast");
        return "快速回复";
      });
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "快速问题",
        messageId: "fast-trigger",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect((h.bot as any).replyTextMessage).not.toHaveBeenCalled();
      expect((h.bot as any).editTextMessage).not.toHaveBeenCalled();
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("fast-trigger", "快速回复");
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("reports killed sessions immediately instead of queueing behind a dead run", async () => {
    const h = makeHarness("Claude");
    try {
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: "killed" } }));
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "你在吗",
        messageId: "killed-session-msg",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("killed-session-msg", "FAIL");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("killed-session-msg", expect.stringContaining("session 状态异常（killed）"));
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("monitors active runs and reports when the session becomes killed while waiting", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyTextMessage = vi.fn(async () => "live-killed-msg");
      (h.bot as any).editTextMessage = vi.fn(async () => {});
      (h.bot as any).deleteMessageById = vi.fn(async () => {});
      const sessionStatuses = ["active", "active", "killed"];
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: sessionStatuses.shift() || "killed" } }));
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onSendAttempt?.();
        await new Promise(() => {});
        return "never";
      });
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "等回复中途挂掉",
        messageId: "killed-mid-run",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.openclaw.chatCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(800);
      expect((h.bot as any).replyTextMessage).toHaveBeenCalledWith("killed-mid-run", expect.stringContaining("等待 OpenClaw 回复"));
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(h.openclaw.abortChat).toHaveBeenCalled();
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("killed-mid-run", "FAIL");
      // recoverFromUnhealthySession replies the error via the normal path...
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("killed-mid-run", expect.stringContaining("session 状态异常（killed）"));
      // ...and the live status placeholder is deleted (not overwritten with the error).
      expect((h.bot as any).deleteMessageById).toHaveBeenCalledWith("live-killed-msg");
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("reports killed sessions during queue drain and clears existing waiting reactions", async () => {
    const h = makeHarness("Claude");
    try {
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: "active | killed" } }));
      const id = h.store.insert({ chatId: "chat1", messageId: "pending-killed", senderType: "human", senderName: "u", content: "pending", timestamp: 1 });
      h.store.markPendingTrigger("Claude", "chat1", id);
      (h.bot as any).pendingAckMessages.set("chat1", [{ messageId: "pending-killed", emoji: "Typing", rowId: id }]);
      (h.bot as any).busyChats.set("chat1", Date.now());

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).removeReaction).toHaveBeenCalledWith("pending-killed", "Typing");
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("pending-killed", "FAIL");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("pending-killed", expect.stringContaining("active | killed"));
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
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

  it("drops stale delivered triggers inside a merged batch but keeps newer pending triggers", async () => {
    const h = makeHarness();
    try {
      const oldId = h.store.insert({ chatId: "chat1", messageId: "old", senderType: "human", senderName: "u", content: "old delivered", timestamp: 1 });
      const newId = h.store.insert({ chatId: "chat1", messageId: "new", senderType: "human", senderName: "u", content: "new pending", timestamp: 2 });
      h.store.markPendingTrigger("GPT", "chat1", oldId);
      h.store.markPendingTrigger("GPT", "chat1", newId);
      h.store.markDeliveredReply("GPT", "chat1", oldId, "old");

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.openclaw.chatCalls[0].currentMessage).toBe("new pending");
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
      expect(h.store.hasDeliveredReply("GPT", "chat1", oldId)).toBe(true);
      expect(h.store.hasDeliveredReply("GPT", "chat1", newId)).toBe(true);
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

  it("does not send placeholder attachment failure as a separate user-visible provider error", async () => {
    const h = makeHarness();
    try {
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `示例：\nMEDIA:/some/real/file.png`;
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "review 下", messageId: "m1" }));
      const allReplies = (h.bot as any).replyMessage.mock.calls.map((call: any[]) => call[1]);
      expect(allReplies.filter((text: string) => text.includes("附件发送失败"))).toHaveLength(1);
      expect(allReplies.some((text: string) => text.includes("这次没有完成回复"))).toBe(false);
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally { h.cleanup(); }
  });

  it("rejects nonexistent attachment paths", async () => {
    const h = makeHarness();
    try {
      expect(() => (h.bot as any).validateBridgeAttachmentPath("/real/path/image.png")).toThrow(/not found/i);
      expect(() => (h.bot as any).validateBridgeAttachmentPath("/absolute/path.png")).toThrow(/not found/i);
    } finally { h.cleanup(); }
  });

  it("converts MEDIA directives into bridge attachments instead of leaving path text", async () => {
    const h = makeHarness();
    try {
      const imagePath = resolve(tmpdir(), "olma-test-media", "avatar.png");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `已经画好了\n\nMEDIA:${imagePath}\n\n1024×1024 正方形。`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "发图", messageId: "m1" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("已经画好了"));
      expect((h.bot as any).replyMessage.mock.calls[0][1]).toContain("1024×1024 正方形。");
      expect((h.bot as any).replyMessage.mock.calls[0][1]).not.toContain("MEDIA:");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", {
        type: "image",
        path: imagePath,
      });
      expect(h.store.getRecent("chat1").some((m) => m.senderType === "bot" && m.content.includes("MEDIA:"))).toBe(false);
      expect(h.store.getRecent("chat1").some((m) => m.senderType === "bot" && m.content.includes("[Attachment: image"))).toBe(true);
    } finally { h.cleanup(); }
  });
});
