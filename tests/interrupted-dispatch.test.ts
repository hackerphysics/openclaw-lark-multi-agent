import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';

// Promoted unchanged from the independent 41-case offline correctness contract.
// Real OpenClawClient -> real FeishuBot -> real MessageStore/SQLite; only wire/Feishu edges mocked.
let h:ReturnType<typeof harness>,history:any,activity:any,extraDirs:string[]=[];
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const input=(id:string,state:any,extra:any={})=>({id,runId:`run-${id}`,acceptedAt:1,state,message:{role:'user',content:[]},...extra});
const pending=(items:any[],extra:any={})=>({items,total:items.length,...extra});
const snapshot=(p:any,extra:any={})=>({sessionKey:h.key,sessionId:'generation-1',sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:p,...extra});
const install=async()=>{
 h.client.ensureModel=vi.fn(async()=>false);
 h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
 const base=h.client.rpc;
 h.client.rpc=vi.fn(async(m:string,p:any)=>{
  if(m==='sessions.describe')return {session:activity};
  if(m==='chat.history')return typeof history==='function'?history(p):history;
  return base(m,p);
 });
 vi.spyOn(h.client,'steer');
 const connected=h.client._doConnect();
 h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));
 await connected;
};
const beginInput=async(text='new-input')=>{const p=h.bot.handleMessage(event(text));await tick(100);return {p};};
const finish=async(p:Promise<any>,runId='r1')=>{
 h.final(runId,'synthetic offline final');await tick(350);await p;
};
const readMethods=()=>h.client.rpc.mock.calls.map(([m]:any)=>m);
const noDestructiveRpc=()=>expect(readMethods().filter((m:string)=>/abort|reset|delete|cancel|remove|patch/.test(m))).toEqual([]);
const metadataStatus=async()=>h.client.getSessionDispatchStatus(h.key);
const expectUnknown=async()=>{const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed===true).toBe(false);};
const recordPending=(name:string,state='pending',attempted=false)=>{
 const row=h.store.insert({chatId:'chat',messageId:name,senderType:'human',senderName:'fixture-user',content:name,timestamp:Date.now()});
 h.store.markPendingTrigger('Bot','chat',row);
 h.store.saveInsertion('Bot','chat',row,`fixture-${name}`,state,{messageId:name,text:name,stopEpoch:0,sessionKey:h.bot.getSessionKey('chat'),sessionId:'generation-1',expectedRunId:'',activityUnbound:true,attempted},0);
 return row;
};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T06:32:00Z'));
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 h=harness();activity={sessionId:'generation-1',status:'done',hasActiveRun:false};history=snapshot(pending([]));await install();
});
afterEach(async()=>{
 await h.cleanup();vi.clearAllTimers();for(const d of extraDirs)rmSync(d,{recursive:true,force:true});extraDirs=[];vi.useRealTimers();vi.restoreAllMocks();
});

describe('public pending metadata dispatch contract',()=>{
 it.each(['interrupted','cancelled'])('only retained %s is idle, never a current runnable queue',async(state)=>{
  history=snapshot(pending([input('retained',state)]));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(true);expect(s.busyConfirmed===true).toBe(false);expect(s.activeRunId).toBeUndefined();noDestructiveRpc();
 });
 it('mixed queued/interrupted is really busy even when active flag is false',async()=>{
  history=snapshot(pending([input('older','queued'),input('newer','interrupted')]));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed).toBe(true);noDestructiveRpc();
 });
 it.each(['hasActiveRun','inFlightRun'])('%s always outranks retained interrupted input',async(mode)=>{
  history=snapshot(pending([input('retained','interrupted')]),mode==='hasActiveRun'?{sessionInfo:{sessionId:'generation-1',hasActiveRun:true}}:{inFlightRun:{runId:'actual-active'}});
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed).toBe(true);noDestructiveRpc();
 });
 it('global positive queuedCount outranks an interrupted-only visible page',async()=>{
  history=snapshot(pending([input('retained','interrupted')],{queuedCount:1}));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed).toBe(true);
 });
 it.each(['missing-items','invalid-items','missing-state','bad-state','missing-total','bad-total','wrong-key','missing-session','conflicting-session'])('%s is unknown, not a busy or idle assertion',async(mode)=>{
  const p:any=pending([input('retained','interrupted')]);history=snapshot(p);
  if(mode==='missing-items')delete p.items;
  if(mode==='invalid-items')p.items={state:'interrupted'};
  if(mode==='missing-state')delete p.items[0].state;
  if(mode==='bad-state')p.items[0].state='future-state';
  if(mode==='missing-total')delete p.total;
  if(mode==='bad-total')p.total='1';
  if(mode==='wrong-key')history.sessionKey='agent:main:foreign';
  if(mode==='missing-session'){delete history.sessionId;delete history.sessionInfo.sessionId;}
  if(mode==='conflicting-session')history.sessionId='generation-other';
  await expectUnknown();noDestructiveRpc();
 });
 it('one visible terminal of total two without a cursor is incomplete/unknown',async()=>{
  history=snapshot(pending([input('visible','interrupted')],{total:2}));await expectUnknown();
 });
 it('zero live chat queuedCount cannot prove that an invisible retained input is non-runnable',async()=>{
  history=snapshot(pending([input('visible','interrupted')],{total:2,queuedCount:0}));await expectUnknown();
 });
 it.each(['active','inflight'])('%s remains busy even if pending shape is invalid',async(mode)=>{
  history=snapshot(undefined,mode==='active'?{sessionInfo:{sessionId:'generation-1',hasActiveRun:true}}:{inFlightRun:{runId:'active'}});
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed).toBe(true);
 });
 it('paged queued input behind interrupted first page cannot be skipped (limit 1)',async()=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('older','queued')],{total:2})):snapshot(pending([input('newer','interrupted')],{total:2,nextBefore:40}));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);expect(s.busyConfirmed).toBe(true);
  // Positive global queuedCount is intentionally absent: must inspect continuation.
  expect(h.client.rpc.mock.calls.some(([m,p]:any)=>m==='chat.history'&&p.pendingBefore===40)).toBe(true);
 });
 it('fully covered two terminal pages permit idle after actual pendingBefore traversal',async()=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('older','cancelled')],{total:2})):snapshot(pending([input('newer','interrupted')],{total:2,nextBefore:40}));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(true);expect(s.busyConfirmed===true).toBe(false);
  expect(h.client.rpc.mock.calls.some(([m,p]:any)=>m==='chat.history'&&p.pendingBefore===40)).toBe(true);
 });
 it('empty visible page with continuation is traversed, not mistaken for exhaustion',async()=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('visible','interrupted')],{total:2})):snapshot(pending([],{total:2,nextBefore:40}));
  // Exhausted raw scan still saw only one of total two; hidden row prevents proof.
  await expectUnknown();expect(h.client.rpc.mock.calls.some(([m,p]:any)=>m==='chat.history'&&p.pendingBefore===40)).toBe(true);
 });
 it.each(['repeated-cursor','session-changed','total-changed','duplicate-id','page-error'])('paged %s is bounded unknown, never guessed idle',async(mode)=>{
  let n=0;
  history=(p:any)=>{if(++n>10)throw new Error('fixture bounded pagination guard');
   if(!p.pendingBefore)return snapshot(pending([input('newer','interrupted')],{total:2,nextBefore:40}));
   if(mode==='page-error')throw new Error('synthetic page unavailable');
   if(mode==='repeated-cursor')return snapshot(pending([input('older','interrupted')],{total:2,nextBefore:40}));
   if(mode==='session-changed')return snapshot(pending([input('older','interrupted')],{total:2}),{sessionId:'generation-2',sessionInfo:{sessionId:'generation-2',hasActiveRun:false}});
   if(mode==='total-changed')return snapshot(pending([input('older','interrupted')],{total:3}));
   return snapshot(pending([input('newer','interrupted')],{total:2}));
  };
  await expectUnknown();expect(n).toBeLessThanOrEqual(10);noDestructiveRpc();
 });
});

describe('bounded scan and automatic recovery controls',()=>{
 it('uses limit<=20 and follows actual pending cursors across a full 21-record retained set',async()=>{
  history=(p:any)=>p.pendingBefore===10?snapshot(pending([input('oldest','cancelled')],{total:21})):
   snapshot(pending(Array.from({length:20},(_,i)=>input(`new-${i}`,'interrupted')),{total:21,nextBefore:10}));
  expect((await metadataStatus()).idleConfirmed).toBe(true);
  for(const [m,p] of h.client.rpc.mock.calls)if(m==='chat.history'){expect(p.limit).toBeLessThanOrEqual(20);expect(p).not.toHaveProperty('pendingLimit');}
 });
 it.each([0,-1,'40',NaN])('invalid pending cursor %s is unknown',async(nextBefore)=>{
  history=snapshot(pending([input('retained','interrupted')],{nextBefore}));await expectUnknown();
 });
 it.each([['top-empty',''],['top-zero',0],['info-null',null],['info-false',false]])('malformed supplied session identity %s is not treated as an absent optional field',async(mode,value)=>{
  history=snapshot(pending([input('retained','interrupted')]));
  if(String(mode).startsWith('top-'))history.sessionId=value;else history.sessionInfo.sessionId=value;
  await expectUnknown();
 });
 it('missing retained input identity is unknown',async()=>{
  history=snapshot(pending([{state:'interrupted'}]));await expectUnknown();
 });
 it('head changes while scanning do not create a false idle proof',async()=>{
  let n=0;history=(p:any)=>p.pendingBefore?snapshot(pending([input('older','interrupted')],{total:2})):
   snapshot(pending([input(++n===1?'head':'replacement','interrupted')],{total:2,nextBefore:40}));
  await expectUnknown();expect(n).toBe(2);
 });
 it('a new genuine queued head found on revalidation stays busy',async()=>{
  let n=0;history=(p:any)=>p.pendingBefore?snapshot(pending([input('older','interrupted')],{total:2})):
   snapshot(pending([input('head',++n===1?'interrupted':'queued')],{total:2,nextBefore:40}));
  const status=await metadataStatus();expect(status.idleConfirmed).toBe(false);expect(status.busyConfirmed).toBe(true);
 });
 it('one 8000ms budget applies to pagination and a late page cannot start further queries',async()=>{
  let resolvePage:any,n=0;
  history=()=>++n===1?snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40})):new Promise(r=>resolvePage=r);
  const result=metadataStatus();await tick(8001);expect((await result).idleConfirmed).toBe(false);
  resolvePage(snapshot(pending([input('tail','interrupted')],{total:2,nextBefore:20})));await tick(10);expect(n).toBe(2);
 });
 it('finite page cap refuses an unbounded/filtered retained scan',async()=>{
  history=(p:any)=>snapshot(pending([],{total:1000,nextBefore:(p.pendingBefore||1000)-1}));
  await expectUnknown();expect(h.client.rpc.mock.calls.filter(([m]:any)=>m==='chat.history').length).toBeLessThanOrEqual(32);
 });
 it('paced timer recovers a never-attempted local input exactly once without a third human input',async()=>{
  recordPending('paced-never-attempted');history=snapshot(pending([input('Gateway-retained-not-replayed','interrupted')]));
  h.bot.scheduleInsertionRecovery();await tick(5100);expect(h.sends).toHaveLength(1);
  expect(h.sends[0].message).toContain('paced-never-attempted');expect(h.sends[0].message).not.toContain('Gateway-retained-not-replayed');
  h.final('r1','paced recovered final');await tick(350);await tick(10_000);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it('failed setup cannot bypass dispatch proof and is retried through paced recovery',async()=>{
  const ensure=h.bot.ensureSession;let n=0;h.bot.ensureSession=vi.fn(async(...args:any[])=>{if(++n===1)throw new Error('offline setup unavailable');return ensure(...args);});
  const {p}=await beginInput();await p;expect(h.sends).toHaveLength(0);
  const row=h.store.getMessageId('new-input')!;expect(h.store.getInsertion('Bot','chat',row)?.attempted).toBe(false);
  await tick(5100);expect(h.sends).toHaveLength(1);h.final('r1','recovered after setup');await tick(350);await tick(10_000);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it('ordinary startup drain recovers local never-attempted custody once',async()=>{
  recordPending('startup-never-attempted');history=snapshot(pending([input('retained','interrupted')]));
  h.store.upsertChatInfo({chatId:'chat',chatType:'p2p',chatName:'fixture-chat',members:'',memberNames:'',ownerBot:'Bot',freeDiscussion:false,verbose:false,discuss:false,discussMaxRounds:10,updatedAt:Date.now()});
  const drain=h.bot.drainOnStartup();await tick(100);expect(h.sends).toHaveLength(1);
  h.final('r1','startup recovered final');await tick(350);await drain;await tick(10_000);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it.each(['accepted','unknown','dispatching','stopped'])('paced reconciliation never replays %s custody',async(state)=>{
  const row=recordPending(`never-replay-${state}`,state,true);if(state==='stopped')h.store.clearPendingTrigger('Bot','chat',row);
  history=snapshot(pending([input('retained','interrupted')]));h.bot.scheduleInsertionRecovery();await tick(15_100);
  expect(h.sends).toHaveLength(0);expect(h.client.steer).not.toHaveBeenCalled();noDestructiveRpc();
 });
});

describe('real Client -> FeishuBot -> SQLite admission (fixture RPC only)',()=>{
 it('CONTROL: known empty pending queue admits once using unchanged real code',async()=>{
  history=snapshot(pending([]));const {p}=await beginInput();expect(h.sends).toHaveLength(1);expect(h.client.steer).not.toHaveBeenCalled();
  await finish(p);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it('CONTROL: proven-never-attempted input recovers against an empty queue',async()=>{
  const row=recordPending('never-attempted-control');history=snapshot(pending([]));
  const r=h.bot.reconcileInsertions('chat');await tick(100);await r;expect(h.sends).toHaveLength(1);expect(h.store.getInsertion('Bot','chat',row)?.state).toBe('ordinary');
  h.final('r1','synthetic control final');await tick(350);noDestructiveRpc();
 });
 it.each(['interrupted','cancelled'])('retained %s alone admits a genuinely new input exactly once without steer',async(state)=>{
  history=snapshot(pending([input('retained',state)]));const {p}=await beginInput();
  expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toContain('new-input');expect(h.client.steer).not.toHaveBeenCalled();
  await finish(p);await h.bot.reconcileInsertions('chat');await tick(100);
  expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it('mixed queued/interrupted retains new input without guessing a steer root',async()=>{
  history=snapshot(pending([input('older','queued'),input('newer','interrupted')]));const {p}=await beginInput();await p;
  expect(h.sends).toHaveLength(0);expect(h.client.steer).not.toHaveBeenCalled();
  expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('new-input')!)?.activityUnbound).toBe(true);noDestructiveRpc();
 });
 it.each(['missing-items','bad-state','wrong-key','missing-session','incomplete-page'])('%s cannot be bypassed by a describe-only idle flag',async(mode)=>{
  history=snapshot(pending([input('retained','interrupted')]));
  if(mode==='missing-items')delete history.pendingInputs.items;
  if(mode==='bad-state')history.pendingInputs.items[0].state='future-state';
  if(mode==='wrong-key')history.sessionKey='agent:main:foreign';
  if(mode==='missing-session'){delete history.sessionId;delete history.sessionInfo.sessionId;}
  if(mode==='incomplete-page')history.pendingInputs.total=2;
  const {p}=await beginInput();expect(h.sends).toHaveLength(0);expect(h.client.steer).not.toHaveBeenCalled();noDestructiveRpc();await p;
 });
 it('attempted unknown prior insertion is never replayed when terminal-only metadata becomes idle',async()=>{
  const row=recordPending('prior-unknown','unknown',true);history=snapshot(pending([input('retained','interrupted')]));
  await h.bot.reconcileInsertions('chat');await tick(100);
  expect(h.sends).toHaveLength(0);expect(h.client.steer).not.toHaveBeenCalled();expect(h.store.getInsertion('Bot','chat',row)?.attempted).toBe(true);
  expect(h.store.getInsertion('Bot','chat',row)?.state).not.toBe('ordinary');noDestructiveRpc();
 });
 it('independent new input can run once without including a prior attempted unknown input',async()=>{
  recordPending('prior-unknown','unknown',true);history=snapshot(pending([input('retained','interrupted')]));
  const {p}=await beginInput();expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toContain('new-input');expect(h.sends[0].message).not.toContain('prior-unknown');
  await finish(p);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
 it.each(['empty-control','interrupted'])('restart close/reopen with %s permits proven-never-attempted local input ordinary recovery exactly once',async(mode)=>{
  await h.cleanup();const d=mkdtempSync(join(tmpdir(),'lma-interrupted-reopen-'));extraDirs.push(d);const db=join(d,'db');h=harness(db);await install();
  const row=recordPending('local-never-attempted');
  h.store.upsertChatInfo({chatId:'chat',chatType:'p2p',chatName:'fixture-chat',members:'',memberNames:'',ownerBot:'Bot',freeDiscussion:false,verbose:false,discuss:false,discussMaxRounds:10,updatedAt:Date.now()});
  await h.cleanup();vi.clearAllTimers();h=harness(db);history=snapshot(pending(mode==='empty-control'?[]:[input('retained','interrupted')]));await install();
  const recovered=h.bot.reconcileInsertions('chat');await tick(100);await recovered;
  expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toContain('local-never-attempted');expect(h.client.steer).not.toHaveBeenCalled();
  expect(h.store.getInsertion('Bot','chat',row)?.state).toBe('ordinary');
  h.final('r1','synthetic recovered final');await tick(350);await h.bot.reconcileInsertions('chat');await tick(100);expect(h.sends).toHaveLength(1);noDestructiveRpc();
 });
});
