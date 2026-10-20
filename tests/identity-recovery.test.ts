import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore } from "../src/message-store.js";
import { requestBotIdentity, trustedBotOpenId } from "../src/bot-identity.js";
import { OpenClawClient } from "../src/openclaw-client.js";

process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "0";
const APP = "cli_1111111111111111";
const SELF = "ou_22222222222222222222222222222222";
const GROUP = "oc_33333333333333333333333333333333";
const info = () => ({ code: 0, bot: { open_id: SELF, app_name: "测试助手" } });
const mentions = [{ key: "@_user_1", name: "测试助手", id: { open_id: SELF } }];
function event(id: string, text = "@_user_1 在吗", extra: any = {}) {
  return { sender: { sender_type: "user", sender_id: { open_id: "ou_human" } },
    message: { chat_id: GROUP, chat_type: "group", message_type: "text", message_id: id,
      content: JSON.stringify({ text }), mentions, ...extra } };
}
const directories: string[] = [];
const stores = new Set<MessageStore>();
function fixture(path?: string, appId = APP) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), "lma-identity-"));
  if (dir) directories.push(dir);
  const dbPath = path || join(dir!, "messages.db");
  const store = new MessageStore(dbPath); stores.add(store);
  const gateway: any = {
    getSessionInfo: vi.fn(async () => ({ session: { sessionId: "identity-generation", totalTokens: 0 } })),
    ensureModel: vi.fn(async () => false), createSession: vi.fn(async () => {}),
    injectAssistantMessage: vi.fn(async () => ({})), subscribeSession: vi.fn(async () => {}), onToolEvent: vi.fn(),
    abortChat: vi.fn(async () => {}), resetSession: vi.fn(async () => "ok"),
    chatSendWithContext: vi.fn(async (params: any) => { await params.onSendAttempt?.(); await params.onSubmitted?.("identity-run"); return "你好。"; }),
  };
  const bot: any = new FeishuBot({ name: "GPT", appId, appSecret: "offline-secret", model: "offline-model" }, gateway, store);
  bot.register();
  bot.fetchAndCacheChatInfo = vi.fn(async (chatId: string, chatType: string) => {
    store.upsertChatInfo({ chatId, chatType: chatType as any, chatName: "Identity Fixture Group", members: "", memberNames: "",
      ownerBot: chatType === "p2p" ? "GPT" : "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: Date.now() });
  });
  bot.ensureSession = vi.fn(async (id: string) => bot.getSessionKey(id));
  bot.goController.recoverOnStartup = vi.fn(async () => {});
  bot.goController.pauseSilently = vi.fn(async () => {});
  bot.wsClient.start = vi.fn(async () => {});
  bot.requestIdentity = vi.fn(async () => info());
  bot.addReaction = vi.fn(async () => {}); bot.removeReaction = vi.fn(async () => {});
  let receipt = 0;
  const send = vi.fn(async (params: any) => ({ code: 0, data: { message_id: `reply-${++receipt}`,
    chat_id: params?.data?.receive_id || store.getMessageByMessageId(params?.path?.message_id)?.chatId || GROUP } }));
  bot.client = { im: { message: { create: send, reply: send, patch: vi.fn(async () => ({ code: 0 })) } } };
  bot.replyMessage = vi.fn((FeishuBot.prototype as any).replyMessage.bind(bot));
  bot.sendMessage = vi.fn((FeishuBot.prototype as any).sendMessage.bind(bot));
  bot.sendLiveStatusCard = bot.replyLiveStatusCard = vi.fn(async () => "live-status");
  bot.patchLiveStatusCard = bot.patchLiveStatusDoneSummary = vi.fn(async () => {});
  return { bot, store, gateway, dbPath };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function close(store: MessageStore) { store.close(); stores.delete(store); }
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true }); directories.length = 0;
  FeishuBot.getAllBots().clear(); (FeishuBot as any).seenBotChats.clear();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe("trusted identity recovery through actual start/handleMessage", () => {
  it("recovers startup DNS failure in the background without a new message", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND open.feishu.cn"));
    await h.bot.start();
    expect(h.bot.botOpenId).toBeNull(); expect(h.bot.wsClient.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.bot.botOpenId).toBe(SELF);
    await vi.advanceTimersByTimeAsync(600_000); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("recovers on demand before dedup and handles the real target exactly once (app pair=%s)", async withApp => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValueOnce(new Error("ENOTFOUND open.feishu.cn"));
    await h.bot.start();
    // Advance wall time WITHOUT firing the background retry: ingress owns discovery.
    vi.setSystemTime(Date.now() + 5_001);
    const original = event("fresh-843", "@_user_1 在吗", withApp ? { mentions: [{ ...mentions[0], id: { app_id: APP, open_id: SELF } }] } : {});
    const received = Promise.all([h.bot.handleMessage(original), h.bot.handleMessage(original)]);
    await tick(); await vi.advanceTimersByTimeAsync(500); await received;
    expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.config.name).toBe("GPT");
    expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    await h.bot.handleMessage(original);
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    expect(h.store.hasBotProcessed("GPT", "fresh-843")).toBe(true);
    expect(h.store.listIdentityIngress("GPT", APP)).toEqual([]);
    expect(h.store.getRecent(GROUP).filter(row => row.senderType === "human").map(row => row.messageId)).toEqual(["fresh-843"]);
  });

  it("retains unresolved original events durably, with no admission or acknowledgment, then recovers them", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("unresolved", "@_user_1 /help"));
    expect(h.store.listIdentityIngress("GPT", APP)).toHaveLength(1);
    expect(h.store.hasBotProcessed("GPT", "unresolved")).toBe(false);
    expect(h.store.getMessageCount(GROUP)).toBe(0); expect(h.store.getPendingTriggerIds("GPT", GROUP).size).toBe(0);
    expect(h.bot.replyMessage).not.toHaveBeenCalled(); expect(h.bot.addReaction).not.toHaveBeenCalled();
    expect(h.bot.busyChats.size).toBe(0); expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    h.bot.requestIdentity.mockResolvedValue(info());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.store.hasBotProcessed("GPT", "unresolved")).toBe(true);
  });

  it("single-flights concurrent different mentions and duplicate events, preserving retained order", async () => {
    const h = fixture(); let release!: (x: any) => void;
    h.bot.requestIdentity.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = h.bot.handleMessage(event("first", "@_user_1 /help"));
    const second = h.bot.handleMessage(event("second", "@_user_1 /help"));
    const duplicate = h.bot.handleMessage(event("first", "@_user_1 /help"));
    await tick(); expect(h.bot.requestIdentity).toHaveBeenCalledOnce(); release(info());
    await Promise.all([first, second, duplicate]);
    expect(h.bot.replyMessage.mock.calls.map((call: any[]) => call[0])).toEqual(["first", "second"]);
    expect(h.store.getMessageCount(GROUP)).toBe(2);
  });

  it("bounds a hung initial probe, starts WS, keeps private input unblocked, and refuses late identity", async () => {
    vi.useFakeTimers(); const h = fixture(); let release!: (x: any) => void; let signal!: AbortSignal;
    h.bot.requestIdentity.mockImplementation((s: AbortSignal) => { signal = s; return new Promise(resolve => { release = resolve; }); });
    const startup = h.bot.start(); await tick();
    const group = h.bot.handleMessage(event("hung"));
    await h.bot.handleMessage(event("private", "/help", { chat_id: "private", chat_type: "p2p", mentions: [] }));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000); await Promise.all([startup, group]);
    expect(signal.aborted).toBe(true); expect(h.bot.wsClient.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600_000); expect(h.bot.requestIdentity).toHaveBeenCalledOnce();
    release(info()); await tick(); expect(h.bot.botOpenId).toBeNull();
    h.bot.requestIdentity.mockResolvedValue(info());
    await vi.advanceTimersByTimeAsync(5_000); // A settled transport can be retried, but never late trusted.
    expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
  });

  it("close cancels the deadline, startup and all recovery work without late writes", async () => {
    vi.useFakeTimers(); const h = fixture(); let release!: (x: any) => void; let signal!: AbortSignal;
    h.bot.requestIdentity.mockImplementation((s: AbortSignal) => { signal = s; return new Promise(resolve => { release = resolve; }); });
    const startup = h.bot.start(); const group = h.bot.handleMessage(event("closing")); await tick();
    close(h.store); await Promise.all([startup, group]);
    expect(signal.aborted).toBe(true); release(info()); await tick();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.bot.botOpenId).toBeNull(); expect(h.bot.requestIdentity).toHaveBeenCalledOnce();
    expect(h.bot.wsClient.start).not.toHaveBeenCalled(); expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it("recovers an abortable hung request on the next background retry", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted identity HTTP")), { once: true });
    }));
    const startup = h.bot.start(); const received = h.bot.handleMessage(event("abortable", "@_user_1 /help"));
    await vi.advanceTimersByTimeAsync(2_000); await Promise.all([startup, received]);
    expect(h.bot.botOpenId).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
  });

  it("does not even start identity HTTP when closed before its first microtask", async () => {
    const h = fixture(); const startup = h.bot.start(); close(h.store); await startup; await tick();
    expect(h.bot.requestIdentity).not.toHaveBeenCalled(); expect(h.bot.wsClient.start).not.toHaveBeenCalled();
  });

  it("fresh targeted /reset follows the existing command path once after recovery", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValueOnce(new Error("ENOTFOUND open.feishu.cn"));
    await h.bot.start();
    await h.bot.handleMessage(event("fresh-reset", "@_user_1 /reset"));
    await vi.advanceTimersByTimeAsync(7_100);
    expect(h.gateway.resetSession).toHaveBeenCalledOnce();
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    await h.bot.handleMessage(event("fresh-reset", "@_user_1 /reset"));
    expect(h.gateway.resetSession).toHaveBeenCalledOnce();
  });

  it.each([{}, { code: 0, bot: {} }, { bot: { open_id: "测试助手" } }, { code: 99991672, bot: { open_id: SELF } },
    { bot: { open_id: SELF, app_id: "cli_foreign" } }])("retries empty/bad/permission identity evidence: %j", async response => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockResolvedValueOnce(response);
    await h.bot.start(); expect(h.bot.botOpenId).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000); expect(h.bot.botOpenId).toBe(SELF);
  });

  it("paces and caps backoff even when mention events arrive continuously", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("permission denied"));
    await h.bot.start();
    for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000].entries()) {
      await Promise.all(Array.from({ length: 8 }, (_, n) => h.bot.handleMessage(event(`wave-${index}-${n}`))));
      const count = h.bot.requestIdentity.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(count + 1);
    }
  });

  it.each([
    [{ open_id: "ou_foreign" }, "GPT"], [{ open_id: "ou_human" }, "测试助手"],
    [{ app_id: "cli_foreign", open_id: SELF }, "测试助手"], [{ app_id: APP, open_id: "ou_foreign" }, "测试助手"],
    [{ user_id: SELF }, "GPT"], [{}, "GPT"],
  ])("refuses foreign/human/conflicting/untrusted name targets %j", async (id, name) => {
    const h = fixture();
    await h.bot.handleMessage(event("unsafe", "@_user_1 /help", { mentions: [{ key: "@_user_1", name, id }] }));
    expect(h.bot.replyMessage).not.toHaveBeenCalled(); expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it("does not defer unsupported events or interfere with @all, app-only and private routing", async () => {
    const h = fixture();
    await h.bot.handleMessage(event("unsupported", "x", { message_type: "unknown" }));
    await h.bot.handleMessage(event("all", "@_all /help", { mentions: [{ key: "@_all", id: { open_id: "all" } }] }));
    await h.bot.handleMessage(event("app", "@_user_1 /help", { mentions: [{ key: "@_user_1", id: { app_id: APP } }] }));
    await h.bot.handleMessage(event("p2p", "/help", { chat_id: "p2p", chat_type: "p2p", mentions: [] }));
    expect(h.bot.requestIdentity).not.toHaveBeenCalled(); expect(h.bot.replyMessage).toHaveBeenCalledTimes(3);
    expect(h.store.hasBotProcessed("GPT", "unsupported")).toBe(false);
  });

  it("keeps independent app-ID proof with unknown identity and mixed self+human mentions", async () => {
    const h = fixture();
    await h.bot.handleMessage(event("app-mixed", "@_user_1 /help", { mentions: [
      { key: "@_user_1", id: { app_id: APP } }, { id: { open_id: "ou_human" } },
    ] }));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.bot.requestIdentity).not.toHaveBeenCalled(); expect(h.bot.botOpenId).toBeNull();
  });

  it("fails closed when recovered open-ID evidence matches multiple registered bots", async () => {
    const h = fixture(), other = fixture(undefined, "cli_other");
    other.bot.store = h.store; other.bot.config.name = "Other"; other.bot.botOpenId = SELF;
    await h.bot.handleMessage(event("ambiguous", "@_user_1 /help"));
    expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it("preserves p2p owner isolation while identity API is broken", async () => {
    const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    h.store.upsertChatInfo({ chatId: "other-private", chatType: "p2p", ownerBot: "Other", chatName: "", members: "", memberNames: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: Date.now() });
    h.bot.fetchAndCacheChatInfo.mockImplementation(async () => {});
    await h.bot.handleMessage(event("other-private-event", "/help", { chat_id: "other-private", chat_type: "p2p", mentions: [] }));
    expect(h.bot.replyMessage).not.toHaveBeenCalled(); expect(h.bot.requestIdentity).not.toHaveBeenCalled();
  });

  it("recovers rich-post open-ID-only mentions via the same trusted path", async () => {
    const h = fixture();
    await h.bot.handleMessage(event("post", "", { message_type: "post", mentions: [], content: JSON.stringify({ content: [[{ tag: "at", user_id: SELF, user_name: "测试助手" }, { tag: "text", text: " /help" }]] }) }));
    expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it("resumes only explicit unresolved custody across restart, not today's already-processed 841/842", async () => {
    const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    for (const id of ["om_previous_processed_reset", "om_previous_processed_mention"]) {
      h.store.markBotProcessed("GPT", id); h.store.insert({ chatId: GROUP, messageId: id, senderType: "human", senderName: "user", content: "/reset", timestamp: Date.now() });
      await h.bot.handleMessage(event(id));
    }
    await h.bot.fetchAndCacheChatInfo(GROUP, "group");
    await h.bot.handleMessage(event("new-unresolved", "@_user_1 /help"));
    close(h.store); const restarted = fixture(h.dbPath); await restarted.bot.start();
    await restarted.bot.drainIdentityIngress();
    expect(restarted.bot.replyMessage.mock.calls.map((call: any[]) => call[0])).toEqual(["new-unresolved"]);
    expect(restarted.gateway.resetSession).not.toHaveBeenCalled(); expect(restarted.gateway.chatSendWithContext).not.toHaveBeenCalled();
    await restarted.bot.handleMessage(event("new-unresolved", "@_user_1 /help")); expect(restarted.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it.each(["stop", "recall", "expire", "already-processed", "changed-app"])("fences durable unresolved custody after %s", async mode => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.handleMessage(event("fenced", "@_user_1 /help"));
    if (mode === "stop") await h.bot.handleStopCommand(GROUP, "stop-request");
    if (mode === "recall") await h.bot.handleMessageRecalled({ chat_id: GROUP, message_id: "fenced" });
    if (mode === "expire") vi.setSystemTime(Date.now() + 15 * 60_000);
    if (mode === "already-processed") h.store.markBotProcessed("GPT", "fenced");
    close(h.store); const restarted = fixture(h.dbPath, mode === "changed-app" ? "cli_replacement" : APP);
    await restarted.bot.start(); await restarted.bot.drainIdentityIngress();
    expect(restarted.bot.replyMessage).not.toHaveBeenCalled(); expect(restarted.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it.each(["stop", "recall"])("rechecks %s fences after async routing preparation", async fence => {
    const h = fixture(); let release!: () => void;
    h.bot.fetchAndCacheChatInfo.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = h.bot.handleMessage(event("stopped-during-fetch", "@_user_1 /help"));
    await tick(); expect(release).toBeDefined();
    if (fence === "stop") h.store.bumpStopGeneration("GPT", GROUP);
    else h.store.markMessageRecalled("stopped-during-fetch", GROUP);
    release(); await pending;
    expect(h.bot.replyMessage).not.toHaveBeenCalled(); expect(h.store.getMessageCount(GROUP)).toBe(0);
  });

  it("prevents a real asynchronous chat-info lookup from writing after store close", async () => {
    const h = fixture(); let release!: (result: any) => void;
    h.bot.fetchAndCacheChatInfo = (FeishuBot.prototype as any).fetchAndCacheChatInfo.bind(h.bot);
    const members = vi.fn(async () => ({ data: { items: [] } }));
    h.bot.client.im.chat = { get: vi.fn(() => new Promise(resolve => { release = resolve; })) };
    h.bot.client.im.chatMembers = { get: members };
    const pending = h.bot.handleMessage(event("close-during-chat-info", "@_user_1 /help"));
    await tick(); expect(release).toBeDefined(); close(h.store);
    release({ data: { name: "Identity Fixture Group" } }); await pending;
    expect(members).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("bounds unresolved custody by count and payload, never turns overflow into admission", async () => {
    const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    for (let n = 0; n < 101; n++) await h.bot.handleMessage(event(`bounded-${n}`, "@_user_1 /help"));
    await h.bot.handleMessage(event("oversized", "@_user_1 " + "x".repeat(64 * 1024)));
    expect(h.store.listIdentityIngress("GPT", APP)).toHaveLength(100);
    expect(h.store.hasBotProcessed("GPT", "bounded-100")).toBe(false);
    expect(h.bot.requestIdentity).toHaveBeenCalledOnce(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.getPendingTriggerIds("GPT", GROUP).size).toBe(0);
  });
});

describe("original-account transport and identity validation", () => {
  it("bounds SDK authentication and bot-info HTTP with the same abort signal", async () => {
    const controller = new AbortController();
    const http = vi.spyOn(lark.defaultHttpInstance, "request").mockImplementation(async (options: any) => {
      if (options.url.includes("tenant_access_token")) return { code: 0, tenant_access_token: "offline-token", expire: 7200 };
      return info();
    });
    const result = await requestBotIdentity({ name: "GPT", appId: "cli_transport_test_unique", appSecret: "offline", model: "offline" }, controller.signal, 2_000);
    expect(trustedBotOpenId(result, APP)).toBe(SELF);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info/", signal: controller.signal, timeout: 2_000 }));
    const tokenCalls = http.mock.calls.filter(([options]: any) => options.url.includes("tenant_access_token"));
    expect(tokenCalls).toHaveLength(1); expect(tokenCalls[0][0]).toMatchObject({ signal: controller.signal, timeout: 2_000 });
  });

  it("accepts the documented root bot and compatible nested bot envelopes, never names or legacy arbitrary IDs", () => {
    expect(trustedBotOpenId(info(), APP)).toBe(SELF);
    expect(trustedBotOpenId({ code: 0, data: { bot: { open_id: SELF } } }, APP)).toBe(SELF);
    expect(trustedBotOpenId({ data: { pingBotInfo: { botID: SELF } } }, APP)).toBeNull();
    expect(trustedBotOpenId({ bot: { open_id: 123, app_name: SELF } }, APP)).toBeNull();
  });
});

// Parent regressions, retained as permanent offline coverage. Normalize the
// timer helper result across Vitest variants returning either `vi` or void.
describe("parent identity recovery adversarial schedules", () => {
  it("a transient custody-prune failure must not escape the retry timer or prevent later identity recovery", async () => {
    vi.useFakeTimers(); const h=fixture();
    h.bot.requestIdentity.mockRejectedValueOnce(new Error("startup DNS"));
    await h.bot.start();
    vi.spyOn(h.store,"pruneIdentityIngress").mockImplementationOnce(()=>{throw Object.assign(new Error("temporary identity SQLite busy"),{code:"SQLITE_BUSY"});});
    await expect(vi.advanceTimersByTimeAsync(5_000).then(()=>undefined)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.botOpenId).toBe(SELF);
  });
  it("a long-running recovered ordinary input must not block a following recovered /help", async () => {
    vi.useFakeTimers(); const h=fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start();
    await h.bot.handleMessage(event("long-running-text"));
    await h.bot.handleMessage(event("later-help","@_user_1 /help"));
    h.gateway.chatSendWithContext.mockImplementation(async (params:any)=>{await params.onSendAttempt?.();await params.onSubmitted?.("long-run");return new Promise(()=>{});});
    h.bot.requestIdentity.mockResolvedValue(info());
    await vi.advanceTimersByTimeAsync(5_500); await tick();
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    expect(h.bot.replyMessage.mock.calls.some((call:any[])=>call[0]==="later-help")).toBe(true);
  });
});

describe("identity custody repair and business-owner handoff", () => {
  const busy = () => Object.assign(new Error("temporary identity SQLite busy"), { code: "SQLITE_BUSY" });

  it.each(["listIdentityIngress", "claimIdentityIngress", "pruneIdentityIngress"] as const)(
    "recovers %s failure after identity succeeds, without any further identity request", async method => {
      vi.useFakeTimers(); const h = fixture();
      h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
      await h.bot.start(); await h.bot.handleMessage(event("held-after-discovery", "@_user_1 /help"));
      // Set only after retention, so failure belongs to the recovery drain.
      const original = h.store[method].bind(h.store) as (...args: any[]) => any;
      const journal = vi.spyOn(h.store, method).mockImplementationOnce(() => { throw busy(); });
      h.bot.requestIdentity.mockResolvedValue(info());
      if (method === "pruneIdentityIngress") {
        // The timer's discovery pre-prune succeeds; fail the drain's list prune.
        journal.mockReset().mockImplementation((...args: any[]) => original(...args))
          .mockImplementationOnce((...args: any[]) => original(...args))
          .mockImplementationOnce(() => { throw busy(); });
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.bot.botOpenId).toBe(SELF); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
      expect(h.store.hasIdentityIngress("GPT", APP, "held-after-discovery")).toBe(true);
      expect(h.store.hasBotProcessed("GPT", "held-after-discovery")).toBe(false);
      expect(h.bot.replyMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999); expect(h.bot.replyMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.bot.replyMessage).toHaveBeenCalledOnce();
      expect(h.store.hasIdentityIngress("GPT", APP, "held-after-discovery")).toBe(false);
      expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.bot.replyMessage).toHaveBeenCalledOnce(); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
    });

  it("paces and caps repeated known-identity journal failures without probing or busy admission", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("local-backoff", "@_user_1 /help"));
    const journal = vi.spyOn(h.store, "listIdentityIngress").mockImplementation(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.botOpenId).toBe(SELF);
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      const count = journal.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(journal).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1); expect(journal).toHaveBeenCalledTimes(count + 1);
      expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
      expect(h.bot.busyChats.size).toBe(0); expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    }
    journal.mockRestore(); await vi.advanceTimersByTimeAsync(300_000);
    // This schedule is still within the explicit 15 minute eligibility window
    // only up to the first capped interval; prolonged faults must expire safely.
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.hasBotProcessed("GPT", "local-backoff")).toBe(true);
    expect(h.store.hasIdentityIngress("GPT", APP, "local-backoff")).toBe(false);
  });

  it("rolls back a failed processed-event insert inside claim before retrying unclaimed custody", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("transaction-rollback", "@_user_1 /help"));
    vi.spyOn(h.store, "tryMarkBotProcessed").mockImplementationOnce(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.botOpenId).toBe(SELF);
    expect(h.store.hasIdentityIngress("GPT", APP, "transaction-rollback")).toBe(true);
    expect(h.store.hasBotProcessed("GPT", "transaction-rollback")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.store.hasIdentityIngress("GPT", APP, "transaction-rollback")).toBe(false);
    expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
  });

  it("cancels a known-identity journal retry on close and resumes durable custody with a new bot", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("close-local-repair", "@_user_1 /help"));
    const journal = vi.spyOn(h.store, "listIdentityIngress").mockImplementationOnce(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    expect(journal).toHaveBeenCalledOnce(); close(h.store);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(journal).toHaveBeenCalledOnce(); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
    const restarted = fixture(h.dbPath); await restarted.bot.start(); await restarted.bot.drainIdentityIngress();
    expect(restarted.bot.replyMessage).toHaveBeenCalledWith("close-local-repair", expect.any(String));
    expect(restarted.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it("repairs preflight failure only from existing durable custody, preserving its original envelope", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("original-held", "@_user_1 /help"));
    vi.spyOn(h.store, "listIdentityIngress").mockImplementationOnce(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    vi.spyOn(h.store, "hasIdentityIngress").mockImplementationOnce(() => { throw busy(); });
    await h.bot.handleMessage(event("original-held", "@_user_1 /reset"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.gateway.resetSession).not.toHaveBeenCalled(); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
    expect(h.store.getMessageByMessageId("original-held")?.content).toBe("/help");
  });

  it("local repair never replays a processed claim after preparation failed", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start();
    await h.bot.handleMessage(event("already-claimed", "@_user_1 /reset"));
    await h.bot.handleMessage(event("still-held", "@_user_1 /help"));
    h.bot.fetchAndCacheChatInfo.mockRejectedValueOnce(busy());
    const claim = h.store.claimIdentityIngress.bind(h.store);
    vi.spyOn(h.store, "claimIdentityIngress").mockImplementationOnce(claim).mockImplementationOnce(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.store.hasBotProcessed("GPT", "already-claimed")).toBe(true);
    expect(h.store.hasBotProcessed("GPT", "still-held")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.replyMessage.mock.calls.map((call: any[]) => call[0])).toEqual(["still-held"]);
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
  });

  it("a retained /stop interrupts an admitted long run and fences later pre-stop custody", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start();
    await h.bot.handleMessage(event("long-before-stop"));
    await h.bot.handleMessage(event("retained-stop", "@_user_1 /stop"));
    await h.bot.handleMessage(event("pre-stop-tail"));
    let admitted!: () => void, finish!: (text: string) => void;
    const running = new Promise<void>(resolve => { admitted = resolve; });
    h.gateway.chatSendWithContext.mockImplementation(async (params: any) => {
      await params.onSendAttempt?.(); await params.onSubmitted?.("long-stop-run"); admitted();
      return new Promise<string>(resolve => { finish = resolve; });
    });
    const fetch = h.bot.fetchAndCacheChatInfo.getMockImplementation();
    h.bot.fetchAndCacheChatInfo.mockImplementationOnce(fetch).mockImplementationOnce(async (...args: any[]) => {
      await running; await fetch(...args);
    });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_500); await tick();
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    expect(h.gateway.abortChat).toHaveBeenCalledWith(h.bot.getSessionKey(GROUP));
    expect(h.bot.replyMessage.mock.calls.some((call: any[]) => call[0] === "retained-stop")).toBe(true);
    expect(h.store.getStopGeneration("GPT", GROUP)).toBe(1);
    expect(h.store.hasBotProcessed("GPT", "pre-stop-tail")).toBe(true);
    expect(h.store.getMessageByMessageId("pre-stop-tail")).toBeNull();
    expect(h.store.getPendingTriggerIds("GPT", GROUP).size).toBe(0);
    finish("obsolete response"); await vi.advanceTimersByTimeAsync(250);
    expect(h.bot.replyMessage.mock.calls.some((call: any[]) => call[0] === "long-before-stop")).toBe(false);
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
  });

  it("another retained chat starts its owned run while the first model never resolves", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("long-chat-one"));
    await h.bot.handleMessage(event("chat-two-input", "@_user_1 在吗", { chat_id: "oc_other_group" }));
    h.gateway.chatSendWithContext.mockImplementation(async (params: any) => {
      await params.onSendAttempt?.(); await params.onSubmitted?.(`run-${params.sessionKey}`);
      return params.sessionKey === h.bot.getSessionKey(GROUP) ? new Promise(() => {}) : "other chat response";
    });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_500); await tick();
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledTimes(2);
    expect(h.bot.replyMessage.mock.calls.some((call: any[]) => call[0] === "chat-two-input")).toBe(true);
    expect(h.bot.replyMessage.mock.calls.some((call: any[]) => call[0] === "long-chat-one")).toBe(false);
    expect(h.store.getRecent("oc_other_group").some(row => row.senderType === "bot" && row.content.includes("other chat response"))).toBe(true);
    expect(h.store.listIdentityIngress("GPT", APP)).toEqual([]);
  });

  it("a later claim failure retries only still-held controls, not the running model input", async () => {
    vi.useFakeTimers(); const h = fixture();
    h.bot.requestIdentity.mockRejectedValue(new Error("startup DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("claimed-long"));
    await h.bot.handleMessage(event("held-help", "@_user_1 /help"));
    h.gateway.chatSendWithContext.mockImplementation(async (params: any) => {
      await params.onSendAttempt?.(); await params.onSubmitted?.("long-repair-run"); return new Promise(() => {});
    });
    const claim = h.store.claimIdentityIngress.bind(h.store);
    vi.spyOn(h.store, "claimIdentityIngress").mockImplementationOnce(claim).mockImplementationOnce(() => { throw busy(); });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_500);
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.replyMessage).toHaveBeenCalledWith("held-help", expect.any(String));
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce(); expect(h.bot.requestIdentity).toHaveBeenCalledTimes(2);
  });
});

describe("held identity original-generation and late command fences", () => {
  it("rechecks the original physical target after hydration before a local command effect", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    await h.bot.handleMessage(event("late-local", "@_user_1 /locale en"));
    let release!: (text: string) => void;
    h.bot.hydrateFeishuDocsInMessage = vi.fn(() => new Promise(resolve => { release = resolve; }));
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000); await tick();
    expect(release).toBeDefined(); h.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "replacement" } });
    release("/locale en"); await tick();
    expect(h.store.getChatLocale(GROUP)).not.toBe("en"); expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it.each([123, {}, [], null, false, 0])("rejects malformed self-pair open IDs before any actual ingress effect: %j", async openId => {
    const h = fixture();
    const malformed = event("malformed-self", "@_user_1 /reset", { mentions: [{ key: "@_user_1", id: { app_id: APP, open_id: openId } }] });
    await h.bot.handleMessage(malformed);
    expect(h.bot.requestIdentity).not.toHaveBeenCalled();
    expect(h.store.hasBotProcessed("GPT", "malformed-self")).toBe(false);
    expect(h.store.listIdentityIngress("GPT", APP)).toEqual([]);
    expect(h.bot.addReaction).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.gateway.resetSession).not.toHaveBeenCalled(); expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it.each(["stop", "recall", "close", "replace", "archive"])("a held /reset cancelled by %s during ensureSession never dispatches or syncs", async mode => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("late-reset", "@_user_1 /reset"));
    let release!: () => void;
    h.bot.ensureSession.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const synced = vi.spyOn(h.store, "markSynced"), cleared = vi.spyOn(h.store, "clearPendingTrigger");
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000); await tick();
    expect(release).toBeDefined();
    if (mode === "stop") h.store.bumpStopGeneration("GPT", GROUP);
    if (mode === "recall") h.store.markMessageRecalled("late-reset", GROUP);
    if (mode === "close") close(h.store);
    if (mode === "replace") h.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "replacement" } });
    if (mode === "archive") h.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "identity-generation", archived: true } });
    release(); await vi.advanceTimersByTimeAsync(2_500); await tick();
    expect(h.gateway.resetSession).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(synced).not.toHaveBeenCalled(); expect(cleared).not.toHaveBeenCalled();
  });

  it.each(["stop", "recall", "close"])("a held /compact cancelled by %s during ensureSession never enters maintenance", async mode => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("late-compact", "@_user_1 /compact"));
    let release!: () => void; h.bot.ensureSession.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const compact = h.gateway.toolTrimCompact = vi.fn(async () => ({ compacted: true }));
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000); await tick();
    expect(release).toBeDefined();
    if (mode === "stop") h.store.bumpStopGeneration("GPT", GROUP);
    if (mode === "recall") h.store.markMessageRecalled("late-compact", GROUP);
    if (mode === "close") close(h.store);
    release(); await tick(); expect(compact).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("refuses original-generation holds after external change (restart=%s, archive=%s)", async (restart, archive) => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.start(); await h.bot.handleMessage(event("original-generation-reset", "@_user_1 /reset"));
    expect(h.store.getIdentityTarget("GPT", APP, "original-generation-reset")).toMatchObject({ state: "bound", sessionId: "identity-generation" });
    let current = h;
    if (restart) { close(h.store); current = fixture(h.dbPath); }
    current.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: archive ? "identity-generation" : "replacement", archived: archive } });
    current.bot.requestIdentity.mockResolvedValue(info());
    if (restart) await current.bot.start(); else await vi.advanceTimersByTimeAsync(5_000);
    await current.bot.drainIdentityIngress();
    expect(current.gateway.resetSession).not.toHaveBeenCalled(); expect(current.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(current.bot.replyMessage).not.toHaveBeenCalled();
    expect(current.store.hasBotProcessed("GPT", "original-generation-reset")).toBe(true);
  });

  it.each(["missing", "hung", "permission", "archived"])("never binds an initially %s physical target to a later session", async mode => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    if (mode === "missing") h.gateway.getSessionInfo.mockResolvedValueOnce({});
    if (mode === "hung") h.gateway.getSessionInfo.mockImplementationOnce(() => new Promise(() => {}));
    if (mode === "permission") h.gateway.getSessionInfo.mockRejectedValueOnce(new Error("unavailable"));
    if (mode === "archived") h.gateway.getSessionInfo.mockResolvedValueOnce({ session: { sessionId: "identity-generation", archived: true } });
    const received = h.bot.handleMessage(event("unbound-reset", "@_user_1 /reset"));
    await vi.advanceTimersByTimeAsync(2_000); await received;
    expect(h.store.getIdentityTarget("GPT", APP, "unbound-reset").state).toBe("unbound");
    h.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "later-session" } });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    close(h.store); const restarted = fixture(h.dbPath); await restarted.bot.start(); await restarted.bot.drainIdentityIngress();
    expect(restarted.gateway.resetSession).not.toHaveBeenCalled(); expect(restarted.bot.replyMessage).not.toHaveBeenCalled();
    expect(restarted.store.getIdentityTarget("GPT", APP, "unbound-reset").state).toBe("unbound");
  });

  it("close during original target capture cannot write late proof or rebind after restart", async () => {
    vi.useFakeTimers(); const h = fixture(); let release!: (x: any) => void;
    h.gateway.getSessionInfo.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const received = h.bot.handleMessage(event("capture-close", "@_user_1 /reset")); await tick();
    close(h.store); await received; release({ session: { sessionId: "too-late" } }); await tick();
    const restarted = fixture(h.dbPath); await restarted.bot.start(); await restarted.bot.drainIdentityIngress();
    expect(restarted.gateway.resetSession).not.toHaveBeenCalled();
    expect(restarted.store.getIdentityTarget("GPT", APP, "capture-close").state).toBe("capturing");
  });

  it("migrates an old candidate journal without inventing a physical session for its legacy rows", async () => {
    const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));
    await h.bot.handleMessage(event("legacy-unbound-reset", "@_user_1 /reset"));
    // Local disposable fixture only: reproduce the previous candidate's schema.
    (h.store as any).db.exec("ALTER TABLE identity_ingress DROP COLUMN target_json");
    close(h.store); const restarted = fixture(h.dbPath);
    await restarted.bot.start(); await restarted.bot.drainIdentityIngress();
    expect(restarted.gateway.resetSession).not.toHaveBeenCalled();
    expect(restarted.store.getIdentityTarget("GPT", APP, "legacy-unbound-reset").sessionId).toBeUndefined();
    expect(restarted.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("a failed target-journal write retries the same captured proof, never looks up a replacement binding", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    vi.spyOn(h.store, "finishIdentityTarget").mockImplementationOnce(() => { throw new Error("SQLITE_BUSY target write"); });
    await h.bot.handleMessage(event("capture-write-failure", "@_user_1 /reset"));
    h.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "replacement" } });
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.gateway.resetSession).not.toHaveBeenCalled(); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.hasBotProcessed("GPT", "capture-write-failure")).toBe(true);
  });

  it("a drain already awaiting capture cannot clear a later proof-write repair intent", async () => {
    vi.useFakeTimers(); const h = fixture(); let release!: (info: any) => void;
    h.gateway.getSessionInfo.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    vi.spyOn(h.store, "finishIdentityTarget").mockImplementationOnce(() => { throw Object.assign(new Error("late proof busy"), { code: "SQLITE_BUSY" }); });
    const received = h.bot.handleMessage(event("late-capture-repair", "@_user_1 /help"));
    await tick(); expect(h.bot.botOpenId).toBe(SELF); expect(release).toBeDefined();
    release({ session: { sessionId: "identity-generation" } }); await received; await tick();
    expect(h.store.hasBotProcessed("GPT", "late-capture-repair")).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999); expect(h.bot.replyMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bot.replyMessage).toHaveBeenCalledWith("late-capture-repair", expect.any(String));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce(); expect(h.bot.requestIdentity).toHaveBeenCalledOnce();
  });

  it("persists the original session fence through processed-claim/pending handoff and restart", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    await h.bot.handleMessage(event("handoff-before-restart"));
    h.bot.processQueue = vi.fn(async () => new Promise(() => {}));
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_500); await tick();
    expect(h.store.hasBotProcessed("GPT", "handoff-before-restart")).toBe(true);
    expect(h.store.getPendingTriggerIds("GPT", GROUP).size).toBe(1);
    expect(h.store.getIdentityTarget("GPT", APP, "handoff-before-restart").sessionId).toBe("identity-generation");
    close(h.store); const restarted = fixture(h.dbPath);
    restarted.gateway.getSessionInfo.mockResolvedValue({ session: { sessionId: "replacement" } });
    await restarted.bot.start(); await vi.advanceTimersByTimeAsync(500); await tick();
    expect(restarted.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(restarted.store.getPendingTriggerIds("GPT", GROUP).size).toBe(0);
  });

  it("carries the original physical session into ordinary Gateway admission", async () => {
    vi.useFakeTimers(); const h = fixture();
    const received = h.bot.handleMessage(event("generation-pinned-input")); await vi.advanceTimersByTimeAsync(500); await received;
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledWith(expect.objectContaining({ expectedSessionId: "identity-generation" }));
  });

  it("the real client sends a sessionId fence and never unarchives a changed retained target", async () => {
    const client: any = new OpenClawClient({ baseUrl: "ws://offline.invalid", token: "offline" });
    client.collectReply = vi.fn(async () => "answer");
    client.getSessionInfo = vi.fn(async () => ({ session: { sessionId: "original", archived: false } }));
    client.rpc = vi.fn(async (method: string) => method === "chat.send" ? { runId: "pinned-run", status: "started" } : {});
    client.unarchiveSession = vi.fn(async () => true);
    try {
      await client.chatSendWithContext({ sessionKey: "lma-held", expectedSessionId: "original", unsyncedMessages: [], currentMessage: "hello", currentSenderName: "User" });
      expect(client.rpc).toHaveBeenCalledWith("chat.send", expect.objectContaining({ sessionId: "original" }));
      expect(client.collectReply).toHaveBeenCalledWith("pinned-run", expect.any(Number), "lma-held", expect.objectContaining({ expectedSessionId: "original" }));
      client.getSessionInfo.mockResolvedValue({ session: { sessionId: "replacement", archived: true } });
      const count = client.rpc.mock.calls.length;
      await expect(client.chatSend({ sessionKey: "lma-held", expectedSessionId: "original", message: "stale" })).rejects.toThrow();
      expect(client.rpc).toHaveBeenCalledTimes(count); expect(client.unarchiveSession).not.toHaveBeenCalled();
      await expect(client.chatSend({ sessionKey: "lma-held", expectedSessionId: "original", message: "conflicting",
        followupAdmissionGuard: { sessionKey: "agent:main:lma-held", sessionId: "replacement", expectedLeafEntryId: "leaf" } })).rejects.toThrow();
      expect(client.rpc).toHaveBeenCalledTimes(count);
      client.getSessionInfo.mockResolvedValue({ session: { sessionId: "original", archived: false } });
      client.rpc.mockRejectedValue(new Error("RPC error: session is archived. Restore it before starting new work"));
      await expect(client.chatSend({ sessionKey: "lma-held", expectedSessionId: "original", message: "archive race" })).rejects.toThrow();
      expect(client.rpc).toHaveBeenCalledTimes(count + 1); expect(client.unarchiveSession).not.toHaveBeenCalled();
    } finally { await client.disconnect(); }
  });

  it.each(["stop", "recall", "close"])("a held /model cancelled by %s after session setup cannot patch or persist", async mode => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    h.bot.configPath = `${h.dbPath}.config.json`;
    await h.bot.handleMessage(event("late-model", "@_user_1 /model replacement-model"));
    let release!: () => void; h.bot.ensureSession.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    h.gateway.patchSession = vi.fn(async () => ({}));
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000); await tick();
    expect(release).toBeDefined();
    if (mode === "stop") h.store.bumpStopGeneration("GPT", GROUP);
    if (mode === "recall") h.store.markMessageRecalled("late-model", GROUP);
    if (mode === "close") close(h.store);
    release(); await tick(); expect(h.gateway.patchSession).not.toHaveBeenCalled(); expect(h.bot.config.model).toBe("offline-model");
  });

  it("closing after a held reset RPC prevents its delayed post-reset sync and SDK reply", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    await h.bot.handleMessage(event("reset-close-after-effect", "@_user_1 /reset"));
    const synced = vi.spyOn(h.store, "markSynced");
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000); await tick();
    expect(h.gateway.resetSession).toHaveBeenCalledOnce(); close(h.store);
    await vi.advanceTimersByTimeAsync(2_500); await tick();
    expect(synced).not.toHaveBeenCalled(); expect(h.bot.client.im.message.reply).not.toHaveBeenCalled();
    expect(h.gateway.resetSession).toHaveBeenCalledOnce();
  });

  it("maintenance checks a held effect guard after waiting for its owned slot", async () => {
    const client: any = new OpenClawClient({ baseUrl: "ws://offline.invalid", token: "offline" });
    let release!: (x: any) => void; const slotReleased = vi.fn();
    client.acquireMaintenanceSlot = vi.fn(() => new Promise(resolve => { release = resolve; }));
    client.rpc = vi.fn(async () => ({ compacted: true }));
    let current = true;
    const work = client.compactSession("lma-held", { maxLines: 50, effectGuard: async () => { if (!current) throw new Error("held cancellation"); } });
    const result = expect(work).rejects.toThrow("held cancellation"); current = false; release(slotReleased);
    try { await result; expect(client.rpc).not.toHaveBeenCalled(); expect(slotReleased).toHaveBeenCalledOnce(); }
    finally { await client.disconnect(); }
  });

  it("a delayed Go mutator is refused explicitly while a fresh post-recovery command keeps the normal path", async () => {
    vi.useFakeTimers(); const h = fixture(); h.bot.requestIdentity.mockRejectedValue(new Error("DNS")); await h.bot.start();
    h.bot.goController.handleGoCommand = vi.fn(async () => {});
    await h.bot.handleMessage(event("held-go", "@_user_1 /go original goal"));
    h.bot.requestIdentity.mockResolvedValue(info()); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.goController.handleGoCommand).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).toHaveBeenCalledWith("held-go", expect.stringContaining("未执行"));
    await h.bot.handleMessage(event("fresh-go", "@_user_1 /go original goal"));
    expect(h.bot.goController.handleGoCommand).toHaveBeenCalledOnce();
  });
});

describe("parent legacy ACK durable generation",()=>{
 it("persists the original physical target immediately for an identified legacy ACK without sessionId",async()=>{
  const h=fixture();const client:any=new OpenClawClient({baseUrl:"ws://offline.invalid",token:"offline"});
  client.bindRecoveryStore(h.store);client.getSessionInfo=vi.fn(async()=>({session:{sessionId:"original",archived:false}}));
  let release!:(text:string)=>void;client.collectReply=vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}));
  client.rpc=vi.fn(async(method:string)=>method==="chat.send"?{runId:"legacy-identified-run",status:"started"}:{});
  try{
   const pending=client.chatSend({sessionKey:"lma-held",message:"hello",expectedSessionId:"original"});
   await tick();expect(client.collectReply).toHaveBeenCalledOnce();
   const beforeTerminal=h.store.getRunObservation("agent:main:lma-held","legacy-identified-run");
   release("answer");await pending;
   expect(beforeTerminal).toMatchObject({sessionId:"original",state:"observing"});
  }finally{release?.("answer");await client.disconnect();}
 });
});

describe("recovered ingress context is not queue-owner lifetime authority",()=>{
 it.each([false,true])("A-only recall cannot cancel queued ordinary B (recoveredA=%s)",async recovered=>{
  vi.useFakeTimers();const h=fixture();
  h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
  h.gateway.setVerboseTranscriptDelivery=vi.fn();
  h.gateway.patchSession=vi.fn(async()=>({}));
  let release!:(text:string)=>void;const submitted:string[]=[];
  h.gateway.chatSendWithContext.mockImplementation(async(params:any)=>{
   submitted.push(params.currentMessage);await params.onSendAttempt?.();await params.onSubmitted?.(`queue-run-${submitted.length}`);
   return submitted.length===1?new Promise<string>(resolve=>{release=resolve;}):"NO_REPLY";
  });
  if(recovered){h.bot.requestIdentity.mockRejectedValue(new Error("DNS"));await h.bot.start();await h.bot.handleMessage(event("input-A","@_user_1 input A"));h.bot.requestIdentity.mockResolvedValue(info());await vi.advanceTimersByTimeAsync(5_500);}
  else{h.bot.botOpenId=SELF;void h.bot.handleMessage(event("input-A","@_user_1 input A"));await vi.advanceTimersByTimeAsync(500);}
  expect(release).toBeTypeOf("function");expect(submitted).toEqual(["input A"]);
  const b=h.store.insert({chatId:GROUP,messageId:"ordinary-B",senderType:"human",senderName:"fixture-user",content:"input B",timestamp:Date.now()});
  h.store.markPendingTrigger("GPT",GROUP,b);h.store.markMessageRecalled("input-A",GROUP);
  release("NO_REPLY");await vi.advanceTimersByTimeAsync(2_000);await tick();
  expect(submitted).toEqual(["input A","input B"]);
  expect(h.store.getPendingTriggerIds("GPT",GROUP).has(b)).toBe(false);
 });
});

describe("shared service timers do not retain an ingress ALS owner",()=>{
 it.each(["insertions","delivery","notices"])("%s recovery timer runs outside a recalled ingress context",async kind=>{
  const h=fixture();let seen:any="not-called";let finish!:()=>void;
  const observed=new Promise<void>(resolve=>{finish=resolve;});
  const observe=async()=>{seen=h.bot.identityEffects.getStore()?.item.messageId;finish();};
  const item={messageId:"recalled-A",chatId:GROUP,stopEpoch:0,target:{state:"bound",sessionKey:h.bot.getSessionKey(GROUP),sessionId:"identity-generation"}};
  if(kind==="insertions"){
   const row=h.store.insert({chatId:GROUP,messageId:"valid-B",senderType:"human",senderName:"fixture-user",content:"B",timestamp:Date.now()});
   h.store.saveInsertion("GPT",GROUP,row,"B-custody","pending",{messageId:"valid-B",stopEpoch:0,expectedRunId:"B-run",attempted:false});
   h.bot.reconcileInsertions=vi.fn(observe);h.bot.reconcileReactions=vi.fn(async()=>{});
  }else if(kind==="delivery")h.bot.dispatchPendingDeliveries=vi.fn(observe);
  else{vi.spyOn(h.store,"listPendingErrorNotices").mockReturnValue([{nextCheckAt:Date.now()+1000}] as any);h.bot.reconcileErrorNotices=vi.fn(observe);}
  try{
   h.bot.identityEffects.run({item,epoch:0},()=>{
    if(kind==="insertions")h.bot.scheduleInsertionRecovery();
    else if(kind==="delivery")h.bot.scheduleDeliveryRetry(GROUP,1);
    else h.bot.scheduleErrorNoticeCheck(GROUP);
   });
   h.store.markMessageRecalled("recalled-A",GROUP);
   // Real Node timers are required: fake timer callbacks run in their driver's
   // context and would incorrectly pass even before the production fix.
   await observed;await tick();expect(seen).toBeUndefined();
  }finally{
   if(h.bot.insertionTimer)clearTimeout(h.bot.insertionTimer);
   for(const timer of h.bot.deliveryRetryTimers.values())clearTimeout(timer);
   for(const timer of h.bot.errorNoticeTimers.values())clearTimeout(timer);
  }
 });
});
