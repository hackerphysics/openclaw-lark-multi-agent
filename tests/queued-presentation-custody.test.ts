import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness,event} from './helpers/reliability-harness.js';
import {QueuedPresentations} from '../src/queued-presentation.js';
let h:ReturnType<typeof harness>,dir:string,db:string;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const manager=()=>h.bot.queuedPresentations as QueuedPresentations;
const rows=()=>h.store.listPresentations('Bot','offline-app','chat');
const receipt=(id:string)=>{const row=h.store.insert({chatId:'chat',messageId:id,senderType:'human',senderName:'Human',content:id,timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);return row;};
const receive=(id:string)=>manager().receive('chat',receipt(id),id)!;
const restart=async()=>{await h.cleanup();h=harness(db);};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});dir=mkdtempSync(join(tmpdir(),'lma-d3-presentation-'));db=join(dir,'messages.db');h=harness(db);});
afterEach(async()=>{await h.cleanup();rmSync(dir,{recursive:true,force:true});vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('UI-only durable presentation custody never grants admission',()=>{
 it('known card ID and desired queued phase reopen from SQLite, reusing that card for the cohort',async()=>{
  receive('A');await tick(900);expect(rows()[0]).toMatchObject({cardId:'status',create:'accepted',view:{phase:'queued'}});
  await restart();receive('B');await tick(2501);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
  expect(h.bot.patchLiveStatusCard.mock.calls.at(-1)).toEqual(['status',expect.objectContaining({phase:'queued'}) ,'chat']);
  expect(rows()).toHaveLength(1);expect(rows()[0].triggerIds).toHaveLength(2);
  expect(h.sends).toHaveLength(0);expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('exact admitted root restores known card identity; foreign roots cannot acquire it',async()=>{
  const live=receive('A');await tick(900);const row=h.store.getMessageId('A')!;
  expect(manager().claim('chat',[row],'owner','batch')).toBe(live);
  await manager().admit(live,'exact-root','owner','batch');
  await live.progress({kind:'tool',name:'read',phase:'start',text:'read exact.txt'});
  expect(rows()[0].view.phase).toBe('working');await restart();
  expect(manager().forRun('chat','foreign')).toBeUndefined();
  const restored=manager().forRun('chat','exact-root')!;expect(restored.id).toBe('status');
  await restored.progress({kind:'tool',name:'read',phase:'end',text:'read exact done'});
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(h.bot.patchLiveStatusCard).toHaveBeenCalledWith('status',expect.objectContaining({phase:'working'}),'chat');
  expect(h.sends).toHaveLength(0);expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('wrong owner/batch ACK cannot hand a queued card to any root',async()=>{
  const live=receive('A');await tick(900);manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');
  await manager().admit(live,'foreign','wrong','batch');await manager().admit(live,'foreign','owner','wrong');
  expect(rows()[0].runId).toBeUndefined();expect(rows()[0].view.phase).toBe('queued');
  await manager().admit(live,'root','owner','batch');await manager().admit(live,'foreign','owner','batch');
  expect(rows()[0].runId).toBe('root');expect(manager().forRun('chat','foreign')).toBeUndefined();
 });
 it('code0/no ID is durably unknown: repeated inputs and process reopen cannot create another card',async()=>{
  h.bot.replyLiveStatusCard.mockResolvedValue(undefined);
  receive('A');await tick(900);receive('B');await tick(2501);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()[0].create).toBe('unknown');
  await restart();receive('C');await tick(120_000);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
  expect(rows()[0].create).toBe('unknown');expect(rows()[0].cardId).toBeUndefined();expect(rows()[0].triggerIds).toHaveLength(3);
 });
 it('attempted create at process loss is not retried or claimed resolvable by an in-memory observer',async()=>{
  h.bot.replyLiveStatusCard.mockImplementation(()=>new Promise(()=>{}));
  receive('A');await tick(900);expect(rows()[0].create).toBe('attempted');
  await restart();receive('B');await tick(120_000);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].cardId).toBeUndefined();expect(rows()[0].create).toBe('attempted');
 });
 it('unknown create adopts late in-process ID once and renders the current admitted phase on the same card',async()=>{
  const created=deferred<string>();h.bot.replyLiveStatusCard.mockImplementation(()=>created.promise);
  const live=receive('A');await tick(30_801);expect(rows()[0].create).toBe('unknown');
  receive('B');manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');
  await manager().admit(live,'root','owner','batch');
  // An unconfirmed create cannot cause a second create, even on new progress.
  await tick(5000);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  created.resolve('late-card');await tick(0);await tick(1000);
  expect(rows()[0]).toMatchObject({cardId:'late-card',create:'accepted',runId:'root'});
  expect(h.bot.patchLiveStatusCard.mock.calls.at(-1)?.[1].phase).toBe('admitted');
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
 });
 it('stop fences old callbacks; late created ID is recorded but never edits a new cohort',async()=>{
  const oldCreate=deferred<string>();h.bot.replyLiveStatusCard.mockImplementationOnce(()=>oldCreate.promise).mockResolvedValue('new-card');
  receive('A');await tick(900);
  await h.bot.handleStopCommand('chat','stop');
  receive('B');await tick(30_901);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(2);
  const before=h.bot.patchLiveStatusCard.mock.calls.length;
  oldCreate.resolve('old-card');await tick(0);
  expect(rows().find((r:any)=>r.retired)).toMatchObject({cardId:'old-card',create:'accepted'});
  expect(rows().find((r:any)=>!r.retired)).toMatchObject({cardId:'new-card',stopEpoch:1,view:{phase:'queued'}});
  expect(h.bot.patchLiveStatusCard.mock.calls.slice(before).some(([id]:any)=>id==='old-card')).toBe(false);
  expect(manager().forRun('chat','old-root')).toBeUndefined();
 });
 it('stop before queued SDK invocation cancels that old first effect without making dispatch rows',async()=>{
  const block=deferred<void>();void h.bot.sendOrdered('chat',()=>block.promise);
  receive('A');await tick(900);await h.bot.handleStopCommand('chat','stop');
  block.resolve();await tick(0);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].retired).toBe(true);
  expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('unknown edits remain independently fenced across SQLite reopen with a known card ID',async()=>{
  const live=receive('A');await tick(900);manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');await manager().admit(live,'root','owner','batch');
  h.bot.patchLiveStatusCard.mockImplementation(()=>new Promise(()=>{}));
  void live.progress({kind:'tool',name:'read',phase:'start',text:'read unknown.txt'});await tick(30_001);
  expect(Object.keys(rows()[0].editEffects)).toHaveLength(1);expect(Object.values(rows()[0].editEffects)).toEqual(['unknown']);
  await restart();const restored=manager().forRun('chat','root')!;
  expect(restored.id).toBe('status');await restored.progress({kind:'tool',name:'read',phase:'end',text:'read newer desired phase'});await tick(60_000);
  expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
  expect(rows()[0].view.lines.some((line:any)=>line.text.includes('newer desired phase'))).toBe(true);
 });
 it('a late progress receipt cannot erase a distinct unknown terminal edit obligation',async()=>{
  const live=receive('A');await tick(900);manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');await manager().admit(live,'root','owner','batch');
  const progress=deferred<void>(),terminal=deferred<void>();
  h.bot.patchLiveStatusCard.mockImplementationOnce(()=>progress.promise).mockImplementationOnce(()=>terminal.promise);
  void live.progress({kind:'tool',name:'read',phase:'start',text:'read slow'});await tick(30_001);
  const done=live.complete();await tick(30_001);await done;
  expect(Object.keys(rows()[0].editEffects)).toHaveLength(2);expect(rows()[0].view.state).toBe('done');
  progress.resolve();await tick(0);
  expect(Object.keys(rows()[0].editEffects)).toHaveLength(1);expect(Object.values(rows()[0].editEffects)).toEqual(['unknown']);
 });
 it('real submission key seals a pre-ACK cohort, and an old root can never complete the new cohort',async()=>{
  const old=receive('A');await tick(900);manager().claim('chat',[h.store.getMessageId('A')!],'old-owner','old-batch');
  manager().attempted(old,'actual-submission-key','old-owner','old-batch');
  const fresh=receive('B');expect(fresh).not.toBe(old);await tick(900);
  manager().claim('chat',[h.store.getMessageId('B')!],'new-owner','new-batch');
  await manager().admit(old,'old-root','old-owner','old-batch');await old.complete();
  expect(rows().find((r:any)=>r.triggerIds.includes(h.store.getMessageId('B')))).toMatchObject({view:{phase:'queued'}});
  expect(rows().find((r:any)=>r.submissionId)).toMatchObject({submissionId:'actual-submission-key',runId:'old-root'});
  await manager().admit(fresh,'new-root','new-owner','new-batch');
  expect(manager().forRun('chat','new-root')).toBe(fresh);expect(h.sends).toHaveLength(0);
 });
 it('a sealed unknown create fences only its own cohort, while distinct B/C still coalesce into one independent card',async()=>{
  h.bot.replyLiveStatusCard.mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue('independent-card');
  const old=receive('A');manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');manager().attempted(old,'actual-submission','owner','batch');
  await tick(30_801);expect(rows()[0].create).toBe('unknown');
  receive('B');receive('C');await tick(120_000);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(2);expect(rows()).toHaveLength(2);
  expect(rows().find((row:any)=>!row.submissionId)).toMatchObject({create:'accepted',cardId:'independent-card',view:{phase:'queued'}});
  expect(rows().find((row:any)=>row.submissionId).create).toBe('unknown');
  expect(h.sends).toHaveLength(0);expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
 });
 it('a partial or foreign insertion receipt cannot declare the entire coalesced cohort admitted',async()=>{
  const pending=receive('B');receive('C');await tick(900);
  await manager().insertionAccepted('chat',h.store.getMessageId('B')!,'root');
  expect(rows()[0].runId).toBeUndefined();expect(rows()[0].view.phase).toBe('waiting');
  await manager().insertionAccepted('chat',h.store.getMessageId('C')!,'foreign');
  expect(rows()[0].runId).toBeUndefined();
  await manager().insertionAccepted('chat',h.store.getMessageId('C')!,'root');
  expect(rows()[0]).toMatchObject({expectedInsertionRoot:'root',view:{phase:'waiting'}});
  expect(rows()[0].runId).toBeUndefined();expect(manager().forRun('chat','root')).toBeUndefined();
  await manager().settleRun('chat','foreign');expect(rows()[0].view.phase).toBe('waiting');
  await manager().settleRun('chat','root');expect(rows()[0].view.phase).toBe('waiting');
  // Distinct positive control: only an actual ordinary payload/ACK may bind.
  const ids=['B','C'].map(id=>h.store.getMessageId(id)!);
  expect(manager().claim('chat',ids,'owner','ordinary-batch')).toBe(pending);
  await manager().admit(pending,'actual-ordinary-root','owner','ordinary-batch');
  expect(rows()[0]).toMatchObject({runId:'actual-ordinary-root',view:{phase:'admitted'}});
  await manager().settleRun('chat','actual-ordinary-root');expect(rows()[0].view.phase).toBe('done');
 });
 it('same-task continuation requires exact previous root and owner; late old-root card callbacks are fenced',async()=>{
  const live=receive('A');await tick(900);manager().claim('chat',[h.store.getMessageId('A')!],'owner','batch');await manager().admit(live,'root-1','owner','batch');
  await live.progress({kind:'tool',name:'read',phase:'start',text:'read first root'});
  await manager().advance(live,'foreign','root-2','owner','batch');expect(rows()[0].runId).toBe('root-1');
  await manager().advance(live,'root-1','root-2','owner','wrong');expect(rows()[0].runId).toBe('root-1');
  await manager().advance(live,'root-1','root-2','owner','batch');expect(rows()[0]).toMatchObject({runId:'root-2',view:{phase:'admitted'}});
  expect(manager().forTarget('chat','root-1',live)).toBeUndefined();expect(manager().forTarget('chat','root-2',live)).toBe(live);
  await restart();expect(manager().forRun('chat','root-1')).toBeUndefined();expect(manager().forRun('chat','root-2')?.id).toBe('status');
 });
 it('journal app identity prevents another Bot account from adopting this card',async()=>{
  receive('A');await tick(900);
  const another=new QueuedPresentations(h.store,'Bot','other-app',(chat,reply)=>h.bot.liveStatusCallbacks(chat,reply),()=>true,()=>false);
  expect(another.forRun('chat','root')).toBeUndefined();
  another.receive('chat',receipt('B'),'B');await tick(900);
  expect(h.store.listPresentations('Bot','other-app','chat')).toHaveLength(1);expect(rows()).toHaveLength(1);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(2);another.dispose();
 });
});
