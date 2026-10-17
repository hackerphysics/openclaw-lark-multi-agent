import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {OpenClawClient} from '../../src/openclaw-client.js';
import {FeishuBot} from '../../src/feishu-bot.js';
import {harness,event} from './reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const message=(text:string)=>({role:'assistant',content:[{type:'text',text}],stopReason:'stop'});
const wire=(channel:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event:channel,payload:{sessionKey:h.key,...payload}})));
const bodies=()=>h.store.getRecent('chat').filter(m=>m.senderType==='bot').map(m=>m.content);
const cards=()=>JSON.stringify([...h.bot.replyLiveStatusCard.mock.calls,...h.bot.patchLiveStatusCard.mock.calls]);
const final=(text='actual final answer')=>wire('chat',{runId:'r1',state:'final',message:message(text)});
const terminal=(text='actual final answer')=>{final(text);wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});};
const observed=(p:Promise<any>)=>{const state:any={};p.then(text=>state.text=text,error=>state.error=error);return state;};
beforeEach(async()=>{
 vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 h=harness();h.client.ensureModel=vi.fn(async()=>false);h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);const base=h.client.rpc;
 h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.history'?{sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0,items:[]}}:base(m,p));
 const connecting=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connecting;await h.bot.ensureSession('chat');
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('INDEPENDENT desired-safe acceptance; red on ccf64ae is intentional',()=>{
 it.each([true,false])('B3: exact empty wins over draft with lifecycle=%s',async(lifecycle)=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?{runId:p.runId,status:'ok',endedAt:Date.now(),terminalReply:{disposition:'empty'}}:base(m,p));
  const p=h.bot.handleMessage(event('question'));await tick(50);
  wire('agent',{runId:'r1',stream:'assistant',data:{deltaText:'PRIVATE INTERIM PREFACE',replace:true}});
  final('');if(lifecycle)wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
  await tick(5500);expect(bodies().join('\n')).not.toContain('PRIVATE INTERIM PREFACE');await p;
 });
 it.each(['task','prompt'])('C1: private spawn %s never enters card, actual final still delivers',async(field)=>{
  const p=h.bot.handleMessage(event('question'));await tick(50);
  wire('agent',{runId:'r1',stream:'tool',data:{name:'sessions_spawn',phase:'start',toolCallId:'spawn',input:{[field]:'PRIVATE CHILD PAYLOAD',label:'safe-worker'}}});await tick(100);
  expect(cards()).not.toContain('PRIVATE CHILD PAYLOAD');terminal();await tick(350);await p;expect(bodies()).toContain('actual final answer');
 });
 it('B4: unrelated final before admission stays proactive and cannot finish new trigger/card',async()=>{
  const base=h.client.rpc;let admit:any;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?new Promise(r=>admit=r):base(m,p));
  const p=h.bot.handleMessage(event('new question'));await tick(50);
  wire('chat',{runId:'old-independent',state:'final',message:message('old independent final')});await tick(100);
  expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')).toBeFalsy();
  expect(bodies()).toContain('old independent final');
  admit({runId:'r1',status:'started'});await tick(1000);expect(h.bot.replyLiveStatusCard).toHaveBeenCalled();
  terminal('new exact final');await tick(350);await p;expect(h.store.getDeliveryByKey('Bot','chat','trigger:1')?.content).toBe('new exact final');
 });
 it('B2: platform code0 without message_id never becomes delivered ledger or DONE',async()=>{
  h.create.mockResolvedValue({code:0,data:{}} as any);
  const p=h.bot.handleMessage(event('question'));await tick(50);terminal();await tick(350);await p;
  const row=h.store.getMessageId('question')!;const out=h.store.getDeliveryByKey('Bot','chat',`trigger:${row}`)!;
  expect(out.status).not.toBe('delivered');expect(h.store.hasUnknownDeliveryOperation(out.id!)).toBe(true);
  expect(h.store.hasDeliveredReply('Bot','chat',row)).toBe(false);expect(h.store.getReactionIntent('Bot','chat',row)?.desired).not.toBe('DONE');
 });
 it('C2: foreign narration never cross-flushes into current card',async()=>{
  const p=h.bot.handleMessage(event('question'));await tick(50);
  wire('agent',{runId:'foreign',stream:'assistant',data:{deltaText:'FOREIGN PRIVATE NOTE',replace:true}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'read',phase:'start',toolCallId:'read1',input:{path:'safe-file.txt'}}});await tick(100);
  expect(cards()).not.toContain('FOREIGN PRIVATE NOTE');terminal();await tick(350);await p;
 });
 it('CONTROL: same-root narration and actual final remain useful',async()=>{
  const p=h.bot.handleMessage(event('question'));await tick(50);
  wire('agent',{runId:'r1',stream:'assistant',data:{deltaText:'PUBLIC SAME ROOT NOTE',replace:true}});
  wire('agent',{runId:'r1',stream:'tool',data:{name:'read',phase:'start',toolCallId:'read1',input:{path:'safe-file.txt'}}});await tick(100);
  expect(cards()).toContain('PUBLIC SAME ROOT NOTE');terminal();await tick(350);await p;expect(bodies()).toContain('actual final answer');
 });
 it('B5: legal same-batch RPC ACK then final is retained for newly admitted collector',async()=>{
  const old=observed(h.client.chatSend({sessionKey:h.key,message:'old'}));await tick();
  wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'old'}]}});
  const base=h.client.rpc,requests:any[]=[];h.client.ws.send=(s:string)=>requests.push(JSON.parse(s));
  h.client.rpc=(m:string,p:any,t:any)=>m==='chat.send'?(OpenClawClient.prototype as any).rpc.call(h.client,m,p,t):base(m,p,t);
  const next=observed(h.client.chatSend({sessionKey:h.key,message:'new'}));await tick();
  const Receiver=createRequire(import.meta.url)('ws').Receiver;const receiver=new Receiver();receiver.on('message',(body:any)=>h.client.ws.emit('message',body));
  const frame=(v:any)=>{const body=Buffer.from(JSON.stringify(v)),head=Buffer.alloc(body.length<126?2:4);head[0]=0x81;if(body.length<126)head[1]=body.length;else{head[1]=126;head.writeUInt16BE(body.length,2);}return Buffer.concat([head,body]);};
  receiver.write(Buffer.concat([frame({type:'res',id:requests[0].id,ok:true,payload:{runId:'r2',status:'started'}}),frame({type:'event',event:'chat',payload:{sessionKey:h.key,runId:'r2',state:'final',message:message('new exact terminal')}})]));
  await tick(5100);expect(old.error?.name).toBe('SupersededObservation');expect(next.text).toBe('new exact terminal');receiver.end();
 });
});
