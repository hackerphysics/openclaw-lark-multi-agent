import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const views=()=>[...h.bot.replyLiveStatusCard.mock.calls.map(([,view]:any)=>view),...h.bot.patchLiveStatusCard.mock.calls.map(([,view]:any)=>view)];
const lastView=()=>h.bot.patchLiveStatusCard.mock.calls.at(-1)?.[1] || h.bot.replyLiveStatusCard.mock.calls.at(-1)?.[1];
const wire=(runId:string,stream:string,data:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event:'agent',payload:{sessionKey:h.key,runId,stream,data}})));
const noGet=()=>expect(h.bot.addReaction.mock.calls.some(([,emoji]:any)=>emoji==='Get')).toBe(false);
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});h=harness();const connecting=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connecting;});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('durable receipt precedes slow preparation with honest queued presentation',()=>{
 it.each(['health','setup','history','model'] as const)('%s held >2s: queued card precedes Gateway/model acceptance',async gate=>{
  const held=deferred<any>();
  if(gate==='health')h.bot.getUnhealthySessionStatus=()=>held.promise;
  if(gate==='setup')h.bot.ensureSession=()=>held.promise;
  if(gate==='history')h.client.getSessionDispatchStatus=()=>held.promise;
  if(gate==='model'){
   h.bot.initializedSessions.add(h.bot.getSessionKey('chat'));
   h.bot.ensureSession=Object.getPrototypeOf(h.bot).ensureSession;
   h.client.ensureModel=()=>held.promise;
  }
  void h.bot.handleMessage(event('A'));await tick(2501);
  const row=h.store.getMessageId('A')!;
  expect(row).toBeGreaterThan(0);expect(h.store.getPendingTriggerIds('Bot','chat').has(row)).toBe(true);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(lastView()).toMatchObject({state:'queued',phase:'queued',toolCalls:0});
  expect(lastView().title).not.toMatch(/正在执行|is working|完成|done/);
  expect(lastView().lines.some((line:any)=>/本地可靠收件/.test(line.text))).toBe(true);
  expect(h.sends).toHaveLength(0);noGet();
  // Neither the UI row nor elapsed ticking manufactures dispatch custody.
  expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('four simultaneous inputs coalesce before setup, then the exact admitted root owns that same card',async()=>{
  const health=deferred<null>();h.bot.getUnhealthySessionStatus=()=>health.promise;
  const inputs=['A','B','C','D'].map(text=>h.bot.handleMessage(event(text)));
  await tick(2501);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);noGet();
  health.resolve(null);await tick(0);await tick(120);
  expect(h.sends).toHaveLength(1);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(lastView()).toMatchObject({state:'admitted',phase:'admitted'});
  wire('foreign','assistant',{deltaText:'FOREIGN PRIVATE NOTE',replace:true});
  wire('foreign','tool',{name:'read',phase:'start',toolCallId:'foreign',input:{path:'foreign.txt'}});
  wire('r1','assistant',{deltaText:'PUBLIC SAME ROOT NOTE',replace:true});
  wire('r1','tool',{name:'read',phase:'start',toolCallId:'root',input:{path:'root.txt'}});
  await tick(1100);
  expect(lastView()).toMatchObject({state:'running',phase:'working'});
  expect(JSON.stringify(views())).toContain('root.txt');expect(JSON.stringify(views())).not.toContain('FOREIGN PRIVATE NOTE');
  h.final('r1','exact authoritative reply');await tick(1200);await Promise.all(inputs);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(lastView().state).toBe('done');
 });
 it('a held chat.send ACK leaves the card queued and never displays Get',async()=>{
  const ack=deferred<any>(),base=h.client.rpc;
  h.client.rpc=vi.fn((method:string,p:any)=>method==='chat.send'?(h.sends.push(p),ack.promise):base(method,p));
  const input=h.bot.handleMessage(event('A'));await tick(2501);
  expect(h.sends).toHaveLength(1);expect(lastView()).toMatchObject({state:'queued',phase:'queued'});noGet();
  ack.resolve({runId:'exact-root',status:'started'});await tick(100);
  expect(lastView()).toMatchObject({state:'admitted',phase:'admitted'});
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('A')!).desired).toBe('Get');
  h.final('exact-root','accepted result');await tick(1200);await input;
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
 });
 it('slow thinking metadata cannot postpone the receipt card or chat.send',async()=>{
  h.bot.fetchThinkingLabel=()=>new Promise(()=>{});
  const input=h.bot.handleMessage(event('A'));await tick(2501);
  expect(h.sends).toHaveLength(1);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(lastView().phase).toBe('admitted');h.final('r1');await tick(1200);await input;
 });
 it('steering burst reuses the exact active-root card, without claiming additional input accepted',async()=>{
  const input=h.bot.handleMessage(event('A'));await tick(900);
  wire('r1','tool',{name:'read',phase:'start',toolCallId:'working',input:{path:'a.txt'}});await tick(1100);
  // Avoid conflating presentation coalescing with admission policy: busy input
  // health is deliberately held, so no insertion RPC can acknowledge it yet.
  h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
  for(const text of ['B','C','D'])void h.bot.handleMessage(event(text));
  await tick(2501);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(lastView().phase).toBe('working');
  expect(lastView().lines.some((line:any)=>/尚未确认 Gateway 接收/.test(line.text))).toBe(true);
  for(const text of ['B','C','D'])expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId(text)!).desired).toBe('Typing');
  h.final('r1');await tick(1200);await input;
 });
 it.each(['off','verbose','native','mute','shouldRespond'] as const)('preserves %s presentation suppression',async mode=>{
  if(mode==='off')h.store.setBotLiveStatus('Bot','chat',false);
  if(mode==='verbose')h.store.setBotVerbose('Bot','chat',true);
  if(mode==='mute')h.store.setBotMode('Bot','chat','mute');
  if(mode==='shouldRespond')h.bot.shouldRespond=()=>false;
  h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
  const e=event(mode==='native'?'//status':'A');
  if(mode==='mute')e.message.chat_type='group';
  void h.bot.handleMessage(e);await tick(2501);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
 });
 it('presentation journal failure suppresses UI, not ordinary business admission',async()=>{
  vi.spyOn(h.store,'savePresentation').mockImplementation(()=>{throw new Error('UI journal unavailable');});
  const input=h.bot.handleMessage(event('A'));await tick(100);
  expect(h.sends).toHaveLength(1);expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
  h.final('r1','actual final despite UI outage');await tick(1200);await input;
  expect(h.store.hasDeliveredReply('Bot','chat',h.store.getMessageId('A')!)).toBe(true);
 });
 it('queued receipt uses the source Bot SDK and original message address',async()=>{
  h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
  h.bot.replyLiveStatusCard=Object.getPrototypeOf(h.bot).replyLiveStatusCard.bind(h.bot);
  void h.bot.handleMessage(event('A','original-message'));await tick(900);
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.create.mock.calls[0][0]).toMatchObject({path:{message_id:'original-message'},data:{msg_type:'interactive'}});
  expect(JSON.parse(h.create.mock.calls[0][0].data.content).header.title.content).toContain('已收件');
 });
 it('normal fast accepted run remains card-free and confirms final delivery',async()=>{
  h.client.chatSendWithContext=vi.fn(async(p:any)=>{await p.onSendAttempt('fast');await p.onSubmitted('fast');return 'fast exact final';});
  const input=h.bot.handleMessage(event('A'));await tick(500);await input;
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
  expect(h.store.hasDeliveredReply('Bot','chat',h.store.getMessageId('A')!)).toBe(true);
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('A')!).desired).toBe('DONE');
 });
});
