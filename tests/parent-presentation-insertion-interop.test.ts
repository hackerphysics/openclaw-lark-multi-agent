import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter{send(){}close(){}}}));
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
const terminal=(runId:string,text:string)=>{wire('chat',{runId,state:'final',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});wire('agent',{runId,stream:'lifecycle',data:{phase:'end',livenessState:'working'}});};
beforeEach(async()=>{vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});h=harness();let cardN=0;h.bot.replyLiveStatusCard=vi.fn(async()=>`status-${++cardN}`);const p=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await p;});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('parent cross-candidate presentation / custody invariants',()=>{
 it('B1+D3: linked reply may close presentation, never commit a coalesced unproven insertion B',async()=>{
  const p=h.bot.handleMessage(event('ordinary-A'));void p.catch(()=>{});await tick(1000);
  h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'accepted',attempted:true,sessionId:'generation-1'}));
  await h.bot.handleMessage(event('inserted-B'));await tick(150);
  const b=h.store.getMessageId('inserted-B')!,a=h.store.getMessageId('ordinary-A')!;
  expect(h.store.getInsertion('Bot','chat',b)?.state).toBe('accepted');
  terminal('r1','confirmed ordinary A reply');await tick(350);await p;
  expect(h.store.getReactionIntent('Bot','chat',a)?.desired).toBe('DONE');
  expect(h.store.getReactionIntent('Bot','chat',b)?.desired).toBe('Get');
  expect(h.store.getInsertion('Bot','chat',b)?.state).toBe('accepted');
  await tick(1000);
  const held=h.store.listPresentations('Bot','offline-app','chat').filter((row:any)=>!row.retired&&row.triggerIds.includes(b)&&row.cardId);
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((row:any)=>row.view.state==='replied'&&row.view.phase==='replied'&&row.linkedReply?.runId==='r1')).toBe(true);
  expect(h.store.hasDeliveredReply('Bot','chat',b)).toBe(false);
  expect(h.store['db'].prepare('SELECT COUNT(*) n FROM message_sync WHERE message_row_id=?').get(b)?.n).toBe(0);
 });
 it('D3: an accepted create receipt survives a transient post-SDK journal failure without resend',async()=>{
  h.bot.replyLiveStatusCard.mockResolvedValue('accepted-card');
  const save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot:any,app:any,chat:any,id:any,record:any)=>{
   if(!failed&&record.cardId==='accepted-card'&&record.create==='accepted'){failed=true;throw Object.assign(new Error('transient UI checkpoint'),{code:'SQLITE_BUSY'});}
   return save(bot,app,chat,id,record);
  });
  const p=h.bot.handleMessage(event('ordinary-A'));void p.catch(()=>{});await tick(1200);
  expect(failed).toBe(true);terminal('r1','confirmed A final');await tick(500);await p;
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  const row=h.store.listPresentations('Bot','offline-app','chat').find((record:any)=>record.runId==='r1');
  expect(row?.cardId).toBe('accepted-card');
  expect(h.bot.patchLiveStatusCard.mock.calls.some((call:any[])=>call[0]==='accepted-card'&&call[1].state==='done')).toBe(true);
 });
 it('D3: an older unknown create never blocks a distinct later submitted cohort card',async()=>{
  h.bot.replyLiveStatusCard=vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue('new-B-card');
  const pA=h.bot.handleMessage(event('ordinary-A'));void pA.catch(()=>{});await tick(31_000);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  terminal('r1','A reply');await tick(350);await pA;
  h.client.getSessionRuntimeStatus=vi.fn(async()=>({sessionId:'generation-1',status:'done',running:false,idleConfirmed:true,checkedAt:Date.now()}));
  h.client.getSessionDispatchStatus=vi.fn(async()=>({sessionId:'generation-1',idleConfirmed:true}));
  const pB=h.bot.handleMessage(event('ordinary-B'));void pB.catch(()=>{});await tick(1000);
  const createsWhileBWaiting=h.bot.replyLiveStatusCard.mock.calls.length;
  expect(h.sends).toHaveLength(2);
  terminal('r2','B reply');await tick(350);await pB;
  expect(createsWhileBWaiting).toBe(2);
  expect(h.bot.replyLiveStatusCard.mock.calls.map((c:any[])=>c[0])).toEqual(['ordinary-A','ordinary-B']);
 });
});
