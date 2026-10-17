import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness,event} from './helpers/reliability-harness.js';
import {OpenClawClient} from '../src/openclaw-client.js';
import {MessageStore} from '../src/message-store.js';
import {FeishuBot} from '../src/feishu-bot.js';
let h:any,log:any,warn:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const record=(_caseName:string,_value:any)=>{};
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
const agent=(data:any,runId='r1',stream='tool')=>wire('agent',{runId,stream,data});
const toolStart=(id='t1',message='tool requested text.',extra:any={},runId='r1')=>agent({name:'message',toolCallId:id,phase:'start',input:{action:'send',message,...extra}},runId);
const toolEnd=(id='t1',output:any={terminate:true},extra:any={},runId='r1')=>agent({name:'message',toolCallId:id,phase:'result',output,...extra},runId);
const final=(text='trusted exact final.',runId='r1',channel='both')=>{
 if(channel!=='session')wire('chat',{runId,state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 if(channel!=='chat')wire('session.message',{runId,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 agent({phase:'end',livenessState:'working'},runId,'lifecycle');
};
const connect=async(c:any=h.client)=>{const p=c._doConnect();c.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await p;};
const send=async()=>{const state:any={};const promise=h.client.chatSend({sessionKey:h.key,message:'original input',onWaitPaused:vi.fn()}).then((text:any)=>{state.text=text;return text;},(err:any)=>{state.error=err.name;return err;});await tick();return {state,promise};};
const assertActive=(state:any)=>expect(state).toEqual({});
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T07:00:00Z'));log=vi.spyOn(console,'log').mockImplementation(()=>{});warn=vi.spyOn(console,'warn').mockImplementation(()=>{});h=harness();await connect();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

it.each(['running','missing-terminal','unknown-disposition'])('P1 tool flag is not root terminal: %s',async(mode)=>{
 const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'&&mode!=='running'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:mode==='unknown-disposition'?{disposition:'future'}:undefined}:base(m,p));
 const s=await send();toolStart();toolEnd();await h.client.runStateChecks.get(h.key)();await tick(10_100);
 record(mode,{...s.state,rootQueries:h.client.rpc.mock.calls.filter(([m]:any)=>m==='agent.wait').length,observation:h.store.runObservationState(h.key,'r1')});assertActive(s.state);
 
});
it('P1 isError result still triggers success',async()=>{const s=await send();toolStart();toolEnd('t1',{terminate:true},{isError:true,error:'permission denied'});await tick(10_100);record('isError',{...s.state});assertActive(s.state);});
it.each(['read','react','delete'])('P1 no action=send validation: %s',async(action)=>{const s=await send();toolStart('t1','tool requested text.',{action});toolEnd();await tick(10_100);record(`action-${action}`,s.state);assertActive(s.state);});
it('P1 no matching start or toolCallId is required',async()=>{const s=await send();toolEnd('no-start');await tick(10_100);record('orphan-result',s.state);expect(s.state).toEqual({});});
it.each(['parallel','sequential','later-nonterminating'])('P1 send text is one mutable slot: %s',async(mode)=>{const s=await send();toolStart('A','A exact intended text.');if(mode==='sequential')toolEnd('A',{delivered:true});if(mode==='later-nonterminating')toolEnd('A');toolStart('B','B unrelated private text.');if(mode==='later-nonterminating')toolEnd('B',{delivered:true});else toolEnd('A');await tick(10_100);record(`text-slot-${mode}`,s.state);expect(s.state).toEqual({});});
it('P1 assistant draft takes priority over captured send text',async()=>{const s=await send();agent({delta:'interim unverified draft.'},'r1','assistant');toolStart();toolEnd();await tick(10_100);record('draft-priority',s.state);expect(s.state).toEqual({});});
it('P1 continuation/foreign tool bypasses exact-root final gate',async()=>{const s=await send();wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'original input'}]}});agent({phase:'start'},'foreign','lifecycle');toolStart('F','foreign unrelated output.',{},'foreign');toolEnd('F',{terminate:true},{},'foreign');await tick(10_100);record('foreign-adopted-run',s.state);expect(s.state).toEqual({});});
it('P1 even a missing runId message result may close the root',async()=>{const s=await send();wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'original input'}]}});wire('agent',{stream:'tool',data:{name:'message',phase:'start',input:{message:'no run output.'}}});wire('agent',{stream:'tool',data:{name:'message',phase:'result',output:{terminate:true}}});await tick(10_100);record('no-run-id',s.state);expect(s.state).toEqual({});});
it('P1 ongoing root tool progress does not cancel the 10s deadline',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);agent({name:'exec',toolCallId:'long',phase:'start'});await tick(1100);record('progress-after-terminate',s.state);assertActive(s.state);});
it('P1 confirmed yield does not cancel the 10s deadline',async()=>{const s=await send();toolStart();toolEnd();await tick(5000);wire('chat',{runId:'r1',state:'final',yielded:true,message:{role:'assistant',content:[]}});await tick(5100);record('yield-after-terminate',s.state);assertActive(s.state);});
it('P1 WS loss is still followed by success timer with no root evidence',async()=>{const s=await send();toolStart();toolEnd();h.client.shouldReconnect=false;h.client.ws.emit('close');await tick(10_100);record('wire-disconnected',{...s.state,connected:h.client.connected});assertActive(s.state);});

it.each([false,true])('NORMAL nested mentions/nonterminate do not trigger (item=%s)',async(item)=>{const s=await send();const stream=item?'item':'tool';agent({kind:'tool',name:'message',phase:'start',input:{action:'read'}},'r1',stream);agent({kind:'tool',name:'message',phase:'result',output:{content:[{text:'terminate=true'}],ok:false}},'r1',stream);await tick(10_100);expect(s.state).toEqual({});final();await tick(50);expect(s.state.text).toBe('trusted exact final.');});
it('NORMAL a known foreign user run cannot close root',async()=>{const s=await send();wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'original input'}]}});wire('session.message',{runId:'foreign',message:{role:'user',content:[{type:'text',text:'different user input'}]}});agent({phase:'start'},'foreign','lifecycle');toolStart('F','foreign.',{},'foreign');toolEnd('F',{terminate:true},{},'foreign');await tick(10_100);expect(s.state).toEqual({});final();await tick(50);expect(s.state.text).toBe('trusted exact final.');});
it('NORMAL trusted final before 10s wins and cleans all observation timers',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);final('trusted earlier final.');await tick(50);expect(s.state.text).toBe('trusted earlier final.');expect(h.client.eventCollectors.size).toBe(0);expect(h.client.sessionCollectorFences.size).toBe(0);await tick(2000);expect(s.state.text).toBe('trusted earlier final.');});
it('NORMAL real root error before timer rejects, does not publish send text',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);agent({phase:'error',error:'provider authentication rejected'},'r1','lifecycle');await tick(1100);expect(s.state.error).toBe('Error');expect(s.state.text).toBeUndefined();});
it('NORMAL exact terminalReply before timer preserves silent disposition',async()=>{const s=await send();toolStart();toolEnd();const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'silent'}}:base(m,p));await h.client.runStateChecks.get(h.key)();await tick(10_100);expect(s.state.text).toBe('NO_REPLY');});
it('NORMAL revoke fences timer and hands final to proactive same tick',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);const proactive=vi.fn();h.client.sessionMessageCallbacks.set(h.key,proactive);h.client.revokeSessionCollectors(h.key,'test fence');await tick(2100);expect(s.state.error).toBe('SupersededObservation');expect(s.state.text).toBeUndefined();final();await tick(50);expect(proactive).toHaveBeenCalledTimes(1);expect(proactive.mock.calls[0][0]).toBe('trusted exact final.');});
it('NORMAL explicit disconnect fences timer; SQLite reopen waits for real terminal only',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);const path=join(h.dir,'db');await h.client.disconnect();await tick(2100);expect(s.state.error).toBe('SupersededObservation');expect(h.store.runObservationState(h.key,'r1')).toBe('observing');h.store.close();h.store=new MessageStore(path);const c:any=new OpenClawClient({baseUrl:'ws://offline',token:'test'});c.bindRecoveryStore(h.store);const cb=vi.fn();c.sessionMessageCallbacks.set(h.key,cb);c.rpc=vi.fn(async()=>({runId:'r1',status:'timeout'}));await c.recoverExactRuns();expect(cb).not.toHaveBeenCalled();c.rpc=vi.fn(async()=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'restart trusted final.'}}));h.store.db.prepare('UPDATE run_observations SET next_check_at=0').run();await c.recoverExactRuns();expect(cb).toHaveBeenCalledWith('restart trusted final.',expect.objectContaining({runId:'r1',final:true}));await c.disconnect();});

const startBot=async()=>{const p=h.bot.handleMessage(event('A'));await tick();expect(h.sends).toHaveLength(1);return p;};
const snapshotBot=()=>({busy:h.bot.busyChats.get('chat'),queueOwner:h.bot.queueRuns.has('chat'),reaction:h.store.getReactionIntent('Bot','chat',h.store.getMessageId('A')),observation:h.store.runObservationState(h.key,'r1'),delivery:h.store.getDeliveryByKey('Bot','chat','trigger:1'),context:h.store.getRecent('chat').filter((m:any)=>m.senderType==='bot').map((m:any)=>m.content),cardDone:h.bot.patchLiveStatusCard.mock.calls.some((a:any[])=>a[1]?.state==='done')});
it.each(['final','error'])('P1 REAL FeishuBot preserves custody until an exact late %s',async(late)=>{
 const p=h.bot.handleMessage(event('A')); await tick(); toolStart(); toolEnd(); await tick(10_300);
 const first=snapshotBot(); record('bot-before-exact-terminal',first);
 expect(first.queueOwner).toBe(true);
 
  expect(first.observation).toBe('observing'); expect(first.reaction.desired).toBe('Get');
  expect(first.context).toEqual([]); expect(first.delivery).toBeFalsy(); expect(first.cardDone).toBe(false);
  // Do not await an intentionally active batch before supplying terminal evidence.
  if(late==='final') final('real late exact final.');
  else agent({phase:'error',error:'provider authentication rejected'},'r1','lifecycle');
  await tick(350); await p; const after=snapshotBot(); record(`bot-after-exact-${late}`,after);
  expect(after.queueOwner).toBe(false); expect(after.context).not.toContain('tool requested text.');
  if(late==='final') {
   expect(after.context).toEqual(['real late exact final.']); expect(after.delivery.status).toBe('delivered');
   expect(after.reaction.desired).toBe('DONE'); expect(after.cardDone).toBe(true);
  } else {
   expect(after.context).toEqual([]); expect(after.delivery).toBeFalsy();
   const failure=h.store.getDeliveryByKey('Bot','chat','trigger:1:provider-error');
   expect(failure?.status).toBe('delivered'); expect(failure?.content).toContain('供应商认证失败'); expect(failure?.content).not.toContain('tool requested text.');
  }
  return;
 });
it('P1 accepted insertion stays Get until exact root settlement',async()=>{
 const p=h.bot.handleMessage(event('A')); await tick();
 h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'accepted',attempted:true,sessionId:'generation-1'}));
 await h.bot.handleMessage(event('B')); await tick(); const row=h.store.getMessageId('B');
 expect(h.store.getInsertion('Bot','chat',row).state).toBe('accepted');
 toolStart(); toolEnd(); await tick(10_300);
 const state=h.store.getInsertion('Bot','chat',row).state; record('accepted-before-root-terminal',{state,reaction:h.store.getReactionIntent('Bot','chat',row)});
 expect(state).toBe('accepted');
 
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('Get');
  expect(snapshotBot().queueOwner).toBe(true); expect(snapshotBot().context).toEqual([]);
  final('trusted root result for both inputs.'); await tick(350); await p;
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('committed');
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');
  expect(snapshotBot().context).toEqual(['trusted root result for both inputs.']); expect(h.sends).toHaveLength(1);return;
 });
it('P1 SQLite restart retains unresolved root and recovers only its authoritative result',async()=>{
 const p=h.bot.handleMessage(event('A')); await tick(); toolStart(); toolEnd(); await tick(10_300);
 
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  expect(snapshotBot().queueOwner).toBe(true); expect(snapshotBot().context).toEqual([]);
  // Process-local observation is explicitly closed; this is not root success.
  await h.client.disconnect(); await tick(350); await p;
  expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
  const path=join(h.dir,'db'); h.store.close(); h.store=new MessageStore(path);
  const c:any=new OpenClawClient({baseUrl:'ws://offline',token:'test'}); c.bindRecoveryStore(h.store);
  const cb=vi.fn(); c.sessionMessageCallbacks.set(h.key,cb);
  try {
   c.rpc=vi.fn(async()=>({runId:'r1',status:'timeout'}));
   h.store.db.prepare('UPDATE run_observations SET next_check_at=0').run(); await c.recoverExactRuns();
   expect(cb).not.toHaveBeenCalled(); expect(h.store.runObservationState(h.key,'r1')).toBe('observing');
   c.rpc=vi.fn(async()=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'real exact result after restart.'}}));
   h.store.db.prepare('UPDATE run_observations SET next_check_at=0').run(); await c.recoverExactRuns();
   expect(c.rpc).toHaveBeenCalledWith('agent.wait',expect.objectContaining({runId:'r1'}),expect.any(Number));
   expect(cb).toHaveBeenCalledTimes(1);
   expect(cb).toHaveBeenCalledWith('real exact result after restart.',expect.objectContaining({runId:'r1',final:true}));
   expect(h.sends).toHaveLength(1);
  } finally {await c.disconnect();}
  return;
 });
it('P1 real late final after owned grace cannot correct the synthetic trigger owner',async()=>{h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);const p=h.bot.handleMessage(event('A'));await tick();toolStart();toolEnd();await tick(41_000);const before=snapshotBot();expect(h.client.ownedDeliveryRuns.has('r1')).toBe(true);final('real trusted final after grace.');await tick(300);await p;const after=snapshotBot();record('late-after-owned-grace',{before,after});expect(after.context).toEqual(['real trusted final after grace.']);});
it('NORMAL explicit stop cancels pending terminate timer without late success',async()=>{const s=await send();toolStart();toolEnd();await tick(9000);await h.client.abortChat(h.key);await tick(1100);expect(s.state.error).toBe('SupersededObservation');expect(s.state.text).toBeUndefined();expect(h.store.runObservationState(h.key,'r1')).toBe('stopped');});
it('NORMAL unknown insertion is not falsely acknowledged or replayed when the root really settles',async()=>{
 const p=h.bot.handleMessage(event('A'));await tick();
 h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'unknown',attempted:true,sessionId:'generation-1'}));
 await h.bot.handleMessage(event('B'));await tick();toolStart();toolEnd();await tick(10_300);
 const row=h.store.getMessageId('B');expect(h.store.getInsertion('Bot','chat',row).state).toBe('unknown');
 expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');expect(h.sends).toHaveLength(1);
 
  expect(snapshotBot().queueOwner).toBe(true);expect(snapshotBot().context).toEqual([]);
  final('trusted result for original root.');await tick(350);
 
 await p;
 expect(h.store.getInsertion('Bot','chat',row).state).toBe('unknown');expect(h.sends).toHaveLength(1);
 expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','Get');expect(h.bot.addReaction).not.toHaveBeenCalledWith('B','DONE');
});
