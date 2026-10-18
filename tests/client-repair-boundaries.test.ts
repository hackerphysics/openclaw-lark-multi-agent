import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const message=(text:string)=>({role:'assistant',content:[{type:'text',text}],stopReason:'stop'});
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
const agent=(stream:string,data:any,runId='r1')=>wire('agent',{runId,stream,data});
const final=(text='exact delayed final',runId='r1')=>{wire('chat',{runId,state:'final',message:message(text)});agent('lifecycle',{phase:'end',livenessState:'working'},runId);};
const observed=(p:Promise<any>)=>{const s:any={};p.then(text=>s.text=text,error=>s.error=error);return s;};
const send=async(extra:any={})=>{const s=observed(h.client.chatSend({sessionKey:h.key,message:'root input',...extra}));await tick();return s;};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T11:20:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 h=harness();const p=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await p;
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
const terminal=(disposition:string,text?:string)=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition,text}});
describe('B3 terminal authority, never transcript/draft heuristics',()=>{
 it.each(['working','cancelled','abandoned'])('lifecycle %s queries exact authority; short visible beats long preface',async(livenessState)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?terminal('visible','OK'):base(m,p));const s=await send();
  agent('assistant',{delta:'LONG UNVERIFIED PREFACE '.repeat(8)});agent('lifecycle',{phase:'end',livenessState});await tick();expect(s.text).toBe('OK');
 });
 it.each(['silent','empty'])('five-second empty chat fallback honors %s, even with lone N and discussion option',async(disposition)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?terminal(disposition):base(m,p));const s=await send({emptyFinalAsNoReply:true});
  agent('assistant',{delta:'N'});wire('chat',{runId:'r1',state:'final',message:message('')});await tick(5100);expect(s.text).toBe('NO_REPLY');
 });
 it.each([
  {status:'pending'}, {status:'ok',terminalReply:{disposition:'pending'}}, {status:'ok',terminalReply:{disposition:'visible',text:''}},
  {status:'ok',terminalReply:{disposition:'visible',text:'x'},yielded:true}, {status:'ok',terminalReply:{disposition:'empty'},pendingError:true},
  {status:'ok',runId:'foreign',terminalReply:{disposition:'empty'}}, {status:'timeout',timeoutPhase:'queue'}, {status:'timeout',timeoutPhase:'gateway_draining'},
 ])('unconfirmed exact snapshot %j retains observation and delayed final',async(fields)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:'r1',endedAt:Date.now(),...fields}:base(m,p));const s=await send({emptyFinalAsNoReply:true});
  agent('assistant',{delta:'N'});agent('lifecycle',{phase:'end',livenessState:'working'});wire('chat',{runId:'r1',state:'final',message:message('')});await tick(5500);
  expect(s).toEqual({});expect(h.store.runObservationState(h.key,'r1')).toBe('observing');final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it('commentary transcript plus lifecycle without committed terminal never authorizes a body',async()=>{
  const s=await send();wire('session.message',{runId:'r1',message:{role:'assistant',channel:'commentary',content:[{type:'text',text:'checking now'}]}});agent('lifecycle',{phase:'end',livenessState:'working'});await tick(5500);expect(s).toEqual({});final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
});
const PRIVATE='PRIVATE CHILD COORDINATION BODY';
const shapes=[
 ['sessions_spawn',{task:PRIVATE,label:'safe-worker'}],['functions.sessions_spawn',JSON.stringify({prompt:PRIVATE})],
 ['core.sessions_send',{message:PRIVATE}],['functions.sessions_yield',{message:PRIVATE}],
 ['functions.tool_call',{id:'sessions_spawn',args:JSON.stringify({task:PRIVATE})}],
 ['multi_tool_use.parallel',{tool_uses:[{recipient_name:'functions.sessions_yield',parameters:{message:PRIVATE}}]}],
 ['functions.tool_call',{id:'multi_tool_use.parallel',args:{tool_uses:[{recipient_name:'functions.tool_call',parameters:{id:'core.sessions_send',args:{message:PRIVATE}}}]}}],
 ['multi_tool_use.parallel',JSON.stringify({tool_uses:[{recipient_name:'functions.read',parameters:{path:'safe.txt'}},{recipient_name:'functions.tool_call',parameters:{id:'sessions_spawn',args:{prompt:PRIVATE}}}]})],
] as const;
describe('C1 recursive coordination privacy before every sink',()=>{
 it.each(shapes)('redacts %s start + result/error + legacy/command mirrors',async(name,input)=>{
  const progress=vi.fn(),verbose=vi.fn(),evidence=vi.fn();h.client.onToolEvent(h.key,verbose);h.client.observeGoEvidence(evidence);const s=await send({onProgress:progress});
  agent('tool',{name,phase:'start',toolCallId:'private-call',input});
  agent('tool',{name:'tool',phase:'result',toolCallId:'private-call',result:PRIVATE});
  agent('item',{kind:'tool',phase:'error',itemId:'tool:private-call',name:'tool',output:{message:PRIVATE},error:PRIVATE});
  process.env.OPENCLAW_LARK_MULTI_AGENT_VERBOSE_FULL='1';try{agent('command_output',{itemId:'command:private-call',text:PRIVATE});}finally{delete process.env.OPENCLAW_LARK_MULTI_AGENT_VERBOSE_FULL;}
  const all=JSON.stringify([[...h.client.agentEvents.values()],progress.mock.calls,verbose.mock.calls,evidence.mock.calls,(console.log as any).mock.calls]);
  expect(all).not.toContain(PRIVATE);expect(all).toContain(name);expect(progress.mock.calls.some(([e]:any)=>e.kind==='tool')).toBe(true);
  final(`Model may quote ${PRIVATE}`);await tick(50);expect(s.text).toBe(`Model may quote ${PRIVATE}`);
 });
 it('private transcript tool-call and tool-result mirrors are redacted without deleting model text quotes',async()=>{
  const progress=vi.fn(),evidence=vi.fn();h.client.observeGoEvidence(evidence);const s=await send({onProgress:progress});
  wire('session.message',{runId:'r1',message:{role:'assistant',content:[{type:'toolCall',id:'transcript-spawn',name:'sessions_spawn',arguments:{task:PRIVATE}}]}});
  wire('session.message',{runId:'r1',message:{role:'toolResult',toolCallId:'transcript-spawn',toolName:'sessions_spawn',content:[{type:'text',text:PRIVATE}]}});
  expect(JSON.stringify([[...h.client.agentEvents.values()],progress.mock.calls,evidence.mock.calls,(console.log as any).mock.calls])).not.toContain(PRIVATE);
  final(`Quoted model text: ${PRIVATE}`);await tick(50);expect(s.text).toBe(`Quoted model text: ${PRIVATE}`);
 });
 it('an orphan generic result cannot expose private body; correlated public generic read remains useful',async()=>{
  const progress=vi.fn(),verbose=vi.fn();h.client.onToolEvent(h.key,verbose);const s=await send({onProgress:progress});
  agent('tool',{name:'functions.tool_call',phase:'result',toolCallId:'orphan',result:PRIVATE});
  agent('tool',{name:'functions.tool_call',phase:'start',toolCallId:'safe',input:{id:'functions.read',args:{path:'wrapped-safe.txt'}}});
  agent('tool',{name:'functions.tool_call',phase:'result',toolCallId:'safe',result:'PUBLIC WRAPPED READ RESULT'});
  expect(JSON.stringify([progress.mock.calls,verbose.mock.calls,[...h.client.agentEvents.values()]])).not.toContain(PRIVATE);
  expect(JSON.stringify(progress.mock.calls)).toContain('wrapped-safe.txt');expect(JSON.stringify(verbose.mock.calls)).toContain('PUBLIC WRAPPED READ RESULT');
  final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it('canonical read path and tool result remain visible and run/id privacy cannot bleed into a different run',async()=>{
  const progress=vi.fn(),verbose=vi.fn();h.client.onToolEvent(h.key,verbose);const s=await send({onProgress:progress});
  agent('tool',{name:'sessions_spawn',phase:'start',toolCallId:'shared-id',input:{task:PRIVATE}},'foreign');
  agent('tool',{name:'functions.read',phase:'start',toolCallId:'shared-id',input:{path:'safe-file.txt'}});
  agent('tool',{name:'read',phase:'result',toolCallId:'shared-id',result:'public read output'});
  expect(JSON.stringify(progress.mock.calls)).toContain('safe-file.txt');expect(JSON.stringify(verbose.mock.calls)).toContain('public read output');final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
});
describe('C2 session+run presentation custody',()=>{
 it('foreign lifecycle end cannot flush or clear current narration; later same-root tool flushes it',async()=>{
  const progress=vi.fn();const s=await send({onProgress:progress});agent('assistant',{delta:'CURRENT ROOT NOTE'});agent('assistant',{delta:'FOREIGN NOTE'},'foreign');agent('lifecycle',{phase:'end'},'foreign');
  expect(JSON.stringify(progress.mock.calls)).not.toContain('FOREIGN NOTE');expect(JSON.stringify(progress.mock.calls)).not.toContain('CURRENT ROOT NOTE');
  agent('tool',{name:'read',phase:'start',toolCallId:'r',input:{path:'safe.txt'}});expect(JSON.stringify(progress.mock.calls)).toContain('CURRENT ROOT NOTE');expect(JSON.stringify(progress.mock.calls)).not.toContain('FOREIGN NOTE');final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it('reused tool call id in a foreign run cannot suppress current root progress',async()=>{
  const progress=vi.fn();const s=await send({onProgress:progress});agent('tool',{name:'read',phase:'start',toolCallId:'same',input:{path:'foreign.txt'}},'foreign');agent('tool',{name:'read',phase:'start',toolCallId:'same',input:{path:'root.txt'}});
  expect(JSON.stringify(progress.mock.calls)).toContain('root.txt');expect(JSON.stringify(progress.mock.calls)).not.toContain('foreign.txt');final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it('public runtime continuation mapped to admitted root retains its progress, uncorrelated lifecycle start does not',async()=>{
  const progress=vi.fn();const s=await send({onProgress:progress});agent('lifecycle',{phase:'start'},'unproven');agent('assistant',{delta:'UNPROVEN NOTE'},'unproven');agent('tool',{name:'read',phase:'start',toolCallId:'unproven'},'unproven');
  agent('lifecycle',{phase:'start'});agent('assistant',{delta:'PUBLIC ROOT CONTINUATION'});agent('tool',{name:'read',phase:'start',toolCallId:'continuation'});
  expect(JSON.stringify(progress.mock.calls)).not.toContain('UNPROVEN NOTE');expect(JSON.stringify(progress.mock.calls)).toContain('PUBLIC ROOT CONTINUATION');final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
});
describe('B5 non-destructive observer and admission boundaries',()=>{
 it('failed replacement admission retains old callback, narration and exact final',async()=>{
  const progress=vi.fn(),old=await send({onProgress:progress});agent('assistant',{delta:'OLD STILL LEGITIMATE'});const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>{if(m==='chat.send')throw new Error('RPC error: rejected');return base(m,p);});
  const next=await send();expect(next.error).toBeDefined();agent('tool',{name:'read',phase:'start',toolCallId:'old'});expect(JSON.stringify(progress.mock.calls)).toContain('OLD STILL LEGITIMATE');final();await tick(50);expect(old.text).toBe('exact delayed final');
 });
 it('two live observers cannot consume each other terminal frames, including no run identity',async()=>{
  const a=observed(h.client.collectReply('a',600000,h.key)),b=observed(h.client.collectReply('b',600000,h.key));
  agent('lifecycle',{phase:'start'},'b');wire('chat',{state:'final',message:message('UNIDENTIFIED')});final('B','b');final('A','a');await tick(50);expect(a.text).toBe('A');expect(b.text).toBe('B');expect(h.client.agentEvents.get(h.key).some((e:any)=>!e.runId)).toBe(true);
 });
});
describe('B6 canonical complete dispatch proof',()=>{
 it.each(['queued','incomplete','generation-changed','archived','page2-queued'])('does not release after weak hasActiveRun false: %s',async(mode)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{runId:'r1',status:'started',sessionId:'generation-1'}:m==='chat.history'?{
   sessionKey:h.key,sessionInfo:{sessionId:mode==='generation-changed'?'generation-2':'generation-1',hasActiveRun:false,archived:mode==='archived'},
   pendingInputs:mode==='queued'?{total:1,items:[{id:'q',state:'queued'}]}:mode==='incomplete'?{total:1,items:[]}:mode==='page2-queued'?(p.pendingBefore?{total:2,items:[{id:'q',state:'queued'}]}:{total:2,items:[{id:'i',state:'interrupted'}],nextBefore:100}):{total:0,items:[]}
  }:base(m,p));const s=await send();await h.client.runStateChecks.get(h.key)();await tick();expect(s).toEqual({});expect(h.client.eventCollectors.size).toBe(1);final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it('complete same-generation no-queue proof can release local phantom without abort/replay',async()=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0,items:[]}}:base(m,p));
  const s=await send();await h.client.runStateChecks.get(h.key)();await tick();expect(s.error?.name).toBe('InactiveRunObservation');expect(h.sends).toHaveLength(1);expect(h.client.rpc.mock.calls.some(([m]:any)=>m==='chat.abort')).toBe(false);
 });
});
describe('A5 timeout is observation loss, not execution failure',()=>{
 it.each(['chatError','lifecycle','generic-chat-error'])('timeout with unknown runtime retains exact observation: %s',async(mode)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='sessions.describe'?{}:base(m,p));const notice=vi.fn(),s=await send({onWaitPaused:notice});agent('assistant',{delta:'NOT FINAL'});
  if(mode==='chatError')wire('chat',{runId:'r1',state:'error',errorMessage:'RPC timeout'});else if(mode==='lifecycle')agent('lifecycle',{phase:'error',error:'RPC timeout'});else wire('chat',{runId:'r1',state:'error'});
  await tick(500);expect(s).toEqual({});expect(notice).toHaveBeenCalledTimes(1);expect(h.store.runObservationState(h.key,'r1')).toBe('observing');expect(h.sends).toHaveLength(1);expect(h.client.rpc.mock.calls.some(([m]:any)=>m==='chat.abort')).toBe(false);
  final();await tick(50);expect(s.text).toBe('exact delayed final');
 });
 it.each(['error','timeout'])('exact recorded root %s still rejects, even while a successor is running',async(status)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:'r1',status,endedAt:Date.now(),error:'exact root execution exhausted'}:base(m,p));const s=await send();agent('lifecycle',{phase:'end',livenessState:'working'});await tick();expect(s.error?.message).toContain('exact root execution exhausted');expect(h.client.rpc.mock.calls.some(([m]:any)=>m==='chat.abort')).toBe(false);
 });
});
