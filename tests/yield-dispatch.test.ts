import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>,activity:any;
let restartDirs:string[]=[];
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
 h.client.rpc=vi.fn(async(m:string,p:any)=>{if(m==='sessions.describe')return {session:{sessionId:'generation-1',...activity}};const result=await base(m,p);if(m==='chat.send')activity={status:'running',hasActiveRun:true};return result;});
 const connected=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
};
const start=async()=>{const promise=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(1);return {promise};};
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T00:40:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});h=harness();activity={status:'done',hasActiveRun:false};await setup();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();for(const dir of restartDirs)rmSync(dir,{recursive:true,force:true});restartDirs=[];vi.useRealTimers();vi.restoreAllMocks();});
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

describe('dispatch handoff fences and long-running controls',()=>{
 it('fresh authoritative idle history permits a new request while old exact wait cache is unknown, without settling the old task',async()=>{
  const a=await start();const base=h.client.rpc;activity={status:'done',hasActiveRun:false};
  h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0}}:base(m,p));
  const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(2);expect(h.client.eventCollectors.size).toBe(1);
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('Get');
  activity={status:'running',hasActiveRun:true};final('r1','old exact answer');final('r2','new answer');await tick(350);await a.promise;await b;
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('old exact answer');
 });
 it.each(['missing-session','pending-input','inflight','wrong-session'])('idle history is not scheduling proof with %s',async(mode)=>{
  await start();activity={status:'done',hasActiveRun:false};const base=h.client.rpc;
  h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:mode==='wrong-session'?'agent:main:wrong':h.key,
   sessionInfo:{sessionId:mode==='missing-session'?undefined:'generation-1',hasActiveRun:false},pendingInputs:{total:mode==='pending-input'?1:0},...(mode==='inflight'?{inFlightRun:{runId:'r1'}}:{})}:base(m,p));
  await h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(1);expect(h.bot.queueRuns.has('chat')).toBe(true);
 });
 it.each(['foreign','missing','tool'])('untrusted %s yielded data cannot hand off foreground custody',async(mode)=>{
  await start();if(mode==='tool')wire('agent',{runId:'r1',stream:'tool',data:{name:'sessions_yield',phase:'result',output:{yielded:true}}});
  else yieldRoot(mode==='foreign'?'foreign':undefined,{...(mode==='missing'?{runId:undefined}:{})});
  await tick(100);activity={status:'done',hasActiveRun:false};await h.bot.handleMessage(event('B'));await tick(100);
  expect(h.sends).toHaveLength(1);expect(h.bot.queueRuns.has('chat')).toBe(true);expect(h.client.eventCollectors.size).toBe(1);
 });
 it('long silent API beyond ten minutes is not yield, stays owned and inserts later input',async()=>{
  await start();wire('agent',{runId:'r1',stream:'tool',data:{name:'exec',phase:'start',toolCallId:'long-api'}});
  await tick(11*60_000);expect(h.client.eventCollectors.size).toBe(1);expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  await h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(1);expect(h.bot.queueRuns.has('chat')).toBe(true);
 });
 it.each(['unknown','accepted'])('old %s insertion never replays and does not block an independent post-yield C',async(state)=>{
  const a=await start();let calls=0;
  h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>{calls++;return {...id,status:state,attempted:true,sessionId:'generation-1'};});
  await h.bot.handleMessage(event('B'));await tick(100);const bRow=h.store.getMessageId('B')!;
  yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const c=h.bot.handleMessage(event('C'));await tick(100);
  expect(h.sends).toHaveLength(2);expect(h.sends[1].message).not.toContain('B');expect(h.sends[1].message).toContain('C');
  expect(h.store.getInsertion('Bot','chat',bRow).state).toBe(state);
  if(state==='unknown'){expect(h.store.getReactionIntent('Bot','chat',bRow).desired).toBe('Typing');}
  final('r2','C answer');await tick(350);await c;await a.promise;expect(h.sends).toHaveLength(2);
  expect(calls).toBeGreaterThan(0);
 });
 it('already reserved but never attempted B is returned exactly once at yield without exact root termination',async()=>{
  const a=await start();h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'pending',attempted:false,reason:'target_not_ready',sessionId:'generation-1'}));
  await h.bot.handleMessage(event('B'));await tick(100);const row=h.store.getMessageId('B')!;expect(h.store.getInsertion('Bot','chat',row).attempted).toBe(false);
  activity={status:'done',hasActiveRun:false};yieldRoot();await tick(100);expect(h.sends).toHaveLength(2);expect(h.store.getInsertion('Bot','chat',row).state).toBe('ordinary');
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');activity={status:'running',hasActiveRun:true};final('r2','B answer');await tick(350);await a.promise;await tick(10_000);expect(h.sends).toHaveLength(2);
 });
 it('a notice/card promise hanging during yield cannot hold the new dispatch owner',async()=>{
  const a=await start();h.bot.sendWaitPaused=vi.fn(()=>new Promise(()=>{}));h.bot.patchLiveStatusCard=vi.fn(()=>new Promise(()=>{}));
  yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);
  expect(h.sends).toHaveLength(2);activity={status:'running',hasActiveRun:true};final('r2','B answer');await tick(350);await b;await a.promise;
 });
 it('A final after thirty seconds cannot revoke B owner or steal its trigger',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);activity={status:'running',hasActiveRun:true};
  const owner=h.bot.queueRuns.get('chat');await tick(31_000);final('r1','A late final');await tick(100);
  expect(h.bot.queueRuns.get('chat')).toBe(owner);expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('A late final');
  final('r2','B final');await tick(350);await b;expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${h.store.getMessageId('B')}`)?.content).toBe('B final');
 });
 it.each(['archive','generation'])('yield cannot migrate a reserved input across %s',async(mode)=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false,...(mode==='archive'?{archived:true}:{sessionId:'generation-2'})};
  await h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!)?.state).toBe('target_changed');
 });
 it('stop after yield fences old results/reservations but permits a new human request',async()=>{
  const a=await start();yieldRoot();await tick(100);await h.bot.handleStopCommand('chat','stop');activity={status:'done',hasActiveRun:false};
  const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(2);final('r1','stopped old answer');final('r2','B answer');await tick(350);await a.promise;await b;
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.runObservationState(h.key,'r1')).toBe('stopped');
 });
});

describe('admission and asynchronous identity races',()=>{
 it('host idle while local chat.send RPC is unresolved cannot admit another main run',async()=>{
  let receipt:any;const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?await new Promise(r=>receipt=()=>base(m,p).then(r)):base(m,p));
  const a=h.bot.handleMessage(event('A'));await tick();activity={status:'done',hasActiveRun:false};await h.bot.handleMessage(event('B'));await tick(100);
  expect(h.client.rpc.mock.calls.filter(([m]:any)=>m==='chat.send')).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!)?.expectedRunId).toBe('');
  activity={status:'running',hasActiveRun:true};receipt();await tick(100);expect(h.sends).toHaveLength(1);final('r1','A result');await tick(350);await a;
 });
 it('late authoritative idle from the old actual batch cannot revoke its same-promise successor',async()=>{
  const a=await start();let resolveActivity:any;h.client.getSessionDispatchStatus=vi.fn(()=>new Promise(r=>resolveActivity=r));
  const b=h.bot.handleMessage(event('B'));await tick();expect(resolveActivity).toBeTypeOf('function');
  const row=h.store.insert({chatId:'chat',messageId:'C',senderType:'human',senderName:'u',content:'C',timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);
  const promise=h.bot.queueRuns.get('chat'),batch=h.bot.queueRunTokens.get('chat');final('r1','A result');await tick(350);
  expect(h.sends).toHaveLength(2);expect(h.bot.queueRuns.get('chat')).toBe(promise);expect(h.bot.queueRunTokens.get('chat')).not.toBe(batch);
  resolveActivity({idleConfirmed:true,sessionId:'generation-1'});await tick(100);await b;expect(h.bot.queueRuns.get('chat')).toBe(promise);
  final('r2','C result');await tick(350);await a.promise;
 });
 it('high-frequency concurrent human inputs hand off once, remain ordered and receive actual batch receipts',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};
  const messages=Array.from({length:8},(_,i)=>`B${i}`);const pending=messages.map(text=>h.bot.handleMessage(event(text)));await tick(100);
  expect(h.sends).toHaveLength(2);for(const text of messages)expect(h.sends[1].message).toContain(text);
  const indexes=messages.map(text=>h.sends[1].message.indexOf(text));expect(indexes).toEqual([...indexes].sort((a,b)=>a-b));
  for(const text of messages)expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId(text)!).desired).toBe('Get');
  activity={status:'running',hasActiveRun:true};final('r2','merged B result');await tick(350);await Promise.all(pending);expect(h.sends).toHaveLength(2);
  for(const text of messages)expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId(text)!).desired).toBe('DONE');
 });
 it('a timed-out activity lookup is unknown and a later idle result cannot release custody',async()=>{
  await start();const base=h.client.rpc;const late:any[]=[];h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?await new Promise(r=>late.push(r)):base(m,p));
  const b=h.bot.handleMessage(event('B'));await tick(1501);await b;expect(h.sends).toHaveLength(1);
  activity={status:'done',hasActiveRun:false};late[0]({sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0}});await tick(100);
  expect(h.sends).toHaveLength(1);expect(h.bot.queueRuns.has('chat')).toBe(true);
 });
});

describe('durable detached yield restart and exact terminal dispositions',()=>{
 it('SQLite close/reopen recovers old exact delivery while B schedules independently, with no business replay',async()=>{
  await h.cleanup();const dir=mkdtempSync(join(tmpdir(),'lma-yield-restart-'));restartDirs.push(dir);const db=join(dir,'db');h=harness(db);await setup();
  const a=await start();yieldRoot();await tick(100);await a.promise;expect(h.store.getDispatchCustody('Bot','chat')?.yielded).toBe(true);
  await h.client.disconnect();vi.clearAllTimers();h.store.close();h=harness(db);activity={status:'done',hasActiveRun:false};await setup();
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{...await base(m,p),runId:'r2'}:base(m,p));
  const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toContain('B');expect(h.sends[0].message).not.toContain('A');
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');activity={status:'running',hasActiveRun:true};
  const newBase=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'&&p.runId==='r1'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'A recovered authoritative result'}}:newBase(m,p));
  h.store['db'].prepare('UPDATE run_observations SET next_check_at=0').run();await h.client.recoverExactRuns();await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('A recovered authoritative result');expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');
  final('r2','B result');await tick(350);await b;expect(h.sends).toHaveLength(1);
 });
 it.each(['silent','empty'])('yielded root authoritative %s settles only A, not a new running B',async(disposition)=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);activity={status:'running',hasActiveRun:true};
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'&&p.runId==='r1'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition}}:base(m,p));
  h.store['db'].prepare('UPDATE run_observations SET next_check_at=0').run();await h.client.recoverExactRuns();await tick(100);
  expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('B')!).desired).toBe('Get');
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.runObservationState(h.key,'r1')).toBe('settled');final('r2','B result');await tick(350);await b;
 });
 it('repeated yielded visible acknowledgments never claim the original final key',async()=>{
  await start();yieldRoot('r1',{message:{role:'assistant',content:[{type:'text',text:'not a final acknowledgment'}]}});await tick(100);
  yieldRoot('r1',{message:{role:'assistant',content:[{type:'text',text:'repeated acknowledgment'}]}});await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.getRecent('chat').filter(m=>m.senderType==='bot')).toEqual([]);
  final('r1','real final');await tick(100);expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('real final');
 });
});

describe('detached result settlement identity',()=>{
 it('a late explicit root NO_REPLY settles A without body or false settlement of B',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);activity={status:'running',hasActiveRun:true};
  final('r1','NO_REPLY');await tick(100);expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');expect(h.store.runObservationState(h.key,'r1')).toBe('settled');
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('B')!).desired).toBe('Get');final('r2','B result');await tick(350);await b;
 });
 it('real late root error uses durable error outbox and settles only its accepted original inputs',async()=>{
  await start();h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'accepted',attempted:true,sessionId:'generation-1'}));
  await h.bot.handleMessage(event('B'));await tick(100);yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const c=h.bot.handleMessage(event('C'));await tick(100);activity={status:'running',hasActiveRun:true};
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'&&p.runId==='r1'?{runId:'r1',status:'error',endedAt:Date.now(),error:'provider authentication rejected'}:base(m,p));
  h.store['db'].prepare('UPDATE run_observations SET next_check_at=0').run();await h.client.recoverExactRuns();await tick(100);
  expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!).state).toBe('committed');
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('C')!).desired).toBe('Get');expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();
  expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','run-error:').some(d=>d.status==='delivered')).toBe(true);final('r2','C result');await tick(350);await c;
 });
});

describe('explicit reset and stale stop epochs',()=>{
 it('reset after yield fences A old observations and reservations while a new-generation B admits normally',async()=>{
  await start();yieldRoot();await tick(100);const reset=h.bot.handleResetCommand('chat','reset');await tick(100);activity={sessionId:'generation-2',status:'done',hasActiveRun:false};
  const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(2);final('r1','obsolete A result');final('r2','new B result');await tick(2200);await reset;await b;
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.runObservationState(h.key,'r1')).toBe('stopped');expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('B')!).desired).toBe('DONE');
 });
 it('a stale persisted insertion epoch cannot bulk-stop a new post-cutoff request',async()=>{
  await start();const oldRow=h.store.insert({chatId:'chat',messageId:'old-B',senderType:'human',senderName:'u',content:'old',timestamp:Date.now()});
  h.store.saveInsertion('Bot','chat',oldRow,'old-id','pending',{messageId:'old-B',text:'old',stopEpoch:-1,expectedRunId:'old-run',sessionKey:h.key});
  await h.bot.handleMessage(event('C'));await tick(100);const row=h.store.getMessageId('C')!;h.store['db'].prepare('UPDATE insertion_custody SET next_check_at=0').run();await h.bot.reconcileInsertions('chat');
  expect(h.store.getInsertion('Bot','chat',oldRow)?.state).toBe('stopped');expect(h.store.getInsertion('Bot','chat',row)?.state).not.toBe('stopped');
 });
});

describe('publicly linked requester continuation returns through the original exact root',()=>{
 it('verified child/parent task lineage routes only root committed terminalReply to A, never child draft or B trigger',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);activity={status:'running',hasActiveRun:true};
  const childRun='12345678-1234-1234-1234-123456789abc',announce=`announce:requester-settle:main:${h.key}:${childRun}`;
  const child={id:'child-task',kind:'subagent',runId:childRun,sessionKey:h.key,ownerKey:h.key,childSessionKey:'agent:main:subagent:child',parentTaskId:'root-task',status:'completed',deliveryStatus:'delivered'};
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='tasks.list'?{tasks:[child]}:m==='tasks.get'?{task:p.taskId==='child-task'?child:{id:'root-task',runId:'r1',sessionKey:h.key,ownerKey:h.key}}:
   m==='agent.wait'&&p.runId==='r1'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'A canonical committed continuation result'}}:base(m,p));
  final(announce,'child private interim text');await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('A canonical committed continuation result');
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${h.store.getMessageId('B')}`)).toBeNull();
  expect(h.store.getRecent('chat').some(m=>m.content.includes('child private'))).toBe(false);
  final('r1','A canonical committed continuation result');final('r2','B result');await tick(350);await b;
  expect(h.store.getRecent('chat').filter(m=>m.senderType==='bot'&&m.content==='A canonical committed continuation result')).toHaveLength(1);
 });
});

describe('yield identity does not counterfeit admission receipts',()=>{
 it('an identified but unconfirmed root can hand off scheduling at trusted yield without inventing Get',async()=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{...await base(m,p),status:'in_flight'}:base(m,p));
  const a=await start();expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','Get');yieldRoot();await tick(100);expect(h.client.eventCollectors.size).toBe(0);
  activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);expect(h.sends).toHaveLength(2);expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('Typing');
  final('r2','B actual result');await tick(350);await b;await a.promise;expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
 });
});

describe('terminal Gateway error envelope remains authoritative after foreground yield',()=>{
 it('root chat.error settles its original task via durable error outbox even if agent.wait cache is unknown',async()=>{
  await start();yieldRoot();await tick(100);activity={status:'done',hasActiveRun:false};const b=h.bot.handleMessage(event('B'));await tick(100);activity={status:'running',hasActiveRun:true};
  wire('chat',{runId:'r1',state:'error',errorMessage:'provider authentication rejected'});await tick(100);
  expect(h.store.getReactionIntent('Bot','chat',1).desired).toBe('DONE');expect(h.store.runObservationState(h.key,'r1')).toBe('settled');expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('B')!).desired).toBe('Get');expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','run-error:').some(d=>d.status==='delivered')).toBe(true);
  final('r2','B actual result');await tick(350);await b;
 });
});
