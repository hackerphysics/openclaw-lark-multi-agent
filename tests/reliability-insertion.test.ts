import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setActiveEmbeddedRun,clearActiveEmbeddedRun,emitAgentEvent,resetAgentEventsForTest} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {registerSteer} from '../plugins/lma-core/src/steer.js';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>,dir:string,dispose:()=>void,methods:Map<string,any>,calls:number;
let ready:boolean,callbackMode:'accept'|'reject'|'silent',delay:number,callbacks:Array<(value:boolean)=>void>;
let handle:Parameters<typeof setActiveEmbeddedRun>[1];
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const mount=()=>{methods=new Map();dispose=registerSteer({registerGatewayMethod:(name:string,fn:any)=>methods.set(name,fn)});};
const connect=()=>{
 const base=h.client.rpc;
 h.client.rpc=vi.fn(async(name:string,params:any)=>{
  if(!methods.has(name))return base(name,params);
  let result:any;await methods.get(name)({params,respond:(ok:boolean,value:any,error:any)=>{if(!ok)throw new Error(JSON.stringify(error));result=value;}});return result;
 });
};
const start=async()=>{const promise=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(1);return {promise};};
const row=()=>h.store.getMessageId('B')!;
const input=async()=>{await h.bot.handleMessage(event('B'));await tick();};
beforeEach(()=>{
 vi.useFakeTimers();dir=mkdtempSync(join(tmpdir(),'lma-insertion-loop-'));vi.stubEnv('OPENCLAW_STATE_DIR',dir);h=harness();
 calls=0;ready=false;callbackMode='accept';delay=0;callbacks=[];
 handle={kind:'embedded',runId:'r1',isStreaming:()=>ready,isCompacting:()=>false,isStopped:()=>!ready,abort:()=>{},supportsTranscriptCommitWait:true,
  queueMessage:async(_text,options)=>{calls++;const cb=options?.onQueueAccepted;if(cb)callbacks.push(cb);
   if(callbackMode!=='silent'){const value=callbackMode==='accept';if(delay)setTimeout(()=>cb?.(value),delay);else cb?.(value);}},
 } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
 setActiveEmbeddedRun('generation-1',handle,h.key);mount();connect();
 emitAgentEvent({sessionKey:h.key,sessionId:'generation-1',runId:'r1',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
});
afterEach(async()=>{dispose();clearActiveEmbeddedRun('generation-1',handle,h.key);resetAgentEventsForTest();await h.cleanup();rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.clearAllTimers();vi.useRealTimers();});
describe('real bridge SQLite + production plugin + public SDK queue synthetic application loop',()=>{
 it.each([5000,6600,9100,4*3600_000])('waits past %sms, actually inserts, Get only from callback, no ordinary duplicate',async(ms)=>{
  const first=await start();await input();expect(calls).toBe(0);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  // A long wall-clock jump models an offline process; a single recovery tick,
  // not four hours of high-frequency timers, must retain the durable obligation.
  if(ms>3600_000)vi.setSystemTime(Date.now()+ms);else await tick(ms);
  ready=true;if(ms>3600_000)setActiveEmbeddedRun('generation-1',handle,h.key);await tick(5000);
  expect(calls).toBe(1);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');expect(h.bot.addReaction).toHaveBeenCalledWith('B','Get');
  h.final('r1');await tick(300);await first.promise;
  expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');
  expect(h.bot.addReaction).toHaveBeenCalledWith('A','DONE');expect(h.sends).toHaveLength(1);
 });
 it.each([3500,9100])('a callback delayed %sms is queryable after short RPC returns and gets Get once',async(ms)=>{
  const first=await start();ready=true;delay=ms;await input();expect(calls).toBe(1);
  expect(h.store.getInsertion('Bot','chat',row()).state).toBe('unknown');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  await tick(20_000);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');expect(calls).toBe(1);
  expect(h.bot.addReaction.mock.calls.filter(([message,emoji]:any)=>message==='B'&&emoji==='Get')).toHaveLength(1);
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
 });
 it('SDK immediate true then explicit callback false does not Get; retry is paced then truly accepted',async()=>{
  const first=await start();ready=true;callbackMode='reject';delay=9000;await input();
  await tick(9000);expect(calls).toBe(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  callbackMode='accept';delay=0;await tick(20_000);expect(calls).toBe(2);expect(h.bot.addReaction).toHaveBeenCalledWith('B','Get');
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
 });
 it('legacy backend without acceptance callback remains explicitly unknown, no Get or ordinary replay',async()=>{
  const first=await start();ready=true;callbackMode='silent';await input();await tick(60_000);
  expect(calls).toBe(1);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('unknown');
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
 });
 it('explicit backend rejection permits original-target retry but not an ordinary successor after that target ends',async()=>{
  const first=await start();ready=true;callbackMode='reject';await input();expect(calls).toBe(1);
  h.final('r1');emitAgentEvent({sessionKey:h.key,runId:'r1',stream:'lifecycle',data:{phase:'end'}});await tick(300);await first.promise;
  const base=h.client.rpc;h.client.rpc=vi.fn(async(name:string,p:any)=>{
   if(name==='sessions.describe')return {session:{sessionId:'generation-1',status:'idle',hasActiveRun:false}};
   if(name==='agent.wait')return {runId:p.runId,status:'ok',endedAt:Date.now(),terminalReply:{disposition:'empty'}};
   return base(name,p);
  });
  await tick(20_000);expect(calls).toBe(1);expect(h.sends).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('rejected');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
 });
 it('lost RPC response queries stable attempt rather than queueing again',async()=>{
  const first=await start();ready=true;const base=h.client.rpc;let lost=true;
  h.client.rpc=vi.fn(async(name:string,p:any)=>{const result=await base(name,p);if(name==='lma.steer' && lost){lost=false;throw new Error('response lost');}return result;});
  await input();expect(h.store.getInsertion('Bot','chat',row()).state).toBe('unknown');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  await tick(20_000);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');expect(calls).toBe(1);expect(h.bot.addReaction).toHaveBeenCalledWith('B','Get');
  h.final('r1');await tick(300);await first.promise;
 });
 it.each(['accepted','unknown'] as const)('bridge + plugin restart recovers %s without a new queue call or input replay',async(status)=>{
  const first=await start();ready=true;callbackMode=status==='accepted'?'accept':'silent';await input();const originalRow=row(),old=h,db=join(h.dir!,'db');
  expect(calls).toBe(1);old.client.revokeSessionCollectors(old.key,'simulated process exit');await tick();await first.promise;
  if(old.bot.insertionTimer)clearTimeout(old.bot.insertionTimer);old.bot.goController?.dispose();await old.client.disconnect();old.store.close();
  dispose();mount();h=harness(db);connect();vi.setSystemTime(Date.now()+20_000);await h.bot.reconcileInsertions('chat');await tick();
  expect(h.store.getInsertion('Bot','chat',originalRow).state).toBe(status);expect(calls).toBe(1);expect(h.sends).toHaveLength(0);
  if(status==='accepted') {
    // Emulate lost bridge acceptance response: no ephemeral ACK array exists.
    expect(h.store.getReactionIntent('Bot','chat',originalRow).desired).toBe('Get');
  } else expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  await h.cleanup();h=harness();rmSync(old.dir!,{recursive:true,force:true});
 });
 it('stop before callback prevents Get/DONE and fences late old submit at the plugin',async()=>{
  const first=await start();ready=true;callbackMode='silent';await input();
  await h.bot.handleStopCommand('chat','stop');callbacks[0](true);await tick(20_000);await first.promise;
  expect(h.store.getInsertion('Bot','chat',row()).state).toBe('stopped');expect(calls).toBe(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
 });
 it('original run truly ended and never attempted: explicit ordinary handoff executes original input once',async()=>{
  const first=await start();await input();expect(calls).toBe(0);
  h.final('r1');emitAgentEvent({sessionKey:h.key,runId:'r1',stream:'lifecycle',data:{phase:'end'}});await tick(300);await first.promise;
  const base=h.client.rpc;h.client.rpc=vi.fn(async(name:string,p:any)=>{
   if(name==='sessions.describe')return {session:{sessionId:'generation-1',status:'idle',hasActiveRun:false}};
   if(name==='agent.wait')return {runId:p.runId,status:'ok',endedAt:Date.now(),terminalReply:{disposition:'empty'}};
   return base(name,p);
  });
  await tick(10_000);expect(h.sends).toHaveLength(2);expect(h.sends[1].message).toContain('B');expect(calls).toBe(0);
  expect(h.store.getInsertion('Bot','chat',row()).state).toBe('ordinary');h.final('r2');await tick(300);await tick(20_000);expect(h.sends).toHaveLength(2);
  expect(h.bot.addReaction).toHaveBeenCalledWith('B','DONE');expect(h.store.getReactionIntent('Bot','chat',row()).runId).toBe('r2');
 });
 it('plugin lost lifecycle map with a ready successor: exact old terminal prevents SDK retarget and ordinary handoff waits for idle',async()=>{
  const first=await start();await input();h.final('r1');await tick(300);await first.promise;
  dispose();mount();ready=true;
  const successor={...handle,runId:'r2'} satisfies Parameters<typeof setActiveEmbeddedRun>[1];
  setActiveEmbeddedRun('generation-1',successor,h.key);
  const base=h.client.rpc;let idle=false;
  h.client.rpc=vi.fn(async(name:string,p:any)=>{
   if(name==='sessions.describe')return {session:{sessionId:'generation-1',status:idle?'idle':'running',hasActiveRun:!idle}};
   if(name==='agent.wait')return p.runId==='r1'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'empty'}}:{runId:p.runId,status:'timeout'};
   return base(name,p);
  });
  await tick(10_000);expect(calls).toBe(0);expect(h.sends).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('pending');
  idle=true;await tick(10_000);expect(calls).toBe(0);expect(h.sends).toHaveLength(2);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('ordinary');
  h.final('r2');await tick(300);clearActiveEmbeddedRun('generation-1',successor,h.key);
 });
 it('bridge restart can query a durable plugin no-effect record then make one safe attempt',async()=>{
  const first=await start();await input();const inputRow=row();
  expect(h.store.claimInsertionAttempt('Bot','chat',inputRow)).toBe(true);
  // No plugin mutation occurred: its prior pending record still proves no
  // effect, so read-only query may safely recover pending, then make ONE call.
  ready=true;await tick(10_000);expect(calls).toBe(1);expect(h.store.getInsertion('Bot','chat',inputRow).state).toBe('accepted');
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
 });
 it('lost plugin journal after an uncertain attempted input is unknown, not a new queue call',async()=>{
  const first=await start();ready=true;callbackMode='silent';await input();expect(calls).toBe(1);
  dispose();rmSync(join(dir,'lma-core'),{recursive:true,force:true});mount();
  await tick(30_000);expect(calls).toBe(1);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('unknown');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
 });
 it('stop while session observation is pending prevents later queue invocation or Get',async()=>{
  const first=await start();let release:any;
  h.client.getSessionInfo=vi.fn(async()=>await new Promise(r=>release=()=>r({session:{sessionId:'generation-1'}})));
  ready=true;await input();expect(release).toBeTypeOf('function');await h.bot.handleStopCommand('chat','stop');release();await tick(300);await first.promise;
  expect(calls).toBe(0);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('stopped');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
 });
 it.each(['accepted','unknown'] as const)('restart retains %s insertion plus B2 unknown root receipt without replay or DONE',async(status)=>{
  const first=await start();ready=true;callbackMode=status==='accepted'?'accept':'silent';await input();
  h.create.mockResolvedValue({code:0,data:{}});h.final('r1');await tick(300);await first.promise;
  const originalRow=row(),old=h,db=join(h.dir!,'db');
  expect(h.store.getDeliveryDispatchOutcome('Bot','chat','trigger:1').state).toBe('unknown');
  for(const map of [old.bot.deliveryRetryTimers,old.bot.errorNoticeTimers,old.bot.delayedFailureTimers])for(const timer of map.values())clearTimeout(timer);
  if(old.bot.insertionTimer)clearTimeout(old.bot.insertionTimer);old.bot.goController?.dispose();await old.client.disconnect();old.store.close();
  dispose();mount();h=harness(db);connect();vi.setSystemTime(Date.now()+20_000);
  const base=h.client.rpc;h.client.rpc=vi.fn(async(name:string,p:any)=>name==='agent.wait'?{runId:p.runId,status:'error',endedAt:Date.now(),error:'root terminal, input unknown'}:base(name,p));
  await h.bot.reconcileInsertions('chat');await h.bot.dispatchPendingDeliveries('chat');await tick();
  expect(h.store.getInsertion('Bot','chat',originalRow).state).toBe(status);
  expect(h.store.getReactionIntent('Bot','chat',originalRow).desired).toBe(status==='accepted'?'Get':'Typing');
  expect(h.store.getDeliveryDispatchOutcome('Bot','chat','trigger:1').state).toBe('unknown');
  expect(calls).toBe(1);expect(h.sends).toHaveLength(0);expect(h.create).not.toHaveBeenCalled();
  expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
  await h.cleanup();h=harness();rmSync(old.dir!,{recursive:true,force:true});
 });
 it('real public SDK acceptance callback after root terminal is still admission only, not committed/DONE',async()=>{
  const first=await start();ready=true;callbackMode='silent';await input();expect(calls).toBe(1);
  h.final('r1');await tick(300);await first.promise;
  const base=h.client.rpc;
  h.client.rpc=vi.fn(async(name:string,p:any)=>name==='agent.wait'?{runId:p.runId,status:'error',endedAt:Date.now(),error:'root failed before queue drain'}:base(name,p));
  callbacks[0](true);await tick(20_000);
  expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');
  expect(h.store.getReactionIntent('Bot','chat',row()).desired).toBe('Get');
  await tick(70_000);
  expect(calls).toBe(1);expect(h.sends).toHaveLength(1);
  expect(h.store.getInsertion('Bot','chat',row()).state).toBe('accepted');
  expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
  expect(h.store.hasDeliveredReply('Bot','chat',row())).toBe(false);
 });
 it('identical input bodies with distinct queue identities never borrow root or text commitment proof',async()=>{
  const first=await start();ready=true;
  await h.bot.handleMessage(event('same private body','same-1'));await tick();
  await h.bot.handleMessage(event('same private body','same-2'));await tick();
  const rows=['same-1','same-2'].map(id=>h.store.getMessageId(id)!);
  expect(calls).toBe(2);
  expect(h.store.getInsertion('Bot','chat',rows[0]).insertionId).not.toBe(h.store.getInsertion('Bot','chat',rows[1]).insertionId);
  h.client.handleSteerConsumption(h.key,'same private body');
  h.final('r1');await tick(300);await first.promise;
  for(const [index,id] of ['same-1','same-2'].entries()){
   expect(h.store.getInsertion('Bot','chat',rows[index]).state).toBe('accepted');
   expect(h.store.getReactionIntent('Bot','chat',rows[index]).desired).toBe('Get');
   expect(h.bot.addReaction).not.toHaveBeenCalledWith(id,'DONE');
  }
  expect(h.sends).toHaveLength(1);expect(calls).toBe(2);
 });
 it('archive / generation change pauses rather than migrates pending input',async()=>{
  const first=await start();await input();const base=h.client.rpc;
  h.client.rpc=vi.fn(async(name:string,p:any)=>name==='sessions.describe'?{session:{sessionId:'generation-2',archived:true}}:base(name,p));
  ready=true;await tick(10_000);expect(calls).toBe(0);expect(h.store.getInsertion('Bot','chat',row()).state).toBe('target_changed');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
 });
});
