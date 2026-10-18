import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){}close(){}}}));
import {harness} from './helpers/reliability-harness.js';
import {QueuedPresentations} from '../src/queued-presentation.js';
let h:ReturnType<typeof harness>,dir:string,db:string;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const manager=()=>h.bot.queuedPresentations as QueuedPresentations;
const rows=()=>h.store.listPresentations('Bot','offline-app','chat');
const receipt=(id:string)=>{const row=h.store.insert({chatId:'chat',messageId:id,senderType:'human',senderName:'Human',content:id,timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);return row;};
const last=()=>h.bot.patchLiveStatusCard.mock.calls.at(-1)?.[1];
const bindOrdinary=async()=>{const a=receipt('A'),live=manager().receive('chat',a,'A')!;manager().claim('chat',[a],'owner','batch');await manager().admit(live,'ordinary-root','owner','batch');await tick(900);return {a,live};};
const attachLegacy=(run='ordinary-root')=>{const b=receipt('B');manager().receive('chat',b,'B',false,run);h.store.saveInsertion('Bot','chat',b,'legacy-queue-B','accepted',{messageId:'B',text:'B',stopEpoch:0,expectedRunId:run,sessionId:'generation-1',attempted:true});h.store.setReactionIntent('Bot','chat',b,{messageId:'B',desired:'Get',shown:'Get',runId:run,stopEpoch:0});return b;};
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});dir=mkdtempSync(join(tmpdir(),'lma-d3-v2-'));db=join(dir,'db');h=harness(db);});
afterEach(async()=>{await h.cleanup();rmSync(dir,{recursive:true,force:true});vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('D3 v2 local suppression and per-input presentation completeness',()=>{
 it.each(['complete','noReply','fail','prepareTerminalDelivery'] as const)('%s cannot summarize an unresolved accepted sibling as all done/failed',async method=>{
  const {live}=await bindOrdinary(),b=attachLegacy();await manager().insertionAccepted('chat',b,'ordinary-root');
  const result=method==='prepareTerminalDelivery'?await live.prepareTerminalDelivery(true):await live[method]();
  expect(result).toBeUndefined();expect(last().state).not.toBe('done');expect(last().state).not.toBe('failed');expect(last().phase).toBe('waiting');
  expect(JSON.stringify(last())).toMatch(method==='fail'?/本轮结束|run ended/:/部分完成|partial result/);expect(JSON.stringify(last())).toMatch(/实际接收方|actual receiver/);
  expect(h.store.getInsertion('Bot','chat',b)).toMatchObject({state:'accepted',expectedRunId:'ordinary-root'});
  expect(h.store.getReactionIntent('Bot','chat',b).desired).toBe('Get');expect(h.store.hasDeliveredReply('Bot','chat',b)).toBe(false);
 });
 it('an unacknowledged ordinary attempt is not turned into confirmed execution failure by UI settlement',async()=>{
  const a=receipt('A'),live=manager().receive('chat',a,'A')!;manager().claim('chat',[a],'owner','batch');await tick(900);
  await live.fail();expect(last().state).not.toBe('failed');expect(last().state).not.toBe('done');expect(last().phase).toBe('waiting');expect(rows()[0].runId).toBeUndefined();
  expect(h.sends).toHaveLength(0);expect(h.store.hasDeliveredReply('Bot','chat',a)).toBe(false);
 });
 it('mixed ordinary/legacy waiting remains honest after SQLite close/reopen',async()=>{
  const {live}=await bindOrdinary(),b=attachLegacy();await manager().insertionAccepted('chat',b,'ordinary-root');await live.complete();
  await h.cleanup();h=harness(db);const restored=manager().forRun('chat','ordinary-root')!;expect(restored.id).toBe('status');
  await restored.complete();expect(last().phase).toBe('waiting');expect(last().state).not.toBe('done');
  expect(h.store.getInsertion('Bot','chat',b).state).toBe('accepted');expect(h.store.getReactionIntent('Bot','chat',b).desired).toBe('Get');
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
 });
 it('a legacy-only expected root never becomes an actual owner or terminal authority',async()=>{
  const b=receipt('B'),c=receipt('C'),live=manager().receive('chat',b,'B')!;manager().receive('chat',c,'C');await tick(900);
  for(const id of [b,c])await manager().insertionAccepted('chat',id,'expected-root');
  expect(rows()).toHaveLength(1);expect(rows()[0].runId).toBeUndefined();expect(rows()[0]).toMatchObject({expectedInsertionRoot:'expected-root',view:{phase:'waiting'}});
  expect(manager().forRun('chat','expected-root')).toBeUndefined();await manager().settleRun('chat','expected-root');await live.complete();
  expect(last().state).not.toBe('done');expect(last().phase).toBe('waiting');expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(h.sends).toHaveLength(0);expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('a fast enqueue ACK before the 800ms delay still creates one honest waiting card',async()=>{
  const b=receipt('B');manager().receive('chat',b,'B');await manager().insertionAccepted('chat',b,'expected-root');await tick(900);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()[0].view.phase).toBe('waiting');expect(rows()[0].runId).toBeUndefined();
  expect(h.bot.replyLiveStatusCard.mock.calls[0][1].phase).toBe('waiting');expect(JSON.stringify(h.bot.replyLiveStatusCard.mock.calls[0])).toMatch(/实际接收方|actual receiver/);
  manager().receive('chat',receipt('C'),'C');await manager().insertionAccepted('chat',h.store.getMessageId('C')!,'expected-root');await tick(2000);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()).toHaveLength(1);expect(h.sends).toHaveLength(0);
 });
 it('a v1 unowned expected-root UI row reopens as enqueue-only without losing its known card ID',async()=>{
  const b=receipt('B');h.store.savePresentation('Bot','offline-app','chat','legacy-v1',{id:'legacy-v1',chatId:'chat',messageId:'B',triggerIds:[b],stopEpoch:0,startedAt:Date.now(),lease:'old',runId:'expected-root',insertionRoot:'expected-root',acceptedIds:[b],cardId:'existing-legacy-card',create:'accepted',view:{title:'old admitted view',state:'admitted',phase:'admitted',lines:[],elapsed:'0:00',toolCalls:0,noReply:false}});
  expect(manager().forRun('chat','expected-root')).toBeUndefined();
  const live=manager().receive('chat',b,'B')!;await manager().insertionAccepted('chat',b,'expected-root');await live.complete();
  expect(live.id).toBe('existing-legacy-card');expect(rows()[0].runId).toBeUndefined();expect(last().phase).toBe('waiting');expect(last().state).not.toBe('done');expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
 });
 it('settings-off before the queued SDK effect is known suppression; on + new input can create normally',async()=>{
  const blocked=deferred<void>();void h.bot.sendOrdered('chat',()=>blocked.promise);
  const a=receipt('A');manager().receive('chat',a,'A');await tick(900);h.store.setBotLiveStatus('Bot','chat',false);blocked.resolve();await tick(0);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].create).toBe('never');expect(Object.keys(rows()[0].editEffects||{})).toHaveLength(0);
  h.store.setBotLiveStatus('Bot','chat',true);const b=receipt('B');manager().receive('chat',b,'B');await tick(900);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()).toHaveLength(1);expect(rows()[0]).toMatchObject({create:'accepted',cardId:'status'});
  expect(rows()[0].triggerIds).toEqual([a,b]);
 });
 it('lease supersession before transport is not an unknown create or a permanent UI lock',async()=>{
  const blocked=deferred<void>();void h.bot.sendOrdered('chat',()=>blocked.promise);
  const a=receipt('A');manager().receive('chat',a,'A');await tick(900);
  const replacement=new QueuedPresentations(h.store,'Bot','offline-app',(chat,reply)=>h.bot.liveStatusCallbacks(chat,reply),()=>true,()=>false);
  replacement.receive('chat',a,'A');blocked.resolve();await tick(0);replacement.dispose();
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].create).toBe('never');
  const b=receipt('B');manager().receive('chat',b,'B');await tick(900);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()[0]).toMatchObject({create:'accepted',cardId:'status'});expect(rows()[0].triggerIds).toEqual([a,b]);
 });
 it('settings suppression of an edit leaves no transport-unknown token and can resume real progress',async()=>{
  const {live}=await bindOrdinary();h.bot.patchLiveStatusCard.mockClear();h.store.setBotLiveStatus('Bot','chat',false);
  await live.progress({kind:'tool',name:'read',phase:'start',text:'read paused'});expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();expect(Object.keys(rows()[0].editEffects||{})).toHaveLength(0);
  h.store.setBotLiveStatus('Bot','chat',true);await live.progress({kind:'tool',name:'read',phase:'end',text:'read resumed'});
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);expect(last().phase).toBe('working');expect(Object.keys(rows()[0].editEffects||{})).toHaveLength(0);
 });
 it('an actually attempted unknown create cannot be retried by more overlapping input or after reopen',async()=>{
  h.bot.replyLiveStatusCard.mockImplementation(()=>new Promise(()=>{}));const a=receipt('A');manager().receive('chat',a,'A');await tick(30_801);
  expect(rows()[0].create).toBe('unknown');manager().receive('chat',a,'A');manager().receive('chat',receipt('B'),'B');await tick(900);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);await h.cleanup();h=harness(db);
  manager().receive('chat',receipt('C'),'C');await tick(60_000);expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].create).toBe('unknown');
 });
 it('a late ID from an attempted superseded lease is adopted durably without old-lease edits or duplicate create',async()=>{
  const created=deferred<string>();h.bot.replyLiveStatusCard.mockImplementation(()=>created.promise);
  const a=receipt('A');manager().receive('chat',a,'A');await tick(30_801);
  const replacement=new QueuedPresentations(h.store,'Bot','offline-app',(chat,reply)=>h.bot.liveStatusCallbacks(chat,reply),()=>true,()=>false);
  replacement.receive('chat',a,'A');created.resolve('late-original-card');await tick(2000);
  expect(rows()[0]).toMatchObject({cardId:'late-original-card',create:'accepted'});expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();replacement.dispose();
 });
});
