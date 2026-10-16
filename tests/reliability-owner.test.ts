import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
beforeEach(()=>{vi.useFakeTimers();h=harness();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();});
const start=async()=>{const promise=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(1);return {promise};};
const acceptance=(identity:any,status='accepted')=>({...identity,status,attempted:status!=='pending',sessionId:'generation-1'});
describe('owner and real-batch generation correctness',()=>{
 it('revoked pre-send owner cannot dispatch after ensureSession resumes',async()=>{
  let resume:any,n=0;h.bot.ensureSession=async()=>++n===1?await new Promise(r=>resume=()=>r(h.key)):h.key;
  const old=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(0);
  h.bot.forceExpireQueueOwner('chat','test authoritative idle prior to admission');
  const replacement=h.bot.handleMessage(event('B'));await tick();expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toContain('A\nB');
  resume();await tick();expect(h.sends).toHaveLength(1);h.final('r1');await tick(300);await old;await replacement;
 });
 it.each(['success','error'])('late old %s cannot change replacement busy/ACK/observers or dispatch',async(mode)=>{
  let late:any;h.client.chatSendWithContext=vi.fn(async(p:any)=>{
   if(!late)return await new Promise((resolve,reject)=>late={resolve,reject});
   await p.onSendAttempt?.();await p.onSubmitted?.('replacement');return await new Promise(()=>{});
  });
  const old=h.bot.handleMessage(event('A'));await tick();h.bot.forceExpireQueueOwner('chat','test idle');
  void h.bot.handleMessage(event('B'));await tick();const owner=h.bot.queueRuns.get('chat');const context=h.bot.queueOwners.get('chat');
  const observer=vi.fn();h.bot.runFailureObservers.set('chat',[observer]);h.bot.admittedSteerAcks.set('chat',[{messageId:'C',insertedId:99,batch:context.batch}]);
  const busy=h.bot.busyChats.get('chat');if(mode==='success')late.resolve('old result');else late.reject(new Error('old failure'));
  await tick(300);await old;
  expect(h.bot.queueRuns.get('chat')).toBe(owner);expect(h.bot.busyChats.get('chat')).toBe(busy);expect(observer).not.toHaveBeenCalled();
  expect(h.bot.admittedSteerAcks.get('chat')).toHaveLength(1);expect(h.client.chatSendWithContext).toHaveBeenCalledTimes(2);
 });
 it('same queue promise advances real batch; stale idle snapshot cannot expire successor run',async()=>{
  const first=await start();let releaseStatus:any;
  h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...acceptance(id,'pending'),reason:'target_not_ready'}));
  let statusCalls=0;h.client.getSessionRuntimeStatus=vi.fn(async()=>++statusCalls===1?await new Promise(r=>releaseStatus=r):{status:'running',running:true});
  await h.bot.handleMessage(event('B'));await tick();expect(releaseStatus).toBeTypeOf('function');
  // A separate ordinary trigger is already eligible, unlike the reserved B.
  const row=h.store.insert({chatId:'chat',messageId:'C',senderType:'human',senderName:'u',content:'C',timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);
  const owner=h.bot.queueRuns.get('chat'),batch=h.bot.queueRunTokens.get('chat');h.final('r1');await tick(300);
  expect(h.sends).toHaveLength(2);expect(h.bot.queueRuns.get('chat')).toBe(owner);expect(h.bot.queueRunTokens.get('chat')).not.toBe(batch);
  releaseStatus({status:'idle',running:false,idleConfirmed:true});await tick();expect(h.bot.queueRuns.get('chat')).toBe(owner);
  h.final('r2');await tick(300);await first.promise;
 });
 it('session idle alone cannot expire an original run still queued without an exact terminal',async()=>{
  const first=await start();h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...acceptance(id,'pending'),reason:'target_not_ready'}));
  h.client.getSessionRuntimeStatus=vi.fn(async()=>({status:'idle',running:false,idleConfirmed:true}));
  const owner=h.bot.queueRuns.get('chat');await h.bot.handleMessage(event('B'));await tick();expect(h.bot.queueRuns.get('chat')).toBe(owner);expect(h.sends).toHaveLength(1);
  h.final('r1');await tick(300);await first.promise;
 });
 it('unknown/future activity states do not authorize owner expiration',async()=>{
  const first=await start();h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...acceptance(id,'pending'),reason:'target_not_ready'}));
  h.client.getSessionRuntimeStatus=vi.fn(async()=>({running:false,status:'future_busy_state'}));
  const owner=h.bot.queueRuns.get('chat');await h.bot.handleMessage(event('B'));await tick();expect(h.bot.queueRuns.get('chat')).toBe(owner);expect(h.sends).toHaveLength(1);
  h.final('r1');await tick(300);await first.promise;
 });
});
describe('durable insertion reservation and exact receipt reactions',()=>{
 it('ingress reserves insertion before a slow health await so the old owner cannot ordinary-drain it',async()=>{
  const first=await start();let releaseHealth:any;h.bot.getUnhealthySessionStatus=()=>new Promise(r=>releaseHealth=()=>r(null));
  const input=h.bot.handleMessage(event('B'));await tick();const row=h.store.getMessageId('B')!;expect(h.store.isInsertionReserved('Bot','chat',row)).toBe(true);
  h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
  releaseHealth();await tick();await input;expect(h.sends).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',row).expectedRunId).toBe('r1');
 });
 it('a handler delayed by health cannot steer its own message after another handler ordinary-admitted it',async()=>{
  let releaseHealth:any,calls=0;h.bot.getUnhealthySessionStatus=async()=>++calls===1?await new Promise(r=>releaseHealth=()=>r(null)):null;
  const first=h.bot.handleMessage(event('B'));await tick();const second=h.bot.handleMessage(event('C'));await tick();expect(h.sends).toHaveLength(1);
  releaseHealth();await tick();await first;expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!)).toBeNull();
  h.final('r1');await tick(300);await second;expect(h.sends).toHaveLength(1);
 });
 it('late accepted ACK cannot ordinary-drain the same input while RPC is pending',async()=>{
  const first=await start();let accept:any;h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>await new Promise(r=>accept=()=>r(acceptance(id))));
  await h.bot.handleMessage(event('B'));await tick();const row=h.store.getMessageId('B')!;
  expect(h.store.isInsertionReserved('Bot','chat',row)).toBe(true);h.final('r1');await tick(300);await first.promise;
  expect(h.sends).toHaveLength(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');accept();await tick();
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('accepted');expect(h.bot.addReaction).toHaveBeenCalledWith('B','Get');expect(h.sends).toHaveLength(1);
 });
 it('stop before late ACK cancels reservation and cannot resurrect/Get/dispatch old input',async()=>{
  const first=await start();let accept:any;h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>await new Promise(r=>accept=()=>r(acceptance(id))));
  await h.bot.handleMessage(event('B'));await tick();await h.bot.handleStopCommand('chat','stop-command');accept();await tick(300);await first.promise;
  expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!).state).toBe('stopped');expect(h.sends).toHaveLength(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
 });
 it('eligibility/unknown never Get/DONE and never blindly falls back after original task succeeds',async()=>{
  const first=await start();h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>acceptance(id,'unknown'));
  await h.bot.handleMessage(event('B'));await tick();h.final('r1');await tick(300);await first.promise;
  expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('B')!).state).toBe('unknown');expect(h.sends).toHaveLength(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
 });
 it('verified missing host capability is retained and surfaced, not fake-success or an ordinary send',async()=>{
  const first=await start();await h.bot.handleMessage(event('B'));await tick();const row=h.store.getMessageId('B')!;
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('pending');h.final('r1');await tick(300);await first.promise;expect(h.sends).toHaveLength(1);
  expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','insertion:').length).toBe(0);
 });
});
describe('ordinary receipt-driven reactions',()=>{
 it('ordinary queued/sending request stays Typing until started acceptance then Get, exact final then DONE',async()=>{
  let receipt:any;const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?await new Promise(r=>receipt=()=>r({runId:'r1',status:'started'})):base(m,p));
  const input=h.bot.handleMessage(event('A'));await tick();expect(h.bot.addReaction).toHaveBeenCalledWith('A','Typing');expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','Get');
  receipt();await tick();expect(h.bot.addReaction).toHaveBeenCalledWith('A','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','DONE');h.final('r1');await tick(300);await input;expect(h.bot.addReaction).toHaveBeenCalledWith('A','DONE');
 });
 it('lost send response is durable unknown and never Get/DONE or business replay',async()=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>{if(m==='chat.send')throw new Error('reply lost');return base(m,p);});
  await h.bot.handleMessage(event('A'));await tick();expect(h.store.listAdmissions(h.key)[0].state).toBe('unknown');expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','DONE');
  await tick(60_000);expect(h.client.rpc.mock.calls.filter(([m]:any)=>m==='chat.send')).toHaveLength(1);
 });
 it('in_flight reservation is not an acceptance receipt',async()=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{runId:'r1',status:'in_flight'}:base(m,p));
  const pending=h.bot.handleMessage(event('A'));await tick();expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','Get');h.final('r1');await tick(300);await pending;
 });
 it('new user input during stop RPC survives the cutoff and waits for abort completion',async()=>{
  const first=await start();let releaseAbort:any;const base=h.client.rpc;
  h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.abort'?await new Promise(r=>releaseAbort=()=>r({aborted:true,runIds:['r1']})):base(m,p));
  const stopping=h.bot.handleStopCommand('chat','stop');await tick();const next=h.bot.handleMessage(event('new-after-stop'));await tick();
  expect(h.sends).toHaveLength(1);expect(h.bot.addReaction).not.toHaveBeenCalledWith('new-after-stop','Get');
  releaseAbort();await tick();await stopping;expect(h.sends).toHaveLength(2);expect(h.bot.addReaction).toHaveBeenCalledWith('new-after-stop','Get');
  h.final('r2');await tick(300);await next;await first.promise;expect(h.bot.addReaction).toHaveBeenCalledWith('new-after-stop','DONE');
 });
 it('failed reaction API is retried without rolling back accepted business custody',async()=>{
  h.bot.addReaction.mockRejectedValueOnce(new Error('UI unavailable'));const first=await start();await h.bot.reconcileReactions('chat');
  expect(h.bot.addReaction).toHaveBeenCalledWith('A','Get');expect(h.sends).toHaveLength(1);h.final('r1');await tick(300);await first.promise;
 });
 it('a stalled reaction API never blocks admission, collection or real result delivery',async()=>{
  let release:any,firstCall=true;h.bot.addReaction=vi.fn(async()=>{if(firstCall){firstCall=false;await new Promise(r=>release=r);}});
  const first=await start();expect(h.client.sessionCollectorFences.get(h.key)?.size).toBe(1);
  h.final('r1');await tick(300);await first.promise;expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.status).toBe('delivered');
  release();await tick(5000);expect(h.bot.addReaction).toHaveBeenCalledWith('A','DONE');expect(h.sends).toHaveLength(1);
 });
 it('SQLite process restart recovers bound old result and DONE without a business resend',async()=>{
  const first=await start();const old=h,dir=old.dir!,path=join(dir,'db');
  old.client.revokeSessionCollectors(old.key,'simulated process exit');await tick();await first.promise;
  if(old.bot.insertionTimer)clearTimeout(old.bot.insertionTimer);old.bot.goController?.dispose();await old.client.disconnect();old.store.close();
  h=harness(path);const target=h.store.getDeliveryRunTarget('Bot','chat','r1');expect(target.messageId).toBe('A');
  h.client.sessionMessageCallbacks.set(h.key,async(text:string,meta:any)=>h.bot.enqueueAndDispatchDelivery('chat','assistant_visible','recovered',text,[],target.messageId,`trigger:${target.triggerId}`,undefined,meta));
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'restart final'}}:base(m,p));
  await h.client.recoverExactRuns();await tick();expect(h.sends).toHaveLength(0);expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${target.triggerId}`)?.status).toBe('delivered');
  expect(h.bot.addReaction).toHaveBeenCalledWith('A','DONE');expect(h.store.listRunObservations(undefined,Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  // Explicitly dispose both local fixtures before removing the owned temp dir.
  await h.cleanup();h=harness();rmSync(dir,{recursive:true,force:true});
 });

});
