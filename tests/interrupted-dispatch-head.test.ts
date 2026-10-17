import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';

// Independent head/deadline probes with the same real-class fixtures as the 41-case contract.
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


describe('independent parent head and deadline correctness probes',()=>{
 it.each([undefined,null,'false',0])('missing/malformed head activity %s must not become positive idle through a valid tail',async(active)=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('tail','cancelled')],{total:2})):
   snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40}),{sessionInfo:{sessionId:'generation-1',hasActiveRun:active}});
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);
 });
 it.each([undefined,null,'false',0])('malformed middle-page activity %s must not be laundered by a valid final page',async(active)=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('middle','interrupted')],{total:3,nextBefore:20}),{sessionInfo:{sessionId:'generation-1',hasActiveRun:active}}):
   p.pendingBefore===20?snapshot(pending([input('tail','cancelled')],{total:3})):
   snapshot(pending([input('head','interrupted')],{total:3,nextBefore:40}));
  const s=await metadataStatus();expect(s.idleConfirmed).toBe(false);
 });
 it('Bot must not ordinary-admit when current head active state is missing',async()=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('tail','cancelled')],{total:2})):
   snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40}),{sessionInfo:{sessionId:'generation-1'}});
  const {p}=await beginInput();expect(h.sends).toHaveLength(0);await p;
 });
 it('complete single page with absent active flag stays unknown',async()=>{
  history=snapshot(pending([input('head','interrupted')]),{sessionInfo:{sessionId:'generation-1'}});await expectUnknown();
 });
 it('complete two pages with explicit false head stay idle',async()=>{
  history=(p:any)=>p.pendingBefore===40?snapshot(pending([input('tail','cancelled')],{total:2})):
   snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40}));
  expect((await metadataStatus()).idleConfirmed).toBe(true);
 });
 it('a real multi-page scan finishing between 1.5s and 8s succeeds (audit P1: outer race was still 1500ms)',async()=>{
  const started=Date.now();let n=0;
  history=(p:any)=>{n++;vi.setSystemTime(started+n*650);
    return p.pendingBefore===40?snapshot(pending([input('tail','cancelled')],{total:2})):
     snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40}));};
  const s=await metadataStatus();
  expect(n).toBe(3);
  expect(s.idleConfirmed).toBe(true);
 });
 it('head response observed beyond absolute 1500ms deadline cannot authorize idle',async()=>{
  let n=0;const started=Date.now();history=(p:any)=>{
   n++;if(n===3)vi.setSystemTime(started+8001);
   return p.pendingBefore===40?snapshot(pending([input('tail','cancelled')],{total:2})):
    snapshot(pending([input('head','interrupted')],{total:2,nextBefore:40}));
  };
  const s=await metadataStatus();expect(n).toBe(3);expect(s.idleConfirmed).toBe(false);
 });
});
