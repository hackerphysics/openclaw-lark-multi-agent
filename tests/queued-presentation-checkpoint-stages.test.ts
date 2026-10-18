import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter{send(){}close(){}}}));
import {harness} from './helpers/reliability-harness.js';
import {QueuedPresentations} from '../src/queued-presentation.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const manager=()=>h.bot.queuedPresentations as QueuedPresentations;
const rows=()=>h.store.listPresentations('Bot','offline-app','chat');
const receipt=(id:string)=>{const row=h.store.insert({chatId:'chat',messageId:id,senderType:'human',senderName:'Human',content:id,timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);return row;};
const root=async(id='A',run='root-A')=>{const row=receipt(id),live=manager().receive('chat',row,id)!;manager().claim('chat',[row],`owner-${id}`,`batch-${id}`);await manager().admit(live,run,`owner-${id}`,`batch-${id}`);return live;};
const busy=()=>Object.assign(new Error('transient UI checkpoint'),{code:'SQLITE_BUSY'});
const effects=()=>rows()[0].editEffects||{};
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});h=harness();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('D3 v3 UI checkpoints are not transport outcomes',()=>{
 it.each(['before-write','write-then-throw'] as const)('create pre-effect %s is zero SDK, repair-only, and recoverable by new input',async mode=>{
  const save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&record.create==='attempted'){failed=true;if(mode==='write-then-throw')save(bot,app,chat,id,record);throw busy();}
   return save(bot,app,chat,id,record);
  });
  const a=receipt('A');manager().receive('chat',a,'A');await tick(900);
  expect(failed).toBe(true);expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].create).toBe('never');
  await tick(5000);expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();expect(rows()[0].create).toBe('never');
  manager().receive('chat',receipt('B'),'B');await tick(900);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(rows()[0]).toMatchObject({cardId:'status',create:'accepted'});
 });
 it('accepted create reaches the D2 adopter BEFORE its failing post-effect checkpoint and still patches that ID terminally',async()=>{
  h.bot.replyLiveStatusCard.mockResolvedValue('known-card');
  const save=h.store.savePresentation.bind(h.store);let failed=false;let live:any;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&record.create==='accepted'&&record.cardId==='known-card'){
    expect(live.id).toBe('known-card');failed=true;throw busy();
   }
   return save(bot,app,chat,id,record);
  });
  live=await root();await tick(900);expect(failed).toBe(true);expect(live.id).toBe('known-card');
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
  await live.complete();await tick(0);
  expect(rows()[0]).toMatchObject({cardId:'known-card',create:'accepted',view:{state:'done'}});
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledWith('known-card',expect.objectContaining({state:'done'}),'chat');
  const count=h.bot.patchLiveStatusCard.mock.calls.length;await tick(10_000);await live.complete();
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(count);
 });
 it('post-create failure has paced journal-only custody even after controller ticks stop',async()=>{
  h.bot.replyLiveStatusCard.mockResolvedValue('known-card');const save=h.store.savePresentation.bind(h.store);let block=true,writes=0;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(block&&record.cardId==='known-card'&&record.create==='accepted'){writes++;throw busy();}
   return save(bot,app,chat,id,record);
  });
  const live=await root();await tick(900);expect(live.id).toBe('known-card');live.dispose();
  await tick(60_000);expect(writes).toBeLessThan(12);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
  block=false;await tick(30_001);
  expect(rows()[0]).toMatchObject({cardId:'known-card',create:'accepted'});expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
 });
 it('late accepted create repair preserves a retired epoch and never touches a fresh cohort',async()=>{
  const old=deferred<string>();h.bot.replyLiveStatusCard.mockImplementationOnce(()=>old.promise).mockResolvedValue('new-card');
  await root();await tick(30_801);await h.bot.handleStopCommand('chat','stop');await root('B','root-B');await tick(900);
  const save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&record.cardId==='late-old-card'){failed=true;throw busy();}return save(bot,app,chat,id,record);
  });
  const before=h.bot.patchLiveStatusCard.mock.calls.length;old.resolve('late-old-card');await tick(3000);
  expect(failed).toBe(true);expect(rows().find((r:any)=>r.retired)).toMatchObject({cardId:'late-old-card',create:'accepted',stopEpoch:0,retired:true});
  expect(rows().find((r:any)=>!r.retired)).toMatchObject({cardId:'new-card',runId:'root-B',stopEpoch:1});
  expect(h.bot.patchLiveStatusCard.mock.calls.slice(before).some(([id]:any)=>id==='late-old-card')).toBe(false);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(2);
 });
 it('accepted create repair merges the new lease and its desired view instead of restoring the old lease',async()=>{
  h.bot.replyLiveStatusCard.mockResolvedValue('known-card');const save=h.store.savePresentation.bind(h.store);let block=true;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(block&&record.cardId==='known-card'&&record.create==='accepted')throw busy();return save(bot,app,chat,id,record);
  });
  const live=await root();await tick(900);expect(live.id).toBe('known-card');const oldLease=rows()[0].lease;
  const replacement=new QueuedPresentations(h.store,'Bot','offline-app',(chat,reply)=>h.bot.liveStatusCallbacks(chat,reply),()=>true,()=>false);
  const next=replacement.receive('chat',h.store.getMessageId('A')!,'A')!;next.received('new lease desired note');const newLease=rows()[0].lease;
  expect(newLease).not.toBe(oldLease);block=false;await tick(3000);
  expect(rows()[0]).toMatchObject({cardId:'known-card',create:'accepted',lease:newLease});
  expect(rows()[0].view.lines.some((line:any)=>line.text.includes('new lease desired note'))).toBe(true);
  expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();replacement.dispose();
 });
 it('a real attempted unknown create remains no-replay even if its unknown checkpoint also fails once',async()=>{
  h.bot.replyLiveStatusCard.mockImplementation(()=>new Promise(()=>{}));const save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&record.create==='unknown'){failed=true;throw busy();}return save(bot,app,chat,id,record);
  });
  manager().receive('chat',receipt('A'),'A');await tick(30_801);expect(failed).toBe(true);
  manager().receive('chat',receipt('B'),'B');await tick(5000);
  expect(rows()[0].create).toBe('unknown');expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
 });
 it.each(['before-write','write-then-throw'] as const)('edit pre-effect %s is zero SDK, no unknown token, and a fresh desired edit can proceed',async mode=>{
  const live=await root();await tick(900);const save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&Object.values(record.editEffects||{}).includes('attempted')){failed=true;if(mode==='write-then-throw')save(bot,app,chat,id,record);throw busy();}
   return save(bot,app,chat,id,record);
  });
  await live.progress({kind:'tool',name:'read',phase:'start',text:'read suppressed-old'});await tick(0);
  expect(failed).toBe(true);expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();expect(Object.keys(effects())).toHaveLength(0);
  await live.progress({kind:'tool',name:'read',phase:'end',text:'read fresh-desired'});await tick(0);
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);expect(JSON.stringify(h.bot.patchLiveStatusCard.mock.calls[0])).toContain('fresh-desired');
  expect(Object.keys(effects())).toHaveLength(0);await live.complete();const count=h.bot.patchLiveStatusCard.mock.calls.length;await tick(5000);
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(count);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
 });
 it('post-edit clear failure never turns a successful terminal patch into transport unknown or a replay',async()=>{
  const live=await root();await tick(900);const save=h.store.savePresentation.bind(h.store);let token='',failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   const tokens=Object.keys(record.editEffects||{});if(tokens.length)token=tokens[0];
   if(token&&!failed&&!tokens.includes(token)){failed=true;throw busy();}return save(bot,app,chat,id,record);
  });
  await live.complete();expect(failed).toBe(true);expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);
  expect(effects()[token]).toBe('attempted'); // durable lag, NOT a transport-unknown classification
  await tick(3000);await live.complete();expect(Object.keys(effects())).toHaveLength(0);
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);expect(h.bot.patchLiveStatusCard.mock.calls[0][1].state).toBe('done');
 });
 it.each(['before-write','write-then-throw'] as const)('post-edit %s repairs only its successful token while another SDK effect remains genuinely unknown',async mode=>{
  const live=await root();await tick(900);h.bot.patchLiveStatusCard.mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue(undefined);
  void live.progress({kind:'tool',name:'read',phase:'start',text:'read genuinely unknown'});await tick(30_001);
  const oldToken=Object.keys(effects())[0];expect(effects()[oldToken]).toBe('unknown');const save=h.store.savePresentation.bind(h.store);let terminalToken='',failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   const tokens=Object.keys(record.editEffects||{}),next=tokens.find(t=>t!==oldToken);if(next)terminalToken=next;
   if(terminalToken&&!failed&&!tokens.includes(terminalToken)){failed=true;if(mode==='write-then-throw')save(bot,app,chat,id,record);throw busy();}
   return save(bot,app,chat,id,record);
  });
  await live.complete();expect(failed).toBe(true);expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(2);
  expect(effects()[oldToken]).toBe('unknown');expect(effects()[terminalToken]).not.toBe('unknown');
  await tick(5000);await live.complete();expect(Object.keys(effects())).toEqual([oldToken]);expect(effects()[oldToken]).toBe('unknown');
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(2);expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
 });
 it('repeated zero-SDK checkpoint failures do not accumulate one in-memory receipt token per progress event',async()=>{
  const live=await root();await tick(900);
  const fail=vi.spyOn(h.store,'savePresentation').mockImplementation(()=>{throw busy();});
  for(let i=0;i<100;i++)await live.progress({kind:'tool',name:'read',phase:'start',text:`read local-${i}`});
  expect(h.bot.patchLiveStatusCard).not.toHaveBeenCalled();
  // Resource-state inspection only; no callback or schedule is overridden.
  const pending=[...(manager() as any).repairs.values()] as any[];
  expect(pending.reduce((n:number,r:any)=>n+r.edits.size,0)).toBeLessThanOrEqual(1);
  fail.mockRestore();await live.progress({kind:'tool',name:'read',phase:'end',text:'read fresh after recovery'});await tick(0);
  expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);expect(Object.keys(effects())).toHaveLength(0);
 });
 it('pre-edit write-then-throw clears only the zero-SDK attempt, not an older unknown token',async()=>{
  const live=await root();await tick(900);h.bot.patchLiveStatusCard.mockImplementation(()=>new Promise(()=>{}));
  void live.progress({kind:'tool',name:'read',phase:'start',text:'read old unknown'});await tick(30_001);
  const oldToken=Object.keys(effects())[0],save=h.store.savePresentation.bind(h.store);let failed=false;
  vi.spyOn(h.store,'savePresentation').mockImplementation((bot,app,chat,id,record:any)=>{
   if(!failed&&Object.keys(record.editEffects||{}).some(t=>t!==oldToken)){failed=true;save(bot,app,chat,id,record);throw busy();}
   return save(bot,app,chat,id,record);
  });
  await live.complete();await tick(3000);expect(failed).toBe(true);
  expect(Object.keys(effects())).toEqual([oldToken]);expect(effects()[oldToken]).toBe('unknown');expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);
 });
});
