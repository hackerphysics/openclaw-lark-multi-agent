import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
// Auto-retry is on by default in production; turn it off for the general suite so
// the plain mock replies (no trailing punctuation) do not trigger probe rounds.
// The dedicated auto-retry describe block enables it per-case.
process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "0";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discussionManager } from "../src/discussion-manager.js";
import { FeishuBot } from "../src/feishu-bot.js";
import { SessionWaitPaused, normalizeSessionRuntimeStatus } from "../src/session-status.js";
import { OpenClawClient, InactiveRunObservation } from "../src/openclaw-client.js";
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
  return { bot, store, openclaw, dbPath: join(dir, "messages.db"), cleanup: () => {
    for (const timer of (bot as any).deliveryRetryTimers.values()) clearTimeout(timer);
    (bot as any).deliveryRetryTimers.clear();
    for (const target of (bot as any).deliveryTargetsByRun.values()) if (target.timer) clearTimeout(target.timer);
    (bot as any).deliveryTargetsByRun.clear();
    for (const cleanup of (bot as any).pendingSteerCleanups.values()) cleanup();
    (bot as any).pendingSteerCleanups.clear();
    for (const target of (bot as any).activeDeliveryTargets.values()) if (target.timer) clearTimeout(target.timer);
    for (const timer of (bot as any).delayedFailureTimers.values()) clearTimeout(timer);
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

// All transports are stubs at the Feishu SDK boundary, not sendFinalMessage.
// Production dispatcher, chunking, uploads and MessageStore/SQLite stay real.
const observations: Record<string, unknown> = {};

const baseline = process.env.AUDIT_BASELINE === "1";
function rows(h: any, chat = "chat1") { return h.store.getRecent(chat, 1000).filter((m: any) => m.senderType === "bot"); }
function db(h: any) { return h.store.db; }
function clearTimers(bot: any) {
  for (const t of bot.deliveryRetryTimers.values()) clearTimeout(t);
  bot.deliveryRetryTimers.clear();
  for (const v of bot.deliveryTargetsByRun.values()) if (v.timer) clearTimeout(v.timer);
  for (const v of bot.activeDeliveryTargets.values()) if (v.timer) clearTimeout(v.timer);
}
function wire(bot: any, behavior?: (p: any, op: string, n: number) => any) {
  const calls: any[] = [];
  const accepted: any[] = [];
  let n = 0;
  const operation = (op: string) => vi.fn(async (p: any) => {
    calls.push({op, p});
    const result = behavior ? await behavior(p, op, ++n) : { code: 0, data: { message_id: `om-${++n}`, chat_id: p.data.receive_id || "chat1" } };
    if (result?.code === 0 && result?.data?.message_id) accepted.push({op, p, result});
    return result;
  });
  const api = {create: operation("create"), reply: operation("reply")};
  bot.client = {im: {message: api, v1: {message: api}, file: {create: vi.fn(async () => ({data:{file_key:"file-offline"}}))}, image: {create:vi.fn(async () => ({data:{image_key:"img-offline"}}))}}};
  bot.sendMessage = (FeishuBot.prototype as any).sendMessage.bind(bot);
  bot.replyMessage = (FeishuBot.prototype as any).replyMessage.bind(bot);
  return {calls, accepted, api};
}
async function enqueue(h: any, key: string, content = "offline result", attachments: any[] = [], chat = "chat1", source = key, type = "assistant_visible") {
  return h.bot.enqueueAndDispatchDelivery(chat, type, source, content, attachments, undefined, key, `model-${h.bot.config.name}`);
}
function peer(h: any, name: string, appId = `app-${name}`) {
  const oc = new MockOpenClaw();
  const bot: any = new FeishuBot({name,appId,appSecret:"offline",model:`model-${name}`}, oc as any, h.store);
  bot.ensureSession = async (chat: string) => bot.getSessionKey(chat);
  bot.addReaction = vi.fn(async () => {}); bot.removeReaction = vi.fn(async () => {});
  bot.replyLiveStatusCard = vi.fn(async () => "status"); bot.sendLiveStatusCard = vi.fn(async () => "status");
  bot.patchLiveStatusCard = vi.fn(async () => {}); bot.patchLiveStatusDoneSummary = vi.fn(async () => {});
  wire(bot);
  return {bot,oc};
}
async function trigger(h: any, bot = h.bot, content = "please review", chat = "chat1") {
  const id = h.store.insert({chatId:chat,messageId:`human-${Math.random()}`,senderType:"human",senderName:"u",content,timestamp:Date.now()});
  h.store.markPendingTrigger(bot.config.name,chat,id);
  await bot.processQueue(chat);
  return id;
}
async function subscribe(h: any, chat = "chat1") {
  await (FeishuBot.prototype as any).ensureSession.call(h.bot,chat);
  return h.openclaw.sessionCallbacks.get(h.bot.getSessionKey(chat))! as any;
}

describe("context-sync closure desired invariants",()=>{
  it("I01 trigger-key continuation becomes peer context",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{await enqueue(h,"trigger:42");expect(rows(h)).toHaveLength(1);}finally{h.cleanup();}});
  it("I02 retry after SQLite insert failure repairs missing shared row",async()=>{const h=makeHarness("Kimi");wire(h.bot);const original=h.store.insert.bind(h.store);try{h.store.insert=((m:any)=>{if(m.messageId.startsWith("lma:"))throw new Error("injected SQLite failure");return original(m);}) as any;await enqueue(h,"proactive:insert");h.store.insert=original;clearTimers(h.bot);await (h.bot as any).dispatchPendingDeliveries("chat1");expect(rows(h)).toHaveLength(1);}finally{h.store.insert=original;h.cleanup();}});
  it("I03 same deliveryKey in another chat is not a global row collision",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{await enqueue(h,"proactive:key","A",[],"chatA");await enqueue(h,"proactive:key","B",[],"chatB");expect(rows(h,"chatB")).toHaveLength(1);}finally{h.cleanup();}});
  it("I04 attachment-only delivery is represented in peer context",async()=>{const h=makeHarness("Kimi");wire(h.bot);const path=join(dirname(h.dbPath),"file.txt");writeFileSync(path,"fixture");try{await enqueue(h,"proactive:file","",[{type:"file",path}]);expect(rows(h)).toHaveLength(1);}finally{h.cleanup();}});
  it("I05 rejected receipt must not create peer context",async()=>{const h=makeHarness("Kimi");wire(h.bot,()=>({code:230002,msg:"rejected"}));try{await enqueue(h,"proactive:rejected");expect(rows(h)).toHaveLength(0);}finally{h.cleanup();}});
  it("I06 exact platform receipt reuses an existing raw assistant row",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{h.store.insert({chatId:"chat1",messageId:"om-1",senderType:"bot",senderName:"Kimi",content:"same",timestamp:1});await enqueue(h,"proactive:reentry","same");expect(rows(h)).toHaveLength(1);}finally{h.cleanup();}});
  it("I07 NO_REPLY sentinel must not enter peer context",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{const cb=await subscribe(h);await cb("NO_REPLY");expect(rows(h)).toHaveLength(0);}finally{h.cleanup();}});
  it("I08 proactive burst must not strand a newly inserted human request",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{let tick=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>++tick);(h.bot as any).getUnhealthySessionStatus=async()=>{for(let i=0;i<10;i++)await enqueue(h,`proactive:burst-${i}`,`part ${i}`);return null;};await (h.bot as any).handleMessage(event({text:"human request",messageId:"human-burst",chatType:"p2p"}));expect(h.openclaw.chatCalls).toHaveLength(1);}finally{vi.restoreAllMocks();h.cleanup();}});
  it("I09 standalone accepted proactive text becomes shared context",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{await enqueue(h,"proactive:happy");expect(rows(h)).toHaveLength(1);}finally{h.cleanup();}});
  it("I10 sender does not reread its own proactive row",async()=>{const h=makeHarness("Kimi");wire(h.bot);try{await enqueue(h,"proactive:own");await trigger(h);expect(h.openclaw.chatCalls[0].unsyncedMessages.filter((m:any)=>m.senderName==="Kimi")).toHaveLength(0);}finally{h.cleanup();}});
});
