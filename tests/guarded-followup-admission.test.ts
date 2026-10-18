import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {OpenClawClient} from '../src/openclaw-client.js';
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';
import {setActiveEmbeddedRun,clearActiveEmbeddedRun,emitAgentEvent,resetAgentEventsForTest} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {registerSteer} from '../plugins/lma-core/src/steer.js';

// Real Bot -> SQLite -> Client.rpc -> serialized WS request/response/ACK hook.
// Only the Gateway server and Feishu SDK edges are synthetic; no private Core
// functions, sockets, model calls, provenance receipts or terminal/yield guesses.
let h:ReturnType<typeof harness>,session:any,history:any,requests:any[],dirs:string[]=[];
let runNumber=0,activePathLeaves:Set<string>;
let intercept:((request:any)=>Promise<any>|any)|undefined;
let disposal:undefined|(()=>void),sdkHandle:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,sessionId:'generation-1',...payload}})));
const empty=()=>({total:0,queuedCount:0,items:[]});
const busy=()=>{
 session={sessionId:'generation-1',status:'running',hasActiveRun:true,archived:false};
 history={sessionKey:h.key,sessionId:'generation-1',sessionInfo:{...session,activeLeafEntryId:'leaf-1'},pendingInputs:empty()};
};
const idle=()=>{busy();session.status='done';session.hasActiveRun=false;history.sessionInfo={...history.sessionInfo,...session};};
const final=async(runId:string,text:string)=>{
 wire('chat',{runId,state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('session.message',{runId,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('agent',{runId,stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
 await tick(400);
};
const originalServer=(request:any):any=>{
 const {method,params:p}=request;
 if(method==='sessions.describe')return {session:{...session}};
 if(method==='chat.history')return structuredClone(history);
 if(method==='chat.send') {
  // Synthetic public exact-or-ancestor contract, NOT a Core function import.
  if(p.expectedLeafEntryId && (!activePathLeaves.has(p.expectedLeafEntryId) || p.sessionId!==session.sessionId))
   return {rpcError:{code:'INVALID_REQUEST',message:'active leaf changed',details:{reason:'active-leaf-changed'}}};
  return {runId:`r${++runNumber}`,status:'started',sessionId:session.sessionId};
 }
 if(method==='agent.wait')return {runId:p.runId,status:'timeout'};
 if(method==='chat.abort')return {aborted:true,runIds:['r1']};
 if(method==='lma.steer.capabilities')return {protocol:1,atomicRunBound:false};
 return {};
};
const install=async()=>{
 requests=[];intercept=undefined;
 h.client.rpc=(OpenClawClient.prototype as any).rpc.bind(h.client);
 h.client.ensureModel=vi.fn(async()=>false);
 h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
 const connected=h.client._doConnect();
 h.client.ws.send=(raw:string)=>{
  const request=JSON.parse(raw);requests.push(request);
  if(request.method==='chat.send')h.sends.push(request.params);
  Promise.resolve().then(()=>intercept?.(request) ?? originalServer(request)).then(result=>{
   h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',id:request.id,
    ...(result?.rpcError ? {ok:false,error:result.rpcError} : {ok:true,payload:result})})));
  });
 };
 h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));
 await connected;
};
const input=async(text='B')=>{const promise=h.bot.handleMessage(event(text));await tick(100);return {promise,row:h.store.getMessageId(text)!};};
const admitBounded=async()=>{await tick(65_000);};
const item=(row:number)=>h.store.getInsertion('Bot','chat',row);
const synced=(row:number)=>h.store['db'].prepare('SELECT COUNT(*) AS n FROM message_sync WHERE message_row_id=?').get(row)?.n;
const noMutation=()=>expect(requests.filter(r=>/abort|reset|delete|patch|cancel/.test(r.method))).toEqual([]);
const startRoot=async()=>{
 idle();const a=await input('A');expect(h.sends).toHaveLength(1);
 busy();history.inFlightRun={runId:'r1'};return a;
};
const yieldRoot=async()=>{wire('chat',{runId:'r1',state:'final',yielded:true});await tick(100);};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 runNumber=0;activePathLeaves=new Set(['leaf-1']);h=harness();busy();await install();
});
afterEach(async()=>{
 disposal?.();disposal=undefined;
 if(sdkHandle)clearActiveEmbeddedRun('generation-1',sdkHandle,h.key);sdkHandle=undefined;resetAgentEventsForTest();
 await h.cleanup();vi.clearAllTimers();for(const d of dirs)rmSync(d,{recursive:true,force:true});dirs=[];
 vi.unstubAllEnvs();vi.useRealTimers();vi.restoreAllMocks();
});

describe('separate guarded followup admission (actual WS / Client / Bot / SQLite)',()=>{
 it('aggregate busy, zero pending and observed physical ID+leaf deliver fresh B once; old exact result/Get custody persists',async()=>{
  const a=await startRoot();delete history.inFlightRun;
  const b=await input();expect(h.sends).toHaveLength(1);
  const status=await h.client.getSessionDispatchStatus(h.key);
  expect(status).toMatchObject({idleConfirmed:false,busyConfirmed:true,followupAdmissionEligible:true,expectedLeafEntryId:'leaf-1'});
  expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');
  await admitBounded();expect(h.sends).toHaveLength(2);
  expect(h.sends[1]).toMatchObject({queueMode:'followup',sessionKey:h.key,sessionId:'generation-1',expectedLeafEntryId:'leaf-1',suppressCommandInterpretation:true,deliver:false});
  expect(h.sends[1]).not.toHaveProperty('expectedSessionId');
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  expect(h.store.getRunObservation(h.key,'r1').yielded).not.toBe(true);
  expect(h.store.getDeliveryRunTarget('Bot','chat','r1').triggerId).toBe(a.row);
  expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');
  // Admission is not immediate execution: simulate Gateway queued custody.
  history.pendingInputs={total:1,queuedCount:1,items:[{id:'queued-B',state:'queued'}]};
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${b.row}`)).toBeNull();
  await final('r1','A exact late result');await a.promise;
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${a.row}`)?.content).toBe('A exact late result');
  await final('r2','B later queued result');await b.promise;
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${b.row}`)?.content).toBe('B later queued result');
  await h.bot.reconcileInsertions('chat');await tick(10_000);expect(h.sends).toHaveLength(2);noMutation();
 });
 it('without a local owner, two matching observations admit one queued turn, never relabel busy as idle',async()=>{
  const b=await input();expect(h.sends).toHaveLength(0);expect(item(b.row).attempted).toBe(false);
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Typing');
  await tick(2501);
  const view=h.bot.patchLiveStatusCard.mock.calls.at(-1)?.[1] || h.bot.replyLiveStatusCard.mock.calls.at(-1)?.[1];
  expect(view).toMatchObject({state:'queued',phase:'queued'});
  expect(h.store.listPresentations('Bot','offline-app','chat').length).toBeGreaterThan(0);
  await tick(55_000);expect(h.sends).toHaveLength(0);
  await tick(7600);expect(h.sends).toHaveLength(1);expect(h.sends[0].queueMode).toBe('followup');
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');
  expect((await h.client.getSessionDispatchStatus(h.key)).idleConfirmed).toBe(false);
  await final('r1','B exact');await b.promise;expect(item(b.row)).toMatchObject({state:'ordinary',attempted:true,admittedRunId:'r1'});noMutation();
 });
 it.each(['offline','permission'])('%s metadata keeps a durable local queued receipt, never a fake Gateway Get',async(mode)=>{
  await h.bot.ensureSession('chat');
  intercept=r=>['chat.history','sessions.describe','chat.send'].includes(r.method)?{rpcError:{code:mode==='permission'?'FORBIDDEN':'UNAVAILABLE',message:mode}}:originalServer(r);
  const b=await input();await tick(70_000);
  const view=h.bot.patchLiveStatusCard.mock.calls.at(-1)?.[1] || h.bot.replyLiveStatusCard.mock.calls.at(-1)?.[1];
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalled();
  expect(view.state).not.toBe('admitted');
  expect(h.store.getMessageByMessageId('B')?.id).toBe(b.row);
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Typing');
  expect(h.sends).toHaveLength(1);expect(h.store.listAdmissions(h.key).every((a:any)=>a.state!=='accepted')).toBe(true);noMutation();
 });
 it('escaped native commands are outside the ordinary-human restricted rescue',async()=>{
  const p=h.bot.handleMessage(event('//status','native'));await tick(70_000);await p;
  expect(h.sends).toHaveLength(0);expect(h.store.getMessageByMessageId('native')?.triggerKind).toBe('native_command');noMutation();
 });
 it.each(['partial-pending','missing-generation'])('%s unknown activity preserves bounded ordinary fresh-input rescue',async(mode)=>{
  session={sessionId:'generation-1',status:'unknown',archived:false};
  history.sessionInfo={sessionId:'generation-1',archived:false,activeLeafEntryId:'leaf-1'};
  history.pendingInputs={total:1,items:[],queuedCount:0};delete history.sessionInfo.activeLeafEntryId;
  if(mode==='missing-generation'){delete session.sessionId;delete history.sessionId;delete history.sessionInfo.sessionId;history.pendingInputs=empty();}
  const b=await input();expect(h.sends).toHaveLength(0);await tick(70_000);
  expect(h.sends).toHaveLength(1);expect(h.sends[0].queueMode).toBe('followup');expect(h.sends[0]).not.toHaveProperty('expectedLeafEntryId');
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');await final('r1','ordinary unknown rescue result');await b.promise;noMutation();
 });
 it('a previous restricted proof cannot bypass into ordinary unknown-state rescue after metadata disappears',async()=>{
  const b=await input();expect(item(b.row).followupAdmissionGuard.expectedLeafEntryId).toBe('leaf-1');
  session={sessionId:'generation-1',status:'unknown'};
  history.sessionInfo={sessionId:'generation-1'};delete history.pendingInputs;
  await tick(120_000);expect(h.sends).toHaveLength(0);expect(item(b.row)).toMatchObject({state:'pending',attempted:false});noMutation();
 });
 it.each(['retained-hidden','queued','missing-pending','malformed-pending','unknown-active-projection'])('%s pending work is not a receiving veto and never fabricates idle',async(mode)=>{
  if(mode==='retained-hidden')history.pendingInputs={total:1,items:[],queuedCount:0};
  if(mode==='queued')history.pendingInputs={total:1,items:[{id:'other-input',state:'queued'}],queuedCount:1};
  if(mode==='missing-pending')delete history.pendingInputs;
  if(mode==='malformed-pending')history.pendingInputs={total:1,items:'hidden'};
  if(mode==='unknown-active-projection'){
   delete session.hasActiveRun;session.status='unknown';delete history.sessionInfo.hasActiveRun;
   history.pendingInputs={total:1,items:[],queuedCount:0};
  }
  const before=await h.client.getSessionDispatchStatus(h.key);expect(before.idleConfirmed).toBe(false);expect(before.followupAdmissionEligible).toBe(true);
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);
  expect(h.sends[0]).toMatchObject({queueMode:'followup',sessionId:'generation-1',expectedLeafEntryId:'leaf-1'});
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');await final('r1','B queued after existing work');await b.promise;noMutation();
 });
 it('a second new C can be accepted while B is already Gateway-queued, preserving B exact result/Get',async()=>{
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);
  history.pendingInputs={total:1,items:[],queuedCount:1};
  const c=await input('C');await tick(70_000);expect(h.sends).toHaveLength(2);expect(h.sends[1].message).toBe('C');
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');
  await final('r1','B queued original result');await final('r2','C queued result');await b.promise;await c.promise;noMutation();
 });
 it.each(['missing-leaf','null-leaf','foreign-key','missing-archive','archived','malformed-inflight'])('%s never authorizes timeout-only admission',async(mode)=>{
  if(mode==='missing-leaf')delete history.sessionInfo.activeLeafEntryId;
  if(mode==='null-leaf')history.sessionInfo.activeLeafEntryId=null;
  if(mode==='missing-generation'){delete session.sessionId;delete history.sessionId;delete history.sessionInfo.sessionId;}
  if(mode==='foreign-key')history.sessionKey='agent:main:foreign';
  if(mode==='hidden-pending')history.pendingInputs={total:1,queuedCount:0};
  if(mode==='queued')history.pendingInputs={total:1,queuedCount:1,items:[{id:'q',state:'queued'}]};
  if(mode==='missing-archive')delete history.sessionInfo.archived;
  if(mode==='archived')history.sessionInfo.archived=true;
  if(mode==='malformed-inflight')history.inFlightRun=false;
  const b=await input();await admitBounded();await b.promise;
  expect(h.sends).toHaveLength(0);expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);
  expect(h.store.isInsertionReserved('Bot','chat',b.row)).toBe(true);
  expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','followup:').some((d:any)=>d.deliveryKey.endsWith('guard-unavailable'))).toBe(true);noMutation();
 });
 it.each(['generation','archive'])('a %s change during bounded observation retains B without migration',async(mode)=>{
  const b=await input();
  if(mode==='generation'){session.sessionId='generation-2';history.sessionId='generation-2';history.sessionInfo.sessionId='generation-2';}
  if(mode==='archive')history.sessionInfo.archived=true;
  await admitBounded();expect(h.sends).toHaveLength(0);expect(item(b.row).state).toBe('target_changed');
  expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','followup:').length).toBeGreaterThan(0);
  expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);noMutation();
 });
 it('a genuine active injectable target retains the real callback-confirmed public SDK steer path',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-followup-sdk-'));dirs.push(dir);vi.stubEnv('OPENCLAW_STATE_DIR',dir);
  const handlers=new Map<string,any>();disposal=registerSteer({registerGatewayMethod:(name:string,fn:any)=>handlers.set(name,fn)});
  const queued=vi.fn(async(_text:string,o:any)=>{o.onQueueAccepted?.(true);});
  sdkHandle={kind:'embedded',runId:'external-root',isStreaming:()=>true,isCompacting:()=>false,isStopped:()=>false,abort:()=>{},supportsTranscriptCommitWait:true,queueMessage:queued};
  setActiveEmbeddedRun('generation-1',sdkHandle,h.key);
  emitAgentEvent({sessionKey:h.key,sessionId:'generation-1',runId:'external-root',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
  history.inFlightRun={runId:'external-root'};
  intercept=async r=>{
   const handler=handlers.get(r.method);if(!handler)return originalServer(r);
   let result:any;await handler({params:r.params,respond:(ok:boolean,value:any,error:any)=>{result=ok?value:{rpcError:error};}});return result;
  };
  const b=await input();await admitBounded();
  expect(h.sends).toHaveLength(0);expect(queued).toHaveBeenCalledTimes(1);
  expect(item(b.row)).toMatchObject({state:'accepted',attempted:true,expectedRunId:'external-root'});
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');noMutation();
 });
 it('an exact SDK zero-effect refusal can become ONE guarded followup after bounded no-target proof',async()=>{
  history.inFlightRun={runId:'external-root'};
  intercept=r=>r.method==='lma.steer.capabilities'?{protocol:2,durableAttempts:true,acceptanceCallback:true}
   :r.method==='lma.steer'?{...r.params,sessionId:'generation-1',status:'pending',attempted:false,reason:'backend_rejected_no_effect',ordinaryEligible:true}:originalServer(r);
  const b=await input();expect(item(b.row)).toMatchObject({state:'pending',attempted:false});
  delete history.inFlightRun;await tick(70_000);
  expect(h.sends).toHaveLength(1);expect(h.sends[0]).toMatchObject({queueMode:'followup',sessionId:'generation-1',expectedLeafEntryId:'leaf-1'});
  await final('r1','B after definitive no-effect');await b.promise;await tick(15_000);expect(h.sends).toHaveLength(1);noMutation();
 });
 it.each(['external','local-owner'])('real zero-effect/not-ready receipt permits bounded queued followup despite persistent inFlight target (%s)',async(ownerMode)=>{
  let a:any;if(ownerMode==='local-owner')a=await startRoot();
  const target=a?'r1':'maintenance-root';history.inFlightRun={runId:target};
  intercept=r=>r.method==='lma.steer.capabilities'?{protocol:2,durableAttempts:true,acceptanceCallback:true}
   :r.method==='lma.steer'?{...r.params,sessionId:'generation-1',status:'pending',attempted:false,reason:'target_not_ready',ordinaryEligible:true}:originalServer(r);
  const b=await input();expect(item(b.row)).toMatchObject({state:'pending',attempted:false,noEffectRunId:target});
  await tick(70_000);expect(h.sends).toHaveLength(a?2:1);
  const send=h.sends.at(-1);expect(send).toMatchObject({message:'B',queueMode:'followup',sessionId:'generation-1',expectedLeafEntryId:'leaf-1'});
  expect(item(b.row).followupAdmissionGuard.nonInjectableRunId).toBe(target);
  if(a){expect(h.store.runObservationState(h.key,'r1')).toBe('observing');expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');await final('r1','A maintenance exact result');}
  await final(a?'r2':'r1','B noninterrupting queued result');await b.promise;if(a)await a.promise;noMutation();
 });
 it.each(['not-ready','now-ready'])('a queued B never captures fresh C from actual foreground SDK routing (%s)',async(mode)=>{
  history.inFlightRun={runId:'maintenance-root'};let ready=false;
  intercept=r=>r.method==='lma.steer.capabilities'?{protocol:2,durableAttempts:true,acceptanceCallback:true}
   :r.method==='lma.steer'?{...r.params,sessionId:'generation-1',status:ready?'accepted':'pending',attempted:ready,reason:'target_not_ready',ordinaryEligible:true}:originalServer(r);
  const b=await input();await tick(70_000);expect(h.sends).toHaveLength(1);
  ready=mode==='now-ready';const c=await input('C');await tick(75_000);
  if(ready) {
   expect(h.sends).toHaveLength(1);expect(item(c.row)).toMatchObject({state:'accepted',expectedRunId:'maintenance-root'});
  } else {
   expect(h.sends).toHaveLength(2);expect(h.sends[1].message).toBe('C');expect(item(c.row)).toMatchObject({state:'ordinary',admittedRunId:'r2'});
   await final('r2','C exact queued result');
  }
  expect(h.store.getReactionIntent('Bot','chat',b.row).desired).toBe('Get');expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  await final('r1','B original queued result');await b.promise;await c.promise;
  if(ready)expect(h.store.getReactionIntent('Bot','chat',c.row).desired).toBe('Get');noMutation();
 });
 it.each(['ineligible','target-changed','generation','unknown'])('no-effect escape remains forbidden with %s proof',async(mode)=>{
  history.inFlightRun={runId:'maintenance-root'};
  intercept=r=>r.method==='lma.steer.capabilities'?{protocol:2,durableAttempts:true,acceptanceCallback:true}
   :r.method==='lma.steer'?{...r.params,sessionId:'generation-1',status:mode==='unknown'?'unknown':mode==='target-changed'?'target_changed':'pending',attempted:mode==='unknown',reason:'target_not_ready',ordinaryEligible:!['ineligible','target-changed'].includes(mode)}:originalServer(r);
  const b=await input();
  if(mode==='target-changed')history.inFlightRun={runId:'replacement-root'};
  if(mode==='generation'){session.sessionId='generation-2';history.sessionId='generation-2';history.sessionInfo.sessionId='generation-2';}
  await tick(120_000);expect(h.sends).toHaveLength(0);expect(h.store.isInsertionReserved('Bot','chat',b.row)).toBe(true);noMutation();
 });
 it.each(['unknown','accepted'])('an SDK %s original never becomes a guarded followup after its target disappears',async(state)=>{
  history.inFlightRun={runId:'external-root'};
  intercept=r=>r.method==='lma.steer.capabilities'?{protocol:2,durableAttempts:true,acceptanceCallback:true}
   :r.method==='lma.steer'?{...r.params,sessionId:'generation-1',status:state,attempted:true}:originalServer(r);
  const b=await input();delete history.inFlightRun;await tick(120_000);
  expect(h.sends).toHaveLength(0);expect(item(b.row)).toMatchObject({state,attempted:true});noMutation();
 });
 it.each(['busy','idle'])('normal ancestor leaf advancement during 60s admits B with earliest real guard and never wedges fresh C while %s',async(state)=>{
  const a=await startRoot();await yieldRoot();delete history.inFlightRun;const b=await input();
  history.sessionInfo.activeLeafEntryId='leaf-2';activePathLeaves.add('leaf-2');
  await tick(65_000);expect(h.sends).toHaveLength(2);expect(h.sends[1].expectedLeafEntryId).toBe('leaf-1');
  expect(item(b.row)).toMatchObject({state:'ordinary',admittedRunId:'r2'});
  await final('r2','B after normal ancestor advance');
  if(state==='idle'){session.status='done';session.hasActiveRun=false;history.sessionInfo.hasActiveRun=false;}
  const c=await input('C');if(state==='busy')await admitBounded();
  expect(h.sends).toHaveLength(3);expect(h.sends[2].message).toBe('C');
  await final('r1','A actual late result');await final('r3','C exact result');await a.promise;await b.promise;await c.promise;noMutation();
 });
 it('off-path leaf change is refused by the actual RPC guard response, not guessed from any current-leaf difference',async()=>{
  const b=await input();history.sessionInfo.activeLeafEntryId='leaf-2';activePathLeaves=new Set(['leaf-2']);
  await admitBounded();expect(h.sends).toHaveLength(1);expect(h.sends[0].expectedLeafEntryId).toBe('leaf-1');
  expect(item(b.row)).toMatchObject({state:'target_changed',attempted:false});expect(synced(b.row)).toBe(0);
  expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);
  expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','admission:').some((d:any)=>d.content.includes('input retained'))).toBe(true);noMutation();
 });
 it('an old off-path B refusal does not discard or wedge a newer C with its own genuinely observed leaf',async()=>{
  const a=await startRoot();await yieldRoot();delete history.inFlightRun;const b=await input();
  history.sessionInfo.activeLeafEntryId='leaf-2';activePathLeaves=new Set(['leaf-2']);
  const c=await input('C');await tick(65_000);
  expect(h.sends).toHaveLength(3);expect(h.sends[1]).toMatchObject({message:'B',expectedLeafEntryId:'leaf-1'});
  expect(h.sends[2]).toMatchObject({message:'C',expectedLeafEntryId:'leaf-2'});
  expect(item(b.row)).toMatchObject({state:'target_changed',attempted:false});expect(synced(b.row)).toBe(0);
  expect(item(c.row)).toMatchObject({state:'ordinary',admittedRunId:'r2'});
  await final('r1','A exact retained result');await final('r2','C current branch result');await a.promise;await b.promise;await c.promise;noMutation();
 });
 it('trusted yield releases only local scheduler under guarded busy followup, without settling A',async()=>{
  const a=await startRoot();await yieldRoot();delete history.inFlightRun;
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(2);
  expect(h.store.getRunObservation(h.key,'r1')).toMatchObject({yielded:true,state:'observing'});
  expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');
  await final('r2','B after yield');await final('r1','A actual yield result');await a.promise;await b.promise;
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${a.row}`)?.content).toBe('A actual yield result');noMutation();
 });
});

describe('pre-effect refusal, uncertainty and stop/admission CAS',()=>{
 it.each(['active-leaf-changed','session-changed'])('%s at actual RPC admission: no archive restore/retry, no current-input sync/delete, old A result custody untouched',async(reason)=>{
  const a=await startRoot();delete history.inFlightRun;const b=await input();
  intercept=r=>r.method==='chat.send'?{rpcError:{code:'INVALID_REQUEST',message:'active leaf changed',details:{reason}}}:originalServer(r);
  await admitBounded();expect(h.sends).toHaveLength(2);
  expect(item(b.row)).toMatchObject({state:'target_changed',attempted:false});
  expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);expect(synced(b.row)).toBe(0);
  expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');
  expect(h.store.listAdmissions(h.key)[0].state).toBe('rejected');
  expect(h.store.listDeliveriesByKeyPrefix('Bot','chat','admission:').some((d:any)=>d.content.includes('input retained'))).toBe(true);
  await tick(5*60_000);expect(h.sends).toHaveLength(2);
  await final('r1','A still recoverable');await a.promise;await b.promise;
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${a.row}`)?.content).toBe('A still recoverable');noMutation();
 });
 it('archive changes in client revalidation BEFORE onSendAttempt preserve the newest input and issue no send',async()=>{
  const original=h.client.chatSendWithContext.bind(h.client);
  vi.spyOn(h.client,'chatSendWithContext').mockImplementation(async(p:any)=>{history.sessionInfo.archived=true;return original(p);});
  const b=await input();await admitBounded();
  expect(h.sends).toHaveLength(0);expect(item(b.row)).toMatchObject({state:'target_changed',attempted:false});
  expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);expect(synced(b.row)).toBe(0);noMutation();
 });
 it('an archived RPC refusal with no positive pre-effect receipt remains unknown, never auto-unarchives or resends',async()=>{
  intercept=r=>r.method==='chat.send'?{rpcError:{code:'INVALID_REQUEST',message:'Session is archived'}}:originalServer(r);
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);
  const key=h.sends[0].idempotencyKey;
  expect(item(b.row)).toMatchObject({state:'unknown',attempted:true,admissionSubmissionId:key});
  expect(h.store.listAdmissions(h.key)[0]).toMatchObject({state:'unknown',submissionId:key});
  expect(synced(b.row)).toBe(0);expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(true);
  await tick(5*60_000);expect(h.sends).toHaveLength(1);noMutation();
 });
 it.each(['initial-read','final-read','after-send'])('/stop at %s fences async work and never replays the stopped B',async(phase)=>{
  let release:any,held=false;
  if(phase==='initial-read')intercept=r=>r.method==='chat.history'&&!held?(held=true,new Promise(resolve=>release=()=>resolve(originalServer(r)))):originalServer(r);
  const b=await input();
  if(phase!=='initial-read') {
   if(h.bot.insertionTimer){clearTimeout(h.bot.insertionTimer);h.bot.insertionTimer=undefined;}
   vi.setSystemTime(Date.now()+61_000);
   if(phase==='final-read') {
    const original=h.client.chatSendWithContext.bind(h.client);
    vi.spyOn(h.client,'chatSendWithContext').mockImplementation(async(p:any)=>{
     intercept=r=>r.method==='chat.history'&&!held?(held=true,new Promise(resolve=>release=()=>resolve(originalServer(r)))):originalServer(r);
     return original(p);
    });
   } else intercept=r=>r.method==='chat.send'&&!held?(held=true,new Promise(resolve=>release=()=>resolve(originalServer(r)))):originalServer(r);
   void h.bot.reconcileInsertions('chat');await tick(100);
  }
  expect(release).toBeTypeOf('function');
  const stop=h.bot.handleStopCommand('chat','stop');await tick(100);await stop;
  release();await tick(400);await b.promise;
  expect(h.sends).toHaveLength(phase==='after-send'?1:0);
  expect(item(b.row)?.state || 'stopped').toBe('stopped');
  expect(h.store.getPendingTriggerIds('Bot','chat').has(b.row)).toBe(false);
  await tick(70_000);expect(h.sends).toHaveLength(phase==='after-send'?1:0);
 });
 it('concurrent fresh input owners never duplicate root admission or lose the newer input in the send/ACK window',async()=>{
  let ack:any;intercept=r=>r.method==='chat.send'?new Promise(resolve=>ack=()=>resolve(originalServer(r))):originalServer(r);
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);
  const c=await input('C');await Promise.all([h.bot.reconcileInsertions('chat'),h.bot.reconcileInsertions('chat')]);
  expect(h.sends).toHaveLength(1);expect(h.store.getPendingTriggerIds('Bot','chat').has(c.row)).toBe(true);
  intercept=undefined;ack();await tick(100);idle();await final('r1','B result');await b.promise;
  await tick(70_000);expect(h.sends).toHaveLength(2);expect(h.sends[1].message).toContain('C');expect(h.sends[1].message).not.toContain('B');
  await final('r2','C result');await c.promise;
  expect(h.sends.filter(s=>s.message==='B')).toHaveLength(1);expect(h.sends.filter(s=>s.message==='C')).toHaveLength(1);noMutation();
 });
});

describe('SQLite reopen retains guarded proof and original admission identities',()=>{
 const reopen=async()=>{
  const path=join(h.dir!,'db'),d=mkdtempSync(join(tmpdir(),'lma-followup-reopen-'));dirs.push(d);
  // SQLite backup is a test-only copy of this fixture DB, never a live DB.
  h.client.revokeSessionCollectors(h.key,'fixture process exit');await tick(100);
  h.store['db'].pragma('wal_checkpoint(TRUNCATE)');copyFileSync(path,join(d,'db'));await h.cleanup();h=harness(join(d,'db'));busy();await install();
  return path;
 };
 it('never-attempted bounded proof survives reopen; simultaneous startup reconcilers admit once',async()=>{
  const b=await input();await reopen();await tick(61_000);
  const drains=[h.bot.drainOnStartup(),h.bot.reconcileInsertions('chat'),h.bot.processQueue('chat')];await tick(100);
  expect(h.sends).toHaveLength(1);expect(h.sends[0]).toMatchObject({sessionId:'generation-1',expectedLeafEntryId:'leaf-1',queueMode:'followup'});
  await final('r1','reopened B result');await Promise.all(drains);expect(item(b.row).admittedRunId).toBe('r1');noMutation();
 });
 it.each(['accepted','unknown'])('%s guarded original is never sent again with a new ID after reopen',async(outcome)=>{
  intercept=r=>r.method==='chat.send'&&outcome==='unknown'?{rpcError:{code:'UNAVAILABLE',message:'outcome uncertain'}}:originalServer(r);
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);const key=h.sends[0].idempotencyKey;
  await reopen();await h.bot.ensureSession('chat');
  const drain=h.bot.drainOnStartup();await tick(100);await drain;await tick(120_000);
  expect(h.sends).toHaveLength(0);
  expect(h.store.listAdmissions(h.key).some((r:any)=>r.submissionId===key)).toBe(true);
  if(outcome==='unknown') {
   expect(item(b.row)).toMatchObject({state:'unknown',attempted:true,admissionSubmissionId:key});
   expect(requests.some(r=>r.method==='agent.wait'&&r.params.runId===key)).toBe(true);
  }
  noMutation();
 });
 it('detached admitted scheduler after reopen allows guarded B while exact A result recovery remains',async()=>{
  const a=await startRoot();delete history.inFlightRun;await reopen();
  const b=await input();await admitBounded();expect(h.sends).toHaveLength(1);expect(h.sends[0].message).toBe('B');
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  expect(h.store.getReactionIntent('Bot','chat',a.row).desired).toBe('Get');
  expect(h.store.getDeliveryRunTarget('Bot','chat','r1').triggerId).toBe(a.row);
  expect(h.store.getDeliveryRunTarget('Bot','chat','r2').triggerId).toBe(b.row);
  await final('r1','A durable exact result');await final('r2','B result after restart');await b.promise;
  expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${a.row}`)?.content).toBe('A durable exact result');noMutation();
 });
});
