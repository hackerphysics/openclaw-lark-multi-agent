import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){}close(){}}}));
import {OpenClawClient} from '../src/openclaw-client.js';
import {harness} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
const agent=(runId:string,stream:string,data:any,sessionKey=h.key)=>wire('agent',{runId,stream,data,sessionKey});
const message=(text:string)=>({role:'assistant',content:[{type:'text',text}],stopReason:'stop'});
const final=(runId:string,text:string)=>{wire('chat',{runId,state:'final',message:message(text)});agent(runId,'lifecycle',{phase:'end',livenessState:'working'});};
const state=(p:Promise<any>)=>{const s:any={};p.then(text=>s.text=text,error=>s.error=error);return s;};
const owned=()=>[...h.client.agentEvents.values()].flat().filter((e:any)=>e.runId==='r1');
const ordinary=(e:any)=>!(e.stream==='chatFinal'||e.stream==='chatError'||e.stream==='lifecycle'&&e.data?.phase==='error');
const bytes=(events:any[])=>events.filter(ordinary).reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e),'utf8')+2,0);
const all=()=>[...h.client.agentEvents.values()].flat();
beforeEach(async()=>{vi.useFakeTimers();h=harness();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});const p=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await p;});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
describe('owned buffer resource custody: bounded progress, whole authoritative finals',()=>{
 it('retires the parent 24x64KiB owned-result reproduction after the entire 144KiB final is durable',async()=>{
  const result=h.client.chatSend({sessionKey:h.key,message:'bounded resource check'});await tick();
  for(let i=0;i<24;i++)agent('r1','tool',{name:'read',phase:'result',toolCallId:`read-${i}`,output:`BULK_${i}:`+'x'.repeat(64*1024)});
  const text='EXACT_FINAL_'.repeat(12000);final('r1',text);await tick(100);
  expect(await result).toBe(text);expect(h.client.eventCollectors.size).toBe(0);expect(h.store.getRunObservation(h.key,'r1')?.terminalText).toBe(text);
  expect(owned().filter((e:any)=>typeof e.data?.output==='string'&&e.data.output.startsWith('BULK_')).length).toBe(0);
  expect(owned()).toHaveLength(0);
 });
 it('projects large tool input/output during a live run, not only after terminal cleanup',async()=>{
  const result=state(h.client.chatSend({sessionKey:h.key,message:'long live tools'}));await tick();
  for(let i=0;i<80;i++)agent('r1','tool',{name:'read',phase:'result',toolCallId:`active-${i}`,input:{opaque:'INPUT_BULK_'+'i'.repeat(64*1024)},output:'BULK_'+i+'x'.repeat(64*1024)});
  expect(result).toEqual({});expect(h.client.eventCollectors.size).toBe(1);
  expect(JSON.stringify(owned()).includes('BULK_')).toBe(false);expect(bytes(owned())).toBeLessThanOrEqual(256*1024);
  final('r1','complete after active projection');await tick(50);expect(result.text).toBe('complete after active projection');
 });
 it.each(['lifecycle','yield'])('compacts non-authoritative %s payloads while retaining the end/yield hint and whole later final',async(kind)=>{
  const root=state(h.client.chatSend({sessionKey:h.key,message:'nonterminal payloads'}));await tick();
  for(let i=0;i<80;i++){
    if(kind==='lifecycle')agent('r1','lifecycle',{phase:'end',livenessState:'working',error:'BULK_END_'+i+'x'.repeat(64*1024)});
    else wire('chat',{runId:'r1',state:'final',yielded:true,message:message('BULK_YIELD_'+i+'x'.repeat(64*1024))});
  }
  await tick();expect(root).toEqual({});expect(JSON.stringify(owned()).includes('BULK_')).toBe(false);expect(bytes(owned())).toBeLessThanOrEqual(256*1024);
  expect(Buffer.byteLength(JSON.stringify(owned()),'utf8')).toBeLessThan(64*1024);
  const text='FULL_AFTER_NONTERMINAL_'.repeat(8000);final('r1',text);await tick(50);expect(root.text).toBe(text);
 });
 it('enforces a measured per-session byte budget on large draft/progress bursts without finalizing them',async()=>{
  const result=state(h.client.chatSend({sessionKey:h.key,message:'large progress'}));await tick();
  for(let i=0;i<240;i++)agent('r1','assistant',{deltaText:'DRAFT_'+i+':'+('进度'.repeat(16000)),replace:true});
  expect(result).toEqual({});expect(bytes(owned())).toBeLessThanOrEqual(256*1024);
  const text='FULL_FINAL_'.repeat(35000);final('r1',text);await tick(50);expect(result.text).toBe(text);expect(h.store.getRunObservation(h.key,'r1')?.terminalText).toBe(text);
 });
 it('enforces a global progress byte budget across unobserved sessions; their unknown terminals are not evicted',async()=>{
  const text='UNOWNED_FINAL_'.repeat(25000);wire('chat',{runId:'unknown-run',state:'final',message:message(text)});
  for(let k=0;k<24;k++)for(let i=0;i<120;i++)agent(`f-${k}`,'assistant',{deltaText:'P'+i+':'+('x'.repeat(8192)),replace:true},`agent:main:pressure-${k}`);
  expect(bytes(all())).toBeLessThanOrEqual(4*1024*1024);
  expect(all().find((e:any)=>e.runId==='unknown-run'&&e.stream==='chatFinal')?.data.text).toBe(text);
  const recovered=state(h.client.collectReply('unknown-run',600000,h.key));await tick(5100);expect(recovered.text).toBe(text);
 });
 it('keeps the entire over-budget terminal for two same-root readers until the delayed real poll has consumed it',async()=>{
  const root=state(h.client.chatSend({sessionKey:h.key,message:'two readers'}));await tick();
  const before=new Set(h.client.eventCollectors);const extra=state(h.client.collectReply('r1',600000,h.key));
  const extraWake=[...h.client.eventCollectors].find(w=>!before.has(w));expect(extraWake).toBeTypeOf('function');h.client.eventCollectors.delete(extraWake);
  const text='双观察者完整正文'.repeat(50000);final('r1',text);await tick();
  expect(root.text).toBe(text);expect(extra).toEqual({});expect(h.store.getRunObservation(h.key,'r1')?.terminalText).toBe(text);
  expect(owned().some((e:any)=>e.stream==='chatFinal'&&e.data.text===text)).toBe(true);
  await tick(50);expect(extra.text).toBe(text);expect(owned()).toHaveLength(0);
 });
 it('reserves an ACK-first same-batch full terminal until the new collector is admitted through a delayed identification callback',async()=>{
  const old=state(h.client.chatSend({sessionKey:h.key,message:'old'}));await tick();
  const base=h.client.rpc,requests:any[]=[];h.client.ws.send=(s:string)=>requests.push(JSON.parse(s));
  h.client.rpc=(m:string,p:any,t:any)=>m==='chat.send'?(OpenClawClient.prototype as any).rpc.call(h.client,m,p,t):base(m,p,t);
  let release!:(v?:any)=>void;const next=state(h.client.chatSend({sessionKey:h.key,message:'new',onRunIdentified:()=>new Promise(r=>release=r)}));await tick();
  const Receiver=createRequire(import.meta.url)('ws').Receiver,receiver=new Receiver();receiver.on('message',(body:any)=>h.client.ws.emit('message',body));
  const frame=(v:any)=>{const body=Buffer.from(JSON.stringify(v)),head=Buffer.alloc(body.length<126?2:body.length<65536?4:10);head[0]=0x81;if(head.length===2)head[1]=body.length;else if(head.length===4){head[1]=126;head.writeUInt16BE(body.length,2);}else{head[1]=127;head.writeBigUInt64BE(BigInt(body.length),2);}return Buffer.concat([head,body]);};
  const text='ACK_FULL_TERMINAL_'.repeat(65000);
  receiver.write(Buffer.concat([frame({type:'res',id:requests[0].id,ok:true,payload:{runId:'r2',status:'started'}}),frame({type:'event',event:'chat',payload:{sessionKey:h.key,runId:'r2',state:'final',message:message(text)}})]));await tick();
  expect(h.client.eventCollectors.size).toBe(0);expect(old.error?.name).toBe('SupersededObservation');
  for(let i=0;i<2300;i++)agent('pressure','assistant',{deltaText:'x'.repeat(8192)+i,replace:true});
  expect(all().find((e:any)=>e.runId==='r2'&&e.stream==='chatFinal')?.data.text).toBe(text);
  release();await tick(5100);expect(next.text).toBe(text);expect(h.store.getRunObservation(h.key,'r2')?.terminalText).toBe(text);expect(all().some((e:any)=>e.runId==='r2')).toBe(false);receiver.end();
 });
 it('a failed replacement admission keeps old progress and result custody despite projection pressure',async()=>{
  const progress=vi.fn(),old=state(h.client.chatSend({sessionKey:h.key,message:'old',onProgress:progress}));await tick();
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>{if(m==='chat.send')throw new Error('RPC error: admission rejected');return base(m,p);});
  const next=state(h.client.chatSend({sessionKey:h.key,message:'new'}));await tick();expect(next.error).toBeDefined();
  agent('r1','assistant',{deltaText:'OLD LEGITIMATE NOTE',replace:true});agent('r1','tool',{name:'read',phase:'start',toolCallId:'old-tool',input:{path:'safe.txt'}});
  expect(JSON.stringify(progress.mock.calls)).toContain('OLD LEGITIMATE NOTE');expect(h.client.eventCollectors.size).toBe(1);
  final('r1','old exact final');await tick(50);expect(old.text).toBe('old exact final');expect(owned()).toHaveLength(0);
 });
 it('a completed owned root never retires a different run full terminal or an unidentified full terminal',async()=>{
  const root=state(h.client.chatSend({sessionKey:h.key,message:'root'}));await tick();
  const text='FOREIGN_TERMINAL_'.repeat(20000),unidentified='UNKNOWN_ID_'.repeat(20000);
  wire('chat',{runId:'foreign',state:'final',message:message(text)});wire('chat',{state:'final',message:message(unidentified)});final('r1','root done');await tick(50);
  expect(root.text).toBe('root done');expect(all().find((e:any)=>e.runId==='foreign'&&e.stream==='chatFinal')?.data.text).toBe(text);
  expect(all().find((e:any)=>!e.runId&&e.stream==='chatFinal')?.data.text).toBe(unidentified);
  const foreign=state(h.client.collectReply('foreign',600000,h.key));await tick(5100);expect(foreign.text).toBe(text);
 });
 it('a failed durable terminal checkpoint retains the whole authoritative frame for read-only recollection',async()=>{
  const original=h.store.saveRunObservation.bind(h.store);
  h.store.saveRunObservation=vi.fn((session:string,run:string,record:any,next?:number)=>{
    if(record.terminalObserved===true)throw new Error('synthetic terminal checkpoint unavailable');
    return original(session,run,record,next);
  });
  const root=state(h.client.chatSend({sessionKey:h.key,message:'checkpoint custody'}));await tick();
  const text='UNCONFIRMED_CHECKPOINT_FULL_'.repeat(16000);final('r1',text);await tick(50);
  expect(root.error?.message).toContain('checkpoint unavailable');
  expect(owned().find((e:any)=>e.stream==='chatFinal')?.data.text).toBe(text);
  h.store.saveRunObservation=original;
  const recovered=state(h.client.collectReply('r1',600000,h.key));await tick(5100);expect(recovered.text).toBe(text);expect(h.sends).toHaveLength(1);
 });
 it.each([false,true])('progress beyond the retained preview resets silence but repeated snapshots do not (blank preview=%s)',async(blankPreview)=>{
  const notice=vi.fn(),root=state(h.client.chatSend({sessionKey:h.key,message:'fingerprint',timeoutMs:1000,onWaitPaused:notice}));await tick();
  const prefix=blankPreview?' '.repeat(8192):'相同前缀'.repeat(8192);agent('r1','assistant',{deltaText:prefix+'A',replace:true});await tick(900);
  agent('r1','assistant',{deltaText:prefix+'B',replace:true});await tick(150);expect(notice).not.toHaveBeenCalled();
  agent('r1','assistant',{deltaText:prefix+'B',replace:true,usage:{outputTokens:12345}});await tick(850);expect(notice).toHaveBeenCalledOnce();
  final('r1','full exact after long progress');await tick(50);expect(root.text).toBe('full exact after long progress');
 });
 it('large message terminate results retain only the boolean hint and still require exact root terminal proof',async()=>{
  const base=h.client.rpc;let queries=0;h.client.rpc=vi.fn(async(m:string,p:any)=>m==='agent.wait'?(queries++,{runId:'r1',status:'ok',endedAt:Date.now(),terminalReply:{disposition:'visible',text:'committed exact root'}}):base(m,p));
  const root=state(h.client.chatSend({sessionKey:h.key,message:'hint projection'}));await tick();
  agent('r1','tool',{name:'message',phase:'result',toolCallId:'large-message',output:{terminate:true,body:'BULK_MESSAGE_'+'x'.repeat(256*1024)}});
  expect(root).toEqual({});expect(JSON.stringify(owned()).includes('BULK_MESSAGE_')).toBe(false);expect(queries).toBe(0);
  await tick(10100);expect(queries).toBe(1);expect(root.text).toBe('committed exact root');
 });
});
