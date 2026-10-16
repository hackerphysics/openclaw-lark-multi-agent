import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setActiveEmbeddedRun,clearActiveEmbeddedRun,emitAgentEvent,resetAgentEventsForTest,queueAgentHarnessMessage} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {registerSteer} from '../plugins/lma-core/src/steer.js';
const KEY='agent:main:lma-sdk-contract';
let dir:string,handler:(args:any)=>Promise<void>,handle:Parameters<typeof setActiveEmbeddedRun>[1],calls:number;
let ready:boolean,callbackMode:'accept'|'reject'|'silent',laterReject:boolean;
const invoke=async(id='insertion-1',extra:Record<string,unknown>={})=>{
 let result:any;await handler({params:{sessionKey:KEY,text:'new input',insertionId:id,expectedRunId:'run-A',...extra},respond:(ok:boolean,value:any,error:any)=>{if(!ok)throw new Error(JSON.stringify(error));result=value;}});return result;
};
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'lma-public-sdk-'));vi.stubEnv('OPENCLAW_STATE_DIR',dir);
 ready=false;callbackMode='accept';calls=0;laterReject=false;
 handle={kind:'embedded',runId:'run-A',isStreaming:()=>ready,isCompacting:()=>false,isStopped:()=>!ready,abort:()=>{},supportsTranscriptCommitWait:true,
   queueMessage:async(_text,options)=>{calls++;if(callbackMode==='accept')options?.onQueueAccepted?.(true);else if(callbackMode==='reject')options?.onQueueAccepted?.(false);
     if(laterReject)throw new Error('real async SDK queue rejection');},
 } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
 setActiveEmbeddedRun('sid-A',handle,KEY);
 registerSteer({registerGatewayMethod:(name:string,fn:any)=>{if(name==='lma.steer')handler=fn;}});
 // The REAL SDK rejects lifecycle starts without producer-owned startedAt.
 emitAgentEvent({sessionKey:KEY,sessionId:'sid-A',runId:'run-A',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
});
afterEach(()=>{clearActiveEmbeddedRun('sid-A',handle,KEY);resetAgentEventsForTest();rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.useRealTimers();});
describe('actual public SDK complete typed harness contract',()=>{
 it('eligibility true followed by async rejection is not runtime acceptance',async()=>{
  ready=true;callbackMode='silent';laterReject=true;const accepted=vi.fn();
  expect(queueAgentHarnessMessage('sid-A','input',{queueIdentity:'one',onQueueAccepted:accepted})).toBe(true);
  await Promise.resolve();expect(accepted).not.toHaveBeenCalled();expect(calls).toBe(1);
 });
 it.each([true,false])('real runtime callback %s is distinct from synchronous eligibility',async(value)=>{
  ready=true;callbackMode=value?'accept':'reject';const accepted=vi.fn();
  expect(queueAgentHarnessMessage('sid-A','input',{queueIdentity:'one',onQueueAccepted:accepted})).toBe(true);
  expect(accepted).toHaveBeenCalledWith(value);
 });
 it('same queueIdentity is NOT SDK deduplication; durable custody must prevent another invocation',()=>{
  ready=true;queueAgentHarnessMessage('sid-A','input',{queueIdentity:'same'});queueAgentHarnessMessage('sid-A','input',{queueIdentity:'same'});expect(calls).toBe(2);
 });
 it.each([5000,6600,9100])('strict original-run intent at %sms stays durable with explicit genuine capability boundary',async(ms)=>{
  vi.useFakeTimers();const initial=await invoke();expect(initial.attempted).toBe(false);
  await vi.advanceTimersByTimeAsync(ms);ready=true;
  expect(await invoke()).toMatchObject({status:'capability_blocked',attempted:false,expectedRunId:'run-A',sessionId:'sid-A'});expect(calls).toBe(0);
  expect(await invoke()).toMatchObject({status:'capability_blocked'});expect(calls).toBe(0);
 });
 it('invisible successor handle reusing sessionId cannot receive an original-run injection',async()=>{
  // Exactly the public-contract counterexample: no successor event is emitted,
  // session resolver still returns sid-A, but the concrete mutation target is B.
  const successor={...handle,runId:'run-B',isStopped:()=>false,isStreaming:()=>true} satisfies Parameters<typeof setActiveEmbeddedRun>[1];
  setActiveEmbeddedRun('sid-A',successor,KEY);
  expect(await invoke()).toMatchObject({status:'capability_blocked',attempted:false});expect(calls).toBe(0);
  clearActiveEmbeddedRun('sid-A',successor,KEY);
 });
 it('stopped insertion and lost journal query cannot replay work',async()=>{
  ready=true;expect(await invoke('stop-item',{cancel:true})).toMatchObject({status:'stopped'});
  expect(await invoke('stop-item')).toMatchObject({status:'stopped'});expect(calls).toBe(0);
  expect(await invoke('missing',{queryOnly:true})).toMatchObject({status:'unknown',attempted:true});expect(calls).toBe(0);
 });
});
