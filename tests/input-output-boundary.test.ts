import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';

// Source-derived public envelopes, not a claim of archived incident WS frames.
// Core projects inter-session user records to role:assistant, preserving input
// provenance, senderSession and :user keys. Real model output has no such marks.
const wrapper='【用户中途插入的新消息，请与当前任务一起处理】\n为啥消息发给我了';
const provenance={kind:'inter_session',sourceSessionKey:'agent:main:fixture-peer',sourceTool:'sessions_send'};
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const wire=(channel:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event:channel,payload:{sessionKey:h.key,...payload}})));
const message=(text=wrapper,extra:any={})=>({role:'assistant',content:[{type:'text',text}],...extra});
const bodyDeliveries=()=>h.store.getRecent('chat').filter(m=>m.senderType==='bot').map(m=>m.content);
const cards=()=>JSON.stringify([...h.bot.replyLiveStatusCard.mock.calls,...h.bot.patchLiveStatusCard.mock.calls,...h.bot.patchLiveStatusDoneSummary.mock.calls]);
const begin=async()=>{const p=h.bot.handleMessage(event('offline question'));await tick(50);expect(h.sends).toHaveLength(1);return {p};};
const final=(text='real model answer')=>{
 wire('chat',{runId:'r1',state:'final',message:message(text,{stopReason:'stop'})});
 wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
};
beforeEach(async()=>{
 vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 h=harness();h.client.ensureModel=vi.fn(async()=>false);h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
 const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0,items:[]}}:base(m,p));
 const connected=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
 await h.bot.ensureSession('chat');
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

const inputs=[
 ['user',{role:'user'}],
 ['forwarded input',{provenance}],
 ['internal system input',{provenance:{kind:'internal_system',sourceTool:'progress_card_refresh'}}],
 ['projected external input',{provenance:{kind:'external_user'}}],
 ['sender session mirror',{senderSession:{sessionKey:'agent:main:fixture-peer'}}],
 ['input idempotency key',{idempotencyKey:'fixture-submission:user'}],
 ['nested public input key',{__openclaw:{idempotencyKey:'fixture-submission:user'}}],
] as const;

describe('real WS receiver -> collector/progress/proactive -> SQLite business outbox',()=>{
 it.each(inputs)('session.message %s is not model output or an original-run final',async(_label,marks)=>{
  const {p}=await begin();wire('session.message',{runId:'r1',sessionId:'generation-1',message:message(wrapper,marks)});
  wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
  await tick(5100);expect(cards()).not.toContain('【用户中途插入');expect(bodyDeliveries()).toEqual([]);
  final();await tick(350);await p;
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('real model answer');expect(bodyDeliveries()).toEqual(['real model answer']);expect(cards()).not.toContain('【用户中途插入');
 });
 it.each(inputs)('unowned session.message %s never creates a proactive business delivery',async(_label,marks)=>{
  wire('session.message',{runId:'external-input',message:message(wrapper,marks)});await tick(100);
  expect(bodyDeliveries()).toEqual([]);expect(h.create).not.toHaveBeenCalled();expect(cards()).not.toContain('【用户中途插入');
 });
 it.each(['chat','agent'] as const)('%s user/input delta cannot become running-card assistant text',async(channel)=>{
  const {p}=await begin();
  if(channel==='chat')wire('chat',{runId:'r1',state:'delta',deltaText:wrapper,message:message(wrapper,{role:'user'})});
  else wire('agent',{runId:'r1',stream:'assistant',data:{deltaText:wrapper,replace:true,message:message(wrapper,{provenance})}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'read',phase:'start',toolCallId:'fixture',input:{path:'offline.txt'}}});
  await tick(100);expect(cards()).not.toContain('【用户中途插入');expect(bodyDeliveries()).toEqual([]);
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it.each(inputs)('chat.final %s cannot terminate/overwrite the owned collector',async(_label,marks)=>{
  const {p}=await begin();wire('chat',{runId:'r1',state:'final',message:message(wrapper,marks)});await tick(5100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(cards()).not.toContain('【用户中途插入');
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it('input-marked chat error is not a model failure or a business-outbox body',async()=>{
  wire('chat',{runId:'input-error',state:'error',errorMessage:wrapper,message:message(wrapper,{provenance})});await tick(100);
  expect(h.client.agentEvents.get(h.key)?.some((ev:any)=>ev.stream==='chatError')).not.toBe(true);
  expect(bodyDeliveries()).toEqual([]);expect(h.create).not.toHaveBeenCalled();
 });
 it('outer-envelope input identity cannot enter proactive output or Go assistant evidence',async()=>{
  const observe=vi.fn(),unobserve=h.client.observeGoEvidence(observe);
  wire('session.message',{provenance,runId:'input-mirror',sessionId:'generation-1',message:message(wrapper)});await tick(100);
  expect(observe).not.toHaveBeenCalled();expect(bodyDeliveries()).toEqual([]);expect(h.create).not.toHaveBeenCalled();
  wire('session.message',{runId:'real-output',sessionId:'generation-1',message:message('real proactive reply',{stopReason:'stop'})});await tick(100);
  expect(observe).toHaveBeenCalledTimes(1);expect(bodyDeliveries()).toEqual(['real proactive reply']);unobserve();
 });
 it('no-runId projected sessions_send input cannot create assistant_visible business outbox',async()=>{
  wire('session.message',{message:message(wrapper,{content:wrapper,provenance,senderSession:{sessionKey:provenance.sourceSessionKey},idempotencyKey:'fixture-peer:user'})});await tick(100);
  expect(bodyDeliveries()).toEqual([]);expect(h.create).not.toHaveBeenCalled();
 });
 it('internal sessions_send tool body is not exposed by progress or verbose transcript',async()=>{
  const {p}=await begin();wire('agent',{runId:'r1',stream:'tool',data:{name:'sessions_send',phase:'start',toolCallId:'send-private',input:{sessionKey:'fixture-peer',message:wrapper}}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'sessions_send',phase:'result',toolCallId:'send-private',output:{message:wrapper,status:'accepted'}}});
  await tick(100);expect(cards()).not.toContain('【用户中途插入');expect(bodyDeliveries()).toEqual([]);final();await tick(350);await p;
 });
 it.each(['tool','item'])('wrapped internal sends redact both start and correlated %s result bodies',async(stream)=>{
  const {p}=await begin();
  wire('agent',{runId:'r1',stream,data:{kind:'tool',name:'functions.tool_call',phase:'start',toolCallId:'wrapper-send',input:{id:'sessions_send',args:{message:wrapper}}}});
  wire('agent',{runId:'r1',stream,data:{kind:'tool',name:'functions.tool_call',phase:stream==='tool'?'result':'end',toolCallId:'wrapper-send',output:{message:wrapper}}});
  await tick(100);expect(cards()).not.toContain('【用户中途插入');expect(bodyDeliveries()).toEqual([]);
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it('real model output in a run answering internal/child input remains visible',async()=>{
  const {p}=await begin();wire('agent',{runId:'r1',stream:'assistant',inputProvenance:provenance,data:{deltaText:'real continued model note',replace:true}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'read',phase:'start',toolCallId:'continued',input:{path:'offline.txt'}}});
  await tick(100);expect(cards()).toContain('real continued model note');final('real continued final');await tick(350);await p;expect(bodyDeliveries()).toEqual(['real continued final']);
 });
 it('model may legitimately quote the exact wrapper in partial/final output',async()=>{
  const {p}=await begin();wire('agent',{runId:'r1',stream:'assistant',data:{deltaText:wrapper,replace:true}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'read',phase:'start',toolCallId:'real',input:{path:'offline.txt'}}});
  await tick(100);expect(cards()).toContain('用户中途插入');final(wrapper);await tick(350);await p;
  expect(bodyDeliveries()).toEqual([wrapper]);expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe(wrapper);
 });
 it.each(['cron-result','child-continuation','unrelated-external'])('real %s assistant output retains the proactive route',async(runId)=>{
  wire('session.message',{runId,message:message('genuine external model reply',{stopReason:'stop'})});await tick(100);
  expect(bodyDeliveries()).toEqual(['genuine external model reply']);expect(h.create).toHaveBeenCalledTimes(1);
 });
 it('ordinary user receipt still confirms consumed steer using only unwrapped display text',async()=>{
  const {p}=await begin();const consumed=vi.fn();h.client.registerPendingSteer(h.key,wrapper,'为啥消息发给我了');h.client.onSteerConsumed(h.key,wrapper,consumed);
  wire('session.message',{runId:'r1',message:message(wrapper,{role:'user'})});await tick(100);
  expect(consumed).toHaveBeenCalledTimes(1);expect(cards()).not.toContain('【用户中途插入');expect(bodyDeliveries()).toEqual([]);
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
});
