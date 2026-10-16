import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {execFileSync} from "node:child_process";
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


// Independent frozen-candidate review. Only external SDK/session ports are stubs.
// Every SDK success has a globally unique real-identity fixture.
let receiptSerial=0;
const oldWire=wire;
function uniqueWire(bot:any, behavior?:(p:any,op:string,n:number)=>any) {
 return oldWire(bot,behavior ?? ((p:any)=>({code:0,data:{message_id:`review-${++receiptSerial}`,chat_id:p.data.receive_id || 'chat1'}})));
}
function fixture(h:any,kind:string) {
 const path=join(dirname(h.dbPath),kind==='image'?'fixture.png':kind==='document'?'fixture.md':'fixture.txt');
 writeFileSync(path,kind==='document'?'# offline report':'nonempty offline fixture');
 if(kind==='document') h.bot.client.docx={document:{
  create:vi.fn(async()=>({code:0,data:{document:{document_id:'doc-review',revision_id:1}}})),
  convert:vi.fn(async()=>({code:0,data:{blocks:[]}}))}};
 return {type:kind,path,caption:'confirmed report'};
}
async function reopen(h:any) {
 clearTimers(h.bot);h.store.close();const store=new MessageStore(h.dbPath);
 const bot:any=new FeishuBot({name:'Kimi',appId:'app-Kimi',appSecret:'offline',model:'model-Kimi'},new MockOpenClaw() as any,store);
 const port=uniqueWire(bot);store.resetDeliveringOnStartup('Kimi');return {store,bot,port};
}
afterAll(()=>{if(process.env.LMA_CONTEXT_EVIDENCE_PATH)writeFileSync(process.env.LMA_CONTEXT_EVIDENCE_PATH,JSON.stringify(observations,null,2));});

describe('independent real-class end-to-end route matrix',()=>{
 for(const route of ['normal','discuss','proactive','continuation','Go']) for(const kind of ['body','file','image','document']) {
  it(`${route}/${kind}: real dispatch + SDK receipt + SQLite context`,async()=>{
   const h=makeHarness('Kimi');const w=uniqueWire(h.bot);
   try {
    const attachment=kind==='body'?undefined:fixture(h,kind);
    const value=attachment?`<LMA_BRIDGE_ATTACHMENTS>${JSON.stringify([attachment])}</LMA_BRIDGE_ATTACHMENTS>`:'independent final report';
    if(route==='normal'){h.openclaw.replies.push(value);await trigger(h);}
    else if(route==='discuss'){h.openclaw.replies.push(value);await (h.bot as any).runDiscussionTurn('chat1','review',{round:1,maxRounds:2});}
    else if(route==='proactive'){const cb=await subscribe(h);await cb(value,{runId:'proactive-root',sessionKey:h.bot.getSessionKey('chat1'),sessionId:'s1',final:true});}
    else if(route==='continuation'){
     const cb=await subscribe(h);h.openclaw.chatSendWithContext=vi.fn(async(p:any)=>{await p.onSubmitted('paused-run');throw new SessionWaitPaused({status:'running',running:true,checkedAt:Date.now()} as any);});
     const id=await trigger(h);await cb(value,{runId:'paused-run',sessionKey:h.bot.getSessionKey('chat1'),sessionId:'s1',final:true});
     expect(h.store.getDeliveryByKey('Kimi','chat1',`trigger:${id}`)?.status).toBe('delivered');
    } else {
     const sessionKey=h.bot.getSessionKey('chat1');const id=h.store.createGoJob({botName:'Kimi',chatId:'chat1',goal:'offline audit',acceptance:'report',executorSessionKey:sessionKey,executorSessionId:'s-go',checkerSessionKey:'check',checkerModel:'offline'});
     (h.bot as any).goController.notifyExactRunOutcome=vi.fn();
     await (h.bot as any).deliverGoExecutorResult('chat1',{sessionKey,sessionId:'s-go',runId:'r-go',disposition:'visible',text:value},id);
     expect(h.store.listGoVisibleEvidence(id)[0].receipt.messages.length).toBeGreaterThan(0);
    }
    expect(w.accepted.length).toBeGreaterThan(0);expect(rows(h)).toHaveLength(1);
    if(kind==='document')expect(rows(h)[0].content).toContain('https://www.feishu.cn/docx/doc-review');
    observations[`${route}/${kind}`]={accepted:w.accepted.length,rows:rows(h).length};
   }finally{h.cleanup();}
  });
 }
});

describe('independent real SQLite rollback and restart',()=>{
 it.each(['message','checkpoint','context'])('SQLite RAISE at %s boundary rolls back context/checkpoint; restart repairs without resend',async boundary=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   const clause=boundary==='message'?"BEFORE INSERT ON messages WHEN NEW.sender_type='bot'":boundary==='checkpoint'?"BEFORE UPDATE OF text_delivered ON delivery_outbox WHEN NEW.text_delivered=1":'BEFORE INSERT ON delivery_context';
   db(h).exec(`CREATE TRIGGER inject_failure ${clause} BEGIN SELECT RAISE(ABORT,'independent SQLite failure'); END;`);
   await enqueue(h,'sqlite-'+boundary);clearTimers(h.bot);
   expect(w.accepted).toHaveLength(1);expect(rows(h)).toHaveLength(0);expect(h.store.getDeliveryByKey('Kimi','chat1','sqlite-'+boundary)?.textDelivered).toBe(false);
   db(h).exec('DROP TRIGGER inject_failure');r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   expect(r.port.calls).toHaveLength(0);expect(r.store.getRecent('chat1').filter((m:any)=>m.senderType==='bot')).toHaveLength(1);
   expect(r.store.getDeliveryByKey('Kimi','chat1','sqlite-'+boundary)?.status).toBe('delivered');
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
 it('accepted journal write failure must not permanently lose a known SDK receipt',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   db(h).exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON delivery_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'receipt disk error'); END;");
   await enqueue(h,'accepted-save');clearTimers(h.bot);expect(w.accepted).toHaveLength(1);db(h).exec('DROP TRIGGER fail_receipt');
   r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   observations.acceptedSave={effects:w.accepted.length,retryEffects:r.port.accepted.length,outbox:r.store.getDeliveryByKey('Kimi','chat1','accepted-save'),operations:(r.store as any).db.prepare('SELECT * FROM delivery_operations').all(),rows:r.store.getRecent('chat1').length};
   expect(r.port.calls).toHaveLength(0);expect(r.store.getRecent('chat1').filter((m:any)=>m.senderType==='bot')).toHaveLength(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
 it.each(['file','image','document'])('confirmed %s before unknown caption/link cannot permanently disappear from shared context',async kind=>{
  const h=makeHarness('Kimi');let count=0;const w=uniqueWire(h.bot,(p:any)=>{
   if(p.data.msg_type==='interactive')throw new Error('caption outcome unknown');
   return {code:0,data:{message_id:`accepted-file-${++count}`,chat_id:'chat1'}};
  });let r:any;
  try {
   const a=fixture(h,kind);await enqueue(h,'attachment-partial-'+kind,'',[a]);clearTimers(h.bot);
   r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   observations['partial-'+kind]={effects:w.accepted.length,rows:r.store.getRecent('chat1').length,operations:(r.store as any).db.prepare('SELECT * FROM delivery_operations').all()};
   if(kind==='document')expect(w.accepted).toHaveLength(0);else expect(w.accepted).toHaveLength(1);
   expect(r.port.calls).toHaveLength(0);
   if(kind!=='document')expect(r.store.getRecent('chat1').filter((m:any)=>m.senderType==='bot')).toHaveLength(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
 it('a definitive transient rejection can retry safely rather than replay a cached rejection forever',async()=>{
  const h=makeHarness('Kimi');let fail=true;const w=uniqueWire(h.bot,(p:any)=>fail?{code:99991400,msg:'rate limited'}:{code:0,data:{message_id:'retry-success',chat_id:'chat1'}});
  try{
   await enqueue(h,'transient-rejection');clearTimers(h.bot);const before=w.calls.length;fail=false;await (h.bot as any).dispatchPendingDeliveries('chat1');
   observations.rejectedRetry={calls:w.calls.length,before,rows:rows(h).length,outbox:h.store.getDeliveryByKey('Kimi','chat1','transient-rejection')};
   expect(w.accepted).toHaveLength(1);expect(rows(h)).toHaveLength(1);
  }finally{h.cleanup();}
 });
});


describe('independent identity and reconciliation boundaries',()=>{
 it('actual inbound platform echo reuses exact alias and peer catches up once',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);const p=peer(h,'GPT');uniqueWire(p.bot);
  try{
   FeishuBot.getAllBots().set('app-Kimi',h.bot);(h.bot as any).botOpenId='ou-Kimi';
   await enqueue(h,'echo-event','same platform answer');p.bot.fetchAndCacheChatInfo=(h.bot as any).fetchAndCacheChatInfo;
   await p.bot.handleMessage(event({text:'same platform answer',messageId:w.accepted[0].result.data.message_id,senderType:'app',openId:'ou-Kimi'}));
   expect(rows(h)).toHaveLength(1);await trigger(h,p.bot);
   expect(p.oc.chatCalls[0].unsyncedMessages.filter((m:any)=>m.content==='same platform answer')).toHaveLength(1);
   await trigger(h,p.bot,'again');expect(p.oc.chatCalls[1].unsyncedMessages.filter((m:any)=>m.content==='same platform answer')).toHaveLength(0);
  }finally{clearTimers(p.bot);h.cleanup();}
 });
 it('same text with distinct exact task identities is not deduped, sender/chat isolated',async()=>{
  const h=makeHarness('Kimi');uniqueWire(h.bot);const p=peer(h,'GPT');uniqueWire(p.bot);
  try{
   await enqueue(h,'same-key','same',[],'chatA');await enqueue(h,'same-key','same',[],'chatB');
   await enqueue(h,'different-key','same',[],'chatA');await enqueue({bot:p.bot},'same-key','same',[],'chatA');
   expect(rows(h,'chatA')).toHaveLength(3);expect(rows(h,'chatB')).toHaveLength(1);
   expect(rows(h,'chatA').filter((m:any)=>m.senderName==='GPT')).toHaveLength(1);
  }finally{clearTimers(p.bot);h.cleanup();}
 });
 it.each(['normal','discuss'])('%s no phantom assistant row when platform rejects',async route=>{
  const h=makeHarness('Kimi');uniqueWire(h.bot,()=>({code:230002,msg:'not in chat'}));
  try{
   h.openclaw.replies.push('unconfirmed report');
   if(route==='normal')await trigger(h);else await (h.bot as any).runDiscussionTurn('chat1','review');
   expect(rows(h)).toHaveLength(0);
  }finally{h.cleanup();}
 });
 it.each([
  {code:230002,data:{message_id:'bad-id'}}, {code:0,data:{}},
  {code:0,data:{message_id:'wrong-chat',chat_id:'other'}},
  {code:0,data:{message_id:'wrong-app',sender:{sender_type:'app',id_type:'app_id',id:'other'}}},
  {code:0,data:{message_id:'wrong-open-id',sender:{sender_type:'app',id_type:'open_id',id:'other'}}},
 ])('rejected/no-id/wrong identity never emits a second fallback request or context: %j',async response=>{
  const h=makeHarness('Kimi');(h.bot as any).botOpenId='ou-Kimi';const w=uniqueWire(h.bot,()=>response);
  try{
   await enqueue(h,'invalid-identity');clearTimers(h.bot);const before=w.calls.length;
   await (h.bot as any).dispatchPendingDeliveries('chat1');expect(w.calls.length).toBe(before);expect(rows(h)).toHaveLength(0);
   if(response.code===0)expect(w.calls).toHaveLength(1);
   expect(h.store.getDeliveryByKey('Kimi','chat1','invalid-identity')?.status).not.toBe('delivered');
  }finally{h.cleanup();}
 });
 it('definitive unsupported-card rejection permits exactly one successful text fallback',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot,(p:any)=>p.data.msg_type==='interactive'?{code:230001,msg:'unsupported'}:{code:0,data:{message_id:'text-fallback',chat_id:'chat1'}});
  try{await enqueue(h,'fallback');expect(w.calls).toHaveLength(2);expect(w.accepted).toHaveLength(1);expect(rows(h)).toHaveLength(1);await enqueue(h,'fallback');expect(w.calls).toHaveLength(2);}finally{h.cleanup();}
 });
 it('unknown operation has a no-resend verified-receipt reconciliation path, not permanent failed lockout',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot,()=>{throw new Error('platform response lost');});
  try{
   await enqueue(h,'unknown-lock');clearTimers(h.bot);
   for(let i=0;i<5;i++){await (h.bot as any).dispatchPendingDeliveries('chat1');clearTimers(h.bot);}
   const out=h.store.getDeliveryByKey('Kimi','chat1','unknown-lock')!;
   observations.unknownLock={effects:w.calls.length,status:out.status,attempts:out.attempts,preview:h.store.previewMissingDeliveryContext('Kimi')};
   expect(w.calls).toHaveLength(1);
   expect(()=>h.store.registerHistoricalDeliveryContext(out.id!,'Kimi','chat1',['independently-verified-actual-id'])).not.toThrow();
  }finally{h.cleanup();}
 });
 it.each([false,true])('historical preview reads legacy journals without migration (context table=%s)',hasContext=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-legacy-preview-'));const file=join(dir,'messages.db');
  try {
   const legacy=new Database(file);
   legacy.exec("CREATE TABLE delivery_outbox(id INTEGER PRIMARY KEY,chat_id TEXT,delivery_key TEXT,source_type TEXT,text_delivered INTEGER,attachment_cursor INTEGER,bot_name TEXT,status TEXT); INSERT INTO delivery_outbox VALUES(1,'chat1','proactive:old','assistant_visible',1,0,'Kimi','delivered'),(2,'chat1','other','assistant_visible',1,0,'GPT','delivered'),(3,'chat1','pending','assistant_visible',0,0,'Kimi','pending');");
   if(hasContext)legacy.exec('CREATE TABLE delivery_context(outbox_id INTEGER PRIMARY KEY)');
   legacy.close();const before=readFileSync(file);
   const preview=JSON.parse(execFileSync(process.execPath,[resolve('scripts/audit-delivery-context.mjs'),'--db',file,'--bot','Kimi'],{encoding:'utf8'}));
   expect(preview).toMatchObject({dryRun:true,registered:false,resent:false});
   expect(preview.rows.map((row:any)=>row.id)).toEqual([1]);expect(readFileSync(file)).toEqual(before);
   const check=new Database(file,{readonly:true});
   try{expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('delivery_operations','lma_database_identity')").all()).toEqual([]);}finally{check.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it('historical dry run and explicit register are exact and idempotent, no transport',()=>{
  const h=makeHarness('Kimi');const script=resolve('scripts/audit-delivery-context.mjs');
  try{
   const id=h.store.enqueueDelivery({sessionKey:'lma-kimi-chat1',chatId:'chat1',botName:'Kimi',sourceType:'assistant_visible',sourceId:'historical',deliveryKey:'old-key',contentHash:'x',content:'historical answer',attachmentsJson:'[]',replyToMessageId:''})!;
   h.store.markDeliveryTextDelivered(id);h.store.markDeliveryDelivered(id);h.store.close();
   const before=readFileSync(h.dbPath);const preview=JSON.parse(execFileSync(process.execPath,[script,'--db',h.dbPath,'--bot','Kimi'],{encoding:'utf8'}));
   expect(readFileSync(h.dbPath)).toEqual(before);expect(preview.rows[0].id).toBe(id);
   const args=[script,'--db',h.dbPath,'--bot','Kimi','--register','--outbox',String(id),'--chat','chat1','--verified-message-id','verified-old'];
   execFileSync(process.execPath,args,{encoding:'utf8'});execFileSync(process.execPath,args,{encoding:'utf8'});
   const store=new MessageStore(h.dbPath);expect(store.getRecent('chat1')).toHaveLength(1);store.close();
  }finally{h.cleanup();}
 });
 it('non-LMA database with generic overlapping table names must be rejected without migration writes',()=>{
  const h=makeHarness('Kimi');const foreign=join(dirname(h.dbPath),'foreign.db');const f=new Database(foreign);
  f.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,message_id TEXT UNIQUE,chat_id TEXT,sender_type TEXT,sender_name TEXT,content TEXT,timestamp INTEGER); CREATE TABLE delivery_outbox(id INTEGER PRIMARY KEY,bot_name TEXT,chat_id TEXT,status TEXT); INSERT INTO delivery_outbox VALUES(1,'Kimi','chat1','delivered');");f.close();
  try {
   const before=readFileSync(foreign);try{execFileSync(process.execPath,[resolve('scripts/audit-delivery-context.mjs'),'--db',foreign,'--bot','Kimi','--register','--outbox','1','--chat','chat1','--verified-message-id','actual-id'],{encoding:'utf8',stdio:'pipe'});}catch{}
   const f=new Database(foreign,{readonly:true});observations.foreignGuard={beforeBytes:before.length,afterBytes:readFileSync(foreign).length,tables:f.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()};f.close();
   expect(readFileSync(foreign)).toEqual(before);
  }finally{h.cleanup();}
 });
});

describe('independent persistence beyond one-shot failure',()=>{
 it('confirmed body context obligation survives more than five SQLite failures and restart',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   db(h).exec("CREATE TRIGGER long_context_failure BEFORE INSERT ON messages WHEN NEW.sender_type='bot' BEGIN SELECT RAISE(ABORT,'context unavailable'); END;");
   await enqueue(h,'persistent-sqlite');clearTimers(h.bot);
   for(let i=0;i<5;i++){await (h.bot as any).dispatchPendingDeliveries('chat1');clearTimers(h.bot);}
   const failed=h.store.getDeliveryByKey('Kimi','chat1','persistent-sqlite');
   db(h).exec('DROP TRIGGER long_context_failure');r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   observations.sqliteExhaustion={effects:w.accepted.length,status:failed?.status,attempts:failed?.attempts,receipts:r.store.listDeliveryReceipts(failed!.id!),contextRows:r.store.getRecent('chat1').length,restartSends:r.port.calls.length};
   expect(r.port.calls).toHaveLength(0);expect(r.store.getRecent('chat1').filter((m:any)=>m.senderType==='bot')).toHaveLength(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
 it.each(['file','image','document'])('confirmed %s stage context transaction fails then restarts with no duplicate SDK operations',async kind=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   const a=fixture(h,kind);db(h).exec("CREATE TRIGGER attachment_context_failure BEFORE INSERT ON delivery_context BEGIN SELECT RAISE(ABORT,'attachment context unavailable'); END;");
   await enqueue(h,'attachment-sqlite-'+kind,'',[a]);clearTimers(h.bot);expect(w.accepted.length).toBeGreaterThan(0);expect(rows(h)).toHaveLength(0);
   expect(h.store.getDeliveryByKey('Kimi','chat1','attachment-sqlite-'+kind)?.attachmentCursor).toBe(0);
   db(h).exec('DROP TRIGGER attachment_context_failure');r=await reopen(h);if(kind==='document')fixture({bot:r.bot,dbPath:h.dbPath},kind);
   await r.bot.dispatchPendingDeliveries('chat1');expect(r.port.calls).toHaveLength(0);expect(r.store.getRecent('chat1').filter((m:any)=>m.senderType==='bot')).toHaveLength(1);
   expect(r.store.getDeliveryByKey('Kimi','chat1','attachment-sqlite-'+kind)?.attachmentCursor).toBe(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
});

describe('persistent local custody and explicit no-send reconciliation controls',()=>{
 it('six main receipt journal UPDATE failures do not resend an accepted card or emit send-failed text',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   db(h).exec("CREATE TRIGGER fail_many_receipts BEFORE UPDATE OF state ON delivery_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'receipt checkpoint unavailable'); END;");
   await enqueue(h,'receipt-many');clearTimers(h.bot);
   for(let i=0;i<6;i++){await (h.bot as any).dispatchPendingDeliveries('chat1');clearTimers(h.bot);}
   expect(w.accepted).toHaveLength(1);expect(w.calls).toHaveLength(1);
   const out=h.store.getDeliveryByKey('Kimi','chat1','receipt-many')!;expect(out.status).toBe('pending');expect(out.attempts).toBe(0);
   expect(db(h).prepare('SELECT failures FROM delivery_local_obligations WHERE outbox_id=?').get(out.id).failures).toBeGreaterThan(5);
   db(h).exec('DROP TRIGGER fail_many_receipts');r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   expect(r.port.calls).toHaveLength(0);expect(rows(r)).toHaveLength(1);expect(r.store.getDeliveryByKey('Kimi','chat1','receipt-many')?.status).toBe('delivered');
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
 it('a receipt-custody INSERT outage retains the full known SDK result in the live process and retries only local writes',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot);
  try{
   db(h).exec("CREATE TRIGGER fail_escrow BEFORE INSERT ON delivery_receipt_custody BEGIN SELECT RAISE(ABORT,'receipt local journal unavailable'); END;");
   await enqueue(h,'receipt-memory');clearTimers(h.bot);expect(w.accepted).toHaveLength(1);
   for(let i=0;i<6;i++){await (h.bot as any).dispatchPendingDeliveries('chat1');clearTimers(h.bot);}
   expect(w.calls).toHaveLength(1);expect(h.store.listDeliveryReceipts(h.store.getDeliveryByKey('Kimi','chat1','receipt-memory')!.id!)).toHaveLength(1);
   db(h).exec('DROP TRIGGER fail_escrow');await (h.bot as any).dispatchPendingDeliveries('chat1');
   expect(w.calls).toHaveLength(1);expect(rows(h)).toHaveLength(1);expect(h.store.getDeliveryByKey('Kimi','chat1','receipt-memory')?.status).toBe('delivered');
  }finally{h.cleanup();}
 });
 it('an hour-later restart still repairs accepted context, with a separate local-attempt counter and no scary platform failure',async()=>{
  vi.useFakeTimers();const h=makeHarness('Kimi');const w=uniqueWire(h.bot);let r:any;
  try{
   db(h).exec("CREATE TRIGGER hour_context_failure BEFORE INSERT ON messages WHEN NEW.sender_type='bot' BEGIN SELECT RAISE(ABORT,'offline context'); END;");
   await enqueue(h,'hour-later');clearTimers(h.bot);
   for(let i=0;i<8;i++){await (h.bot as any).dispatchPendingDeliveries('chat1');clearTimers(h.bot);}
   expect(w.calls).toHaveLength(1);expect(h.store.getDeliveryByKey('Kimi','chat1','hour-later')?.attempts).toBe(0);
   vi.setSystemTime(Date.now()+3600_000);db(h).exec('DROP TRIGGER hour_context_failure');r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');
   expect(r.port.calls).toHaveLength(0);expect(rows(r)).toHaveLength(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();vi.useRealTimers();}
 });
 it('unknown attachment caption remains audit-visible after confirmed file context, then exact proof settles with no SDK request',async()=>{
  const h=makeHarness('Kimi');const w=uniqueWire(h.bot,p=>{if(p.data.msg_type==='interactive')throw new Error('unknown caption');return {code:0,data:{message_id:'confirmed-file',chat_id:'chat1'}};});let r:any;
  try{
   await enqueue(h,'proof-caption','',[fixture(h,'file')]);clearTimers(h.bot);const out=h.store.getDeliveryByKey('Kimi','chat1','proof-caption')!;
   expect(rows(h)).toHaveLength(1);expect(rows(h)[0].content).not.toContain('confirmed report');
   expect(h.store.previewMissingDeliveryContext('Kimi').map((x:any)=>x.id)).toContain(out.id);
   h.store.registerHistoricalDeliveryContext(out.id!,'Kimi','chat1',['independently-confirmed-caption']);
   r=await reopen(h);await r.bot.dispatchPendingDeliveries('chat1');expect(r.port.calls).toHaveLength(0);
   expect(r.store.getDeliveryByKey('Kimi','chat1','proof-caption')?.status).toBe('delivered');expect(w.accepted).toHaveLength(1);
  }finally{if(r){clearTimers(r.bot);r.store.close();}h.cleanup();}
 });
});

it('legacy unknown body without captured transport payload can be settled only by independently verified exact message identity, with no sending',async()=>{
 const h=makeHarness('Kimi');const w=uniqueWire(h.bot);
 try{
  const id=h.store.enqueueDelivery({sessionKey:'lma-kimi-chat1',chatId:'chat1',botName:'Kimi',sourceType:'assistant_visible',sourceId:'legacy-unknown',deliveryKey:'legacy-unknown',contentHash:'exact',content:'independently verified original answer',attachmentsJson:'[]',replyToMessageId:''})!;
  h.store.saveDeliveryOperation(id,`outbox:${id}:body:0`,'unknown',{});
  expect(()=>h.store.registerHistoricalDeliveryContext(id,'Other','chat1',['actual-proof'])).toThrow();
  h.store.registerHistoricalDeliveryContext(id,'Kimi','chat1',['actual-proof']);await (h.bot as any).dispatchPendingDeliveries('chat1');
  expect(w.calls).toHaveLength(0);expect(rows(h)).toHaveLength(1);expect(h.store.getDeliveryByKey('Kimi','chat1','legacy-unknown')?.status).toBe('delivered');
 }finally{h.cleanup();}
});
