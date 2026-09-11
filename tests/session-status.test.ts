import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenClawClient } from '../src/openclaw-client.js';
import { SessionWaitPaused, normalizeSessionRuntimeStatus, isWaitTimeout, formatSessionFooter, FOREGROUND_WAIT_MS } from '../src/session-status.js';
const key='agent:main:test-status';
let c:any;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));c=new OpenClawClient({baseUrl:'ws://offline.invalid',token:'test'});c.agentEvents.set(key,[]);});
afterEach(async()=>{await c.disconnect();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
const event=(stream:string,data:any)=>c.agentEvents.get(key).push({runId:'r',sessionKey:key,stream,data});
describe('session status and paused waits',()=>{
 it('normalizes real status without trusting unsafe text or inventing running',()=>{
  expect(normalizeSessionRuntimeStatus({session:{status:'running'}}).running).toBe(true);
  expect(normalizeSessionRuntimeStatus({session:{status:'idle'}}).status).toBe('idle');
  expect(normalizeSessionRuntimeStatus({session:{status:'idle',hasActiveRun:true}}).status).toBe('running');
  expect(normalizeSessionRuntimeStatus(undefined).status).toBe('unknown');
  expect(normalizeSessionRuntimeStatus({session:{status:'<script>running</script>'}}).status).toBe('unknown');
  expect(isWaitTimeout('invalid timeout parameter')).toBe(false);
 });
 it.each([
  [{status:'running',totalTokens:84501,contextTokens:200000,totalTokensFresh:true}, 'running · 85K/200K'],
  [{status:'idle',totalTokens:578384,contextTokens:1000000}, 'idle · 578K/1000K'],
  [{status:'running',totalTokens:210000,contextTokens:200000}, 'running · 210K/200K'],
  [{status:'idle',totalTokens:0,contextTokens:200000,totalTokensFresh:true}, 'idle · 0K/200K'],
  [{status:'running',contextTokens:200000}, 'running · ?K/200K'],
  [{status:'running',totalTokens:85000}, 'running · 85K/?K'],
  [{status:'running',totalTokens:85000,contextTokens:200000,totalTokensFresh:false}, 'running · ?K/200K'],
  [{status:'running',totalTokens:-1,contextTokens:0}, 'running'],
  [{status:'running',totalTokens:Infinity,contextTokens:NaN}, 'running'],
 ])('formats compact integer K usage without hiding overflow or inventing missing counts: %j', (session, expected) => {
  expect(formatSessionFooter(normalizeSessionRuntimeStatus({session}))).toBe(expected);
 });
 it('obtains state and context counters in one metadata query',async()=>{
  c.rpc=vi.fn(async()=>({session:{status:'running',totalTokens:84501,contextTokens:200000,totalTokensFresh:true}}));
  const snapshot=await c.getSessionRuntimeStatus(key);
  expect(formatSessionFooter(snapshot)).toBe('running · 85K/200K');
  expect(c.rpc).toHaveBeenCalledOnce();
  expect(c.rpc.mock.calls[0][0]).toBe('sessions.describe');
 });
 it('bounds an unavailable status query without stopping execution',async()=>{
  c.rpc=vi.fn(()=>new Promise(()=>{}));
  const p=c.getSessionRuntimeStatus(key);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await p).status).toBe('unknown');
  expect(c.rpc.mock.calls.map((v:any[])=>v[0])).toEqual(['sessions.describe']);
  expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['chatError','lifecycle'])('pauses %s wait timeouts when the session is still running',async stream=>{
  c.rpc=vi.fn(async(method:string)=>method==='sessions.describe'?{session:{status:'running'}}:{runId:'r',status:'timeout'});
  const p=c.collectReply('r',30000,key).catch((e:Error)=>e);
  event(stream,stream==='chatError'?{error:'Request timed out'}:{phase:'error',error:'Request timeout'});
  await vi.advanceTimersByTimeAsync(100);
  expect(await p).toBeInstanceOf(SessionWaitPaused);
  expect(c.rpc.mock.calls.some((v:any[])=>v[0]==='chat.abort')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
 });
 it('pauses a quiet local wait, not the running session',async()=>{
  c.rpc=vi.fn(async(method:string)=>method==='sessions.describe'?{session:{status:'running'}}:{runId:'r',status:'timeout'});
  const p=c.collectReply('r',1000,key).catch((e:Error)=>e);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await p).toBeInstanceOf(SessionWaitPaused);
  expect(c.rpc.mock.calls.some((v:any[])=>v[0]==='chat.abort')).toBe(false);
 });
 it('does not mask a real non-timeout failure merely because another task is running',async()=>{
  c.rpc=vi.fn(async()=>({session:{status:'running'}}));
  const p=c.collectReply('r',1000,key).catch((e:Error)=>e);
  event('lifecycle',{phase:'error',error:'tool validation failed'});
  await vi.advanceTimersByTimeAsync(100);
  const error=await p;
  expect(error).not.toBeInstanceOf(SessionWaitPaused);
  expect(error.message).toContain('tool validation failed');
 });
 it('still reports a timeout when status is idle',async()=>{
  c.rpc=vi.fn(async()=>({session:{status:'idle'}}));
  const p=c.collectReply('r',1000,key).catch((e:Error)=>e);
  event('chatError',{error:'Request timeout'});
  await vi.advanceTimersByTimeAsync(100);
  expect(await p).not.toBeInstanceOf(SessionWaitPaused);
  expect((await p).message).toContain('Request timeout');
 });
 it('reconciles a generic timeout into a running-session pause',async()=>{
  c.rpc=vi.fn(async(method:string)=>method==='agent.wait'?{runId:'r',status:'timeout',endedAt:Date.now()}:{session:{status:'running'}});
  const p=c.collectReply('r',1000,key).catch((e:Error)=>e);
  event('chatError',{error:'chat error'});
  await vi.advanceTimersByTimeAsync(500);
  expect(await p).toBeInstanceOf(SessionWaitPaused);
 });
 it('lets a real final beat a pending timeout classification',async()=>{
  let release:any;
  c.getSessionRuntimeStatus=vi.fn(()=>new Promise(r=>{release=r}));
  c.rpc=vi.fn(async()=>({runId:'r',status:'timeout'}));
  const p=c.collectReply('r',30000,key);
  event('chatError',{error:'Request timeout'});
  await vi.advanceTimersByTimeAsync(50);
  event('chatFinal',{text:'real final'});
  event('lifecycle',{phase:'end',livenessState:'working'});
  await vi.advanceTimersByTimeAsync(100);
  expect(await p).toBe('real final');
  release({status:'running',running:true,checkedAt:Date.now()});
  await vi.advanceTimersByTimeAsync(0);
  expect(c.rpc.mock.calls.some((v:any[])=>v[0]==='chat.abort')).toBe(false);
 });
 it('notifies the foreground once while preserving original ownership and later final collection',async()=>{
  c.rpc=vi.fn(async(method:string)=>method==='chat.send'?{runId:'r'}:method==='sessions.describe'?{session:{status:'running'}}:{runId:'r',status:'timeout'});
  const notice=vi.fn(); let settled=false;
  const p=c.chatSend({sessionKey:key,message:'test',timeoutMs:1000,onWaitPaused:notice}).then((v:string)=>{settled=true;return v;});
  await vi.advanceTimersByTimeAsync(1000);
  expect(notice).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(c.ownedDeliveryRuns.has('r')).toBe(true);
  await vi.advanceTimersByTimeAsync(60000); expect(notice).toHaveBeenCalledOnce(); expect(settled).toBe(false);
  event('assistant',{delta:'real result'}); event('lifecycle',{phase:'end',livenessState:'working'});
  await vi.advanceTimersByTimeAsync(100); expect(await p).toBe('real result');
  expect(c.rpc.mock.calls.some((v:any[])=>v[0]==='chat.abort')).toBe(false);
 });
 it('waits ten silent minutes after ongoing activity, not ten total minutes, and still returns the real result',async()=>{
  expect(FOREGROUND_WAIT_MS).toBe(600000);
  c.rpc=vi.fn(async(method:string)=>method==='chat.send'?{runId:'r'}:method==='sessions.describe'?{session:{status:'running'}}:{runId:'r',status:'timeout'});
  const notice=vi.fn(); let settled=false;
  const p=c.chatSend({sessionKey:key,message:'test',onWaitPaused:notice}).then((v:string)=>{settled=true;return v;});
  for (let i=0;i<5;i++) {
   await vi.advanceTimersByTimeAsync(4*60000);
   event('assistant',{delta:`step ${i}`}); await vi.advanceTimersByTimeAsync(50);
   expect(notice).not.toHaveBeenCalled();
  }
  // More than twenty minutes of progress; only the last progress starts silence.
  await vi.advanceTimersByTimeAsync(FOREGROUND_WAIT_MS-1);
  expect(notice).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(notice).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(c.ownedDeliveryRuns.has('r')).toBe(true);
  event('assistant',{delta:' more work'}); await vi.advanceTimersByTimeAsync(11*60000);
  expect(notice).toHaveBeenCalledOnce();
  event('chatFinal',{text:'real final'}); event('lifecycle',{phase:'end',livenessState:'working'});
  await vi.advanceTimersByTimeAsync(100); expect(await p).toBe('real final');
  expect(c.rpc.mock.calls.filter((v:any[])=>v[0]==='chat.send')).toHaveLength(1);
  expect(c.rpc.mock.calls.some((v:any[])=>v[0]==='chat.abort')).toBe(false);
 });
 it('releases exact run final-delivery ownership immediately after pausing',async()=>{
  c.rpc=vi.fn(async(method:string)=>method==='chat.send'?{runId:'r'}:method==='sessions.describe'?{session:{status:'running'}}:{runId:'r',status:'timeout'});
  const p=c.chatSend({sessionKey:key,message:'test',timeoutMs:1000}).catch((e:Error)=>e);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await p).toBeInstanceOf(SessionWaitPaused);
  expect(c.ownedDeliveryRuns.has('r')).toBe(false);
  expect(c.ownedDeliveryRunTimers.has('r')).toBe(false);
 });
});
