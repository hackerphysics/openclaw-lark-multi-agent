import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const reserve=(state:string,id=state,runId='r1')=>{
 const row=h.store.insert({chatId:'chat',messageId:id,senderType:'human',senderName:'u',content:'identical private input',timestamp:Date.now()});
 h.store.saveInsertion('Bot','chat',row,`legacy:${id}`,state,{messageId:id,text:'identical private input',stopEpoch:0,sessionKey:h.key,sessionId:'generation-1',expectedRunId:runId,attempted:state!=='pending'});
 h.store.setReactionIntent('Bot','chat',row,{messageId:id,desired:state==='accepted'?'Get':'Typing',shown:'',runId,stopEpoch:0});
 return row;
};
beforeEach(()=>{vi.useFakeTimers();h=harness();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();});
describe('B1 preventive settlement fence: root terminal is not exact legacy input proof',()=>{
 it.each(['pending','accepted','dispatching','unknown','stopped','target_changed','rejected'])('bulk root DONE excludes %s input and leaves ordinary siblings intact',async(state)=>{
  const row=reserve(state),ordinary=reserve('ordinary','ordinary');
  h.store.setReactionIntent('Bot','chat',ordinary,{messageId:'ordinary',desired:'Get',shown:'',runId:'r1',stopEpoch:0});
  h.store.settleRunReactionIntents('Bot','chat','r1');
  expect(h.store.getInsertion('Bot','chat',row).state).toBe(state);
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe(state==='accepted'?'Get':'Typing');
  expect(h.store.getReactionIntent('Bot','chat',ordinary).desired).toBe('DONE');
 });
 it('bulk settlement does not rewrite historical committed or DONE rows',()=>{
  const historical=reserve('committed'),done=reserve('accepted','historical-done');
  h.store.setReactionIntent('Bot','chat',done,{messageId:'historical-done',desired:'DONE',shown:'DONE',runId:'r1',stopEpoch:0});
  h.store.settleRunReactionIntents('Bot','chat','r1');
  expect(h.store.getInsertion('Bot','chat',historical).state).toBe('committed');
  expect(h.store.getReactionIntent('Bot','chat',historical).desired).toBe('Typing');
  expect(h.store.getReactionIntent('Bot','chat',done).desired).toBe('DONE');
  expect(h.store.getInsertion('Bot','chat',done).state).toBe('accepted');
 });
 it.each(['ok','error','timeout'])('accepted input remains Get and reserved after exact root %s (no commit evidence)',async(status)=>{
  const row=reserve('accepted');
  // Exercise the production exactRunSettled parser: even a valid exact
  // terminal error/timeout is not proof about this queue item's commitment.
  const base=h.client.rpc;
  h.client.rpc=vi.fn(async(method:string,p:any)=>method==='agent.wait'?{runId:p.runId,status,endedAt:Date.now(),...(status==='ok'?{terminalReply:{disposition:'empty'}}:{})}:base(method,p));
  const observed=vi.spyOn(h.client,'exactRunSettled');
  h.client.steer=vi.fn();
  await h.bot.reconcileInsertions('chat');await tick();
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('accepted');
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('Get');
  expect(h.bot.addReaction).not.toHaveBeenCalledWith('accepted','DONE');
  expect(h.store.isInsertionReserved('Bot','chat',row)).toBe(true);
  expect(h.client.steer).not.toHaveBeenCalled();
  expect(h.sends).toHaveLength(0);
  await h.bot.reconcileInsertions('chat');expect(observed).toHaveBeenCalledTimes(1);
  await tick(60_000);await h.bot.reconcileInsertions('chat');
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('accepted');
 });
 it.each(['pending','accepted','dispatching','unknown'])('a stale completion cohort cannot mark %s insertion delivered or model-synced',async(state)=>{
  const row=reserve(state);
  h.store.markDeliveredReply('Bot','chat',row,'ordinary-root-reply');
  h.store.markMessagesSynced('Bot','chat',[row],'ordinary-root-completion');
  await h.bot.receiptReaction('chat',row,state,'DONE','r1');await tick();
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);
  expect(h.store['db'].prepare('SELECT 1 FROM message_sync WHERE bot_name=? AND chat_id=? AND message_row_id=?').get('Bot','chat',row)).toBeUndefined();
  expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');
 });
 it('accepted input is neither replayed as group catch-up nor treated as model consumed by matching text',async()=>{
  const one=reserve('accepted','same-one'),two=reserve('accepted','same-two');
  h.store.clearPendingTrigger('Bot','chat',one);h.store.clearPendingTrigger('Bot','chat',two);
  expect(h.store.getUnsyncedMessagesForBot('Bot','chat',two).map(m=>m.id)).not.toContain(one);
  expect(h.store.getUnsyncedMessagesForBot('Bot','chat',two).map(m=>m.id)).not.toContain(two);
  h.client.registerPendingSteer(h.key,'identical private input');
  h.client.handleSteerConsumption(h.key,'identical private input');
  h.store.settleRunReactionIntents('Bot','chat','r1');
  for(const row of [one,two]){
   expect(h.store.getInsertion('Bot','chat',row).state).toBe('accepted');
   expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('Get');
  }
 });
 it('explicit no-effect ordinary recovery still completes on its new exact root, not its old expected root',async()=>{
  const row=reserve('pending');const item=h.store.getInsertion('Bot','chat',row);
  h.store.saveInsertion('Bot','chat',row,item.insertionId,'ordinary',{...item,attempted:false,reason:'backend_rejected_no_effect'});
  h.store.setReactionIntent('Bot','chat',row,{messageId:'pending',desired:'Get',shown:'Get',runId:'r2',stopEpoch:0});
  h.store.settleRunReactionIntents('Bot','chat','r1');expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('Get');
  h.store.markMessagesSynced('Bot','chat',[row],'new-ordinary-input');h.store.markDeliveredReply('Bot','chat',row,'new-platform-receipt');
  h.store.settleRunReactionIntents('Bot','chat','r2');
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(true);
  expect(h.store.getInsertion('Bot','chat',row).state).toBe('ordinary');
 });
 it.each(['accepted','unknown','dispatching'])('B2 unknown delivery control leaves %s custody and Get/Typing unchanged',async(state)=>{
  const row=reserve(state);
  const outbox=h.store.enqueueDelivery({sessionKey:h.key,chatId:'chat',botName:'Bot',sourceType:'assistant_visible',sourceId:'root',deliveryKey:'trigger:999',contentHash:'root',content:'root result',attachmentsJson:'[]',replyToMessageId:'root',deliveryMetaJson:JSON.stringify({provenance:{runId:'r1',final:true}})})!;
  h.store.saveDeliveryOperation(outbox,'message.create:body','unknown',{stage:'body',visible:true});
  h.store.settleRunReactionIntents('Bot','chat','r1');
  expect(h.store.getInsertion('Bot','chat',row).state).toBe(state);expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');
  expect(h.store.getDeliveryDispatchOutcome('Bot','chat','trigger:999').state).not.toBe('delivered');
 });
});
