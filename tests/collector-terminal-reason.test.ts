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
    send(text: string) { const req = JSON.parse(text); if (req.method === "connect") queueMicrotask(() => this.frame({ type: "res", id: req.id, ok: true, payload: { type: "hello-ok", protocol: 4, features: {} } })); }
    close() { this.emit("close"); }
  } };
});
process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "0";
const CHAT = "oc_11111111111111111111111111111111";
const KEY = `agent:main:lma-fixture-${CHAT}`;
const SID = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const APP = "cli_4444444444444444";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); sockets.length = 0; FeishuBot.getAllBots().clear(); vi.clearAllTimers(); vi.useRealTimers(); });
async function harness(existingPath?: string) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  const dir = existingPath ? undefined : mkdtempSync(join(tmpdir(), "lma-terminal-reason-"));
  const dbPath=existingPath || join(dir!, "messages.db");
  const store = new MessageStore(dbPath); let storeClosed=false;
  const closeStore=()=>{if(!storeClosed){store.close();storeClosed=true;}};
  const client: any = new OpenClawClient({ baseUrl: "ws://offline", token: "synthetic" } as any);
  await client.connect(); const socket = sockets.at(-1); let admitted = false;
  let snapshot: any = { runId: RUN, status: "timeout", stopReason: "timeout", startedAt: Date.now() - 10_000, endedAt: Date.now(), error: "chat run timed out" };
  client.rpc = vi.fn(async (method: string) => {
    if (method === "sessions.describe") return { session: { sessionId: SID, model: "offline-model", modelProvider: "offline", hasActiveRun: admitted, status: admitted ? "running" : "idle", totalTokens: 0 } };
    if (method === "chat.history") return { sessionKey: KEY, sessionInfo: { sessionId: SID, hasActiveRun: admitted }, pendingInputs: { total: 0, items: [] } };
    if (method === "chat.send") { admitted = true; return { runId: RUN, sessionId: SID, status: "started" }; }
    if (method === "agent.wait") { if (snapshot instanceof Error) throw snapshot; return snapshot; }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.abort") return { aborted: true, runIds: [RUN] };
    throw new Error(`Unexpected offline RPC: ${method}`);
  });
  client.ensureModel = vi.fn(async () => false);
  const bot: any = new FeishuBot({ name: "Fixture", appId: APP, appSecret: "synthetic", model: "offline-model" }, client, store);
  const bodies: string[] = []; let sequence = 0;
  const send = vi.fn(async (p: any) => { bodies.push(p.data.content); return { code: 0, data: { message_id: `om_offline_receipt_${++sequence}`, chat_id: CHAT } }; });
  bot.client.im.message.create = send; bot.client.im.message.reply = send;
  bot.addReaction = bot.removeReaction = vi.fn(async () => {});
  bot.sendLiveStatusCard = bot.replyLiveStatusCard = vi.fn(async () => "offline-status");
  bot.patchLiveStatusCard = bot.patchLiveStatusDoneSummary = vi.fn(async () => {});
  bot.goController.recoverOnStartup = vi.fn(async () => {});
  await bot.ensureSession(CHAT);
  closes.push(async () => { for (const map of [bot.errorNoticeTimers, bot.deliveryRetryTimers]) { for (const t of map.values()) clearTimeout(t); map.clear(); } for (const target of bot.deliveryTargetsByRun.values()) clearTimeout(target.timer); closeStore(); await client.disconnect(); if(dir)rmSync(dir, { recursive: true, force: true }); });
  const frame = (event: string, payload: any) => socket.frame({ type: "event", event, payload: { runId: RUN, sessionKey: KEY, sessionId: SID, ...payload } });
  const ingress = () => bot.handleMessage({ sender: { sender_type: "user", sender_id: { open_id: "ou_55555555555555555555555555555555" } }, message: { chat_id: CHAT, chat_type: "p2p", message_id: "om_offline_trigger", message_type: "text", content: JSON.stringify({ text: "Synthetic terminal boundary check." }), mentions: [] } });
  const rows = () => (store as any).db.prepare("SELECT * FROM delivery_outbox WHERE source_type IN ('provider_error','run_error') ORDER BY id").all();
  return { store, client, bot, frame, ingress, rows, bodies, send, dbPath, closeStore, setSnapshot: (s: any) => { snapshot = s; } };
}

describe("receiver → foreground collector → queue catch → renderer → guarded outbox → SDK receipt", () => {
  it("preserves chat.aborted timeout through generic lifecycle error and emits only one same-run error body", async () => {
    const h = await harness(); const work = h.ingress(); await vi.advanceTimersByTimeAsync(10);
    // The aborted frame shape/reason is observed; lifecycle and late error
    // envelopes are source-derived synthetic fixtures, not a captured full wire.
    h.frame("chat", { state: "aborted", stopReason: "timeout" });
    h.frame("agent", { stream: "lifecycle", data: { phase: "error", error: "aborted" } });
    await vi.advanceTimersByTimeAsync(1_000); await work;
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].content).toContain("总时限");
    expect(h.rows()[0].content).not.toMatch(/原因尚未分类|仍在继续|等待暂停|用户.*停止/);
    expect(JSON.parse(h.rows()[0].delivery_meta_json).provenance).toMatchObject({ runId: RUN, sessionKey: KEY, sessionId: SID, error: { stopReason: "timeout" } });
    await vi.advanceTimersByTimeAsync(60_000);
    h.frame("chat", { state: "error", errorMessage: "chat run timed out" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.rows()).toHaveLength(1);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.store.listDeliveryReceipts(h.rows()[0].id)).toHaveLength(1);
    expect(h.client.rpc.mock.calls.filter(([m]: any[]) => m === "chat.send")).toHaveLength(1);
  });

  it("has one error body even when the later same-run diagnostic/source differs", async () => {
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    await vi.advanceTimersByTimeAsync(60_000);
    h.frame('chat',{state:'error',errorMessage:'chat run timed out'});
    h.frame('session.message',{message:{role:'assistant',stopReason:'error',errorMessage:'different diagnostic for the same terminal run',content:[]}});
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows().every((row:any)=>row.status==='delivered' && row.attempts===1)).toBe(true);
    expect(h.send).toHaveBeenCalledOnce();expect(h.rows()).toHaveLength(1);
  });

  it.each(['wire','query'])('reconciles generic aborted before later closed metadata (%s)',async mode=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    if(mode==='wire'){await vi.advanceTimersByTimeAsync(100);h.frame('chat',{state:'aborted',stopReason:'timeout'});}
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.rows()[0].content).toContain('总时限');
    expect(h.rows()[0].content).not.toMatch(/原因尚未分类|仍在继续|等待暂停/);expect(h.send).toHaveBeenCalledOnce();
  });

  it('keeps bare aborted unknown when exact cause inspection is unavailable',async()=>{
    const h=await harness();h.setSnapshot(new Error('offline query unavailable'));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.rows()[0].content).toContain('原因尚未分类');
    expect(h.rows()[0].content).toContain('aborted');expect(h.rows()[0].content).not.toMatch(/用户.*停止|已取消|总时限/);
  });

  it('lets late closed abort metadata replace an earlier generic chat-error placeholder',async()=>{
    const h=await harness();h.setSnapshot({runId:RUN,status:'timeout'});
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'error'});await vi.advanceTimersByTimeAsync(100);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.rows()[0].content).toContain('总时限');expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not promote a generic abort hint over verified subsequent progress',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(100);
    h.frame('agent',{stream:'assistant',data:{text:'A synthetic progress update.'}});
    await vi.advanceTimersByTimeAsync(500);expect(h.rows()).toHaveLength(0);
    h.frame('chat',{state:'final',message:{content:[{type:'text',text:'Synthetic recovered final.'}]}});
    h.frame('agent',{stream:'lifecycle',data:{phase:'end'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(0);expect(h.send).toHaveBeenCalledOnce();
  });

  it.each(['query-only timeout','stale ended terminal','query rejection'])('post-await abort cut: same-run progress invalidates %s',async outcome=>{
    const h=await harness();let resolve!:(value:any)=>void;let reject!:(error:Error)=>void;
    h.setSnapshot(new Promise<any>((yes,no)=>{resolve=yes;reject=no;}));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(400);
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='agent.wait')).toHaveLength(1);
    const sampledAt=Date.now();
    h.frame('agent',{stream:'assistant',data:{text:'Verified same-run progress during the pending query.'}});
    await vi.advanceTimersByTimeAsync(100);
    h.setSnapshot({runId:RUN,status:'timeout'});
    if(outcome==='query rejection')reject(new Error('Synthetic pending query failed'));
    else resolve(outcome==='query-only timeout' ? {runId:RUN,status:'timeout'} :
      {runId:RUN,status:'timeout',stopReason:'timeout',startedAt:sampledAt-10_000,endedAt:sampledAt,error:'chat run timed out'});
    await vi.advanceTimersByTimeAsync(1000);
    const failureCountBeforeFinal=h.rows().length;const sendsBeforeFinal=h.send.mock.calls.length;
    h.frame('chat',{state:'final',message:{content:[{type:'text',text:'Synthetic final after progress during query.'}]}});
    h.frame('agent',{stream:'lifecycle',data:{phase:'end'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(failureCountBeforeFinal).toBe(0);expect(sendsBeforeFinal).toBe(0);
    expect(h.rows()).toHaveLength(0);expect(h.send).toHaveBeenCalledOnce();
    expect(h.bodies.join('\n')).toContain('Synthetic final after progress during query.');
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='chat.send')).toHaveLength(1);
    expect(h.client.rpc.mock.calls.some(([method]:any[])=>method==='chat.abort')).toBe(false);
  });

  it.each(['query-only timeout','query rejection'])('post-await abort control: unchanged cut still reports bare unknown after %s',async outcome=>{
    const h=await harness();let resolve!:(value:any)=>void;let reject!:(error:Error)=>void;
    h.setSnapshot(new Promise<any>((yes,no)=>{resolve=yes;reject=no;}));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(400);
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='agent.wait')).toHaveLength(1);
    if(outcome==='query rejection')reject(new Error('Synthetic pending query failed'));
    else resolve({runId:RUN,status:'timeout'});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.send).toHaveBeenCalledOnce();
    expect(h.rows()[0].content).toContain('原因尚未分类');
    expect(h.rows()[0].content).not.toMatch(/总时限|用户.*停止|本次运行已取消/);
  });

  it.each(['wire final','closed timeout','explicit stop'])('post-await abort control: %s retains priority during the query',async authority=>{
    const h=await harness();let resolve!:(value:any)=>void;
    h.setSnapshot(new Promise<any>(yes=>{resolve=yes;}));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(400);
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='agent.wait')).toHaveLength(1);
    const sampledAt=Date.now();
    h.frame('agent',{stream:'assistant',data:{text:'Verified same-run progress before new terminal authority.'}});
    await vi.advanceTimersByTimeAsync(100);
    if(authority==='wire final')h.frame('chat',{state:'final',message:{content:[{type:'text',text:'Synthetic final wins over the old query.'}]}});
    if(authority==='closed timeout')h.frame('chat',{state:'aborted',stopReason:'timeout'});
    if(authority==='explicit stop')await h.client.abortChat(KEY);
    resolve({runId:RUN,status:'timeout',stopReason:'timeout',startedAt:sampledAt-10_000,endedAt:sampledAt,error:'chat run timed out'});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='chat.send')).toHaveLength(1);
    if(authority==='closed timeout'){
      expect(h.rows()).toHaveLength(1);expect(h.rows()[0].content).toContain('总时限');expect(h.send).toHaveBeenCalledOnce();
    } else {
      expect(h.rows()).toHaveLength(0);
      if(authority==='wire final'){expect(h.send).toHaveBeenCalledOnce();expect(h.bodies.join('\n')).toContain('Synthetic final wins over the old query.');}
      else expect(h.send).not.toHaveBeenCalled();
    }
  });

  it('preserves recoverable context handling when lifecycle metadata only says error',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',stopReason:'error',error:'context overflow: prompt too large'}});
    await vi.advanceTimersByTimeAsync(500);expect(h.rows()).toHaveLength(0);
    h.frame('chat',{state:'final',message:{content:[{type:'text',text:'Synthetic recovered context final.'}]}});
    h.frame('agent',{stream:'lifecycle',data:{phase:'end'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(0);expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not parse prompt/credential-bearing prose into a closed terminal reason',async()=>{
    const h=await harness();h.setSnapshot(new Error('offline lookup unavailable'));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted',stopReason:'User prompt: {"stopReason":"timeout","secret":"PRIVATE_INPUT"}'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()[0].content).toContain('原因尚未分类');
    expect(h.rows()[0].content).not.toMatch(/PRIVATE_INPUT|secret|User prompt|总时限|用户.*停止/);
  });

  it.each(['superseded','restart'])('preserves closed %s over generic aborted and a timeout hint',async reason=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted',stopReason:reason}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.rows()[0].content).toContain(reason==='restart'?'重启':'取代');
    expect(h.rows()[0].content).not.toContain('总时限');expect(h.rows()[0].content).not.toContain('本次运行已取消');
  });

  it('honors an explicit stop receipt before terminal presentation',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    await h.client.abortChat(KEY);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(0);expect(h.send).not.toHaveBeenCalled();
  });

  it.each([{status:'timeout'},{status:'timeout',pendingError:true,endedAt:123},{status:'error',yielded:true,endedAt:123},{status:'timeout',timeoutPhase:'queue',endedAt:123}])('does not manufacture termination from a public wait projection alone: %j',async projection=>{
    const h=await harness();h.setSnapshot({runId:RUN,...projection});
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'end'}});
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows()).toHaveLength(0);expect(h.send).not.toHaveBeenCalled();
    h.client.revokeSessionCollectors(KEY,'offline cleanup');await vi.advanceTimersByTimeAsync(10);await work;
  });

  it('never borrows another concurrent run reason in the same physical session',async()=>{
    const h=await harness();h.setSnapshot(new Error('no terminal proof for run A'));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    const other='66666666-6666-4666-8666-666666666666';
    h.frame('chat',{runId:other,state:'aborted',stopReason:'timeout'});
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'aborted'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    const a=h.rows().find((row:any)=>JSON.parse(row.delivery_meta_json).provenance.runId===RUN);
    const b=h.rows().find((row:any)=>JSON.parse(row.delivery_meta_json).provenance.runId===other);
    expect(a.content).toContain('原因尚未分类');expect(a.content).not.toContain('总时限');
    expect(b.content).toContain('总时限');expect(a.delivery_key).not.toBe(b.delivery_key);expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('lets an already received exact final outrank the delayed abort decision',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    h.frame('chat',{state:'final',message:{content:[{type:'text',text:'Synthetic final result.'}]}});
    h.frame('agent',{stream:'lifecycle',data:{phase:'end'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(0);expect(h.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);h.frame('chat',{state:'error',errorMessage:'chat run timed out'});
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows()).toHaveLength(0);expect(h.send).toHaveBeenCalledOnce();
  });

  it('reuses an ordinary foreground provider-error owner when late terminal provenance arrives',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'provider failed without a classified cause'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()[0].source_type).toBe('provider_error');expect(JSON.parse(h.rows()[0].delivery_meta_json).provenance.runId).toBe(RUN);
    await vi.advanceTimersByTimeAsync(60_000);h.frame('chat',{state:'error',errorMessage:'later detail for the same failure'});
    await vi.advanceTimersByTimeAsync(1000);expect(h.rows()).toHaveLength(1);expect(h.send).toHaveBeenCalledOnce();
  });

  it('retains trigger-scoped delivery for an unadmitted failure with no run identity',async()=>{
    const h=await harness();const rpc=h.client.rpc.getMockImplementation();
    h.client.rpc.mockImplementation(async(method:string,...args:any[])=>{
      if(method==='chat.send')throw new Error('RPC error: {"code":"INVALID_REQUEST","message":"Synthetic admission rejection"}');
      return rpc(method,...args);
    });
    const work=h.ingress();await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.rows()).toHaveLength(1);expect(h.rows()[0].source_type).toBe('provider_error');
    expect(h.rows()[0].delivery_key).toMatch(/^trigger:\d+:provider-error$/);
    expect(JSON.parse(h.rows()[0].delivery_meta_json).provenance?.runId).toBeUndefined();
    expect(h.client.rpc.mock.calls.filter(([m]:any[])=>m==='chat.send')).toHaveLength(1);
    expect(h.store.getRunObservation(KEY,RUN)).toBeNull();expect(h.send).toHaveBeenCalledOnce();
  });

  it.each(['app','epoch','physical','recall'])('rechecks original %s ownership before a terminal error send',async change=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    if(change==='app')h.bot.config.appId='cli_7777777777777777';
    if(change==='epoch')h.store.bumpStopGeneration('Fixture',CHAT);
    if(change==='physical'){
      const original=h.store.getDeliveryRunTarget('Fixture',CHAT,RUN);
      h.store.bindDeliveryRun('Fixture',CHAT,RUN,{...original,sessionId:'88888888-8888-4888-8888-888888888888'});
    }
    if(change==='recall')h.store.markMessageRecalled('om_offline_trigger',CHAT,Date.now(),'fixture_owner');
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).not.toHaveBeenCalled();expect(h.rows()).toHaveLength(0);
  });

  it('ordinary admitted error route: matching original app sends once with retained provenance',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    const target=h.store.getDeliveryRunTarget('Fixture',CHAT,RUN);
    expect(target).toMatchObject({botIdentity:APP,sessionId:SID,stopGeneration:0});
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'Synthetic ordinary provider failure'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).toHaveBeenCalledOnce();expect(h.rows()).toHaveLength(1);
    const row=h.rows()[0];const meta=JSON.parse(row.delivery_meta_json);
    expect(row).toMatchObject({source_type:'provider_error',status:'delivered',attempts:1});
    expect(meta).toMatchObject({botIdentity:APP,deliveryStopEpoch:0,provenance:{runId:RUN,sessionKey:KEY,sessionId:SID,error:{botIdentity:APP,stopEpoch:0,runId:RUN,sessionKey:KEY,sessionId:SID}}});
    expect(h.store.listDeliveryReceipts(row.id)).toHaveLength(1);
  });

  it.each(['app','epoch','physical','recall'])('ordinary admitted error route: refuses changed %s before foreground catch',async change=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    const target=h.store.getDeliveryRunTarget('Fixture',CHAT,RUN);
    expect(target).toMatchObject({botIdentity:APP,sessionId:SID,stopGeneration:0});
    if(change==='app')h.bot.config.appId='cli_7777777777777777';
    if(change==='epoch')h.store.bumpStopGeneration('Fixture',CHAT);
    if(change==='physical')h.store.bindDeliveryRun('Fixture',CHAT,RUN,{...target,sessionId:'88888888-8888-4888-8888-888888888888'});
    if(change==='recall')h.store.markMessageRecalled('om_offline_trigger',CHAT,Date.now(),'fixture_owner');
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'Synthetic ordinary provider failure'}});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).not.toHaveBeenCalled();
    for(const row of h.rows()){
      expect(row.status).not.toBe('delivered');expect(h.store.listDeliveryReceipts(row.id)).toHaveLength(0);
      expect(JSON.parse(row.delivery_meta_json)).toMatchObject({botIdentity:APP,deliveryStopEpoch:0,provenance:{error:{botIdentity:APP,stopEpoch:0,sessionId:SID}}});
    }
    expect(h.store.getDeliveryRunTarget('Fixture',CHAT,RUN).botIdentity).toBe(APP);
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='chat.send')).toHaveLength(1);
  });

  it.each(['app','epoch','physical','recall'])('ordinary admitted error route: rechecks changed %s after outbox enqueue',async change=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    const target=h.store.getDeliveryRunTarget('Fixture',CHAT,RUN);
    let release!:(status:any)=>void;const held=new Promise<any>(yes=>{release=yes;});let footerRead=false;
    const status={status:'running',running:true,checkedAt:Date.now(),sessionId:SID};
    h.bot.readSessionStatus=vi.fn(async()=>{if(h.rows().length){footerRead=true;return held;}return status;});
    h.frame('agent',{stream:'lifecycle',data:{phase:'error',error:'Synthetic ordinary provider failure'}});
    await vi.advanceTimersByTimeAsync(100);
    expect(footerRead).toBe(true);expect(h.rows()).toHaveLength(1);expect(h.send).not.toHaveBeenCalled();
    const row=h.rows()[0];expect(JSON.parse(row.delivery_meta_json).provenance.error.botIdentity).toBe(APP);
    if(change==='app')h.bot.config.appId='cli_7777777777777777';
    if(change==='epoch')h.store.bumpStopGeneration('Fixture',CHAT);
    if(change==='physical')h.store.bindDeliveryRun('Fixture',CHAT,RUN,{...target,sessionId:'88888888-8888-4888-8888-888888888888'});
    if(change==='recall')h.store.markMessageRecalled('om_offline_trigger',CHAT,Date.now(),'fixture_owner');
    release(status);await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).not.toHaveBeenCalled();expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].status).not.toBe('delivered');expect(h.store.listDeliveryReceipts(row.id)).toHaveLength(0);
    expect(JSON.parse(h.rows()[0].delivery_meta_json)).toMatchObject({botIdentity:APP,deliveryStopEpoch:0,provenance:{error:{botIdentity:APP,stopEpoch:0,sessionId:SID}}});
    expect(h.client.rpc.mock.calls.filter(([method]:any[])=>method==='chat.send')).toHaveLength(1);
  });

  it('keeps attempted-unknown error delivery custody through restart without another platform attempt',async()=>{
    const h=await harness();h.send.mockRejectedValueOnce(new Error('offline send receipt unknown'));
    const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    h.frame('chat',{state:'aborted',stopReason:'timeout'});
    await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).toHaveBeenCalledOnce();const row=h.rows()[0];expect(h.store.hasUnknownDeliveryOperation(row.id)).toBe(true);
    h.closeStore();const restarted=await harness(h.dbPath);
    restarted.frame('chat',{state:'error',errorMessage:'chat run timed out'});
    await vi.advanceTimersByTimeAsync(1000);await restarted.bot.dispatchPendingDeliveries(CHAT);
    expect(restarted.rows()).toHaveLength(1);expect(restarted.send).not.toHaveBeenCalled();
    expect(restarted.store.hasUnknownDeliveryOperation(row.id)).toBe(true);
  });

  it('does not erase the first admitted app/physical/epoch target on a later local rebind',async()=>{
    const h=await harness();const work=h.ingress();await vi.advanceTimersByTimeAsync(10);
    const original=h.store.getDeliveryRunTarget('Fixture',CHAT,RUN);
    expect(original).toMatchObject({botIdentity:APP,sessionId:SID,stopGeneration:0});
    h.bot.config.appId='cli_7777777777777777';h.store.bumpStopGeneration('Fixture',CHAT);
    h.bot.bindRunDeliveryTarget(CHAT,RUN,{triggerId:original.triggerId,messageId:original.messageId});
    expect(h.store.getDeliveryRunTarget('Fixture',CHAT,RUN)).toMatchObject({botIdentity:APP,sessionId:SID,stopGeneration:0});
    h.frame('chat',{state:'aborted',stopReason:'timeout'});await vi.advanceTimersByTimeAsync(1000);await work;
    expect(h.send).not.toHaveBeenCalled();
  });

  it('recognizes confirmed legacy trigger/run error keys without rewriting or replaying them',async()=>{
    const h=await harness();
    h.store.bindDeliveryRun('Fixture',CHAT,RUN,{triggerId:42,runId:RUN,messageId:'om_legacy_trigger',sessionKey:KEY,sessionId:SID,stopGeneration:0});
    await h.bot.enqueueAndDispatchDelivery(CHAT,'provider_error','trigger:42:provider-error','Legacy synthetic error.',[],undefined,'trigger:42:provider-error');
    const old=h.store.enqueueDelivery({sessionKey:KEY,chatId:CHAT,botName:'Fixture',sourceType:'run_error',sourceId:'legacy',deliveryKey:`run-error:${errorIdentity(KEY,RUN)}`,contentHash:'legacy',content:'Legacy synthetic timeout.',attachmentsJson:'[]',replyToMessageId:'',deliveryMetaJson:JSON.stringify({botIdentity:APP,deliveryStopEpoch:0})});
    h.store.markDeliveryDelivered(old!); // Historical owner fixture, not a captured lifecycle wire.
    const before=h.rows();const attempts=h.send.mock.calls.length;
    h.frame('chat',{state:'error',errorMessage:'chat run timed out'});await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows()).toEqual(before);expect(h.send).toHaveBeenCalledTimes(attempts);
  });

  it('uses original legacy outbox app evidence instead of a replacement app identity',async()=>{
    const h=await harness();h.store.bindDeliveryRun('Fixture',CHAT,RUN,{triggerId:43,runId:RUN,messageId:'om_legacy_owner',sessionKey:KEY,stopGeneration:0});
    await h.bot.enqueueAndDispatchDelivery(CHAT,'provider_error','trigger:43:provider-error','Legacy synthetic owner.',[],undefined,'trigger:43:provider-error');
    const before=h.rows();h.bot.config.appId='cli_7777777777777777';
    h.frame('chat',{state:'error',errorMessage:'late error from the original run'});await vi.advanceTimersByTimeAsync(1000);
    expect(h.rows()).toEqual(before);expect(h.send).toHaveBeenCalledOnce();
  });
});
