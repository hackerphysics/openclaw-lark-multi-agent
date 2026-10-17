import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {OpenClawClient} from '../src/openclaw-client.js';
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const message=(text:string)=>({role:'assistant',content:[{type:'text',text}],stopReason:'stop'});
const wire=(channel:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event:channel,payload:{sessionKey:h.key,...payload}})));
const bodies=()=>h.store.getRecent('chat').filter(m=>m.senderType==='bot').map(m=>m.content);
const cards=()=>JSON.stringify([...h.bot.replyLiveStatusCard.mock.calls,...h.bot.patchLiveStatusCard.mock.calls]);
const final=(text='actual final answer')=>wire('chat',{runId:'r1',state:'final',message:message(text)});
const terminal=(text='actual final answer')=>{final(text);wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});};
const observed=(p:Promise<any>)=>{const state:any={};p.then(text=>state.text=text,error=>state.error=error);return state;};
beforeEach(async()=>{
 vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 h=harness();h.client.ensureModel=vi.fn(async()=>false);h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);const base=h.client.rpc;
 h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0,items:[]}}:base(m,p));
 const connecting=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connecting;await h.bot.ensureSession('chat');
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('B4 exact trigger/card ownership',()=>{
 it('B4: unrelated final before admission stays proactive and cannot finish new trigger/card',async()=>{
  const base=h.client.rpc;let admit:any;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?new Promise(r=>admit=r):base(m,p));
  const p=h.bot.handleMessage(event('new question'));await tick(50);
  wire('chat',{runId:'old-independent',state:'final',message:message('old independent final')});await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeFalsy();
  expect(bodies()).toContain('old independent final');
  admit({runId:'r1',status:'started'});await tick(1000);expect(h.bot.replyLiveStatusCard).toHaveBeenCalled();
  terminal('new exact final');await tick(350);await p;expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('new exact final');
 });
 it('B4: unidentified proactive output cannot finish the admitted root card or claim its trigger',async()=>{
  const p=h.bot.handleMessage(event('new question'));await tick(50);
  wire('session.message',{message:message('independent unbound output')});await tick(1000);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeFalsy();
  expect(bodies()).toContain('independent unbound output');
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalled();
  expect(h.bot.patchLiveStatusCard.mock.calls.every((call:any[])=>call[1]?.state!=='done')).toBe(true);
  terminal('new exact final');await tick(350);await p;
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('new exact final');
 });

});
