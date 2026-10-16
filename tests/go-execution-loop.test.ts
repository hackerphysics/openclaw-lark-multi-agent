import {describe,it,expect} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MessageStore} from "../src/message-store.js";
import {OpenClawClient} from "../src/openclaw-client.js";
import {FeishuBot} from "../src/feishu-bot.js";
import {GoPolicyRegistry} from "../plugins/lma-go/src/registry.js";

/** Real Controller + production public adapters + FeishuBot callbacks/outbox + SQLite.
 * Only host/model/platform transports are synthetic; no evidence is manually inserted. */
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),"go-execution-loop-")),db=join(dir,"messages.db");
 let store=new MessageStore(db);
 const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any;
 const key="agent:main:lma-synthetic-chat",generation="executor-generation";
 const sessions=new Map<string,any>();
 const registry=new GoPolicyRegistry(join(dir,"policy.json"));
 const admissions=new Map<string,any>(),terminals=new Map<string,any>();
 const calls:any[]=[],sends:any[]=[],platform:any[]=[];
 let running=false,queued=0,queryAvailable=true,tasks:any[]=[],lost=false,platformLost=false,terminal:any={disposition:"visible",text:"initial report: appendix missing"};
 let bot:any,checkerRound=0,markCommandPending=false;
 client.getSessionInfo=async(k:string)=>({session:sessions.get(k.startsWith("agent:") ? k : `agent:main:${k}`)});
 client.ensureModel=async()=>false;
 client.patchSession=async()=>({});
 client.injectAssistantMessage=async()=>({});
 client.createSession=async(p:any)=>{sessions.set(p.key.startsWith("agent:") ? p.key : `agent:main:${p.key}`,{sessionId:p.key.includes("lma-go-") ? "checker-generation" : generation,model:p.model,activeLeafEntryId:null,hasActiveRun:false});};
 client.getSessionRuntimeStatus=async()=>({status:running ? "running" : "idle",running});
 client.rpc=async(method:string,p:any)=>{
  calls.push({method,p});
  if(method==="lma.go.capabilities")return {mode:"independent",checkerToolsIsolated:true,taskQuery:true};
  if(method==="lma.go.bind"){registry.bind(p.binding);return {persisted:true,binding:p.binding};}
  if(method==="lma.go.snapshot")return {sessionKey:p.sessionKey,requestedSessionId:p.sessionId,queryAvailable,tasks};
  if(method==="sessions.messages.subscribe")return {};
  if(method==="chat.history")return {sessionInfo:sessions.has(p.sessionKey) ? {...sessions.get(p.sessionKey),hasActiveRun:p.sessionKey===key ? running : false} : null,pendingInputs:{total:queued},inputReceipts:(p.inputRunIds || []).flatMap((r:string)=>admissions.has(r) ? [{runId:r,state:"consumed",consumedByEventId:"original-event"}] : [])};
  if(method==="agent.wait")return terminals.get(p.runId) || {runId:p.runId,status:"running"};
  if(method!=="chat.send")throw new Error(`unexpected synthetic RPC: ${method}`);
  const session=sessions.get(p.sessionKey);
  if(session?.sessionId!==p.sessionId || session.activeLeafEntryId!==p.expectedLeafEntryId || session.archived || !p.suppressCommandInterpretation)throw new Error("guard rejected");
  if(admissions.has(p.idempotencyKey))throw new Error("test forbids replay, even idempotent");
  sends.push(p);admissions.set(p.idempotencyKey,{runId:p.idempotencyKey});
  if(p.sessionKey===key){
   terminals.set(p.idempotencyKey,{runId:p.idempotencyKey,sessionId:generation,status:terminal.status || "ok",endedAt:42,terminalReply:terminal,error:terminal.error});
   if(lost){lost=false;throw new Error("admitted original executor input; response lost");}
  }
  return {runId:p.idempotencyKey};
 };
 // Synthetic Checker model, but all executor terminal collection uses real agent.wait.
 client.collectGoRun=async(p:any)=>{
  if(p.runId.includes("initialization"))return '{"action":"WAIT","summary":"initialized"}';
  const job=store.getActiveGoJob("synthetic","chat")!;
  const events=store.listGoEventsSince(job.id,0);
  expect(events.length).toBeGreaterThan(0);
  checkerRound++;
  if(checkerRound===1)return '{"action":"CONTINUE","summary":"missing appendix","missing":["原目标附录"]}';
  const last=events.filter(e=>e.kind==="assistant_reply").at(-1)!;
  return JSON.stringify({action:"COMPLETE",summary:"original criteria covered",evidence_refs:[`E${last.seq}`],criteria_evidence:{C1:[`E${last.seq}`]}});
 };
 const makeBot=()=>{
  const b=new FeishuBot({name:"synthetic",appId:"synthetic-id",appSecret:"fixture",model:"synthetic/model"},client,store) as any;
  const send=async(p:any)=>{platform.push(p);if(platformLost){platformLost=false;throw new Error("platform accepted but response lost");}return {code:0,data:{message_id:`platform-${platform.length}`}};};
  b.client={im:{message:{create:send,reply:async(p:any)=>{
   if(markCommandPending && p.path.message_id==="go-command"){
    markCommandPending=false;const row=store.getMessageId("go-command")!;store.markPendingTrigger("synthetic","chat",row);
    const n=sends.length;await b.goController.runCheckCycle("chat");expect(sends).toHaveLength(n);
   }
   return send(p);
  }},file:{create:async()=>({data:{file_key:"fixture-file-key"}})},image:{create:async()=>({data:{image_key:"fixture-image-key"}})}}};
  b.fetchAndCacheChatInfo=async()=>{};
  b.validateBridgeAttachmentPath=(p:string)=>p;
  b.readSessionStatus=async()=>({status:running ? "running" : "idle",running});
  return b;
 };
 bot=makeBot();
 const goal="生成报告并交付原目标附录附件";
 const start=async(pending=false)=>{
  markCommandPending=pending;
  await bot.handleMessage({message:{chat_id:"chat",chat_type:"p2p",message_type:"text",message_id:"go-command",content:JSON.stringify({text:`/go ${goal}`})},sender:{sender_type:"user",sender_id:{open_id:"user"}}});
  const job=store.getActiveGoJob("synthetic","chat")!;
  expect(job?.state).toBe("WAITING_WORK");expect(sends).toHaveLength(1); // Checker only. Command never awaits executor.
  expect(bot.goController.timers.size).toBe(1); // initial cycle already armed without executor evidence
  return job;
 };
 const cycle=()=>bot.goController.runCheckCycle("chat");
 const control=(command:string)=>bot.goController.handleGoCommand("chat",`control-${command}`,command);
 const restart=async()=>{
  for(const t of bot.deliveryRetryTimers.values())clearTimeout(t);
  store.close();store=new MessageStore(db);FeishuBot.getAllBots().clear();bot=makeBot();
  await bot.ensureSession("chat");await bot.goController.recoverOnStartup();
 };
 return {dir,client,calls,sends,platform,terminals,admissions,goal,key,generation,start,cycle,control,restart,
  get store(){return store;},get bot(){return bot;},get exec(){return sends.filter(s=>s.sessionKey===key);},
  set:(p:any)=>{if(p.running!==undefined)running=p.running;if(p.queued!==undefined)queued=p.queued;if(p.queryAvailable!==undefined)queryAvailable=p.queryAvailable;if(p.tasks!==undefined)tasks=p.tasks;if(p.lost!==undefined)lost=p.lost;if(p.platformLost!==undefined)platformLost=p.platformLost;if(p.terminal!==undefined)terminal=p.terminal;},
  cleanup:async()=>{for(const t of bot.deliveryRetryTimers.values())clearTimeout(t);store.close();await client.disconnect();FeishuBot.getAllBots().clear();rmSync(dir,{recursive:true,force:true});}
 };
}

describe("Go command starts a real execution/delivery/checker loop (synthetic transports)",()=>{
 it("only /go goal -> initial execute -> actual body receipt -> CONTINUE -> execute -> body+attachment receipts -> COMPLETE",async()=>{
  const h=fixture();try{
   const job=await h.start(true);expect(h.store.getPendingTriggerIds("synthetic","chat").size).toBe(0);
   expect(h.store.maxGoEventSeq(job.id)).toBe(0);
   await h.cycle();expect(h.exec).toHaveLength(1);expect(h.exec[0].message.startsWith(h.goal)).toBe(true);
   const initial=h.store.listGoVisibleEvidence(job.id).find(e=>e.sourceKey.startsWith("outbox:"))!;
   expect(initial).toMatchObject({sessionId:h.generation,runId:h.exec[0].idempotencyKey,text:"initial report: appendix missing"});
   expect(initial.receipt.messages[0].messageId).toMatch(/^platform-/);
   const file=join(h.dir,"appendix.txt");writeFileSync(file,"synthetic original-goal appendix");
   h.set({terminal:{disposition:"visible",text:`completed report\n<LMA_BRIDGE_ATTACHMENTS>${JSON.stringify({attachments:[{type:"file",path:file,caption:"original appendix"}]})}</LMA_BRIDGE_ATTACHMENTS>`}});
   await h.cycle();expect(h.exec).toHaveLength(2);
   expect(h.store.getGoJobById(job.id)?.continueCount).toBe(1);
   const followup=h.store.listGoVisibleEvidence(job.id).filter(e=>e.sourceKey.startsWith("outbox:")).at(-1)!;
   expect(followup).toMatchObject({sessionId:h.generation,runId:h.exec[1].idempotencyKey,text:"completed report"});
   expect(followup.attachments).toHaveLength(1);
   expect(followup.receipt.messages.some((r:any)=>r.payload.msg_type==="file" && r.messageId)).toBe(true);
   const count=h.platform.length;
   // Direct subscription callback, not just the client suppressor, is also deduped.
   await h.client.sessionMessageCallbacks.get(h.key)("completed report",{sessionKey:h.key,sessionId:h.generation,runId:h.exec[1].idempotencyKey,final:true});
   expect(h.platform).toHaveLength(count);
   await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("COMPLETED");
   expect(h.calls.some(c=>c.method.includes("goal"))).toBe(false);
   const n=h.sends.length;await h.restart();await h.cycle();expect(h.sends).toHaveLength(n);
   const delivered=h.platform.length;await h.client.sessionMessageCallbacks.get(h.key)("completed report",{sessionKey:h.key,sessionId:h.generation,runId:h.exec[1].idempotencyKey,final:true});expect(h.platform).toHaveLength(delivered);
  }finally{await h.cleanup();}
 });
 it.each([{running:true},{queued:1},{queryAvailable:false},{tasks:[{id:"main",runId:"old-run",status:"running",deliveryStatus:"not_applicable"}]},{tasks:[{id:"main",runId:"old-run",status:"completed",deliveryStatus:"not_applicable"},{id:"child",runId:"child-run",parentTaskId:"main",status:"completed",deliveryStatus:"pending"}]}])("waits for main/queue/unknown/descendant boundaries before first admission %j",async state=>{
  const h=fixture();try{await h.start();h.set(state);await h.cycle();expect(h.exec).toHaveLength(0);h.set({running:false,queued:0,queryAvailable:true,tasks:[]});await h.cycle();expect(h.exec).toHaveLength(1);await h.cycle();expect(h.exec).toHaveLength(2);}finally{await h.cleanup();}
 });
 it.each(["pause","stop","input"])("%s while initial idle observation is awaiting invalidates the CAS and admits nothing",async action=>{
  const h=fixture();try{
   const job=await h.start();let release!:(r:any)=>void;
   const original=h.client.readGoRuntimeSnapshot.bind(h.client);
   h.client.readGoRuntimeSnapshot=async(...args:any[])=>{const s=await original(...args);return new Promise(r=>{release=()=>r(s);});};
   const cycle=h.cycle();for(let i=0;!release && i<100;i++)await new Promise(r=>setTimeout(r,1));expect(release).toBeTypeOf("function");
   if(action==="input")h.bot.goController.onHumanInput("chat");else await h.control(action);
   release(null);await cycle;expect(h.exec).toHaveLength(0);expect(h.store.getGoJobById(job.id)?.state).toBe(action==="stop" ? "STOPPED" : "PAUSED");
  }finally{await h.cleanup();}
 });
 it.each(["pause","stop","input"])("%s during execution retains ordinary result delivery but cannot revive automatic followups",async action=>{
  const h=fixture();try{
   const job=await h.start();let release!:(r:any)=>void;
   const original=h.client.collectGoExecutorRun.bind(h.client);
   h.client.collectGoExecutorRun=async(p:any)=>{const result=await original(p);return new Promise(r=>{release=()=>r(result);});};
   const cycle=h.cycle();for(let i=0;!release && i<100;i++)await new Promise(r=>setTimeout(r,1));
   if(action==="input")h.bot.goController.onHumanInput("chat");else await h.control(action);
   release(null);await cycle;expect(h.exec).toHaveLength(1);expect(h.platform.some(p=>p.data.content.includes("initial report"))).toBe(true);
   if(action==="input")await h.control("pause");await h.cycle();expect(h.exec).toHaveLength(1);expect(h.store.getGoJobById(job.id)?.state).not.toBe("COMPLETED");
  }finally{await h.cleanup();}
 });
 it("stop + new Go cannot steal a late old-run body or attachment receipt",async()=>{
  const h=fixture();try{
   const originalJob=await h.start();let release!:(r:any)=>void;
   const original=h.client.collectGoExecutorRun.bind(h.client);
   h.client.collectGoExecutorRun=async(p:any)=>{const result=await original(p);return new Promise(r=>{release=()=>r(result);});};
   const pending=h.cycle();for(let i=0;!release && i<100;i++)await new Promise(r=>setTimeout(r,1));
   await h.control("stop");await h.control("new approved objective");const newJob=h.store.getActiveGoJob("synthetic","chat")!;
   expect(newJob.id).not.toBe(originalJob.id);release(null);await pending;
   expect(h.store.maxGoEventSeq(newJob.id)).toBe(0);
   expect(h.store.listGoVisibleEvidence(newJob.id)).toHaveLength(0);
   expect(h.store.listGoVisibleEvidence(originalJob.id)[0]).toMatchObject({runId:h.exec[0].idempotencyKey});
   expect(h.store.listGoVisibleEvidence(originalJob.id)[0].receipt.messages[0].messageId).toMatch(/^platform-/);
   expect(h.store.getGoJobById(originalJob.id)?.state).toBe("STOPPED");
  }finally{await h.cleanup();}
 });
 it("queued local human triggers also block initial admission without consuming or replaying them",async()=>{
  const h=fixture();try{
   await h.start();const row=h.store.insert({chatId:"chat",messageId:"ordinary-pending",senderType:"human",senderName:"user",content:"existing business input",timestamp:1,triggerKind:"normal"});
   h.store.markPendingTrigger("synthetic","chat",row);await h.cycle();expect(h.exec).toHaveLength(0);expect(h.store.getPendingTriggerIds("synthetic","chat")).toEqual(new Set([row]));
   h.store.clearPendingTrigger("synthetic","chat",row);await h.cycle();expect(h.exec).toHaveLength(1);
  }finally{await h.cleanup();}
 });
 it("accepted initial admission with lost response is never replayed after DB restart; resume reconciles original result and delivers once",async()=>{
  const h=fixture();try{
   const job=await h.start();h.set({lost:true});await h.cycle();expect(h.exec).toHaveLength(1);expect(h.store.getGoJobById(job.id)?.state).toBe("PAUSED");
   await h.restart();await h.cycle();expect(h.exec).toHaveLength(1);
   await h.control("resume");expect(h.exec).toHaveLength(1);expect(h.store.getGoBootstrap(job.id)).toBe("done");expect(h.store.hasUnresolvedGoActions(job.id)).toBe(false);
   const receipts=h.store.listGoVisibleEvidence(job.id).filter(e=>e.sourceKey.startsWith("outbox:"));expect(receipts).toHaveLength(1);expect(receipts[0].receipt.messages[0].messageId).toMatch(/^platform-/);
   await h.restart();expect(h.exec).toHaveLength(1);expect(h.store.listGoVisibleEvidence(job.id).filter(e=>e.sourceKey.startsWith("outbox:"))).toHaveLength(1);
  }finally{await h.cleanup();}
 });
 it.each(["silent","empty"])("authoritative %s is terminal non-completion evidence, not a timeout or an invisible successful receipt",async disposition=>{
  const h=fixture();try{const job=await h.start();h.set({terminal:{disposition}});const n=h.platform.length;await h.cycle();expect(h.platform).toHaveLength(n);const events=h.store.listGoEventsSince(job.id,0);expect(events).toHaveLength(1);expect(events[0].kind).toBe("no_reply");expect(events[0].content).toContain(disposition==="silent" ? "NO_REPLY" : "terminalReply.empty");expect(h.store.listGoVisibleEvidence(job.id)).toHaveLength(0);expect(h.store.getGoJobById(job.id)?.state).toBe("WAITING_WORK");}finally{await h.cleanup();}
 });
 it("authoritative terminal error is delivered as error evidence and pauses, never COMPLETE",async()=>{
  const h=fixture();try{const job=await h.start();h.set({terminal:{status:"error",error:"synthetic terminal provider error"}});await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("PAUSED");expect(h.store.listGoEventsSince(job.id,0)[0].kind).toBe("run_error");expect(h.store.listGoVisibleEvidence(job.id)[0].receipt.messages[0].messageId).toMatch(/^platform-/);await h.cycle();expect(h.exec).toHaveLength(1);}finally{await h.cleanup();}
 });
 it("platform lost response fences the result without manufacturing evidence or replaying sends after restart",async()=>{
  const h=fixture();try{const job=await h.start();h.set({platformLost:true});await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("PAUSED");expect(h.store.listGoEventsSince(job.id,0)).toHaveLength(0);const n=h.platform.length;await h.restart();await h.control("resume");expect(h.exec).toHaveLength(1);expect(h.platform).toHaveLength(n+1); // only explicit resume's rejection reply
   expect(h.store.getGoJobById(job.id)?.state).toBe("PAUSED");expect(h.store.listGoVisibleEvidence(job.id)[0].receipt).toBeNull();
  }finally{await h.cleanup();}
 });
});
