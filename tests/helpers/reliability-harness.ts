import {vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuBot} from '../../src/feishu-bot.js';
import {OpenClawClient} from '../../src/openclaw-client.js';
import {MessageStore} from '../../src/message-store.js';
process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY='0';
export const event=(text:string,id=text)=>({message:{chat_id:'chat',chat_type:'p2p',message_type:'text',message_id:id,content:JSON.stringify({text})},sender:{sender_type:'user',sender_id:{open_id:'human'}}});
export function harness(dbPath?:string) {
 const dir=dbPath?undefined:mkdtempSync(join(tmpdir(),'lma-owner-'));
 const store=new MessageStore(dbPath||join(dir!,'db'));
 const client:any=new OpenClawClient({baseUrl:'ws://offline',token:'offline'});
 let n=0;const sends:any[]=[];
 client.rpc=vi.fn(async(method:string,p:any)=>{
   if(method==='chat.send'){sends.push(p);return {runId:`r${++n}`,status:'started'};}
   if(method==='agent.wait')return {runId:p.runId,status:'timeout'};
   if(method==='chat.abort')return {aborted:true,runIds:['r1']};
   if(method==='sessions.describe')return {session:{sessionId:'generation-1',status:n>0?'running':'done',hasActiveRun:n>0,totalTokens:0}};
   if(method==='lma.steer.capabilities')return {protocol:1,atomicRunBound:false};
   return {};
 });
 const bot:any=new FeishuBot({name:'Bot',appId:'offline-app',appSecret:'offline',model:'offline/model'},client,store);
 let messageN=0;const create=vi.fn(async(p:any)=>({code:0,data:{message_id:`platform-${++messageN}`,chat_id:p.data.receive_id || 'chat'}}));
 bot.client={im:{message:{create,reply:create},file:{create:vi.fn()},image:{create:vi.fn()}}};
 bot.ensureSession=async()=>bot.getSessionKey('chat');
 bot.fetchAndCacheChatInfo=async()=>store.upsertChatInfo({chatId:'chat',chatType:'p2p',chatName:'offline',members:'',memberNames:'',ownerBot:'Bot',freeDiscussion:false,verbose:false,discuss:false,discussMaxRounds:10,updatedAt:Date.now()});
 bot.getUnhealthySessionStatus=async()=>null;
 bot.addReaction=vi.fn(async()=>{});bot.removeReaction=vi.fn(async()=>{});
 bot.replyLiveStatusCard=vi.fn(async()=> 'status');bot.sendLiveStatusCard=vi.fn(async()=> 'status');bot.patchLiveStatusCard=vi.fn(async()=>{});bot.patchLiveStatusDoneSummary=vi.fn(async()=>{});
 const key=client.canonicalSessionKey(bot.getSessionKey('chat'));
 const frame=(runId:string,stream:string,data:any)=>{if(!client.agentEvents.has(key))client.agentEvents.set(key,[]);client.agentEvents.get(key).push({sessionKey:key,runId,stream,data});};
 const final=(runId:string,text='final')=>{frame(runId,'chatFinal',{text});frame(runId,'lifecycle',{phase:'end',livenessState:'working'});};
 const cleanup=async()=>{
  bot.goController?.dispose();if(bot.insertionTimer)clearTimeout(bot.insertionTimer);
  for(const map of [bot.deliveryRetryTimers,bot.errorNoticeTimers,bot.delayedFailureTimers])for(const t of map.values())clearTimeout(t);
  for(const map of [bot.deliveryTargetsByRun,bot.activeDeliveryTargets])for(const v of map.values())if(v.timer)clearTimeout(v.timer);
  client.revokeSessionCollectors(key,'test cleanup');await client.disconnect();await Promise.resolve();store.close();if(dir)rmSync(dir,{recursive:true,force:true});FeishuBot.getAllBots().clear();
 };
 return {bot,client,store,sends,create,key,frame,final,dir,cleanup};
}
