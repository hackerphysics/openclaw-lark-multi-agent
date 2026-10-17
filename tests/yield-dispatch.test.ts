import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>,activity:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
const yieldRoot=(runId='r1',extra:any={})=>wire('chat',{runId,state:'final',yielded:true,...extra});
const final=(runId:string,text:string)=>{
 wire('chat',{runId,state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('session.message',{runId,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('agent',{runId,stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
};
const setup=async()=>{
 h.client.ensureModel=vi.fn(async()=>false);
 h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
 const base=h.client.rpc;
 h.client.rpc=vi.fn(async(m:string,p:any)=>m==='sessions.describe'?{session:{sessionId:'generation-1',...activity}}:base(m,p));
 const connected=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
};
const start=async()=>{const promise=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(1);return {promise};};
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T00:40:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});h=harness();activity={status:'running',hasActiveRun:true};await setup();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('trusted yield separates scheduling from exact background delivery (real WS / bot / SQLite)',()=>{
 it.each(['before','during','after'])('A yields; B ordinary succeeds without stop or third input; A result %s B is delivered once to A',async(order)=>{
  const a=await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};
  expect(h.client.eventCollectors.size).toBe(0);
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('Get');
  if(order==='before'){final('r1','A actual late result');await tick(50);}
  const b=h.bot.handleMessage(event('B'));await tick(100);
  expect(h.sends).toHaveLength(2);expect(h.sends[1].message).toContain('B');
  activity={status:'running',hasActiveRun:true};
  if(order==='during'){final('r1','A actual late result');await tick(50);}
  final('r2','B actual result');await tick(350);await b;await a.promise;
  if(order==='after'){final('r1','A actual late result');await tick(50);}
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('A actual late result');
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${h.store.getMessageId('B')}`)?.content).toBe('B actual result');
  expect(h.store.getRecent('chat').filter(m=>m.senderType==='bot').map(m=>m.content).sort()).toEqual(['A actual late result','B actual result'].sort());
  expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('B')!).desired).toBe('DONE');
 });
 it('a real running B makes C a persistent insertion, never a third concurrent chat.send',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(2);
  activity={status:'running',hasActiveRun:true};await h.bot.handleMessage(event('C'));await tick(100);
  expect(h.sends).toHaveLength(2);expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('C')!)?.expectedRunId).toBe('r2');
  final('r2','B result');await tick(350);await b;
 });
 it.each(['unknown','running'])('yield with live %s never authorizes an ordinary submission',async(state)=>{
  await start();yieldRoot();await tick(100);activity=state==='running'?{status:'running',hasActiveRun:true}:{status:'future_state'};
  await h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(1);expect(h.store.isInsertionReserved('Bot','chat',2)).toBe(true);
 });
});
