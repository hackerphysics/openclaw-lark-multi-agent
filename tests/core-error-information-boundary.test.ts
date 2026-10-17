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

// Observed sanitized assistant body for the exact morning run. Wire envelopes
// below follow installed Core chat/agent publishers; they are source-derived
// offline replays, NOT a claim that an archived raw websocket frame was captured.
const chatId = "oc_03575ef5e487a110c21288353618aa1c";
const sessionKey = `agent:main:lma-gemini-${chatId}`;
const runId = "e95fec89-2c34-4667-8ff1-1db62cd0d69c";
const generic = "⚠️ LLM request failed (provider internal error, HTTP 503). This is usually temporary — try again shortly.";
const closed = "503 model 'gemini-3.8-flash' is disabled";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); sockets.length = 0; vi.useRealTimers(); FeishuBot.getAllBots().clear(); });

async function harness() {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "lma-core-boundary-"));
  const store = new MessageStore(join(dir, "outbox.db"));
  const client: any = new OpenClawClient({ baseUrl: "ws://offline", token: "synthetic" } as any);
  await client.connect();
  const socket = sockets.at(-1);
  let admitted=false;
  client.rpc = vi.fn(async (method: string) => {
    if (method === "sessions.describe") return { session: { model: "gemini-3.8-flash", modelProvider: "x", sessionId:"offline-generation", status:admitted?"running":"idle", hasActiveRun:admitted, totalTokens: 0 } };
    if (method === "chat.history") return {sessionKey,sessionInfo:{sessionId:"offline-generation",hasActiveRun:admitted},pendingInputs:{total:0,items:[]}};
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
  await bot.ensureSession(chatId);
  cleanup.push(async () => {
    for (const key of ["errorNoticeTimers", "deliveryRetryTimers"]) { for (const t of bot[key].values()) clearTimeout(t); bot[key].clear(); }
    for (const target of bot.deliveryTargetsByRun.values()) if (target.timer) clearTimeout(target.timer);
    await client.disconnect(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, client, bot, socket };
}

describe("actual receiver → collector/provenance → locale renderer → persistent guarded outbox boundary", () => {
  it("the observed generic Core error remains unknown through the complete proactive notice chain", async () => {
    const h = await harness();
    h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: generic } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([...h.bot.errorNoticeChecks.values()]);
    const record = h.store.getErrorNotice("Gemini", chatId, errorIdentity(sessionKey, runId))!;
    expect(record.provenance.detail).toBe(generic);
    expect(record.status).toBe("terminal");
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, runId)}`)!;
    expect(delivery.status).toBe("delivered");
    expect(delivery.content).toContain("原因尚未分类");
    expect(delivery.content).not.toContain("所选模型已暂停");
    expect(h.bot.client.im.message.create).toHaveBeenCalledTimes(1);
    expect(h.client.rpc.mock.calls.some((c: any[]) => c[0] === "chat.send")).toBe(false);
  });
  it("the same receiver/provenance/outbox already preserves a supplied closed diagnostic (not available in the observed generic body)", async () => {
    const h = await harness();
    h.socket.frame({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: closed } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([...h.bot.errorNoticeChecks.values()]);
    const delivery = h.store.getDeliveryByKey("Gemini", chatId, `run-error:${errorIdentity(sessionKey, runId)}`)!;
    expect(delivery.status).toBe("delivered"); expect(delivery.content).toContain("所选模型已暂停");
    expect(delivery.content).toContain("HTTP 503"); expect(delivery.content).not.toContain("原因尚未分类");
    expect(h.bot.client.im.message.create).toHaveBeenCalledTimes(1);
  });
  it("owned lifecycle error traverses actual chatSend/collectReply and ordinary Feishu trigger outbox, still without inventing missing cause", async () => {
    const h = await harness();
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
    expect(delivery.status).toBe("delivered"); expect(delivery.content).toContain("原因尚未分类");
    expect(delivery.content).not.toContain("所选模型已暂停");
    expect(h.client.rpc.mock.calls.filter((c: any[]) => c[0] === "chat.send")).toHaveLength(1);
    expect(h.store.getPendingTriggerIds("Gemini", chatId).has(triggerId)).toBe(false);
    expect(h.bot.config.model).toBe("x/gemini-3.8-flash");
  });
});
