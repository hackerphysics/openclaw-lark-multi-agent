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


describe('independent parent private-tool and input identity controls',()=>{
 it.each(['sessions_send','sessions_yield'])('namespaced %s error/result payloads are private',async(name)=>{
  const {p}=await begin();wire('agent',{runId:'r1',stream:'tool',data:{toolName:`functions.${name}`,phase:'start',id:'private-call',args:JSON.stringify({message:wrapper})}});
  wire('agent',{runId:'r1',stream:'item',data:{kind:'tool',name:`functions.${name}`,phase:'error',id:'tool:private-call',error:{message:wrapper}}});
  await tick(100);expect(cards()).not.toContain(wrapper);expect(bodyDeliveries()).toEqual([]);
  for(const ev of h.client.agentEvents.get(h.key)||[])if(['item','tool'].includes(ev.stream))expect(JSON.stringify(ev)).not.toContain(wrapper);
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it.each(['sessions_send','sessions_yield'])('wrapped JSON-string %s start and cross-stream mirror stay private',async(id)=>{
  const {p}=await begin();wire('agent',{runId:'r1',stream:'tool',data:{name:'functions.tool_call',phase:'start',toolCallId:'wrapped-private',args:JSON.stringify({id:`functions.${id}`,args:{message:wrapper}})}});
  wire('agent',{runId:'r1',stream:'item',data:{kind:'tool',name:'functions.tool_call',phase:'end',itemId:'tool:wrapped-private',result:{message:wrapper}}});
  await tick(100);expect(cards()).not.toContain(wrapper);expect(bodyDeliveries()).toEqual([]);
  for(const ev of h.client.agentEvents.get(h.key)||[])if(['item','tool'].includes(ev.stream))expect(JSON.stringify(ev)).not.toContain(wrapper);
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it.each(['agent','chat'])('%s outer-envelope senderSession cannot enter assistant collection/evidence',async(channel)=>{
  const {p}=await begin();const observe=vi.fn(),off=h.client.observeGoEvidence(observe);
  wire(channel,{runId:'r1',stream:'assistant',state:'final',senderSession:{sessionKey:'agent:main:peer'},data:{deltaText:wrapper,replace:true},message:message()});
  await tick(100);expect(cards()).not.toContain(wrapper);expect(bodyDeliveries()).toEqual([]);expect(observe).not.toHaveBeenCalled();off();
  final();await tick(350);await p;expect(bodyDeliveries()).toEqual(['real model answer']);
 });
 it('actual assistant output with senderIsOwner false and wrapper quote remains unchanged',async()=>{
  wire('session.message',{runId:'independent-output',senderIsOwner:false,message:message(wrapper,{stopReason:'stop'})});await tick(100);
  expect(bodyDeliveries()).toEqual([wrapper]);
 });
});
