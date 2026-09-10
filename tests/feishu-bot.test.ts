import { afterEach, describe, expect, it, vi } from "vitest";
// Auto-retry is on by default in production; turn it off for the general suite so
// the plain mock replies (no trailing punctuation) do not trigger probe rounds.
// The dedicated auto-retry describe block enables it per-case.
process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "0";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FeishuBot } from "../src/feishu-bot.js";
import { SessionWaitPaused, normalizeSessionRuntimeStatus } from "../src/session-status.js";
import { InactiveRunObservation } from "../src/openclaw-client.js";
import { MessageStore } from "../src/message-store.js";
import type { BotConfig } from "../src/config.js";

class MockOpenClaw {
  chatCalls: any[] = [];
  replies: string[] = [];
  resolvers: Array<(value: string) => void> = [];
  sessionCallbacks = new Map<string, (text: string, meta?: { sourceType?: string; runId?: string }) => void>();
  async getSessionInfo() { return { session: { totalTokens: 0 } }; }
  async ensureModel() { return false; }
  async createSession() {}
  patchSession = vi.fn(async (_params?: any) => ({}));
  async injectAssistantMessage(_params: any) { return { ok: true }; }
  async subscribeSession(sessionKey: string, onMessage: (text: string, meta?: { sourceType?: string; runId?: string }) => void) { this.sessionCallbacks.set(sessionKey, onMessage); }
  onToolEvent() {}
  setVerboseTranscriptDelivery = vi.fn();
  muteProactiveDelivery = vi.fn(() => vi.fn());
  async chatSendWithContext(params: any) {
    this.chatCalls.push(params);
    if (this.replies.length > 0) return this.replies.shift()!;
    return "mock reply";
  }
  compactSession = vi.fn(async () => ({ ok: true, compacted: true }));
  async resetSession() { return "ok"; }
  abortChat = vi.fn(async () => {});
  // Plugin steer stub: `steered` means queued into the existing active run.
  // Override with unavailable to test safe normal-queue fallback.
  steer = vi.fn(async (_sessionKey: string, _text: string) => ({ status: "steered" as const }));
  // Consumed callbacks registered by the bridge; tests call fireSteerConsumed to
  // simulate the model actually consuming a steered message.
  steerConsumedCbs: Array<(text: string) => boolean | void> = [];
  onSteerConsumed = vi.fn((_sessionKey: string, _matchText: string, cb: (text: string) => boolean | void) => {
    this.steerConsumedCbs.push(cb);
    return () => { this.steerConsumedCbs = this.steerConsumedCbs.filter((candidate) => candidate !== cb); };
  });
  fireSteerConsumed(text: string) { for (const cb of this.steerConsumedCbs) cb(text); }
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
  (bot as any).sendLiveStatusCard = vi.fn(async () => "live-status-msg");
  (bot as any).replyLiveStatusCard = vi.fn(async () => "live-status-msg");
  (bot as any).patchLiveStatusCard = vi.fn(async () => {});
  (bot as any).patchLiveStatusDoneSummary = vi.fn(async () => {});
  return { bot, store, openclaw, cleanup: () => {
    for (const timer of (bot as any).deliveryRetryTimers.values()) clearTimeout(timer);
    (bot as any).deliveryRetryTimers.clear();
    for (const target of (bot as any).deliveryTargetsByRun.values()) if (target.timer) clearTimeout(target.timer);
    (bot as any).deliveryTargetsByRun.clear();
    for (const cleanup of (bot as any).pendingSteerCleanups.values()) cleanup();
    (bot as any).pendingSteerCleanups.clear();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

function markBotSeen(botName: string, chatId = "chat1") {
  const seen = (FeishuBot as any).seenBotChats as Map<string, Set<string>>;
  let set = seen.get(botName);
  if (!set) {
    set = new Set<string>();
    seen.set(botName, set);
  }
  set.add(chatId);
}

afterEach(() => {
  vi.useRealTimers();
  FeishuBot.getAllBots().clear();
  ((FeishuBot as any).seenBotChats as Map<string, Set<string>> | undefined)?.clear();
});

describe("FeishuBot routing and queue behavior", () => {
  it("adds current session status after model without changing stored answer or model metadata", async () => {
    const h = makeHarness("GPT");
    try {
      (h.openclaw as any).getSessionRuntimeStatus = vi.fn(async () => normalizeSessionRuntimeStatus({session: { status: "running", totalTokens: 84501, contextTokens: 200000, totalTokensFresh: true }}));
      const footers: string[] = [];
      (h.bot as any).replyMessage = vi.fn(async (id: string, text: string) => {
        const model = (h.bot as any).replyModelFooters.get(id);
        const status = (h.bot as any).replyStatusFooters.get(id);
        const card = (h.bot as any).buildMarkdownCard(text, model, status);
        footers.push(card.body.elements.at(-1).content);
      });
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "footer-test", "answer", [], "original", "footer-test", "model-GPT");
      expect(footers[0]).toContain("🧠 model-GPT · running · 85K/200K");
      expect(footers[0]).not.toMatch(/status:|查询时/);
      expect(h.store.getDeliveryByKey("GPT", "chat1", "footer-test")?.content).toBe("answer");
      expect(JSON.parse(h.store.getDeliveryByKey("GPT", "chat1", "footer-test")!.deliveryMetaJson)).toEqual({ model: "model-GPT" });
      (h.openclaw as any).getSessionRuntimeStatus.mockResolvedValue(normalizeSessionRuntimeStatus({session: {status: "idle", totalTokens: 120000, contextTokens: 200000}}));
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "footer-test-2", "answer2", [], "original2", "footer-test-2", "model-GPT");
      expect(footers[1]).toContain("idle · 120K/200K");
      expect((h.openclaw as any).getSessionRuntimeStatus).toHaveBeenCalledTimes(2);
      expect((h.bot as any).replyStatusFooters.size).toBe(0);
    } finally { h.cleanup(); }
  });
  it("retains model and status in plain-text fallback", async () => {
    const h = makeHarness("GPT");
    try {
      const reply = vi.fn().mockRejectedValueOnce(new Error("card refused")).mockResolvedValue({ data: { message_id: "sent" } });
      (h.bot as any).client = { im: { message: { reply } } };
      (h.bot as any).replyMessage = (FeishuBot.prototype as any).replyMessage.bind(h.bot);
      await (h.bot as any).replyFinalMessage("source", "answer", "model-GPT", "running · 85K/200K");
      expect(JSON.parse(reply.mock.calls[1][0].data.content).text).toContain("🧠 model-GPT · running · 85K/200K");
      expect(JSON.parse(reply.mock.calls[1][0].data.content).text).not.toMatch(/status:|查询时/);
      expect((h.bot as any).replyStatusFooters.size).toBe(0);
    } finally { h.cleanup(); }
  });
  it("retains compact state and context in new-message plain-text fallback", async () => {
    const h = makeHarness("GPT");
    try {
      const create = vi.fn().mockRejectedValueOnce(new Error("card refused")).mockResolvedValue({ data: { message_id: "sent" } });
      (h.bot as any).client = { im: { message: { create } } };
      (h.bot as any).sendMessage = (FeishuBot.prototype as any).sendMessage.bind(h.bot);
      await (h.bot as any).sendFinalMessage("chat1", "answer", "model-GPT", "running · 85K/200K");
      const card = JSON.parse(create.mock.calls[0][0].data.content);
      expect(card.body.elements.at(-1).content).toContain("🧠 model-GPT · running · 85K/200K");
      const text = JSON.parse(create.mock.calls[1][0].data.content).text;
      expect(text).toContain("🧠 model-GPT · running · 85K/200K");
      expect(text).not.toMatch(/status:|查询时/);
      expect((h.bot as any).sendStatusFooters.size).toBe(0);
    } finally { h.cleanup(); }
  });
  it("keeps discussion pause notices nonfatal and releases proactive mute immediately", async () => {
    const h = makeHarness("GPT");
    try {
      const status = { status: "running", running: true, checkedAt: Date.now() };
      const pause = new SessionWaitPaused(status);
      const unmute = vi.fn(); h.openclaw.muteProactiveDelivery = vi.fn(() => unmute);
      (h.openclaw as any).getSessionRuntimeStatus = vi.fn(async () => status);
      h.openclaw.chatSendWithContext = vi.fn(async () => { throw pause; });
      await expect((h.bot as any).runDiscussionTurn("chat1", "test")).rejects.toBe(pause);
      expect(unmute).toHaveBeenCalledWith(0);
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("暂停本轮等待"));
    } finally { h.cleanup(); }
  });
  it.each(["timeout", "yield"] as const)("returns a %s notice while keeping the normal queue owner until the actual result", async reason => {
    const h = makeHarness("GPT");
    try {
      (h.openclaw as any).getSessionRuntimeStatus = vi.fn(async () => ({ status: "running", running: true, checkedAt: Date.now() }));
      let submitted: any; let finish!: (value: string) => void;
      h.openclaw.chatSendWithContext = vi.fn(async (p: any) => {
        h.openclaw.chatCalls.push(p); await p.onSendAttempt?.(); await p.onSubmitted?.("r"); submitted = p;
        return new Promise<string>(resolve => { finish = resolve; });
      });
      const work = (h.bot as any).handleMessage(event({ chatType: "p2p", text: "work", messageId: "wait-notice" }));
      await vi.waitUntil(() => Boolean(finish), { timeout: 1000 });
      // A recent unrelated delivery must not suppress a confirmed yield notice.
      if (reason === "yield") (h.bot as any).lastRealDeliveryAt.set("chat1", Date.now());
      const pause = new SessionWaitPaused({status:"unknown",running:false,checkedAt:Date.now()}, false, reason);
      await submitted.onWaitPaused(pause);
      if (reason === "yield") await submitted.onWaitPaused(pause); // outbox dedupe, independently of collector dedupe
      const row = h.store.getMessageId("wait-notice")!;
      expect(h.store.getDeliveryByKey("GPT", "chat1", `trigger:${row}:wait-paused`)?.content).toBe(pause.message);
      expect((h.bot as any).replyMessage.mock.calls.filter((call: any[]) => call[1] === pause.message)).toHaveLength(1);
      expect((h.bot as any).addReaction).not.toHaveBeenCalledWith("wait-notice", "DONE");
      expect((h.bot as any).queueRuns.has("chat1")).toBe(true);
      expect(h.store.hasDeliveredReply("GPT", "chat1", row)).toBe(false);
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
      finish("real final"); await work;
      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("wait-notice", "real final");
      expect(h.store.hasDeliveredReply("GPT", "chat1", row)).toBe(true);
    } finally { h.cleanup(); }
  });
  it("keeps a discussion yield notice nonterminal until the scheduler receives the real result", async () => {
    const h = makeHarness("GPT");
    try {
      const unmute = vi.fn(); h.openclaw.muteProactiveDelivery = vi.fn(() => unmute);
      let submitted: any; let finish!: (value: string) => void;
      h.openclaw.chatSendWithContext = vi.fn(async (p: any) => {
        submitted = p; return new Promise<string>(resolve => { finish = resolve; });
      });
      const work = (h.bot as any).runDiscussionTurn("chat1", "discussion question");
      await vi.waitUntil(() => Boolean(finish), { timeout: 1000 });
      expect(submitted.emptyFinalAsNoReply).toBe(true);
      const pause = new SessionWaitPaused({ status: "unknown", running: false, checkedAt: Date.now() }, false, "yield");
      await submitted.onWaitPaused(pause);
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", pause.message);
      expect(unmute).not.toHaveBeenCalled(); expect(h.openclaw.abortChat).not.toHaveBeenCalled();
      finish("discussion final"); await work;
      expect(unmute).toHaveBeenCalledWith(120_000);
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", "discussion final");
      expect(h.openclaw.chatSendWithContext).toHaveBeenCalledOnce();
    } finally { h.cleanup(); }
  });
  it("emits a normal wait notice without DONE or final-answer ownership, allowing the later answer", async () => {
    const h = makeHarness("GPT");
    try {
      (h.openclaw as any).getSessionRuntimeStatus = vi.fn(async () => ({ status: "running", running: true, checkedAt: Date.now() }));
      (h.openclaw as any).releasePausedWait = vi.fn();
      h.openclaw.chatSendWithContext = vi.fn(async (p: any) => {
        h.openclaw.chatCalls.push(p); await p.onSendAttempt?.(); await p.onSubmitted?.("original-run");
        throw new Error("RPC wait timed out");
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "task", messageId: "paused-source" }));
      const row = h.store.getMessageId("paused-source")!;
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
      expect((h.bot as any).addReaction).not.toHaveBeenCalledWith("paused-source", "DONE");
      expect(h.store.hasDeliveredReply("GPT", "chat1", row)).toBe(false);
      expect(h.store.getDeliveryByKey("GPT", "chat1", `trigger:${row}:wait-paused`)?.content).toContain("已暂停");
      expect(h.store.getPendingTriggerIds("GPT", "chat1").has(row)).toBe(false);
      expect((h.openclaw as any).releasePausedWait).toHaveBeenCalledWith("original-run");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "late-result", "real final", [], "paused-source", `trigger:${row}`, "model-GPT");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("paused-source", "real final");
    } finally { h.cleanup(); }
  });

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
      h.openclaw.replies.push("同样的回复内容。", "同样的回复内容。");
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "问题一", messageId: "real-trigger-1" }));
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "问题二", messageId: "real-trigger-2" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(2);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("real-trigger-1", "同样的回复内容。");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("real-trigger-2", "同样的回复内容。");
      const rows = (h.store as any).db.prepare(`SELECT source_id, delivery_key FROM delivery_outbox WHERE source_type='assistant_visible' ORDER BY id`).all();
      expect(rows).toHaveLength(2);
      expect(rows[0].source_id).not.toBe(rows[1].source_id);
      expect(rows.map((r: any) => r.delivery_key)).toEqual(["trigger:1", "trigger:3"]);
    } finally { h.cleanup(); }
  });

  it("recovers even freshly-delivering outbox rows on startup", async () => {
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
      // A new process owns no legitimate in-flight work, so even a row claimed
      // milliseconds before the crash must be restored immediately.
      expect(h.store.resetDeliveringOnStartup("GPT")).toBe(1);
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

  it("propagates model-policy rejection and does not mark the session initialized", async () => {
    const h = makeHarness();
    try {
      delete (h.bot as any).ensureSession;
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 123 } })) as any;
      h.openclaw.ensureModel = vi.fn(async () => { throw new Error("model not allowed by agents.defaults.modelPolicy.allow"); }) as any;

      await expect((h.bot as any).ensureSession("chat1")).rejects.toThrow(/modelPolicy\.allow/);
      expect((h.bot as any).initializedSessions.has("lma-gpt-chat1")).toBe(false);
    } finally { h.cleanup(); }
  });

  it("reports session setup policy errors and always clears the busy marker", async () => {
    const h = makeHarness();
    try {
      (h.bot as any).ensureSession = vi.fn(async () => { throw new Error("model not allowed by agents.defaults.modelPolicy.allow"); });
      h.store.setBotMode("GPT", "chat1", "free");
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "run", messageId: "policy-fail" }));

      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("policy-fail", expect.stringContaining("modelPolicy.allow"));
      const rowId = h.store.getMessageId("policy-fail")!;
      expect(h.store.getPendingTriggerIds("GPT", "chat1").has(rowId)).toBe(false);
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
      markBotSeen("GPT");
      markBotSeen("Claude");
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
      markBotSeen("GPT");
      markBotSeen("Claude");
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



  it("does not include globally configured bots that are not available in the current Feishu chat", async () => {
    const gpt = makeHarness("GPT");
    const ghost = makeHarness("Ghost");
    try {
      (ghost.bot as any).store = gpt.store;
      (ghost.bot as any).openclawClient = ghost.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Ghost", ghost.bot as any);
      // GPT received this chat's event; Ghost is globally configured but has
      // never received or successfully delivered in this chat.
      markBotSeen("GPT");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 1);

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic-no-ghost" }));
      await vi.waitUntil(() => gpt.openclaw.chatCalls.length === 1, { timeout: 1000 });
      expect(ghost.openclaw.chatCalls).toHaveLength(0);
    } finally {
      gpt.cleanup();
      ghost.cleanup();
    }
  });

  it("includes a bot in discuss after restart if it had durably seen the chat", async () => {
    const gpt = makeHarness("GPT");
    const claude = makeHarness("Claude");
    try {
      (claude.bot as any).store = gpt.store;
      (claude.bot as any).openclawClient = claude.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Claude", claude.bot as any);
      markBotSeen("GPT");
      // Simulate process restart: Claude's in-memory seen set is gone, but the
      // durable bot_chat_seen signal remains from a previous received event.
      gpt.store.markBotSeenInChat("Claude", "chat1");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 1);

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic-cold-start" }));
      await vi.waitUntil(() => gpt.openclaw.chatCalls.length === 1 && claude.openclaw.chatCalls.length === 1, { timeout: 1000 });
    } finally {
      gpt.cleanup();
      claude.cleanup();
    }
  });

  it("excludes a bot from discuss after Feishu reports it is out of the chat", async () => {
    const gpt = makeHarness("GPT");
    const ghost = makeHarness("Ghost");
    try {
      (ghost.bot as any).store = gpt.store;
      (ghost.bot as any).openclawClient = ghost.openclaw;
      FeishuBot.getAllBots().set("app-GPT", gpt.bot as any);
      FeishuBot.getAllBots().set("app-Ghost", ghost.bot as any);
      markBotSeen("GPT");
      markBotSeen("Ghost");
      gpt.store.markBotUnavailableInChat("Ghost", "chat1", "code=230002 Bot/User can NOT be out of the chat");
      gpt.store.setDiscussMode("chat1", true);
      gpt.store.setDiscussMaxRounds("chat1", 1);

      await (gpt.bot as any).handleMessage(event({ chatType: "group", text: "讨论一下", messageId: "topic-ghost-unavailable" }));
      await vi.waitUntil(() => gpt.openclaw.chatCalls.length === 1, { timeout: 1000 });
      expect(ghost.openclaw.chatCalls).toHaveLength(0);
    } finally {
      gpt.cleanup();
      ghost.cleanup();
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
      markBotSeen("GPT");
      markBotSeen("Claude");
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

  it("uses live status during discussion turns", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onProgress?.({ kind: "tool", phase: "start", name: "read", text: "read start: spec.md" });
        await vi.advanceTimersByTimeAsync(900);
        return "讨论回复";
      });

      const result = await (h.bot as any).runDiscussionTurn("chat1", "prompt", { round: 1, maxRounds: 10 });
      expect(result.visible).toBe(true);
      expect((h.bot as any).sendLiveStatusCard).toHaveBeenCalledWith("chat1", expect.objectContaining({
        title: "Claude 正在执行",
        lines: expect.arrayContaining([expect.objectContaining({ text: "read: spec.md" })]),
      }));
      expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("讨论回复"));
      expect((h.bot as any).patchLiveStatusCard).toHaveBeenCalledWith(
        "live-status-msg",
        expect.objectContaining({ state: "done", toolCalls: 1 }),
        "chat1",
      );
    } finally {
      vi.useRealTimers();
      h.cleanup();
    }
  });

  it("finishes the discussion live status with a no-content summary on NO_REPLY", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onProgress?.({ kind: "tool", phase: "start", name: "read", text: "read start: spec.md" });
        await vi.advanceTimersByTimeAsync(900);
        return "NO_REPLY";
      });

      const result = await (h.bot as any).runDiscussionTurn("chat1", "prompt", { round: 1, maxRounds: 10 });
      expect(result.visible).toBe(false);
      // NO_REPLY discussion turn must not be delivered to the group...
      expect((h.bot as any).sendMessage).not.toHaveBeenCalled();
      // ...and the status card finishes with the "no content" summary.
      const lastPatch = (h.bot as any).patchLiveStatusCard.mock.calls.at(-1)[1];
      expect(lastPatch.state).toBe("done");
      expect(lastPatch.lines[0].text).toContain("模型没有回复内容");
    } finally {
      vi.useRealTimers();
      h.cleanup();
    }
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

  it("clears out-of-chat cache when the bot receives a new event from that chat", async () => {
    const h = makeHarness("GPT");
    try {
      h.store.markBotUnavailableInChat("GPT", "chat1", "code=230002 Bot/User can NOT be out of the chat");
      expect(h.store.isBotUnavailableInChat("GPT", "chat1")).toBe(true);
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "/status", messageId: "status-after-readd" }));
      expect(h.store.hasBotSeenInChat("GPT", "chat1")).toBe(true);
      expect(h.store.isBotUnavailableInChat("GPT", "chat1")).toBe(false);
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

  it("answers bare /help once from the coordinator in multi-bot groups", async () => {
    const h = makeHarness("GPT");
    try {
      FeishuBot.getAllBots().set("app-GPT", h.bot as any);
      FeishuBot.getAllBots().set("app-Claude", { config: { appId: "app-Claude", name: "Claude" }, store: h.store } as any);
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "/help", messageId: "cmd-help" }));
      expect(h.openclaw.chatCalls).toHaveLength(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("cmd-help", expect.stringContaining("Bot 命令列表"));
      expect(h.store.getPendingTriggerIds("GPT", "chat1").size).toBe(0);
    } finally {
      FeishuBot.getAllBots().delete("app-GPT");
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
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
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-status-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
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

      expect((h.bot as any).replyLiveStatusCard).not.toHaveBeenCalled();
      expect((h.bot as any).patchLiveStatusCard).not.toHaveBeenCalled();
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

  it("does not let a NO_REPLY chat-final overwrite a proactive answer on the shared card", async () => {
    const h = makeHarness("GPT");
    try {
      delete (h.bot as any).ensureSession;
      await (h.bot as any).ensureSession("chat1");
      const cb = h.openclaw.sessionCallbacks.get("lma-gpt-chat1")!;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        await cb("proactive final answer");
        return "NO_REPLY";
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "任务", messageId: "noreply-race" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("noreply-race", "proactive final answer");
      expect((h.bot as any).patchLiveStatusCard).toHaveBeenCalledWith(
        "live-status-msg",
        expect.objectContaining({ state: "done", noReply: false }),
        "chat1",
      );
    } finally { h.cleanup(); }
  });

  it("does not let an empty chat-final overwrite a proactive answer on the shared card", async () => {
    const h = makeHarness("GPT");
    try {
      delete (h.bot as any).ensureSession;
      await (h.bot as any).ensureSession("chat1");
      const cb = h.openclaw.sessionCallbacks.get("lma-gpt-chat1")!;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        await cb("proactive final answer");
        return "";
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "任务", messageId: "empty-race" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("empty-race", "proactive final answer");
      expect((h.bot as any).patchLiveStatusCard).toHaveBeenCalledWith(
        "live-status-msg",
        expect.objectContaining({ state: "done", noReply: false }),
        "chat1",
      );
    } finally { h.cleanup(); }
  });

  it("does not let a NO_REPLY chat-final collapse an attachment-only proactive answer", async () => {
    const h = makeHarness("GPT");
    try {
      delete (h.bot as any).ensureSession;
      await (h.bot as any).ensureSession("chat1");
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      const cb = h.openclaw.sessionCallbacks.get("lma-gpt-chat1")!;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        await cb('<LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"file","path":"/tmp/proactive.pdf"}]}</LMA_BRIDGE_ATTACHMENTS>');
        return "NO_REPLY";
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "任务", messageId: "attachment-race" }));
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledTimes(1);
      expect((h.bot as any).patchLiveStatusCard).toHaveBeenCalledWith(
        "live-status-msg",
        expect.objectContaining({ state: "done", noReply: false }),
        "chat1",
      );
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

  it("sends a proactive visible reply separately and completes live status", async () => {
    const h = makeHarness("GPT");
    try {
      delete (h.bot as any).ensureSession;
      await (h.bot as any).ensureSession("chat1");
      const release = (h.bot as any).setActiveDeliveryTarget("chat1", 42, "reply-42");
      const activeTarget = (h.bot as any).activeDeliveryTargets.get("chat1");
      const meta = { messageId: "live-proactive", toolCalls: 3, elapsed: "0:21", model: "model-GPT", locale: "zh" as const };
      activeTarget.liveStatus = {
        prepareTerminalDelivery: vi.fn(async () => meta),
        prepareFinalDelivery: vi.fn(async () => meta),
        complete: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
      };
      const cb = h.openclaw.sessionCallbacks.get("lma-gpt-chat1")!;
      await cb("proactive answer");
      release();
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-42", "proactive answer");
      expect(h.store.getDeliveryByKey("GPT", "chat1", "trigger:42")).toMatchObject({ status: "delivered" });
      expect(activeTarget.liveStatus.complete).toHaveBeenCalledTimes(1);
      expect(activeTarget.liveStatus.fail).not.toHaveBeenCalled();
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

  it("lets the authoritative chat-final correct an earlier proactive payload", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "proactive:abc", "中间消息", [], "reply-42", "trigger:42", "model-GPT");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "visible:def", "真正的最终答案", [], "reply-42", "trigger:42", "model-GPT");
      const replies = (h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]);
      expect(replies).toEqual(["中间消息", "真正的最终答案"]);
    } finally { h.cleanup(); }
  });

  it("sends an authoritative correction as a later message instead of patching an old card", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "proactive:abc", "中间消息", [], "reply-42", "trigger:separate-final", "model-GPT");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "visible:def", "真正的最终答案", [], "reply-42", "trigger:separate-final", "model-GPT");
      const replies = (h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]);
      expect(replies).toEqual(["中间消息", "真正的最终答案"]);
      expect((h.bot as any).patchLiveStatusDoneSummary).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it("deduplicates a repeated final without patching the live-status card", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "first", "same answer", [], "reply-1", "trigger:dup", "model-GPT");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "second", "same answer", [], "reply-1", "trigger:dup", "model-GPT");
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(1);
      expect((h.bot as any).patchLiveStatusDoneSummary).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it("durably delivers attachments added by a competing duplicate final", async () => {
    const h = makeHarness("GPT");
    try {
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "first", "same answer", [], "reply-1", "trigger:extra-file");
      const attachment = { type: "file", path: "/tmp/new.pdf" };
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "second", "same answer", [attachment], "reply-1", "trigger:extra-file", "model-GPT");
      expect((h.bot as any).replyMessage).toHaveBeenCalledTimes(1);
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", attachment);
      expect((h.bot as any).patchLiveStatusDoneSummary).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it("does not redeliver a supplemental attachment across repeated collisions", async () => {
    const h = makeHarness("GPT");
    try {
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "base", "answer", [], "m", "trigger:supplemental");
      const a = { type: "file", path: "/tmp/a.pdf" };
      const b = { type: "file", path: "/tmp/b.pdf" };
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "collision-1", "answer", [a], "m", "trigger:supplemental");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "collision-2", "answer", [a, b], "m", "trigger:supplemental");
      const sent = (h.bot as any).sendBridgeAttachment.mock.calls.map((c: any[]) => c[1].path);
      expect(sent).toEqual(["/tmp/a.pdf", "/tmp/b.pdf"]);
    } finally { h.cleanup(); }
  });

  it("revives a failed supplemental attachment when it is explicitly retried", async () => {
    const h = makeHarness("GPT");
    try {
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "base", "answer", [], "m", "trigger:failed-file");
      const a = { type: "file", path: "/tmp/retry.pdf" };
      const json = JSON.stringify([a]);
      const id = h.store.enqueueDelivery({
        sessionKey: "lma-gpt-chat1", chatId: "chat1", botName: "GPT",
        sourceType: "assistant_visible_attachments", sourceId: "failed-supplement",
        deliveryKey: `trigger:failed-file:attachments:${(h.bot as any).stableHash(json)}`,
        contentHash: "x", content: "", attachmentsJson: json, replyToMessageId: "m",
        deliveryMode: "send", targetMessageId: "", deliveryMetaJson: "{}",
      })!;
      h.store.markDeliveryFailed(id);
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "assistant_visible", "retry", "answer", [a], "m", "trigger:failed-file");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledTimes(1);
      expect(h.store.getDeliveryByKey("GPT", "chat1", `trigger:failed-file:attachments:${(h.bot as any).stableHash(json)}`)?.status).toBe("delivered");
    } finally { h.cleanup(); }
  });

  it("drains more than one 50-row outbox page without waiting for another event", async () => {
    const h = makeHarness("GPT");
    try {
      for (let i = 0; i < 60; i++) {
        h.store.enqueueDelivery({
          sessionKey: "lma-gpt-chat1", chatId: "chat1", botName: "GPT",
          sourceType: "discussion_system", sourceId: `bulk-${i}`, deliveryKey: `bulk-${i}`,
          contentHash: `h-${i}`, content: `row-${i}`, attachmentsJson: "[]",
          replyToMessageId: "", deliveryMode: "send", targetMessageId: "", deliveryMetaJson: "{}",
        });
      }
      await (h.bot as any).dispatchPendingDeliveries("chat1");
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(60);
      expect(h.store.getPendingDeliveries("chat1", "GPT", 100)).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("revives a failed delivery-key owner when the same final is presented again", async () => {
    const h = makeHarness("GPT");
    try {
      const id = h.store.enqueueDelivery({
        sessionKey: "lma-gpt-chat1", chatId: "chat1", botName: "GPT",
        sourceType: "assistant_visible", sourceId: "failed-owner", deliveryKey: "trigger:failed-owner",
        contentHash: "h", content: "最终答案", attachmentsJson: "[]", replyToMessageId: "reply-1",
      })!;
      h.store.markDeliveryFailed(id);
      await (h.bot as any).enqueueAndDispatchDelivery(
        "chat1", "assistant_visible", "visible:retry", "最终答案", [], "reply-1", "trigger:failed-owner",
      );
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-1", "最终答案");
      expect(h.store.getDeliveryByKey("GPT", "chat1", "trigger:failed-owner")).toMatchObject({ status: "delivered" });
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

  it("deduplicates recent discussion content without touching live status", async () => {
    const h = makeHarness("GPT");
    try {
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "discussion", "discussion-a", "same discussion answer", [], undefined, undefined, "model-GPT");
      await (h.bot as any).enqueueAndDispatchDelivery("chat1", "discussion", "discussion-b", "same discussion answer", [], undefined, undefined, "model-GPT");
      expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
      expect((h.bot as any).patchLiveStatusDoneSummary).not.toHaveBeenCalled();
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

  it("reports an accurate terminal final-text error after the retry budget", async () => {
    const h = makeHarness("Claude");
    try {
      const id = h.store.enqueueDelivery({
        sessionKey: "lma-claude-chat1", chatId: "chat1", botName: "Claude",
        sourceType: "assistant_visible", sourceId: "terminal-text", deliveryKey: "trigger:terminal-text",
        contentHash: "h", content: "final answer", attachmentsJson: "[]", replyToMessageId: "reply-to",
      })!;
      (h.store as any).db.prepare("UPDATE delivery_outbox SET attempts = ? WHERE id = ?").run(4, id);
      let replyCalls = 0;
      (h.bot as any).replyMessage = vi.fn(async () => {
        replyCalls++;
        if (replyCalls === 1) throw new Error("reply transport down");
      });
      (h.bot as any).sendMessage = vi.fn(async () => { throw new Error("send transport down"); });
      await (h.bot as any).dispatchPendingDeliveries("chat1", "reply-to");
      const notices = (h.bot as any).replyMessage.mock.calls.map((c: any[]) => String(c[1]));
      expect(notices.some((x: string) => x.includes("最终回复发送失败"))).toBe(true);
      expect(notices.some((x: string) => x.includes("附件发送失败"))).toBe(false);
    } finally { h.cleanup(); }
  });

  it("sends final text separately with model metadata and still delivers attachments", async () => {
    const h = makeHarness("Claude");
    try {
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      const attachment = { type: "file", path: "/tmp/result.pdf", caption: "结果" };
      await (h.bot as any).enqueueAndDispatchDelivery(
        "chat1",
        "assistant_visible",
        "separate-with-file",
        "结果如下",
        [attachment],
        "trigger-file",
        "trigger:with-file",
        "model-Claude",
      );
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("trigger-file", "结果如下");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", attachment);
      expect(JSON.parse(h.store.getDeliveryByKey("Claude", "chat1", "trigger:with-file")?.deliveryMetaJson || "{}")).toEqual({ model: "model-Claude" });
    } finally { h.cleanup(); }
  });

  it("migrates a legacy patch-live-status row into a new final message and cleans the old status", async () => {
    const h = makeHarness("Claude");
    try {
      const meta = { messageId: "legacy-live", toolCalls: 9, elapsed: "1:03", model: "model-Claude", locale: "zh" as const };
      h.store.enqueueDelivery({
        sessionKey: "lma-claude-chat1", chatId: "chat1", botName: "Claude",
        sourceType: "assistant_visible", sourceId: "legacy", deliveryKey: "trigger:legacy",
        contentHash: "h", content: "旧版本待投递答案", attachmentsJson: "[]", replyToMessageId: "trigger-msg",
        deliveryMode: "patch_live_status", targetMessageId: meta.messageId, deliveryMetaJson: JSON.stringify(meta),
      });
      await (h.bot as any).dispatchPendingDeliveries("chat1", "trigger-msg");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("trigger-msg", "旧版本待投递答案");
      expect((h.bot as any).patchLiveStatusDoneSummary).toHaveBeenCalledWith("legacy-live", meta, "chat1");
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
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("quota-error", "DONE");
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

  it("renders a minimal done card but keeps activity on failure for debugging", () => {
    const h = makeHarness("Claude");
    try {
      const baseView = { title: "✅ Claude 已完成", lines: [], elapsed: "2:15", model: "phgeek-gw/claude-opus-4.8", toolCalls: 7, noReply: false };
      // Done (clean): minimal single compact grey line, no header/footer.
      const doneCard = (h.bot as any).buildLiveStatusCard({ ...baseView, state: "done" }, "chat1");
      expect(doneCard.header).toBeUndefined();
      expect(doneCard.body.elements).toHaveLength(1);
      const doneText = doneCard.body.elements[0].content;
      expect(doneText).toContain("✅");
      expect(doneText).toContain("累计7 次工具调用");
      expect(doneText).toContain("⏱ 耗时2:15");
      expect(doneText).toContain("🧠 phgeek-gw/claude-opus-4.8");
      expect(doneText).toContain("<font color='grey'>"); // unobtrusive grey, footer-like

      // The separate final answer remains self-contained with model attribution;
      // the live-status card also keeps the model visible during and after work.
      const finalCard = (h.bot as any).buildMarkdownCard("## 最终结论\n\n内容", "phgeek-gw/claude-opus-4.8");
      const finalText = finalCard.body.elements.map((e: any) => e.content || "").join("\n");
      expect(finalText).toContain("最终结论");
      expect(finalText).toContain("🧠 phgeek-gw/claude-opus-4.8");
      expect(finalText).not.toContain("累计7 次工具调用");
      // NO_REPLY: still minimal (clean finish), 💤 marker.
      const noReplyCard = (h.bot as any).buildLiveStatusCard({ ...baseView, state: "done", noReply: true, toolCalls: 2, elapsed: "0:11" }, "chat1");
      expect(noReplyCard.header).toBeUndefined();
      expect(noReplyCard.body.elements[0].content).toContain("累计2 次工具调用");
      // Failed: keep the recent activity window + header + footer so the steps
      // before the error/kill/timeout are visible for debugging.
      const failView = { ...baseView, state: "failed", title: "⚠️ Claude 执行中断", lines: [
        { kind: "tool_start", text: "read: a.ts", at: 2 },
        { kind: "tool_end", text: "read: ok", at: 5 },
        { kind: "summary", text: "累计2 次工具调用 · 耗时0:42", at: 42 },
      ] };
      const failCard = (h.bot as any).buildLiveStatusCard(failView, "chat1");
      expect(failCard.header).toBeDefined();
      expect(failCard.header.template).toBe("orange");
      const failContent = failCard.body.elements.map((e: any) => e.content).join("\n");
      expect(failContent).toContain("read: a.ts"); // recent activity retained
      expect(failContent).toContain("read: ok");
      expect(failContent).toContain("累计2 次工具调用"); // summary retained
      expect(failContent).toContain("🧠 phgeek-gw/claude-opus-4.8");
      // Running card still has header + footer, including the active model.
      const runningCard = (h.bot as any).buildLiveStatusCard({ ...baseView, state: "running", title: "Claude 正在执行", lines: [{ kind: "tool_start", text: "read: a.ts", at: 2 }] }, "chat1");
      expect(runningCard.header).toBeDefined();
      expect(runningCard.body.elements.length).toBeGreaterThan(1); // content + hr + footer
      expect(runningCard.body.elements.map((e: any) => e.content || "").join("\n")).toContain("🧠 phgeek-gw/claude-opus-4.8");
    } finally { h.cleanup(); }
  });

  it("sends the final reply after the independent live-status card", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-status-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
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

      // Live status placeholder is created as a separate message and only shows
      // meaningful tool-start progress (no timer/progress bar/edit count noise).
      expect((h.bot as any).replyLiveStatusCard).toHaveBeenCalledWith("live-trigger", expect.objectContaining({ title: "Claude 正在执行" }), "chat1");
      const placeholderView = (h.bot as any).replyLiveStatusCard.mock.calls[0][1];
      expect(placeholderView.lines.map((l: any) => l.text)).toContain("read: 读取 src/feishu-bot.ts");
      expect(placeholderView.hint).toBeUndefined();
      expect(placeholderView.elapsed).toMatch(/\d+:\d{2}/);
      // Live status closes independently; the final answer is a new message sent
      // afterwards, so user messages inserted mid-run cannot appear below it.
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("live-trigger", "最终回复");
      expect((h.bot as any).patchLiveStatusCard).toHaveBeenCalledWith(
        "live-status-msg",
        expect.objectContaining({ state: "done", toolCalls: 1 }),
        "chat1",
      );
      const finalRow = h.store.getDeliveryByKey("Claude", "chat1", "trigger:1");
      expect(finalRow?.deliveryMode).toBe("send");
      expect(JSON.parse(finalRow?.deliveryMetaJson || "{}")).toEqual({ model: "model-Claude" });
      expect((h.bot as any).deleteMessageById).not.toHaveBeenCalled();
      expect(h.store.hasDeliveredReply("Claude", "chat1", 1)).toBe(true);
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("marks live status interrupted for runtime failure replies", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-status-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        await params.onSubmitted?.("run-runtime-failure");
        await params.onProgress?.({ kind: "tool", phase: "start", name: "exec", text: "exec start: npm test" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return "⚠️ Agent 未正常完成\n状态: unknown\n原因: rpc\n请重试";
      });
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "跑一下",
        messageId: "runtime-live-trigger",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(1000);
      await run;

      expect((h.bot as any).replyLiveStatusCard).toHaveBeenCalledWith("runtime-live-trigger", expect.objectContaining({ title: "Claude 正在执行" }), "chat1");
      const runtimeFailPatch = (h.bot as any).patchLiveStatusCard.mock.calls.at(-1)[1];
      expect(runtimeFailPatch.title).toContain("执行中断");
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("does not create live status for fast replies", async () => {
    const h = makeHarness("Claude");
    try {
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-status-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
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

      expect((h.bot as any).replyLiveStatusCard).not.toHaveBeenCalled();
      expect((h.bot as any).patchLiveStatusCard).not.toHaveBeenCalled();
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("fast-trigger", "快速回复");
    } finally {
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("warns about killed sessions but still lets the user retry", async () => {
    const h = makeHarness("Claude");
    try {
      const statuses = ["killed", "active"];
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: statuses.shift() || "active" } }));
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      await (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "你在吗",
        messageId: "killed-session-msg",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("killed-session-msg", expect.stringContaining("我会继续尝试处理这条消息"));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("killed-session-msg", "mock reply");
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
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-killed-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
      (h.bot as any).deleteMessageById = vi.fn(async () => {});
      const sessionStatuses = ["active", "killed", "killed"];
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
      expect((h.bot as any).replyLiveStatusCard).toHaveBeenCalledWith("killed-mid-run", expect.objectContaining({ title: expect.stringContaining("Claude") }), "chat1");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await run;

      expect(h.openclaw.abortChat).toHaveBeenCalled();
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("killed-mid-run", "DONE");
      // stopForUnhealthySession warns but does not force /reset.
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("killed-mid-run", expect.stringContaining("可以直接再发一条继续尝试"));
      // ...and the live status placeholder is marked interrupted (not overwritten with the error).
      expect((h.bot as any).deleteMessageById).not.toHaveBeenCalled();
      const killedPatchView = (h.bot as any).patchLiveStatusCard.mock.calls.at(-1)[1];
      expect(killedPatchView.title).toContain("执行中断");
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("does not report transient killed status if the session recovers before confirmation", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      const sessionStatuses = ["active", "killed", "active"];
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: sessionStatuses.shift() || "active" } }));
      let resolveReply!: (value: string) => void;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onSendAttempt?.();
        return await new Promise<string>((resolve) => { resolveReply = resolve; });
      });
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-transient-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "运行中短暂状态异常",
        messageId: "transient-killed",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.openclaw.chatCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(7_000);
      resolveReply("mock reply");
      await vi.advanceTimersByTimeAsync(250);
      await run;

      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("transient-killed", expect.stringContaining("状态异常"));
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("treats run-level failure statuses (aborted/error/timeout) as a live session, not a dead one", async () => {
    // Root cause of the false "session 状态异常 (killed)" report: sessions.describe
    // returns the LAST RUN's status. An idle-timeout/aborted run leaves the session
    // usable, so these run-level statuses must NOT be surfaced as session death.
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      // Session keeps reporting a run-level failure status the whole time.
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: "aborted" } }));
      let resolveReply!: (value: string) => void;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onSendAttempt?.();
        return await new Promise<string>((resolve) => { resolveReply = resolve; });
      });
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-runfail-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "上一次 run 超时但 session 还活着",
        messageId: "runfail-msg",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.openclaw.chatCalls).toHaveLength(1);
      // Let the health monitor poll several times; 'aborted' must never trip it.
      await vi.advanceTimersByTimeAsync(20_000);
      resolveReply("mock reply");
      await vi.advanceTimersByTimeAsync(250);
      await run;

      // No preflight warning, no mid-run "unhealthy" notice, no forced abort.
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("runfail-msg", expect.stringContaining("状态异常"));
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("runfail-msg", expect.stringContaining("unhealthy"));
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("still reports a genuinely dead session (killed) as unhealthy", async () => {
    // Guard the other direction: a real session-death status must still be caught.
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: "killed" } }));
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        params.onSendAttempt?.();
        await new Promise(() => {}); // never resolves; monitor must stop it
        return "never";
      });
      (h.bot as any).replyLiveStatusCard = vi.fn(async () => "live-dead-msg");
      (h.bot as any).patchLiveStatusCard = vi.fn(async () => {});
      FeishuBot.getAllBots().set("app-Claude", h.bot as any);

      const run = (h.bot as any).handleMessage(event({
        chatType: "group",
        text: "session 真的死了",
        messageId: "dead-msg",
        mentions: [{ name: "万万（Claude）", id: { app_id: "app-Claude", open_id: "claude-open-id" } }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      // Preflight already sees killed and warns (warn-but-continue).
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("dead-msg", expect.stringContaining("状态异常"));
      // Mid-run monitor confirms killed and aborts the stuck run.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await run;
      expect(h.openclaw.abortChat).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      FeishuBot.getAllBots().delete("app-Claude");
      h.cleanup();
    }
  });

  it("queue drain does not preflight-block retries when previous session status is killed", async () => {
    const h = makeHarness("Claude");
    try {
      h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { status: "active | killed" } }));
      const id = h.store.insert({ chatId: "chat1", messageId: "pending-killed", senderType: "human", senderName: "u", content: "pending", timestamp: 1 });
      h.store.markPendingTrigger("Claude", "chat1", id);
      (h.bot as any).pendingAckMessages.set("chat1", [{ messageId: "pending-killed", emoji: "Typing", rowId: id }]);
      (h.bot as any).busyChats.set("chat1", Date.now());

      await (h.bot as any).processQueue("chat1");

      expect(h.openclaw.chatCalls).toHaveLength(1);
      expect(h.store.getPendingTriggerIds("Claude", "chat1").size).toBe(0);
      expect((h.bot as any).removeReaction).toHaveBeenCalledWith("pending-killed", "Typing");
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("pending-killed", "DONE");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("pending-killed", "mock reply");
      expect((h.bot as any).busyChats.get("chat1")).toBe(0);
    } finally { h.cleanup(); }
  });

  it("drains new input after an idle Gateway releases the phantom old queue owner", async () => {
    const h = makeHarness("GPT");
    try {
      let rejectOld!: (err: Error) => void;
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        await params.onSendAttempt?.();
        if (h.openclaw.chatCalls.length === 1) return new Promise<string>((_resolve, reject) => { rejectOld = reject; });
        return "new answer";
      });
      const first = (h.bot as any).handleMessage(event({ chatType: "p2p", text: "old task", messageId: "idle-old" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1 && Boolean(rejectOld), { timeout: 1000 });
      h.openclaw.steer = vi.fn(async () => {
        rejectOld(new InactiveRunObservation());
        return { status: "unavailable" as const };
      });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "new task", messageId: "idle-new" }));
      await first;
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 2, { timeout: 1500 });
      await ((h.bot as any).queueRuns.get("chat1") || Promise.resolve());
      expect(h.openclaw.chatCalls.map(p => p.currentMessage)).toEqual(["old task", "new task"]);
      expect(h.openclaw.abortChat).not.toHaveBeenCalled();
      expect((h.bot as any).addReaction).not.toHaveBeenCalledWith("idle-old", "DONE");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("idle-new", "new answer");
    } finally { h.cleanup(); }
  });

  it("retains no stale cleanup when the inserted message is consumed before the RPC ack", async () => {
    const h = makeHarness("GPT");
    try {
      let release!: (text: string) => void;
      h.openclaw.chatSendWithContext = vi.fn((p: any) => { h.openclaw.chatCalls.push(p); return new Promise<string>(r => { release = r; }); });
      const first = (h.bot as any).handleMessage(event({ chatType: "p2p", text: "first", messageId: "pre-ack-first" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      h.openclaw.steer = vi.fn(async (_key: string, text: string) => { h.openclaw.fireSteerConsumed(text); return { status: "steered" as const }; });
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "fast insert", messageId: "pre-ack-second" }));
      const row = h.store.getMessageId("pre-ack-second")!;
      expect(h.store.getPendingTriggerIds("GPT", "chat1").has(row)).toBe(false);
      expect((h.bot as any).pendingSteerCleanups.has(row)).toBe(false);
      release("done"); await first;
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("still steers input after a healthy queue owner has run for over 30 minutes", async () => {
    const h = makeHarness("GPT");
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      let release!: (text: string) => void;
      h.openclaw.chatSendWithContext = vi.fn((p: any) => {
        h.openclaw.chatCalls.push(p);
        return new Promise<string>(r => { release = r; });
      });
      const first = (h.bot as any).handleMessage(event({ chatType: "p2p", text: "long task", messageId: "long-owner" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      const later = Date.now() + 31 * 60_000;
      clock = vi.spyOn(Date, "now").mockReturnValue(later);
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "insert after thirty minutes", messageId: "long-insert" }));
      expect(h.openclaw.steer).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("insert after thirty minutes"), "insert after thirty minutes");
      h.openclaw.fireSteerConsumed("insert after thirty minutes");
      release("finished");
      await first;
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { clock?.mockRestore(); h.cleanup(); }
  });

  it("does not mark queued mid-run messages DONE or synced before processing", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      // Force the queue-and-wait fallback (steer unavailable) so this test keeps
      // validating the original mid-run queuing behavior.
      h.openclaw.steer = vi.fn(async () => ({ status: "unavailable" as const }));
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

  it("steers a mid-run message into the active run instead of queuing a second run", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      delete (h.bot as any).ensureSession;
      // Default mock plugin steer confirms queueing into the existing run.
      let releaseFirst!: (value: string) => void;
      (h.openclaw as any).chatSendWithContext = vi.fn((params: any) => {
        h.openclaw.chatCalls.push(params);
        if (h.openclaw.chatCalls.length === 1) {
          return new Promise<string>((resolve) => { releaseFirst = resolve; });
        }
        return Promise.resolve("should-not-happen");
      });

      const first = (h.bot as any).handleMessage(event({ chatType: "group", text: "第一条", messageId: "busy-1" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      await (h.bot as any).handleMessage(event({ chatType: "group", text: "中途插入的话", messageId: "busy-2" }));

      // It was steered into the active run: steer() called with the wrapped text
      // (insertion prefix + original) plus the original as the display text.
      expect(h.openclaw.steer).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("中途插入的话"),
        "中途插入的话",
      );
      // Before consumption: reaction is "Typing" (awaiting insertion), NOT "Get".
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("busy-2", "Typing");
      expect((h.bot as any).addReaction).not.toHaveBeenCalledWith("busy-2", "Get");
      // RPC acceptance is provisional: retain the durable fallback until the
      // canonical transcript confirms commitment/consumption.
      const secondRow = h.store.getMessageId("busy-2")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(secondRow)).toBe(true);

      // A confirmed plugin steer belongs to the existing run; it must not replace
      // that run's original final-reply target with the inserted message.
      const activeTargetDuringSteer = (h.bot as any).activeDeliveryTargets.get("chat1");
      expect(activeTargetDuringSteer?.messageId).toBe("busy-1");
      expect((h.bot as any).deliveryTargetsByRun.size).toBe(0);

      // Model consumption controls only the visible Typing -> Get transition.
      h.openclaw.fireSteerConsumed("中途插入的话");
      expect((h.bot as any).addReaction).toHaveBeenCalledWith("busy-2", "Get");
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(secondRow)).toBe(false);

      releaseFirst("first reply");
      await first;
      // No second chatSendWithContext run for the steered message.
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("cancels stale steer correlation when a retained trigger takes the normal queue path", async () => {
    const h = makeHarness("GLM");
    try {
      const rowId = h.store.insert({ chatId: "chat1", messageId: "fallback-normal", senderType: "human", senderName: "u", content: "same text", timestamp: 1 });
      h.store.markPendingTrigger("GLM", "chat1", rowId);
      const cleanup = vi.fn();
      (h.bot as any).pendingSteerCleanups.set(rowId, cleanup);

      await (h.bot as any).processQueue("chat1");

      expect(cleanup).toHaveBeenCalledOnce();
      expect((h.bot as any).pendingSteerCleanups.has(rowId)).toBe(false);
      expect(h.openclaw.chatCalls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("keeps independent Feishu reply targets for concurrent runs in one chat", async () => {
    const h = makeHarness("GLM");
    try {
      delete (h.bot as any).ensureSession;
      await (h.bot as any).ensureSession("chat1");
      (h.bot as any).bindRunDeliveryTarget("chat1", "run-b", { triggerId: 2, messageId: "msg-b" });
      (h.bot as any).bindRunDeliveryTarget("chat1", "run-c", { triggerId: 3, messageId: "msg-c" });
      const sessionCb = h.openclaw.sessionCallbacks.get("lma-glm-chat1")!;

      await sessionCb("answer b", { runId: "run-b" });
      await sessionCb("answer c", { runId: "run-c" });

      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("msg-b", "answer b");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("msg-c", "answer c");
    } finally { h.cleanup(); }
  });

  it("keeps the previous delivery target when plugin steer is unavailable", async () => {
    const h = makeHarness("GLM");
    try {
      h.store.setBotMode("GLM", "chat1", "free");
      let releaseFirst!: (value: string) => void;
      h.openclaw.chatSendWithContext = vi.fn((params: any) => {
        h.openclaw.chatCalls.push(params);
        if (h.openclaw.chatCalls.length === 1) return new Promise<string>((resolve) => { releaseFirst = resolve; });
        return Promise.resolve("second reply");
      }) as any;
      h.openclaw.steer = vi.fn(async () => ({ status: "unavailable" as const }));

      const first = (h.bot as any).handleMessage(event({ chatType: "group", text: "第一条", messageId: "restore-1" }));
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 1, { timeout: 1000 });
      const firstTarget = (h.bot as any).activeDeliveryTargets.get("chat1");
      expect(firstTarget?.messageId).toBe("restore-1");

      await (h.bot as any).handleMessage(event({ chatType: "group", text: "第二条", messageId: "restore-2" }));
      const restored = (h.bot as any).activeDeliveryTargets.get("chat1");
      expect(restored?.messageId).toBe("restore-1");
      const secondRow = h.store.getMessageId("restore-2")!;
      expect(h.store.getPendingTriggerIds("GLM", "chat1").has(secondRow)).toBe(true);

      releaseFirst("first reply");
      await first;
      await vi.waitUntil(() => h.openclaw.chatCalls.length === 2, { timeout: 1500 });
      expect(h.openclaw.chatCalls[1].currentMessage).toBe("第二条");
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
      expect((h.bot as any).client.im.message.create.mock.invocationCallOrder[0])
        .toBeLessThan((h.bot as any).sendMessage.mock.invocationCallOrder[0]);
    } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("abandons exhausted status cleanup without reporting a successful answer as failed", async () => {
    const h = makeHarness("Claude");
    try {
      const meta = { messageId: "deleted-live-card", toolCalls: 3, elapsed: "0:30", model: "model-Claude", locale: "zh" as const };
      const id = h.store.enqueueDelivery({
        sessionKey: "lma-claude-chat1", chatId: "chat1", botName: "Claude",
        sourceType: "assistant_visible_status_cleanup", sourceId: "cleanup", deliveryKey: "trigger:cleanup",
        contentHash: "", content: "", attachmentsJson: "[]", replyToMessageId: "reply-1",
        deliveryMode: "patch_live_status", targetMessageId: meta.messageId,
        deliveryMetaJson: JSON.stringify(meta), textDelivered: true, cleanupPending: true,
      })!;
      (h.store as any).db.prepare("UPDATE delivery_outbox SET attempts = ? WHERE id = ?").run(4, id);
      (h.bot as any).patchLiveStatusDoneSummary = vi.fn(async () => { throw new Error("card deleted"); });
      await (h.bot as any).dispatchPendingDeliveries("chat1", "reply-1");
      expect(h.store.getDeliveryByKey("Claude", "chat1", "trigger:cleanup")).toMatchObject({ status: "delivered" });
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("reply-1", expect.stringContaining("失败"));
    } finally { h.cleanup(); }
  });

  it("retries a transient attachment failure and resumes from its durable cursor", async () => {
    vi.useFakeTimers();
    const h = makeHarness("Claude");
    try {
      let secondAttempts = 0;
      (h.bot as any).sendBridgeAttachment = vi.fn(async (_chatId: string, attachment: any) => {
        if (attachment.path === "/tmp/second") {
          secondAttempts++;
          if (secondAttempts === 1) throw new Error("upload exploded");
        }
      });
      await (h.bot as any).enqueueAndDispatchDelivery(
        "chat1", "assistant_visible", "source-attachment", "",
        [{ type: "file", path: "/tmp/first" }, { type: "file", path: "/tmp/second" }],
        "reply-to", "trigger:attachment",
      );
      expect(h.store.getPendingDeliveries("chat1", "Claude")).toHaveLength(1);
      expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("reply-to", expect.stringContaining("附件发送失败"));
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.waitUntil(() => h.store.getPendingDeliveries("chat1", "Claude").length === 0, { timeout: 1000 });
      expect((h.bot as any).sendBridgeAttachment.mock.calls.map((c: any[]) => c[1].path)).toEqual([
        "/tmp/first", "/tmp/second", "/tmp/second",
      ]);
    } finally { vi.useRealTimers(); h.cleanup(); }
  });

  it("reports an accurate terminal attachment error after the retry budget", async () => {
    const h = makeHarness("Claude");
    try {
      const id = h.store.enqueueDelivery({
        sessionKey: "lma-claude-chat1", chatId: "chat1", botName: "Claude",
        sourceType: "assistant_visible", sourceId: "terminal-attachment", deliveryKey: "trigger:terminal-attachment",
        contentHash: "h", content: "", attachmentsJson: JSON.stringify([{ type: "file", path: "/tmp/missing" }]),
        replyToMessageId: "reply-to",
      })!;
      (h.store as any).db.prepare("UPDATE delivery_outbox SET attempts = ? WHERE id = ?").run(4, id);
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => { throw new Error("upload exploded"); });
      await (h.bot as any).dispatchPendingDeliveries("chat1", "reply-to");
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-to", expect.stringContaining("附件发送失败"));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("reply-to", expect.not.stringContaining("最终回复发送失败"));
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
      // First failure is retained in the durable outbox and retried; do not
      // prematurely tell the user it is terminal or emit a fake provider error.
      expect(allReplies.filter((text: string) => text.includes("附件发送失败"))).toHaveLength(0);
      expect(allReplies.some((text: string) => text.includes("这次没有完成回复"))).toBe(false);
      expect(h.store.getPendingDeliveries("chat1", "GPT")).toHaveLength(1);
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

  it("parses bridge attachment markers even when the closing tag is corrupted to parameter", async () => {
    const h = makeHarness("GPT");
    try {
      const attachmentPath = resolve(tmpdir(), "olma-test-attachments", "bad-close.png");
      mkdirSync(dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, "fake-image");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `正文\n<LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"image","path":"${attachmentPath}","caption":"图"}]}</parameter>`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "生成图", messageId: "bad-close-marker" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("bad-close-marker", "正文");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", expect.objectContaining({ type: "image", path: attachmentPath, caption: "图" }));
      expect((h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]).join("\n")).not.toContain("LMA_BRIDGE_ATTACHMENTS");
    } finally { h.cleanup(); }
  });

  it("parses bridge attachment markers even when the opening tag loses the LMA prefix", async () => {
    const h = makeHarness("GPT");
    try {
      const attachmentPath = resolve(tmpdir(), "olma-test-attachments", "bad-open.png");
      mkdirSync(dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, "fake-image");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `正文\n_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"image","path":"${attachmentPath}","caption":"图"}]}</LMA_BRIDGE_ATTACHMENTS>`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "生成图", messageId: "bad-open-marker" }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("bad-open-marker", "正文");
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", expect.objectContaining({ type: "image", path: attachmentPath, caption: "图" }));
      expect((h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]).join("\n")).not.toContain("BRIDGE_ATTACHMENTS");
    } finally { h.cleanup(); }
  });

  it("recovers attachments when the opening marker is severely truncated (RIDGE_ATTACHMENTS>) and leaks no remnant", async () => {
    const h = makeHarness("GPT");
    try {
      const attachmentPath = resolve(tmpdir(), "olma-test-attachments", "severe-trunc.png");
      mkdirSync(dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, "fake-image");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        // The model dropped the entire `<LMA_B` prefix, leaving `RIDGE_ATTACHMENTS>`.
        // The JSON payload itself is intact — parse it regardless of the mangled tag.
        return `正文\nRIDGE_ATTACHMENTS>{"attachments":[{"type":"image","path":"${attachmentPath}","caption":"活度图叠CT/前位平片/后位平片,共享强度标尺"}]}</LMA_BRIDGE_ATTACHMENTS>`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "发图", messageId: "severe-trunc" }));
      // Attachment recovered with the right path + caption.
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", expect.objectContaining({ type: "image", path: attachmentPath, caption: "活度图叠CT/前位平片/后位平片,共享强度标尺" }));
      // The visible text keeps ONLY the real body — no marker remnant leaks.
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("severe-trunc", "正文");
      const delivered = (h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]).join("\n");
      expect(delivered).not.toMatch(/ATTACHMENTS|RIDGE|<\/parameter>/i);
    } finally { h.cleanup(); }
  });

  it("recovers attachments when the opening marker is gone entirely (JSON only before closer)", async () => {
    const h = makeHarness("GPT");
    try {
      const attachmentPath = resolve(tmpdir(), "olma-test-attachments", "no-open.png");
      mkdirSync(dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, "fake-image");
      h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
        h.openclaw.chatCalls.push(params);
        return `正文\n{"attachments":[{"type":"image","path":"${attachmentPath}","caption":"图"}]}</LMA_BRIDGE_ATTACHMENTS>`;
      });
      (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
      await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "发图", messageId: "no-open" }));
      expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", expect.objectContaining({ type: "image", path: attachmentPath }));
      expect((h.bot as any).replyMessage).toHaveBeenCalledWith("no-open", "正文");
      expect((h.bot as any).replyMessage.mock.calls.map((c: any[]) => c[1]).join("\n")).not.toMatch(/ATTACHMENTS|<\/parameter>/i);
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

  describe("auto-retry on truncated replies", () => {
    const prev = process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY;
    afterEach(() => { process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = prev; });

    it("detects truncation, confirms with the session, and delivers the original when done", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          // First (real) reply looks truncated (ends on a dangling connector).
          if (h.openclaw.chatCalls.length === 1) return "我先看一下代码，然后";
          // Probe round: session says it is done.
          return "结束了";
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "帮我改代码", messageId: "m1" }));
        // One real call + one confirmation probe.
        expect(h.openclaw.chatCalls).toHaveLength(2);
        expect(h.openclaw.chatCalls[1].currentMessage).toContain("结束了吗");
        // Delivers the ORIGINAL reply (the done phrase is never shown to the user).
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "我先看一下代码，然后");
        expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("m1", "结束了");
      } finally { h.cleanup(); }
    });

    it("recognizes wrapped done phrases ('已经结束了') and rejects negations ('还没结束')", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        let n = 0;
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          n++;
          if (n === 1) return "先看代码，然后"; // truncated (dangling connector) -> probe
          if (n === 2) return "还没结束，我接着"; // negation + truncated -> NOT done, keep going
          return "好的，已经结束了"; // wrapped done phrase -> confirmed
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "多轮", messageId: "m1" }));
        // probe1 (negation, not done) -> reply becomes that, re-checked (truncated) ->
        // probe2 returns wrapped done -> stop. 1 real + 2 probes = 3.
        expect(h.openclaw.chatCalls).toHaveLength(3);
        // The negation reply was the latest before the done confirmation, so it is
        // delivered (the '已经结束了' confirmation itself is never shown).
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "还没结束，我接着");
        expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("m1", "好的，已经结束了");
      } finally { h.cleanup(); }
    });

    it("keeps looping while the session continues, then delivers the latest result", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          const n = h.openclaw.chatCalls.length;
          if (n === 1) return "先处理第一步然后"; // truncated
          if (n === 2) return "继续处理第二步接下来"; // still truncated -> keeps going
          return "全部完成了。"; // complete sentence -> stop
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "多步任务", messageId: "m1" }));
        // real + 2 probes (3rd reply ends cleanly so no further probe).
        expect(h.openclaw.chatCalls).toHaveLength(3);
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "全部完成了。");
      } finally { h.cleanup(); }
    });

    it("stops at the retry budget and delivers the latest result", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_MAX = "3";
      const h = makeHarness("GPT");
      try {
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          return "还在处理中然后"; // always truncated, never says done
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "停不下来的任务", messageId: "m1" }));
        // real call + 3 probes = 4 total (budget = 3).
        expect(h.openclaw.chatCalls).toHaveLength(4);
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "还在处理中然后");
      } finally {
        delete process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_MAX;
        h.cleanup();
      }
    });

    it("does not retry a reply that ends cleanly", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          return "任务已经完成。"; // ends with period -> no retry
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "正常任务", messageId: "m1" }));
        expect(h.openclaw.chatCalls).toHaveLength(1);
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "任务已经完成。");
      } finally { h.cleanup(); }
    });

    it("does not retry completed-looking replies merely because they lack punctuation", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const examples = [
        "我先看一下代码再改这里",
        "ARK_OPENCLAW_OK",
        "openclaw-lark-multi-agent",
        "Providers: deepseek github-copilot phgeek-gw",
        "模型配置已经更新完成",
        "C:\\Users\\51694\\.openclaw\\extensions\\lma-steer",
        "sha256:abcdef123456",
      ];
      for (const [i, reply] of examples.entries()) {
        const h = makeHarness("GPT");
        try {
          h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
            h.openclaw.chatCalls.push(params);
            return reply;
          });
          await (h.bot as any).handleMessage(event({ chatType: "p2p", text: `case-${i}`, messageId: `no-punct-${i}` }));
          expect(h.openclaw.chatCalls, reply).toHaveLength(1);
        } finally { h.cleanup(); }
      }
    });

    it("retries only explicit prose lead-in colons, not structural colons", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const suspicious = makeHarness("GPT");
      try {
        suspicious.openclaw.replies.push("原因如下：", "结束了");
        await (suspicious.bot as any).handleMessage(event({ chatType: "p2p", text: "原因", messageId: "colon-leadin" }));
        expect(suspicious.openclaw.chatCalls).toHaveLength(2);
      } finally { suspicious.cleanup(); }

      for (const reply of ["https://example.com/path:", "12:30", "key:value", "C:\\work:"]) {
        const h = makeHarness("GPT");
        try {
          h.openclaw.replies.push(reply);
          await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "结构文本", messageId: `struct-${reply}` }));
          expect(h.openclaw.chatCalls, reply).toHaveLength(1);
        } finally { h.cleanup(); }
      }
    });

    it("uses an English done-phrase in English locale and detects it", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        h.store.setChatLocale("chat1", "en");
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          if (h.openclaw.chatCalls.length === 1) return "I need to inspect it, let me"; // explicit continuation cue
          return "DONE"; // English confirmation
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "fix the code", messageId: "m1" }));
        expect(h.openclaw.chatCalls).toHaveLength(2);
        // English probe must be fully English (no Chinese mixed in).
        expect(h.openclaw.chatCalls[1].currentMessage).toContain("DONE");
        expect(h.openclaw.chatCalls[1].currentMessage).not.toMatch(/[\u4e00-\u9fff]/);
        // Delivers the original truncated-looking reply; DONE is not shown.
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "I need to inspect it, let me");
        expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("m1", "DONE");
      } finally { h.cleanup(); }
    });

    it("does not retry NO_REPLY", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          return "NO_REPLY";
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "不需要回复", messageId: "m1" }));
        expect(h.openclaw.chatCalls).toHaveLength(1);
      } finally { h.cleanup(); }
    });

    it("delivers the existing reply when the confirmation probe fails (no compact, no spin)", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        let n = 0;
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          n++;
          if (n === 1) return "处理中，然后"; // truncated -> probe
          throw new Error("LLM request timed out"); // probe fails -> stop, no compact
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "任务", messageId: "m1" }));
        // Never auto-compacts on a failed probe anymore.
        expect(h.openclaw.compactSession).not.toHaveBeenCalled();
        // Delivers the existing truncated-looking reply rather than spinning.
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", "处理中，然后");
      } finally { h.cleanup(); }
    });

    it("does not retry a reply that produced attachments (hard rule), even if the text looks truncated", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        const dir = mkdtempSync(join(tmpdir(), "lma-attach-"));
        const attachmentPath = join(dir, "out.png");
        writeFileSync(attachmentPath, "x");
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          // Short, no trailing punctuation (would look truncated) BUT carries an
          // attachment marker -> hard rule must skip auto-retry.
          return `已生成\n<LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"image","path":"${attachmentPath}","caption":"图"}]}</LMA_BRIDGE_ATTACHMENTS>`;
        });
        (h.bot as any).sendBridgeAttachment = vi.fn(async () => {});
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "画个图", messageId: "m1" }));
        // No probe round: exactly one call.
        expect(h.openclaw.chatCalls).toHaveLength(1);
        // Attachment still delivered.
        expect((h.bot as any).sendBridgeAttachment).toHaveBeenCalledWith("chat1", expect.objectContaining({ type: "image", path: attachmentPath }));
      } finally { h.cleanup(); }
    });

    it("stops auto-retrying immediately when the user runs /stop mid-loop", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        let n = 0;
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          n++;
          if (n === 1) return "先看代码，然后"; // truncated -> enters auto-retry
          if (n === 2) {
            // The probe comes back "still working" (would normally loop again)...
            // ...but the user hits /stop right now, mid-loop.
            await (h.bot as any).handleStopCommand("chat1", "stop-msg");
            return "还在处理中然后"; // not a done phrase -> loop would continue if not stopped
          }
          return "不应该走到这里"; // a 3rd probe would mean stop was ignored
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "改代码", messageId: "m1" }));
        // 1 real run + exactly 1 probe (the one during which /stop fired). No 3rd call.
        expect(h.openclaw.chatCalls).toHaveLength(2);
        // /stop confirmation was sent.
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("stop-msg", expect.stringContaining("已停止"));
      } finally { h.cleanup(); }
    });

    it("does NOT auto-retry when /stop fired DURING the main run (before auto-retry)", async () => {
      // Reproduces the reported bug: user hits /stop while the main run is going;
      // the main run returns a truncated-looking partial reply; auto-retry must
      // NOT kick in and re-trigger work.
      process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "1";
      const h = makeHarness("GPT");
      try {
        let n = 0;
        h.openclaw.chatSendWithContext = vi.fn(async (params: any) => {
          h.openclaw.chatCalls.push(params);
          n++;
          if (n === 1) {
            // Main run: user stops it mid-flight, then it returns a partial
            // (truncated-looking) reply because it was interrupted.
            await (h.bot as any).handleStopCommand("chat1", "stop-msg");
            return "我正在处理，然后"; // dangling connector -> looksTruncated true
          }
          return "不应该重试"; // any 2nd call = auto-retry wrongly fired
        });
        await (h.bot as any).handleMessage(event({ chatType: "p2p", text: "干个活", messageId: "m1" }));
        // Exactly ONE call (the main run). No probe, because /stop during the main
        // run bumped the epoch past the pre-run baseline.
        expect(h.openclaw.chatCalls).toHaveLength(1);
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("stop-msg", expect.stringContaining("已停止"));
      } finally { h.cleanup(); }
    });
  });

  describe("/compact command honors the actual compaction result", () => {
    it("reports success when native compaction actually compacted", async () => {
      const h = makeHarness("GPT");
      try {
        h.openclaw.compactSession = vi.fn(async () => ({ ok: true, compacted: true })) as any;
        await (h.bot as any).handleCompactCommand("chat1", "m1");
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("已压缩"));
      } finally { h.cleanup(); }
    });

    it("reports a no-op when semantic compaction and Gateway transcript trim both skip", async () => {
      const h = makeHarness("GPT");
      try {
        h.openclaw.compactSession = vi.fn(async (_key: string, options?: { maxLines?: number }) => options?.maxLines
          ? ({ ok: true, compacted: false, reason: "transcript too small" })
          : ({ ok: true, compacted: false, reason: "prompt too long" })) as any;
        await (h.bot as any).handleCompactCommand("chat1", "m1");
        expect(h.openclaw.compactSession).toHaveBeenNthCalledWith(1, expect.any(String));
        expect(h.openclaw.compactSession).toHaveBeenNthCalledWith(2, expect.any(String), { maxLines: 200 });
        expect((h.bot as any).replyMessage).not.toHaveBeenCalledWith("m1", expect.stringContaining("已压缩"));
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("未压缩"));
      } finally { h.cleanup(); }
    });

    it("falls back to Gateway-owned transcript trim for SQLite-compatible compaction", async () => {
      const h = makeHarness("GPT");
      try {
        h.openclaw.compactSession = vi.fn(async (_key: string, options?: { maxLines?: number }) => options?.maxLines
          ? ({ ok: true, compacted: true, kept: 137 })
          : ({ ok: true, compacted: false, reason: "prompt too long" })) as any;
        await (h.bot as any).handleCompactCommand("chat1", "m1");
        expect(h.openclaw.compactSession).toHaveBeenNthCalledWith(2, expect.any(String), { maxLines: 200 });
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("转录裁剪"));
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("137"));
      } finally { h.cleanup(); }
    });

    it("reports both failures when semantic compaction and transcript trim throw", async () => {
      const h = makeHarness("GPT");
      try {
        h.openclaw.compactSession = vi.fn(async (_key: string, options?: { maxLines?: number }) => {
          if (options?.maxLines) throw new Error("trim rpc timeout");
          throw new Error("semantic rpc timeout");
        }) as any;
        await (h.bot as any).handleCompactCommand("chat1", "m1");
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("semantic rpc timeout"));
        expect((h.bot as any).replyMessage).toHaveBeenCalledWith("m1", expect.stringContaining("trim rpc timeout"));
      } finally { h.cleanup(); }
    });
  });

  describe("high-context alert", () => {
    const prev = process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT;
    afterEach(() => { process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT = prev; });

    it("alerts once when context crosses the threshold, then stays quiet until it drops", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT = "80";
      const h = makeHarness("GPT");
      try {
        (h.bot as any).sendMessage = vi.fn(async () => {});
        // 85% usage.
        h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 850, contextTokens: 1000 } })) as any;
        await (h.bot as any).maybeAlertHighContext("chat1");
        await (h.bot as any).maybeAlertHighContext("chat1"); // still high -> no second alert
        expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(1);
        expect((h.bot as any).sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("85%"));
      } finally { h.cleanup(); }
    });

    it("re-arms after usage drops, alerting again on the next crossing", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT = "80";
      const h = makeHarness("GPT");
      try {
        (h.bot as any).sendMessage = vi.fn(async () => {});
        let pctTokens = 850;
        h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: pctTokens, contextTokens: 1000 } })) as any;
        await (h.bot as any).maybeAlertHighContext("chat1"); // 85% -> alert
        pctTokens = 600; // dropped (e.g. after compact) to 60%
        await (h.bot as any).maybeAlertHighContext("chat1"); // re-arms, no alert
        pctTokens = 900; // climbs back to 90%
        await (h.bot as any).maybeAlertHighContext("chat1"); // alert again
        expect((h.bot as any).sendMessage).toHaveBeenCalledTimes(2);
      } finally { h.cleanup(); }
    });

    it("does not alert below the threshold", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT = "80";
      const h = makeHarness("GPT");
      try {
        (h.bot as any).sendMessage = vi.fn(async () => {});
        h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 500, contextTokens: 1000 } })) as any;
        await (h.bot as any).maybeAlertHighContext("chat1");
        expect((h.bot as any).sendMessage).not.toHaveBeenCalled();
      } finally { h.cleanup(); }
    });

    it("is disabled when threshold is 0", async () => {
      process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT = "0";
      const h = makeHarness("GPT");
      try {
        (h.bot as any).sendMessage = vi.fn(async () => {});
        h.openclaw.getSessionInfo = vi.fn(async () => ({ session: { totalTokens: 990, contextTokens: 1000 } })) as any;
        await (h.bot as any).maybeAlertHighContext("chat1");
        expect((h.bot as any).sendMessage).not.toHaveBeenCalled();
      } finally { h.cleanup(); }
    });
  });
});
