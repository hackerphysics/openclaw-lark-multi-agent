import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness,event} from './helpers/reliability-harness.js';
import {SendDeadlineError} from '../src/feishu-bot.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const observed=(p:Promise<any>)=>{const state:any={};p.then(value=>state.value=value,error=>state.error=error);return state;};
const delivery=(key='trigger:A')=>h.store.getDeliveryByKey('Bot','chat',key)!;
const enqueue=(key='trigger:A',text='authoritative result',attachments:any[]=[])=>h.bot.enqueueAndDispatchDelivery('chat','assistant_visible',key,text,attachments,'source',key,'offline/model');
const obligation=(id:number)=>(h.store as any).db.prepare('SELECT * FROM delivery_local_obligations WHERE outbox_id=?').get(id);
const bodyRows=()=>h.store.getRecent('chat').filter(m=>m.senderType==='bot');
const doneViews=()=>h.bot.patchLiveStatusCard.mock.calls.filter(([,view]:any)=>view.state==='done');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T11:10:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});h=harness();});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('durable dispatch outcomes, not promise resolution, authorize completion',()=>{
 it('code0 without message_id returns durable unknown, not successful delivery',async()=>{
  h.create.mockResolvedValue({code:0,data:{}} as any);
  const outcome=await enqueue();
  expect(outcome).toMatchObject({state:'unknown',outboxIds:[delivery().id]});
  expect(h.store.hasUnknownDeliveryOperation(delivery().id!)).toBe(true);
  expect(bodyRows()).toHaveLength(0);
  const count=h.create.mock.calls.length;await h.bot.dispatchPendingDeliveries('chat');expect(h.create).toHaveBeenCalledTimes(count);
 });
 it('R1 full ordinary path: missing receipt cannot write delivered_replies, complete card or request DONE',async()=>{
  h.create.mockResolvedValue({code:0,data:{}} as any);
  const input=h.bot.handleMessage(event('A'));await tick(900);h.final('r1','authoritative final');await tick(350);await input;
  const row=h.store.getMessageId('A')!;
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);
  expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');
  expect(doneViews()).toHaveLength(0);expect(bodyRows()).toHaveLength(0);
 });
 it('generic provider catch: missing error-notice receipt cannot mark delivered/DONE',async()=>{
  h.create.mockResolvedValue({code:0,data:{}} as any);
  h.client.chatSendWithContext=vi.fn(async(p:any)=>{await p.onSendAttempt('r1');await p.onSubmitted('r1');throw new Error('provider unavailable');});
  await h.bot.handleMessage(event('A'));await tick();const row=h.store.getMessageId('A')!;
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);
  expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');
 });
 it('confirmed accepted ordinary final still completes all receipt bookkeeping',async()=>{
  const input=h.bot.handleMessage(event('A'));await tick(900);h.final('r1','confirmed final');await tick(350);await input;
  const row=h.store.getMessageId('A')!;expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(true);
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');expect(doneViews().length).toBeGreaterThan(0);expect(bodyRows()).toHaveLength(1);
 });
 it('plain empty string is unconfirmed, while explicit attributable NO_REPLY remains terminal',async()=>{
  h.client.chatSendWithContext=vi.fn(async(p:any)=>{await p.onSendAttempt('r1');await p.onSubmitted('r1');return '';});
  await h.bot.handleMessage(event('A'));await tick();const row=h.store.getMessageId('A')!;
  expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');expect(doneViews()).toHaveLength(0);expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);
 });
 it.each(['NO_REPLY','no_reply'])('explicit %s does not require a nonexistent platform body receipt',async text=>{
  const input=h.bot.handleMessage(event('A'));await tick();h.final('r1',text);await tick(350);await input;
  const row=h.store.getMessageId('A')!;expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');expect(h.create).not.toHaveBeenCalled();expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);
 });
});

describe('deadline lease + paced local reconciliation, without cancelling old work',()=>{
 it('typed send deadline still releases the next independent same-chat link',async()=>{
  const first=observed(h.bot.sendOrdered('chat',()=>new Promise(()=>{})));
  const second=observed(h.bot.sendOrdered('chat',async()=> 'B'));
  await tick(30_001);expect(first.error).toBeInstanceOf(SendDeadlineError);expect(second.value).toBe('B');
 });
 it('slow-before-first-effect30s: checkpoint custody; late preparation cannot initiate its first SDK effect',async()=>{
  let resume:any;h.bot.readSessionStatus=()=>new Promise(r=>resume=r);
  const state=observed(enqueue());await tick(30_001);
  expect(state.value).toMatchObject({state:'pending'});expect(state.error).toBeUndefined();
  const row=delivery();expect(row.status).toBe('pending');expect(obligation(row.id!).reason).toBe('deadline_before_attempt');expect(h.bot.deliveryRetryTimers.has('chat')).toBe(true);expect(h.create).not.toHaveBeenCalled();
  await h.bot.sendOrdered('chat',async()=> 'B');
  resume({status:'done',running:false,idleConfirmed:true});await tick();expect(h.create).not.toHaveBeenCalled();
  // A fresh, separately guarded operation resumes the proven never-attempted stage.
  h.bot.readSessionStatus=async()=>({status:'done',running:false,idleConfirmed:true});
  await h.bot.dispatchPendingDeliveries('chat');expect(delivery().status).toBe('delivered');expect(h.create).toHaveBeenCalledTimes(1);
 });
 it('hung SDK30s retains attempted/unknown custody; repeated local reconciliation never resends',async()=>{
  h.create.mockImplementation(()=>new Promise(()=>{}));
  const state=observed(enqueue());await tick(30_001);const row=delivery();
  expect(state.value).toMatchObject({state:'unknown'});expect(row.status).toBe('pending');expect(obligation(row.id!).reason).toBe('deadline_attempted_unknown');
  expect(h.bot.inFlightDeliveryWork.has(row.id)).toBe(true);expect(h.create).toHaveBeenCalledTimes(1);
  await tick(900_000);await h.bot.dispatchPendingDeliveries('chat');expect(h.create).toHaveBeenCalledTimes(1);expect(h.bot.deliveryRetryTimers.has('chat')).toBe(true);
  expect(h.store.hasUnknownDeliveryOperation(row.id!)).toBe(true);
 });
 it('lateacceptedreceipt is adopted once, settles the original trigger, and is never blindly resent',async()=>{
  let accept:any;h.create.mockImplementation(()=>new Promise(r=>accept=r));
  const input=h.bot.handleMessage(event('A'));await tick();h.final('r1','late accepted root answer');await tick(30_350);await input;
  const row=h.store.getMessageId('A')!,key=`trigger:${row}`,id=delivery(key).id!;
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);expect(h.store.getReactionIntent('Bot','chat',row).desired).not.toBe('DONE');expect(doneViews()).toHaveLength(0);
  accept({code:0,data:{message_id:'late-accepted',chat_id:'chat'}});await tick();
  expect(delivery(key).status).toBe('delivered');expect(h.store.listDeliveryReceipts(id)).toHaveLength(1);expect(bodyRows()).toHaveLength(1);
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(true);expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');
  await h.bot.dispatchPendingDeliveries('chat');await tick(300_000);expect(h.create).toHaveBeenCalledTimes(1);expect(bodyRows()).toHaveLength(1);
 });
 it('late rejection remains unknown, not a fresh create/reply fallback or a completed final',async()=>{
  let reject:any;h.create.mockImplementation(()=>new Promise((_r,j)=>reject=j));
  const state=observed(enqueue());await tick(30_001);expect(state.value.state).toBe('unknown');
  reject(new Error('network disappeared after platform attempt'));await tick();await h.bot.dispatchPendingDeliveries('chat');
  expect(h.create).toHaveBeenCalledTimes(1);expect(delivery().status).not.toBe('delivered');expect(bodyRows()).toHaveLength(0);
 });
 it('late accepted body may checkpoint, but expired lease cannot launch the next attachment effect',async()=>{
  let accept:any;h.create.mockImplementation(()=>new Promise(r=>accept=r));
  h.bot.sendBridgeAttachment=vi.fn(async()=>{await h.bot.client.im.message.create({data:{receive_id:'chat',msg_type:'text',content:'attachment'}});});
  const state=observed(enqueue('trigger:A','body',[{type:'file',path:'/offline/file'}]));await tick(30_001);
  accept({code:0,data:{message_id:'body-late',chat_id:'chat'}});await tick();
  expect(state.value.state).toBe('unknown');expect(h.create).toHaveBeenCalledTimes(1);expect(delivery().status).toBe('pending');expect(delivery().textDelivered).toBe(true);expect(h.store.getDeliveryDispatchOutcome('Bot','chat','trigger:A').state).toBe('pending');
  h.create.mockResolvedValue({code:0,data:{message_id:'attachment',chat_id:'chat'}} as any);
  await h.bot.dispatchPendingDeliveries('chat');expect(h.create).toHaveBeenCalledTimes(2);expect(delivery().status).toBe('delivered');
 });
 it('deadline during fallback preparation cannot start a later create/chunk effect',async()=>{
  let resume:any;
  h.bot.replyFinalMessage=vi.fn(async()=>{await new Promise(r=>resume=r);throw new Error('local reply preparation failed');});
  const state=observed(enqueue());await tick(30_001);resume();await tick();
  expect(state.value.state).toBe('pending');expect(h.create).not.toHaveBeenCalled();expect(delivery().status).toBe('pending');
 });
 it('real chunk loop: late chunk acceptance cannot launch the next chunk; resume adopts prefix once',async()=>{
  let accept:any,chunk=0;
  h.create.mockImplementation(async(p:any)=>{
    if(p.data.msg_type==='interactive') throw Object.assign(new Error('length of the message content'),{response:{data:{code:230025}}});
    if(++chunk===1)return await new Promise(r=>accept=r);
    return {code:0,data:{message_id:`chunk-${chunk}`,chat_id:'chat'}};
  });
  const state=observed(h.bot.enqueueAndDispatchDelivery('chat','assistant_visible','chunks','X'.repeat(7000),[],undefined,'chunks','offline/model'));
  await tick(30_001);expect(chunk).toBe(1);
  accept({code:0,data:{message_id:'chunk-1',chat_id:'chat'}});await tick();expect(chunk).toBe(1);expect(delivery('chunks').textDelivered).toBe(false);expect(state.value.state).toBe('unknown');
  await h.bot.dispatchPendingDeliveries('chat');expect(chunk).toBe(3);expect(delivery('chunks').status).toBe('delivered');
  const receipts=h.store.listDeliveryReceipts(delivery('chunks').id!);expect(receipts.map(r=>r.messageId)).toEqual(['chunk-1','chunk-2','chunk-3']);expect(bodyRows()).toHaveLength(3);
  // Existing partial-context representation is one row per accepted chunk.
  await h.bot.dispatchPendingDeliveries('chat');expect(chunk).toBe(3);expect(bodyRows()).toHaveLength(3);
 });
 it('real attachment upload: accepted late upload is reused, expired worker cannot issue file message',async()=>{
  let upload:any;h.bot.validateBridgeAttachmentPath=()=>import.meta.filename;
  h.bot.client.im.file.create.mockImplementation(()=>new Promise(r=>upload=r));
  const state=observed(enqueue('upload','',[{type:'file',path:'/offline/file',caption:''}]));await tick(30_001);
  upload({code:0,data:{file_key:'accepted-upload'}});await tick();expect(h.create).not.toHaveBeenCalled();expect(delivery('upload').status).toBe('pending');expect(obligation(delivery('upload').id!).reason).toBe('deadline_after_acceptance');
  await h.bot.dispatchPendingDeliveries('chat');expect(h.bot.client.im.file.create).toHaveBeenCalledTimes(1);expect(h.create).toHaveBeenCalledTimes(1);expect(delivery('upload').status).toBe('delivered');expect(state.value.state).toBe('unknown');
 });
 it('checkpointfailure at outer timeout retains process custody until SQLite recovers, no replay of hung SDK',async()=>{
  h.create.mockImplementation(()=>new Promise(()=>{}));
  const defer=h.store.deferLocalDelivery.bind(h.store);h.store.deferLocalDelivery=vi.fn(()=>{throw Object.assign(new Error('disk busy'),{code:'SQLITE_BUSY'});});
  const state=observed(enqueue());await tick(30_001);const id=delivery().id!;
  expect(state.value.state).toBe('unknown');expect(h.bot.localDeliveryRetryCustody.get('chat').has(id)).toBe(true);expect(h.bot.deliveryRetryTimers.has('chat')).toBe(true);
  h.store.deferLocalDelivery=defer;await tick(300_000);expect(obligation(id)).toBeTruthy();expect(delivery().status).toBe('pending');expect(h.create).toHaveBeenCalledTimes(1);
 });
 it('accepted receipt journal checkpoint failure repairs locally under the same operation ID',async()=>{
  const save=h.store.saveDeliveryOperation.bind(h.store);let failed=false;
  h.store.saveDeliveryOperation=(id,key,state,record)=>{if(state==='accepted' && !failed){failed=true;throw Object.assign(new Error('checkpoint'),{code:'SQLITE_BUSY'});}return save(id,key,state,record);};
  const outcome=await enqueue();expect(outcome.state).not.toBe('delivered');expect(h.create).toHaveBeenCalledTimes(1);expect(h.store.listDeliveryReceipts(delivery().id!)).toHaveLength(1);
  h.store.saveDeliveryOperation=save;await h.bot.dispatchPendingDeliveries('chat');expect(delivery().status).toBe('delivered');expect(h.create).toHaveBeenCalledTimes(1);expect(bodyRows()).toHaveLength(1);
 });
 it('checkpointfailure after marking delivered returns to local reconciliation and repairs without resend',async()=>{
  const mark=h.store.markDeliveredReply.bind(h.store);let once=true;
  h.store.markDeliveredReply=(...args:Parameters<typeof mark>)=>{if(once){once=false;throw Object.assign(new Error('ledger checkpoint'),{code:'SQLITE_BUSY'});}return mark(...args);};
  const outcome=await enqueue('trigger:99');expect(outcome.state).toBe('pending');expect(delivery('trigger:99').status).toBe('pending');expect(h.create).toHaveBeenCalledTimes(1);expect(h.store.hasDeliveredReply('Bot','chat',99)).toBe(false);
  await h.bot.dispatchPendingDeliveries('chat');expect(delivery('trigger:99').status).toBe('delivered');expect(h.store.hasDeliveredReply('Bot','chat',99)).toBe(true);expect(h.create).toHaveBeenCalledTimes(1);
 });
 it('an unknown attachment keeps the accepted body out of full-final DONE/ledger settlement',async()=>{
  h.bot.sendBridgeAttachment=async()=>{await h.bot.client.im.message.create({data:{receive_id:'chat',msg_type:'file',content:'{}'}});};
  let n=0;h.create.mockImplementation(async()=>++n===1?{code:0,data:{message_id:'accepted-body',chat_id:'chat'}}:{code:0,data:{}} as any);
  h.store.setReactionIntent('Bot','chat',99,{runId:'r1',desired:'Get',shown:'Get',stopEpoch:0});
  const outcome=await h.bot.enqueueAndDispatchDelivery('chat','assistant_visible','A','body',[{type:'file',path:'/offline/file'}],'source','trigger:99','offline/model',{runId:'r1',sessionKey:h.key,final:true});
  expect(outcome.state).toBe('unknown');expect(delivery('trigger:99').textDelivered).toBe(true);expect(h.store.hasDeliveredReply('Bot','chat',99)).toBe(false);
  h.store.settleRunReactionIntents('Bot','chat','r1');expect(h.store.getReactionIntent('Bot','chat',99).desired).not.toBe('DONE');expect(h.create).toHaveBeenCalledTimes(2);
 });
 it('a competing authoritative final adds merged-trigger bookkeeping to a proactive-owned row',async()=>{
  let accept:any;h.create.mockImplementation(()=>new Promise(r=>accept=r));
  const first=observed(enqueue('trigger:99'));await tick(30_001);
  const competing=await h.bot.enqueueAndDispatchDelivery('chat','assistant_visible','visible:99','authoritative result',[],'source','trigger:99','offline/model',undefined,undefined,[99,100]);
  expect(first.value.state).toBe('unknown');expect(competing.state).toBe('unknown');
  accept({code:0,data:{message_id:'late-merged',chat_id:'chat'}});await tick();expect(h.store.hasDeliveredReply('Bot','chat',99)).toBe(true);expect(h.store.hasDeliveredReply('Bot','chat',100)).toBe(true);expect(h.create).toHaveBeenCalledTimes(1);
 });
 it.each([false,true])('explicit stop (epoch bump=%s) after deadline adopts the receipt but does not DONE',async bump=>{
  let accept:any;h.create.mockImplementation(()=>new Promise(r=>accept=r));
  const p=h.bot.enqueueAndDispatchDelivery('chat','assistant_visible','A','result',[],'source','trigger:1','offline/model',{runId:'r1',sessionKey:h.key,final:true});observed(p);await tick(30_001);
  h.store.setReactionIntent('Bot','chat',1,{runId:'r1',desired:'Get',shown:'Get',stopEpoch:0});
  h.store.stopExactRun(h.key,'r1');if(bump)h.store.bumpStopGeneration('Bot','chat');
  accept({code:0,data:{message_id:'accepted-before-stop',chat_id:'chat'}});await tick();
  expect(h.store.listDeliveryReceipts(delivery('trigger:1').id!)).toHaveLength(1);expect(h.store.hasDeliveredReply('Bot','chat',1)).toBe(false);expect(h.store.getReactionIntent('Bot','chat',1).desired).not.toBe('DONE');expect(h.create).toHaveBeenCalledTimes(1);
 });
});
