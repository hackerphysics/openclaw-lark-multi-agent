import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawClient } from "../src/openclaw-client.js";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore } from "../src/message-store.js";
import { errorIdentity } from "../src/terminal-errors.js";

const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.frame({ type: "event", event: "connect.challenge", payload: { nonce: "offline" } })); }
    frame(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
    send(text: string) {
      const req = JSON.parse(text);
      if (req.method === "connect") queueMicrotask(() => this.frame({ type: "res", id: req.id, ok: true, payload: { type: "hello-ok", protocol: 4, features: {} } }));
    }
    close() { this.emit("close"); }
  } };
});

// Observed exact agent.wait/chat error constant for this group. Wire envelopes
// below follow installed Core chat/agent publishers; they are source-derived
// offline replays, NOT a claim that an archived raw websocket frame was captured.
const chatId = "oc_831c871914754e3c35947fb512fe4104";
const sessionKey = `agent:main:lma-gemini-${chatId}`;
const runId = "5f583516-fc76-49e1-bd5a-2ecbef268067";
const generic = "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.";
const closed = "503 model 'gemini-3.8-flash' is disabled";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); sockets.length = 0; vi.useRealTimers(); FeishuBot.getAllBots().clear(); });

async function harness(locale: "zh" | "en" = "zh") {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "lma-core-boundary-"));
  const store = new MessageStore(join(dir, "outbox.db"));
  const client: any = new OpenClawClient({ baseUrl: "ws://offline", token: "synthetic" } as any);
  await client.connect();
  const socket = sockets.at(-1);
  let admitted=false;
  client.rpc = vi.fn(async (method: string) => {
    if (method === "sessions.describe") return { session: { model: "gemini-3.8-flash", modelProvider: "x", sessionId:"offline-generation", status:admitted?"running":"idle", hasActiveRun:admitted, totalTokens: 0 } };
    if (method === "agent.wait") return { runId, status: "timeout" }; // actual current read; cannot reconstruct old terminal details
    if (method === "chat.send") {admitted=true;return {runId};}
    if (method === "chat.abort") return { aborted: true, runIds: [] };
    if (method === "sessions.messages.subscribe") return {};
    throw new Error(`Unexpected offline RPC ${method}`);
  });
  const bot: any = new FeishuBot({ name: "Gemini", appId: "offline", appSecret: "synthetic", model: "x/gemini-3.8-flash" }, client, store);
  bot.client.im.message.create = vi.fn(async () => ({ code: 0, data: { message_id: "offline-platform-receipt" } }));
  bot.client.im.message.reply = vi.fn(async () => ({ code: 0, data: { message_id: "offline-platform-receipt" } }));
  bot.addReaction = vi.fn(async () => {}); bot.removeReaction = vi.fn(async () => {});
  bot.sendLiveStatusCard = vi.fn(async () => "offline-status"); bot.replyLiveStatusCard = vi.fn(async () => "offline-status");
  bot.patchLiveStatusCard = vi.fn(async () => {}); bot.patchLiveStatusDoneSummary = vi.fn(async () => {});
  bot.fetchAndCacheChatInfo = async () => store.upsertChatInfo({ chatId, chatType: "p2p", chatName: "offline", members: "", memberNames: "", ownerBot: "Gemini", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: Date.now() });
  store.setChatLocale(chatId, locale);
  await bot.ensureSession(chatId);
  cleanup.push(async () => {
    for (const key of ["errorNoticeTimers", "deliveryRetryTimers"]) { for (const t of bot[key].values()) clearTimeout(t); bot[key].clear(); }
    for (const target of bot.deliveryTargetsByRun.values()) if (target.timer) clearTimeout(target.timer);
    await client.disconnect(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, client, bot, socket };
}

describe("actual receiver → collector/provenance → locale renderer → persistent guarded outbox boundary", () => {
  it.each(["zh", "en"] as const)("the observed compaction copy reaches the %s guarded proactive outbox accurately", async locale => {
    const h = await harness(locale);
    h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: generic } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([...h.bot.errorNoticeChecks.values()]);
    const record = h.store.getErrorNotice("Gemini", chatId, errorIdentity(sessionKey, runId))!;
    expect(record.provenance.detail).toBe(generic);
    expect(record.status).toBe("terminal");
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, runId)}`)!;
    expect(delivery.status).toBe("delivered");
    expect(delivery.content).toContain(locale === "en" ? "Context preparation/compaction did not complete" : "整理/压缩未完成");
    expect(delivery.content).not.toContain("原因尚未分类");
    expect(delivery.content).not.toContain("所选模型已暂停");
    expect(delivery.content).not.toMatch(/gpt-5\.6|JSON Schema|额度已用尽|HTTP 200/);
    expect(h.bot.client.im.message.create).toHaveBeenCalledTimes(1);
    expect(h.client.rpc.mock.calls.some((c: any[]) => c[0] === "chat.send")).toBe(false);
  });
  it("the same receiver/provenance/outbox already preserves a supplied closed diagnostic (not available in the observed compaction body)", async () => {
    const h = await harness();
    h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: closed } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([...h.bot.errorNoticeChecks.values()]);
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, runId)}`)!;
    expect(delivery.status).toBe("delivered"); expect(delivery.content).toContain("所选模型已暂停");
    expect(delivery.content).toContain("HTTP 503"); expect(delivery.content).not.toContain("原因尚未分类");
    expect(h.bot.client.im.message.create).toHaveBeenCalledTimes(1);
  });
  it.each(["zh", "en"] as const)("owned lifecycle error preserves exact group/run and reaches the %s ordinary trigger outbox", async locale => {
    const h = await harness(locale);
    const original = h.client.rpc;
    h.client.rpc = vi.fn(async (method: string, params: any) => {
      const result = await original(method, params);
      if (method === "chat.send") setTimeout(() => h.socket.frame({ type: "event", event: "agent", payload: { runId, sessionKey, stream: "lifecycle", data: { phase: "error", error: generic, executionSettled: true } } }), 1);
      return result;
    });
    const pending = h.bot.handleMessage({ message: { chat_id: chatId, chat_type: "p2p", message_type: "text", message_id: "offline-trigger", content: JSON.stringify({ text: "offline boundary fixture" }) }, sender: { sender_type: "user", sender_id: { open_id: "offline-owner" } } });
    await vi.advanceTimersByTimeAsync(300); await pending;
    const triggerId = h.store.getMessageId("offline-trigger")!;
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `trigger:${triggerId}:provider-error`)!;
    expect(delivery.status).toBe("delivered"); expect(delivery.content).toContain(locale === "en" ? "Context preparation/compaction did not complete" : "整理/压缩未完成");
    expect(delivery.content).not.toContain("原因尚未分类");
    expect(delivery.content).not.toContain("所选模型已暂停");
    expect(delivery.content).not.toMatch(/gpt-5\.6|JSON Schema|额度已用尽|HTTP 200/);
    expect(h.client.rpc.mock.calls.filter((c: any[]) => c[0] === "chat.send")).toHaveLength(1);
    expect(h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, runId)}`)).toBeNull();
    expect(h.store.getPendingTriggerIds("Gemini", chatId).has(triggerId)).toBe(false);
    expect(h.bot.config.model).toBe("x/gemini-3.8-flash");
  });
  it("normal visible chat final through the same actual collector/outbox remains delivered", async () => {
    const h = await harness();
    const original = h.client.rpc;
    h.client.rpc = vi.fn(async (method: string, params: any) => {
      const result = await original(method, params);
      if (method === "chat.send") setTimeout(() => {
        h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "final", message: { role: "assistant", content: [{ type: "text", text: "Offline completed answer." }] } } });
        h.socket.frame({ type: "event", event: "agent", payload: { runId, sessionKey, stream: "lifecycle", data: { phase: "end", livenessState: "working" } } });
      }, 1);
      return result;
    });
    const pending = h.bot.handleMessage({ message: { chat_id: chatId, chat_type: "p2p", message_type: "text", message_id: "offline-positive", content: JSON.stringify({ text: "offline positive fixture" }) }, sender: { sender_type: "user", sender_id: { open_id: "offline-owner" } } });
    await vi.advanceTimersByTimeAsync(300); await pending;
    const triggerId = h.store.getMessageId("offline-positive")!;
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `trigger:${triggerId}`)!;
    expect(delivery.status).toBe("delivered"); expect(delivery.content).toBe("Offline completed answer.");
    expect(h.client.rpc.mock.calls.filter((c: any[]) => c[0] === "chat.send")).toHaveLength(1);
    expect(h.bot.config.model).toBe("x/gemini-3.8-flash");
  });

  it("an internal maintenance content-filter event cannot take this group's delivery owner", async () => {
    const h = await harness();
    const internalRun = "9b8ff505-c622-4e56-b7aa-3ea7628e4bc8";
    const internalKey = `agent:main:internal-session-effects:${internalRun}-cd339a07b91b5713`;
    h.socket.frame({ type: "event", event: "chat", payload: { runId: internalRun, sessionKey: internalKey, state: "error", errorMessage: "Provider finish_reason: content_filter: PROHIBITED_CONTENT" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.bot.client.im.message.create).not.toHaveBeenCalled();
    expect(h.store.getErrorNotice("Gemini", chatId, errorIdentity(sessionKey, internalRun))).toBeUndefined();
    expect(h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, internalRun)}`)).toBeNull();
  });
  it("a confirmed explicit stop continues to suppress the exact run's later compaction notice", async () => {
    const h = await harness(); const original = h.client.rpc;
    h.client.rpc = vi.fn(async (method: string, params: any) => method === "chat.abort" ? { aborted: true, runIds: [runId] } : original(method, params));
    await h.client.abortChat(sessionKey);
    h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: generic } });
    await vi.advanceTimersByTimeAsync(100); await Promise.all([...h.bot.errorNoticeChecks.values()]);
    expect(h.bot.client.im.message.create).not.toHaveBeenCalled();
    expect(h.store.getErrorNotice("Gemini", chatId, errorIdentity(sessionKey, runId))?.status).toBe("stopped");
  });

});
