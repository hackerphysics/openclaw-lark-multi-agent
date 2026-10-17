import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {setActiveEmbeddedRun,clearActiveEmbeddedRun,emitAgentEvent,resetAgentEventsForTest} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {registerSteer} from '../plugins/lma-core/src/steer.js';
import {FeishuBot} from '../src/feishu-bot.js';
import {harness,event} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>,dir:string,dispose:()=>void,methods:Map<string,any>,handle:any,calls:number;
let activity:any,history:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
beforeEach(async()=>{
 vi.useFakeTimers();h=harness();dir=mkdtempSync(join(tmpdir(),'lma-external-sdk-'));vi.stubEnv('OPENCLAW_STATE_DIR',dir);calls=0;methods=new Map();
 dispose=registerSteer({registerGatewayMethod:(name:string,fn:any)=>methods.set(name,fn)});
 activity={status:'running',hasActiveRun:true,sessionId:'generation-1'};
 history={sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:true},inFlightRun:{runId:'external-root'},pendingInputs:{total:0}};
 const base=h.client.rpc;
 h.client.rpc=vi.fn(async(m:string,p:any)=>{
  if(m==='sessions.describe')return {session:activity};if(m==='chat.history')return history;
  if(methods.has(m)){let result:any;await methods.get(m)({params:p,respond:(ok:boolean,value:any)=>{if(!ok)throw new Error('plugin fixture rejected');result=value;}});return result;}
  return base(m,p);
 });
 handle={kind:'embedded',runId:'external-root',isStreaming:()=>true,isCompacting:()=>false,isStopped:()=>false,abort:()=>{},supportsTranscriptCommitWait:true,
  queueMessage:async(_text:string,options:any)=>{calls++;options?.onQueueAccepted?.(true);}};
 setActiveEmbeddedRun('generation-1',handle,h.key);emitAgentEvent({sessionKey:h.key,sessionId:'generation-1',runId:'external-root',stream:'lifecycle',data:{phase:'start',startedAt:Date.now()}});
 h.client.ensureModel=vi.fn(async()=>false);h.bot.ensureSession=(FeishuBot.prototype as any).ensureSession.bind(h.bot);
 const connected=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await connected;
});
afterEach(async()=>{dispose();clearActiveEmbeddedRun('generation-1',handle,h.key);resetAgentEventsForTest();await h.cleanup();rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.clearAllTimers();vi.useRealTimers();});
describe('Gateway current run routing without local queue ownership',()=>{
 it('identified external active root uses the real public SDK callback, not a concurrent chat.send or a hijacked trigger',async()=>{
  await h.bot.handleMessage(event('A'));await tick(100);expect(h.sends).toHaveLength(0);expect(calls).toBe(1);
  const row=h.store.getMessageId('A')!,item=h.store.getInsertion('Bot','chat',row);expect(item.state).toBe('accepted');expect(item.expectedRunId).toBe('external-root');
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('Get');expect(h.store.getDeliveryRunTarget('Bot','chat','external-root')).toBeNull();
  h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event:'chat',payload:{sessionKey:h.key,runId:'external-root',state:'final',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'external root existing result'}]}}})));
  await tick(100);expect(h.store.getDeliveryByKey('Bot','chat',`trigger:${row}`)).toBeNull();expect(h.store.getRecent('chat').filter(m=>m.senderType==='bot').map(m=>m.content)).toEqual(['external root existing result']);
  expect(h.store.getReactionIntent('Bot','chat',row).desired).toBe('DONE');expect(h.sends).toHaveLength(0);expect(calls).toBe(1);
 });
 it.each(['root-missing','lookup-unknown'])('live %s retains unbound input without fabricated root, Get or blind ordinary admission',async(mode)=>{
  if(mode==='root-missing')history={...history,inFlightRun:undefined};else {activity={sessionId:'generation-1',status:'future_state'};history={};}
  await h.bot.handleMessage(event('A'));await tick(100);const item=h.store.getInsertion('Bot','chat',h.store.getMessageId('A')!);
  expect(item.activityUnbound).toBe(true);expect(item.expectedRunId).toBe('');expect(h.sends).toHaveLength(0);expect(calls).toBe(0);expect(h.bot.addReaction).not.toHaveBeenCalledWith('A','Get');
  // A later explicit idle observation releases the NEVER attempted input once.
  activity={sessionId:'generation-1',status:'done',hasActiveRun:false};history={sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:0}};h.store['db'].prepare('UPDATE insertion_custody SET next_check_at=0').run();await h.bot.reconcileInsertions('chat');await tick(100);
  expect(h.sends).toHaveLength(1);h.final('r1','A new ordinary result');await tick(350);expect(h.sends).toHaveLength(1);
 });
 it('capability lookup failure records sanitized exact stage and cause, never a fake acceptance',async()=>{
  const base=h.client.rpc;h.client.rpc=vi.fn(async(m:string,p:any)=>{if(m==='lma.steer.capabilities')throw new Error('RPC error: {"code":"INVALID_REQUEST","message":"unknown method lma.steer.capabilities"}');return base(m,p);});
  await h.bot.handleMessage(event('A'));await tick(100);const item=h.store.getInsertion('Bot','chat',h.store.getMessageId('A')!);
  expect(item.reason).toContain('capabilities');expect(item.reason).toContain('INVALID_REQUEST');expect(item.reason).toContain('unknown method');expect(item.attempted).toBe(false);expect(calls).toBe(0);expect(h.sends).toHaveLength(0);
 });
});

describe('external activity cannot be replaced by local-map absence',()=>{
 it('pending inputs with a false active flag retain new input instead of opening another ordinary run',async()=>{
  activity={sessionId:'generation-1',status:'done',hasActiveRun:false};history={sessionKey:h.key,sessionInfo:{sessionId:'generation-1',hasActiveRun:false},pendingInputs:{total:1}};
  await h.bot.handleMessage(event('A'));await tick(100);expect(h.sends).toHaveLength(0);expect(calls).toBe(0);expect(h.store.getInsertion('Bot','chat',h.store.getMessageId('A')!)?.activityUnbound).toBe(true);
 });
 it('startup pending input is also routed to identified external active root through public callback',async()=>{
  h.store.upsertChatInfo({chatId:'chat',chatType:'p2p',chatName:'offline',members:'',memberNames:'',ownerBot:'Bot',freeDiscussion:false,verbose:false,discuss:false,discussMaxRounds:10,updatedAt:Date.now()});
  const row=h.store.insert({chatId:'chat',messageId:'A',senderType:'human',senderName:'user',content:'A',timestamp:Date.now()});h.store.markPendingTrigger('Bot','chat',row);
  await h.bot.processQueue('chat');await tick(100);expect(h.sends).toHaveLength(0);expect(calls).toBe(1);expect(h.store.getInsertion('Bot','chat',row)?.state).toBe('accepted');
 });
});
