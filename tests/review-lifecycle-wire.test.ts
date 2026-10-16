import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {OpenClawClient} from '../src/openclaw-client.js';
import {MessageStore} from '../src/message-store.js';
const KEY='agent:main:regression';let c:any,proactive:any,n:number,store:MessageStore,dir:string;
const wire=(event:string,payload:any)=>c.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:KEY,...payload}})));
const final=(runId:string,text='old exact final')=>{
 wire('chat',{runId,state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('session.message',{runId,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}});
 wire('agent',{runId,stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
};
const send=async(message:string,extra:any={})=>{
 const promise=c.chatSend({sessionKey:KEY,message,...extra}).then((text:string)=>({text}),(error:Error)=>({error}));
 await vi.advanceTimersByTimeAsync(0);return {promise};
};
beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T02:00:00Z'));
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
 dir=mkdtempSync(join(tmpdir(),'lma-reliable-client-'));store=new MessageStore(join(dir,'db'));
 c=new OpenClawClient({baseUrl:'ws://offline.invalid',token:'test'});c.bindRecoveryStore(store);
 const connected=c._doConnect();c.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
 n=0;c.rpc=vi.fn(async(m:string,p:any)=>m==='chat.send'?{runId:`r${++n}`}:m==='sessions.describe'?{session:{status:'running',hasActiveRun:true}}:{runId:p?.runId,status:'timeout'});
 proactive=vi.fn();c.sessionMessageCallbacks.set(KEY,proactive);
});
afterEach(async()=>{await c.disconnect();vi.clearAllTimers();store.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();vi.restoreAllMocks();});
describe('independent real WS lifecycle provenance',()=>{
 it('R-L4wire foreign delta must not become root final merely on root lifecycle end',async()=>{
  const old=await send('old');wire('session.message',{runId:'r1',message:{role:'user',content:[{type:'text',text:'old'}]}});
  wire('agent',{runId:'foreign',stream:'lifecycle',data:{phase:'start'}});
  wire('agent',{runId:'foreign',stream:'assistant',data:{delta:'FOREIGN PRIVATE ANSWER'}});
  wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
  let result:any;void old.promise.then(v=>result=v);await vi.advanceTimersByTimeAsync(100);
  expect(result).toBeUndefined();
  final('r1','own exact final');await vi.advanceTimersByTimeAsync(50);expect(await old.promise).toEqual({text:'own exact final'});
 });
 it('own-root lifecycle-only assistant delta remains a valid ordinary answer',async()=>{
  const old=await send('old');wire('agent',{runId:'r1',stream:'assistant',data:{delta:'own original answer'}});
  wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
  await vi.advanceTimersByTimeAsync(100);expect(await old.promise).toEqual({text:'own original answer'});
 });
});
