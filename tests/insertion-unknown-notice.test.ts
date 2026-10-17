import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>,actualDispatch:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const row=()=>h.store.getMessageId('B')!;
const current=()=>h.store.getInsertion('Bot','chat',row());
const key=()=>`insertion:${current().insertionId}:unknown-prolonged`;
const due=()=>h.store['db'].prepare('UPDATE insertion_custody SET next_check_at=0').run();
const check=async()=>{due();await h.bot.reconcileInsertions('chat');await tick();};
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T01:00:00Z'));h=harness();
 void h.bot.handleMessage(event('A'));await tick();
 h.client.steer=vi.fn(async(_s:any,_t:any,_d:any,id:any)=>({...id,status:'unknown',attempted:true,sessionId:'generation-1'}));
 await h.bot.handleMessage(event('B'));await tick();
 actualDispatch=h.bot.dispatchPendingDeliveries.bind(h.bot);h.bot.dispatchPendingDeliveries=vi.fn(async()=>{});
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();});
describe('unknown insertion reminder durable real-time intent and send-time verdict',()=>{
 it('four fast checks are not 45 seconds; first unknown time survives repeated queries',async()=>{
  const since=current().unknownSince;for(let i=0;i<8;i++)await check();expect(current().unknownSince).toBe(since);
  expect(h.store.getDeliveryByKey('Bot','chat',key())).toBeNull();vi.setSystemTime(since+44_999);await check();expect(current().unknownNotified).not.toBe(true);
  vi.setSystemTime(since+45_000);await check();expect(current().unknownNotified).toBe(true);expect(h.store.getDeliveryByKey('Bot','chat',key())?.status).toBe('pending');
 });
 it('outbox insertion failure rolls back reminder intent and retries without losing unknown custody',async()=>{
  vi.setSystemTime(current().unknownSince+45_000);h.store['db'].exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON delivery_outbox WHEN NEW.source_type='insertion_status' BEGIN SELECT RAISE(ABORT,'temporary local failure'); END`);
  due();await expect(h.bot.reconcileInsertions('chat')).rejects.toThrow('temporary local failure');expect(current().unknownNotified).not.toBe(true);
  h.store['db'].exec('DROP TRIGGER fail_notice');await check();expect(current().unknownNotified).toBe(true);expect(h.store.getDeliveryByKey('Bot','chat',key())?.status).toBe('pending');
 });
 it.each(['accepted','ordinary','stopped','target_changed'])('a queued reminder cannot send or overwrite a newer %s state',async(state)=>{
  vi.setSystemTime(current().unknownSince+45_000);await check();const item=current(),noticeKey=key();h.store.saveInsertion('Bot','chat',row(),item.insertionId,state,{...item,newField:'new receipt data'});
  const calls=h.create.mock.calls.length;await actualDispatch('chat');expect(h.create.mock.calls.length).toBe(calls);expect(current().state).toBe(state);expect(current().newField).toBe('new receipt data');expect(h.store.getDeliveryByKey('Bot','chat',noticeKey)?.status).toBe('failed');
 });
 it.each(['stop','generation','archive'])('fresh %s verdict suppresses an old reminder before platform effect',async(mode)=>{
  vi.setSystemTime(current().unknownSince+45_000);await check();const noticeKey=key();
  if(mode==='stop')h.store.bumpStopGeneration('Bot','chat');else h.client.getSessionInfo=vi.fn(async()=>({session:{sessionId:mode==='generation'?'generation-2':'generation-1',archived:mode==='archive'}}));
  const calls=h.create.mock.calls.length;await actualDispatch('chat');expect(h.create.mock.calls.length).toBe(calls);expect(h.store.getDeliveryByKey('Bot','chat',noticeKey)?.status).toBe('failed');
 });
 it('acceptance while a reminder is waiting in sendOrdered is rechecked at the actual SDK effect',async()=>{
  vi.setSystemTime(current().unknownSince+45_000);await check();let resume:any;h.bot.sendOrdered=vi.fn(async(_chat:any,fn:any)=>{await new Promise(r=>resume=r);return fn();});
  const dispatch=actualDispatch('chat');await tick();const item=current();h.store.saveInsertion('Bot','chat',row(),item.insertionId,'accepted',{...item,receipt:'new'});
  const calls=h.create.mock.calls.length;resume();await tick();await dispatch;expect(h.create.mock.calls.length).toBe(calls);expect(current().state).toBe('accepted');expect(current().receipt).toBe('new');
 });
});
