import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {OpenClawClient} from '../src/openclaw-client.js';
import {MessageStore} from '../src/message-store.js';
const KEY='agent:main:regression';let c:any,proactive:any,n:number,store:MessageStore,dir:string;
const wire=(event:string,payload:any)=>c.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:KEY,...payload}})));
const final=(runId:string,text='old exact final')=>{
 wire('chat',{runId,state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('session.message',{runId,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('agent',{runId,stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
};
const send=async(message:string,extra:any={})=>{
 const promise=c.chatSend({sessionKey:KEY,message,...extra}).then((text:string)=>({text}),(error:Error)=>({error}));
 await vi.advanceTimersByTimeAsync(0);return {promise};
};
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T02:00:00Z'));
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 dir=mkdtempSync(join(tmpdir(),'lma-reliable-client-'));store=new MessageStore(join(dir,'db'));
 c=new OpenClawClient({baseUrl:'ws://offline.invalid',token:'test'});c.bindRecoveryStore(store);
 const connected=c._doConnect();c.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
 n=0;c.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{runId:`r${++n}`}:m==='sessions.describe'?{session:{status:'running',hasActiveRun:true}}:{runId:p?.runId,status:'timeout'});
 proactive=vi.fn();c.sessionMessageCallbacks.set(KEY,proactive);
});
afterEach(async()=>{await c.disconnect();vi.clearAllTimers();store.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();vi.restoreAllMocks();});
describe('exact-run collector and admission custody correctness',()=>{
 it.each([0,1,30_000])('supersede atomically transfers exact final custody at +%sms',async(delay)=>{
  const old=await send('old');c.revokeSessionCollectors(KEY,'transfer');
  expect(c.ownedDeliveryRuns.has('r1')).toBe(false);
  // Also check same synchronous tick, before old chatSend finally executes.
  if(delay) await vi.advanceTimersByTimeAsync(delay);
  final('r1');await vi.advanceTimersByTimeAsync(50);
  expect((await old.promise).error?.name).toBe('SupersededObservation');
  expect(proactive).toHaveBeenCalledTimes(1);expect(proactive.mock.calls[0][0]).toBe('old exact final');
  expect(c.rpc.mock.calls.filter(([m]:any)=>m==='chat.abort')).toHaveLength(0);
 });
 it('failed replacement admission preserves the healthy old observer and exact answer',async()=>{
  const old=await send('old');const rpc=c.rpc;c.rpc=vi.fn(async(m:string,p:any)=>{if(m==='chat.send')throw new Error('admission unavailable');return rpc(m,p)});
  const newer=await send('new');expect((await newer.promise).error?.name).toBe('AdmissionUnconfirmed');
  expect(c.sessionCollectorFences.get(KEY)?.size).toBe(1);final('r1');await vi.advanceTimersByTimeAsync(50);
  expect(await old.promise).toEqual({text:'old exact final'});expect(proactive).not.toHaveBeenCalled();
 });
 it.each([false,true])('out-of-order admission cannot register stale collector/progress (reverse=%s)',async(reverse)=>{
  const receipts:any[]=[];const rpc=c.rpc;c.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?await new Promise(resolve=>receipts.push(resolve)):rpc(m,p));
  const a=vi.fn(),b=vi.fn();const old=await send('old',{onProgress:a}),newer=await send('new',{onProgress:b});
  for(const i of reverse?[1,0]:[0,1]) {receipts[i]({runId:`r${i+1}`});await vi.advanceTimersByTimeAsync(0);}
  expect((await old.promise).error?.name).toBe('SupersededObservation');expect(c.sessionCollectorFences.get(KEY)?.size).toBe(1);
  expect(c.progressCallbacks.get(KEY)).toBe(b);final('r2','new final');await vi.advanceTimersByTimeAsync(50);
  expect(await newer.promise).toEqual({text:'new final'});
 });
 it('old pre-send callback suspended across replacement is fenced before RPC',async()=>{
  let resume:any;const old=await send('old',{onSendAttempt:()=>new Promise(r=>resume=r)});
  const newer=await send('new');resume();await vi.advanceTimersByTimeAsync(0);
  expect((await old.promise).error?.name).toBe('SupersededObservation');
  expect(c.rpc.mock.calls.filter(([m]:any)=>m==='chat.send')).toHaveLength(1);
  final('r1','new final');await vi.advanceTimersByTimeAsync(50);expect(await newer.promise).toEqual({text:'new final'});
 });
 it('stop before late receipt cannot collect or recover a stopped answer',async()=>{
  let receipt:any;const rpc=c.rpc;c.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?await new Promise(r=>receipt=r):m==='chat.abort'?{aborted:true,runIds:['r1']}:rpc(m,p));
  const old=await send('old');await c.abortChat(KEY);receipt({runId:'r1'});await vi.advanceTimersByTimeAsync(0);
  expect((await old.promise).error?.name).toBe('SupersededObservation');expect(c.sessionCollectorFences.size).toBe(0);
  expect(store.listRunObservations(undefined,Number.MAX_SAFE_INTEGER)).toHaveLength(0);
 });
 it.each([11*60_000,4*60*60_000,25*60*60_000])('silent tool at %sms still has exact final custody and bounded timers',async(duration)=>{
  const notice=vi.fn();const old=await send('old',{onWaitPaused:notice});let settled=false;void old.promise.then(()=>settled=true);
  wire('agent',{runId:'r1',stream:'tool',data:{phase:'start',name:'exec',toolCallId:'long-api'}});
  await vi.advanceTimersByTimeAsync(duration);expect(settled).toBe(false);expect(notice).toHaveBeenCalledTimes(1);
  expect(store.listRunObservations(undefined,Number.MAX_SAFE_INTEGER)).toHaveLength(1);expect(vi.getTimerCount()).toBeLessThan(10);
  final('r1','exact final after long tool');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'exact final after long tool'});
 });
 it('lost connection preserves custody; only exact committed agent.wait terminal settles after reconnect',async()=>{
  const old=await send('old',{onWaitPaused:vi.fn()});c.connected=false;
  await vi.advanceTimersByTimeAsync(3*60*60_000);expect(c.sessionCollectorFences.get(KEY)?.size).toBe(1);
  c.connected=true;const rpc=c.rpc;c.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'recovered exact result'}}:rpc(m,p));
  await vi.advanceTimersByTimeAsync(60_000);expect(await old.promise).toEqual({text:'recovered exact result'});
 });
 it('SQLite reopen recovers exact observation without any new business chat.send',async()=>{
  const old=await send('old');c.revokeSessionCollectors(KEY,'restart');await old.promise;await c.disconnect();
  store.close();store=new MessageStore(join(dir,'db'));
  const replacement:any=new OpenClawClient({baseUrl:'ws://offline',token:'test'});replacement.bindRecoveryStore(store);
  proactive.mockImplementation(()=>store.finishRunObservation(KEY,'r1','outbox_owned'));replacement.sessionMessageCallbacks.set(KEY,proactive);replacement.rpc=vi.fn(async()=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'restart result'}}));
  await replacement.recoverExactRuns();expect(proactive).toHaveBeenCalledWith('restart result',expect.objectContaining({runId:'r1',final:true}));
  expect(replacement.rpc.mock.calls.map(([m]:any)=>m)).toEqual(['agent.wait']);expect(store.listRunObservations()).toHaveLength(0);await replacement.disconnect();
 });
 it('raw agent alias for the exact root still extends activity and returns its own final',async()=>{
  const notice=vi.fn();const old=await send('old',{onWaitPaused:notice});await vi.advanceTimersByTimeAsync(595000);
  wire('agent',{sessionKey:'agent:other:regression',runId:'r1',stream:'tool',data:{phase:'result',name:'read',toolCallId:'alias-tool'}});
  await vi.advanceTimersByTimeAsync(6000);expect(notice).not.toHaveBeenCalled();final('r1');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'old exact final'});
 });
 it('a different run terminal without authoritative lineage cannot settle the old root',async()=>{
  const old=await send('old');wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'old'}]}});
  wire('agent',{runId:'foreign',stream:'lifecycle',data:{phase:'start'}});final('foreign','foreign answer');
  let settled=false;void old.promise.then(()=>settled=true);await vi.advanceTimersByTimeAsync(100);expect(settled).toBe(false);
  final('r1','own exact answer');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'own exact answer'});
 });
 it('large interim stream is bounded and cannot publish a truncated draft as final',async()=>{
  const old=await send('old');wire('agent',{runId:'r1',stream:'assistant',data:{delta:'draft '.repeat(200000)}});wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
  let settled=false;void old.promise.then(()=>settled=true);await vi.advanceTimersByTimeAsync(100);expect(settled).toBe(false);
  final('r1','complete authoritative final');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'complete authoritative final'});
 });
 it.each([undefined,'future-disposition'])('unknown terminal metadata %s cannot promote an interim draft',async(disposition)=>{
  const old=await send('old');wire('agent',{runId:'r1',stream:'assistant',data:{delta:'unverified draft.'}});
  c.rpc=vi.fn(async()=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:disposition?{disposition}:undefined}));
  await c.runStateChecks.get(KEY)();let settled=false;void old.promise.then(()=>settled=true);await vi.advanceTimersByTimeAsync(50);expect(settled).toBe(false);
  final('r1','verified final');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'verified final'});
 });
});
