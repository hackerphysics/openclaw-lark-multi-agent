import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {harness,event} from './helpers/reliability-harness.js';
import {FeishuBot} from '../src/feishu-bot.js';
import {LiveStatusController} from '../src/live-status.js';
let h:ReturnType<typeof harness>;const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T02:00:00Z'));h=harness();});
afterEach(async()=>{process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY='0';await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('independent lifecycle correctness contracts (positive assertions)',()=>{
 it('R-L1 recovery query returning after stop must not emit old visible final',async()=>{
  h.store.saveRunObservation(h.key,'old',{sessionId:'s1'});let resolve:any;const base=h.client.rpc;
  const delivered=vi.fn();h.client.sessionMessageCallbacks.set(h.key,delivered);
  h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?await new Promise(r=>resolve=r):base(m,p));
  const recovery=h.client.recoverExactRuns();await tick();await h.client.abortChat(h.key);
  expect(h.store.runObservationState(h.key,'old')).toBe('stopped');
  resolve({runId:'old',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'must not revive'}});await recovery;
  expect(delivered).not.toHaveBeenCalled();
 });
 it('R-L1b real bridge recovered callback must not create a stopped trigger outbox after late query',async()=>{
  const input=h.bot.handleMessage(event('A'));await tick();h.client.revokeSessionCollectors(h.key,'handoff');await tick();await input;
  await (FeishuBot.prototype as any).ensureSession.call(h.bot,'chat');
  let resolve:any;const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?await new Promise(r=>resolve=r):base(m,p));
  h.store.saveRunObservation(h.key,'r1',{},Date.now());const recovery=h.client.recoverExactRuns();await tick();await h.bot.handleStopCommand('chat','stop');
  resolve({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'late stopped actual bridge result'}});await recovery;await tick();
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();expect(h.store.runObservationState(h.key,'r1')).toBe('stopped');
 });
 it('R-L2 exact error after process restart must settle and route actual error rather than query forever',async()=>{
  h.store.saveRunObservation(h.key,'old',{sessionId:'s1'});const delivered=vi.fn();h.client.sessionMessageCallbacks.set(h.key,delivered);
  h.client.rpc=vi.fn(async()=>({runId:'old',status:'error',endedAt:Date.now(),error:'upstream real execution failure'}));
  await h.client.recoverExactRuns();
  expect(delivered).toHaveBeenCalledWith(expect.stringContaining('upstream real execution failure'),expect.objectContaining({sourceType:'run_error',runId:'old'}));
  expect(h.store.listRunObservations(undefined,Number.MAX_SAFE_INTEGER)).toHaveLength(0);
 });
 it('R-L3 exact silent after process restart must settle the original Get reaction without emitting business text',async()=>{
  const pending=h.bot.handleMessage(event('A'));await tick();h.client.revokeSessionCollectors(h.key,'simulate process exit');await tick();await pending;
  h.client.releasePausedWait('r1');h.store.saveRunObservation(h.key,'r1',{},Date.now());
  const delivered=vi.fn();h.client.sessionMessageCallbacks.set(h.key,delivered);
  h.client.rpc=vi.fn(async()=>({runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'silent'}}));
  await h.client.recoverExactRuns();await tick();
  expect(delivered).not.toHaveBeenCalled();expect(h.store.listRunObservations(undefined,Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  expect(h.store.getReactionIntent('Bot','chat',h.store.getMessageId('A')!).desired).toBe('DONE');
 });
 it('R-L4 foreign assistant delta cannot be promoted by original root lifecycle end',async()=>{
  const input=h.bot.handleMessage(event('A'));await tick();
  h.frame('r1','sessionUser',{text:'A'});h.frame('foreign','lifecycle',{phase:'start'});h.frame('foreign','assistant',{delta:'FOREIGN PRIVATE ANSWER'});
  h.frame('r1','lifecycle',{phase:'end',livenessState:'working'});await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeNull();
  h.final('r1','own final');await tick(300);await input;
 });
 it('R-L5 stop during Get API await must not checkpoint the stale Get as shown',async()=>{
  let release:any;h.bot.addReaction=vi.fn(async(_m:string,e:string)=>{if(e==='Get')await new Promise(r=>release=r);return 'own-reaction';});
  const pending=h.bot.handleMessage(event('A'));await tick();expect(release).toBeTypeOf('function');
  await h.bot.handleStopCommand('chat','stop');release();await tick();await pending;
  const r=h.store.getReactionIntent('Bot','chat',h.store.getMessageId('A')!);
  expect(r.desired).toBe('');expect(r.shown).not.toBe('Get');
 });
 it('R-L6 deleting previous emoji must select this app reaction, not the first other member',async()=>{
  const deleted:any[]=[];h.bot.botOpenId='own-bot';
  h.bot.client.im.messageReaction={list:vi.fn(async()=>({code:0,data:{items:[
   {reaction_id:'other-id',reaction_type:{emoji_type:'Typing'},operator:{operator_type:'user',operator_id:'other-user'}},
   {reaction_id:'own-id',reaction_type:{emoji_type:'Typing'},operator:{operator_type:'app',operator_id:'own-bot'}}],has_more:false}})),
   delete:vi.fn(async(p:any)=>{deleted.push(p.path.reaction_id);return {code:p.path.reaction_id==='own-id'?0:230002};})};
  await (FeishuBot.prototype as any).removeReaction.call(h.bot,'A','Typing').catch(()=>{});
  expect(deleted).toEqual(['own-id']);
 });
 it('R-L7 stop must tombstone every persisted observation, not only the first query page',async()=>{
  for(let i=0;i<65;i++)h.store.saveRunObservation(h.key,`historical-${i}`,{});
  await h.client.abortChat(h.key);expect(h.store.listRunObservations(h.key,Number.MAX_SAFE_INTEGER,100)).toHaveLength(0);
 });
 it('R-L8 silent exact query without a UI callback keeps 25h custody until real final',async()=>{
  h.client.connected=true;
  const promise=h.client.chatSend({sessionKey:h.key,message:'long direct'}).then((text:string)=>({text}),(error:any)=>({error}));await tick();
  let settled=false;void promise.then(()=>settled=true);await tick(25*60*60_000);expect(settled).toBe(false);
  expect(h.client.eventCollectors.size).toBe(1);expect(vi.getTimerCount()).toBeLessThan(10);
  h.final('r1','late direct final');await tick(30_001);expect(await promise).toEqual({text:'late direct final'});
 });
 it('R-L11 stop during auto-retry progress await must not dispatch a fresh confirmation run',async()=>{
  process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY='1';h.bot.shouldUseLiveStatus=()=>true;
  let release:any;const original=LiveStatusController.prototype.progress;
  vi.spyOn(LiveStatusController.prototype,'progress').mockImplementation(function(this:LiveStatusController,e:any){
   if(typeof e==='string' && /疑似任务未完成|looks incomplete/.test(e))return new Promise<void>(r=>release=r);
   return original.call(this,e);
  });
  const pending=h.bot.handleMessage(event('A'));await tick();h.final('r1','我正在处理，然后');await tick(100);expect(release).toBeTypeOf('function');
  await h.bot.handleStopCommand('chat','stop');release();await tick();
  expect(h.sends).toHaveLength(1);
  h.final('r2','结束了');await tick(300);await pending;
 });
 it('R-L9 more than one due page does not starve a subscribed exact result behind unobserved rows',async()=>{
  for(let i=0;i<25;i++)h.store.saveRunObservation(`agent:main:unsub-${i}`,`r-${i}`,{});
  h.store.saveRunObservation(h.key,'subscribed',{});const delivered=vi.fn();h.client.sessionMessageCallbacks.set(h.key,delivered);
  h.client.rpc=vi.fn(async(_m:string,p:any)=>({runId:p.runId,status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'needed final'}}));
  await h.client.recoverExactRuns();await h.client.recoverExactRuns();expect(delivered).toHaveBeenCalledTimes(1);
 });
});
