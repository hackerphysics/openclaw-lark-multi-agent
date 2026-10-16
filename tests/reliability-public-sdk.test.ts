import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setActiveEmbeddedRun,clearActiveEmbeddedRun,emitAgentEvent,resetAgentEventsForTest,queueAgentHarnessMessage} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {registerSteer} from '../plugins/lma-core/src/steer.js';
const KEY='agent:main:lma-sdk-contract';
let dir:string,handlers:Map<string,any>,dispose:()=>void,handle:Parameters<typeof setActiveEmbeddedRun>[1],calls:number;
let ready:boolean,mode:'accept'|'reject'|'silent',delay:number,laterReject:boolean,callbacks:Array<(v:boolean)=>void>;
const rpc=async(name:string,params:any)=>{
 let result:any;await handlers.get(name)({params,respond:(ok:boolean,value:any,error:any)=>{if(!ok)throw new Error(JSON.stringify(error));result=value;}});return result;
};
const invoke=(id='insertion-1',extra:Record<string,unknown>={})=>rpc('lma.steer',{sessionKey:KEY,text:'new input',insertionId:id,expectedRunId:'run-A',expectedSessionId:'sid-A',stopEpoch:0,...extra});
const register=()=>{handlers=new Map();dispose=registerSteer({registerGatewayMethod:(name:string,fn:any)=>handlers.set(name,fn)});};
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'lma-public-sdk-'));vi.stubEnv('OPENCLAW_STATE_DIR',dir);
 ready=false;mode='accept';delay=0;calls=0;laterReject=false;callbacks=[];
 handle={kind:'embedded',runId:'run-A',isStreaming:()=>ready,isCompacting:()=>false,isStopped:()=>!ready,abort:()=>{},supportsTranscriptCommitWait:true,
   queueMessage:async(_text,options)=>{calls++;const cb=options?.onQueueAccepted;if(cb)callbacks.push(cb);
     if(mode!=='silent') {const value=mode==='accept';if(delay)setTimeout(()=>cb?.(value),delay);else cb?.(value);}
     if(laterReject)throw new Error('real async SDK queue rejection');},
 } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
 setActiveEmbeddedRun('sid-A',handle,KEY);register();
 emitAgentEvent({sessionKey:KEY,sessionId:'sid-A',runId:'run-A',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
});
afterEach(()=>{dispose();clearActiveEmbeddedRun('sid-A',handle,KEY);resetAgentEventsForTest();rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.useRealTimers();});
describe('actual public SDK complete typed synthetic harness conformance (no model/network)',()=>{
 it('eligibility true then async rejection without callback is unknown, not rejection/acceptance',async()=>{
  ready=true;mode='silent';laterReject=true;expect(await invoke()).toMatchObject({status:'unknown',attempted:true});
  await Promise.resolve();expect(calls).toBe(1);expect(await invoke()).toMatchObject({status:'unknown'});expect(calls).toBe(1);
 });
 it.each([true,false])('real runtime callback %s is distinct from synchronous eligibility',async(value)=>{
  ready=true;mode=value?'accept':'reject';const accepted=vi.fn();
  expect(queueAgentHarnessMessage('sid-A','input',{queueIdentity:'one',onQueueAccepted:accepted})).toBe(true);
  expect(accepted).toHaveBeenCalledWith(value);
 });
 it('same queueIdentity is NOT SDK deduplication; durable custody prevents another invocation',async()=>{
  ready=true;queueAgentHarnessMessage('sid-A','input',{queueIdentity:'same'});queueAgentHarnessMessage('sid-A','input',{queueIdentity:'same'});expect(calls).toBe(2);
  expect(await invoke()).toMatchObject({status:'accepted'});expect(await invoke()).toMatchObject({status:'accepted'});expect(calls).toBe(3);
 });
 it.each([5000,6600,9100,4*3600_000])('readiness after %sms actually queues ONCE, no short deadline abandonment',async(ms)=>{
  vi.useFakeTimers();expect(await invoke()).toMatchObject({status:'pending',attempted:false});expect(calls).toBe(0);
  await vi.advanceTimersByTimeAsync(ms);ready=true;
  // The synthetic harness (NOT the plugin) publishes fresh readiness. The
  // real SDK otherwise correctly rejects a four-hour stale fake runtime.
  if(ms>3600_000)setActiveEmbeddedRun('sid-A',handle,KEY);
  expect(await invoke()).toMatchObject({status:'accepted',attempted:true,sessionId:'sid-A'});expect(calls).toBe(1);
  expect(await invoke()).toMatchObject({status:'accepted'});expect(calls).toBe(1);
 });
 it.each([3500,9100])('callback accepted after %sms survives short response and is queryable',async(ms)=>{
  vi.useFakeTimers();ready=true;delay=ms;
  expect(await invoke()).toMatchObject({status:'unknown',attempted:true});expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(ms-1);expect(await invoke('insertion-1',{queryOnly:true})).toMatchObject({status:'unknown'});
  await vi.advanceTimersByTimeAsync(1);expect(await invoke('insertion-1',{queryOnly:true})).toMatchObject({status:'accepted'});expect(calls).toBe(1);
 });
 it('explicit asynchronous callback false permits a paced new attempt, accepted is monotone',async()=>{
  vi.useFakeTimers();ready=true;mode='reject';delay=9000;
  expect(await invoke()).toMatchObject({status:'unknown',attempted:true});
  await vi.advanceTimersByTimeAsync(9000);expect(await invoke('insertion-1',{queryOnly:true})).toMatchObject({status:'pending',attempted:false});
  mode='accept';delay=0;expect(await invoke()).toMatchObject({status:'accepted'});callbacks[0](false);expect(await invoke()).toMatchObject({status:'accepted'});expect(calls).toBe(2);
 });
 it.each(['accepted','unknown'] as const)('restart retains %s without repeating a real SDK queue call',async(status)=>{
  ready=true;mode=status==='accepted'?'accept':'silent';expect(await invoke()).toMatchObject({status});expect(calls).toBe(1);
  dispose();register();expect(await invoke()).toMatchObject({status});expect(calls).toBe(1);
 });
 it('SDK false has no dispatch side effect; no lifecycle map does not permanently disable readiness',async()=>{
  expect(await invoke()).toMatchObject({status:'pending',attempted:false});expect(calls).toBe(0);
  dispose();register();ready=true;expect(await invoke()).toMatchObject({status:'accepted'});expect(calls).toBe(1);
 });
 it('observed old-run end + successor never silently retargets a never-attempted pending input',async()=>{
  expect(await invoke()).toMatchObject({status:'pending'});
  emitAgentEvent({sessionKey:KEY,runId:'run-A',stream:'lifecycle',data:{phase:'end'}});
  emitAgentEvent({sessionKey:KEY,runId:'run-B',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
  ready=true;expect(await invoke()).toMatchObject({status:'target_ended',attempted:false});expect(calls).toBe(0);
 });
 it('different observed same-session run without old-end fact remains pending, not silently retargeted/permanently disabled',async()=>{
  expect(await invoke()).toMatchObject({status:'pending'});
  emitAgentEvent({sessionKey:KEY,sessionId:'sid-A',runId:'run-B',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()+1}});
  ready=true;expect(await invoke()).toMatchObject({status:'pending',attempted:false});expect(calls).toBe(0);
  expect(await invoke('insertion-1',{originalRunEnded:true})).toMatchObject({status:'target_ended',ordinaryEligible:true});expect(calls).toBe(0);
 });
 it('session generation replacement pauses and cannot receive the old input',async()=>{
  const successor={...handle,runId:'run-B',isStreaming:()=>true} satisfies Parameters<typeof setActiveEmbeddedRun>[1];
  clearActiveEmbeddedRun('sid-A',handle,KEY);setActiveEmbeddedRun('sid-B',successor,KEY);
  expect(await invoke()).toMatchObject({status:'target_changed',attempted:false});expect(calls).toBe(0);
  clearActiveEmbeddedRun('sid-B',successor,KEY);
 });
 it('stop epoch fences late callback and a delayed old request, including journal restart',async()=>{
  ready=true;mode='silent';expect(await invoke()).toMatchObject({status:'unknown'});
  await rpc('lma.steer.stop',{sessionKey:KEY,stopEpoch:1});callbacks[0](true);
  expect(await invoke()).toMatchObject({status:'stopped',acceptanceAfterStop:true});
  dispose();register();expect(await invoke('delayed-old')).toMatchObject({status:'stopped',attempted:false});expect(calls).toBe(1);
  mode='accept';expect(await invoke('new-input',{stopEpoch:1})).toMatchObject({status:'accepted'});expect(calls).toBe(2);
 });
 it('stopped insertion and missing journal query cannot replay work',async()=>{
  ready=true;expect(await invoke('stop-item',{cancel:true})).toMatchObject({status:'stopped'});
  expect(await invoke('stop-item')).toMatchObject({status:'stopped'});expect(calls).toBe(0);
  expect(await invoke('missing',{queryOnly:true})).toMatchObject({status:'unknown',attempted:true});expect(calls).toBe(0);
 });
 it('callback persistence failure is contained; prior attempt fence stays unknown and no SDK replay',async()=>{
  ready=true;mode='silent';expect(await invoke()).toMatchObject({status:'unknown'});
  const journalDir=join(dir,'lma-core','steer-custody'),path=join(journalDir,readdirSync(journalDir).find(p=>p.endsWith('.json'))!);
  const journal=readFileSync(path,'utf8');rmSync(path);writeFileSync(path,'invalid JSON');
  expect(()=>callbacks[0](true)).not.toThrow();writeFileSync(path,journal);
  expect(await invoke()).toMatchObject({status:'unknown'});expect(calls).toBe(1);
 });
 it('prior no-attempt candidate journal migrates to one real callback-confirmed queue call',async()=>{
  expect(await invoke()).toMatchObject({status:'pending',attempted:false});
  const journalDir=join(dir,'lma-core','steer-custody'),path=join(journalDir,readdirSync(journalDir).find(p=>p.endsWith('.json'))!);
  const old=JSON.parse(readFileSync(path,'utf8'));old.status='capability_blocked';delete old.stopEpoch;delete old.attempt;writeFileSync(path,JSON.stringify(old));
  ready=true;expect(await invoke()).toMatchObject({status:'accepted',attempted:true});expect(calls).toBe(1);
 });
 it('capability describes useful session semantics honestly, never atomic original-run CAS',async()=>{
  expect(await rpc('lma.steer.capabilities',{})).toMatchObject({protocol:2,atomicRunBound:false,acceptanceCallback:true,durableAttempts:true});
 });
});
