import {describe,it,expect} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GoController} from "../src/go-controller.js";
import {MessageStore} from "../src/message-store.js";
import {OpenClawClient} from "../src/openclaw-client.js";
import {GoPolicyRegistry} from "../plugins/lma-go/src/registry.js";
import {checkTool} from "../plugins/lma-go/src/policy.js";
import {goSnapshotBlocked} from "../src/go-runtime-gate.js";
import {FeishuBot} from "../src/feishu-bot.js";

function runtime() {
 const dir=mkdtempSync(join(tmpdir(),"go-full-loop-")); const store=new MessageStore(join(dir,"db"));
 const policy=new GoPolicyRegistry(join(dir,"policy.json")); const sessions=new Map<string,any>();
 sessions.set("lma-synthetic-chat",{sessionId:"executor-generation",model:"synthetic/model",activeLeafEntryId:null});
 const admissions=new Map<string,any>(); const sends:any[]=[];const outputs:string[]=["initialized"];const notices:string[]=[];
 let revision=1, busy="completed",delivery="delivered",queued=0,recoverable=0,pending=0,complete=true,child=false,lost=false;
 const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any;client.goEvidenceObservers=new Set();client.onToolEvent=()=>{};
 client.getSessionInfo=async(key:string)=>({session:sessions.get(key)});client.getGoSessionInfo=client.getSessionInfo;
 client.createSession=async(p:any)=>sessions.set(p.key,{sessionId:"checker-generation",model:p.model,activeLeafEntryId:null});
 const snapshot=(key:string,sid:string)=>({sessionKey:key.startsWith("agent:") ? key : `agent:main:${key}`,sessionId:sid,goalId:"native",goalRevision:revision,executorRunIds:store.getGoNativeIdentity(1)?.executorRunIds ?? ["executor-root"],checkerRunId:store.getGoNativeIdentity(1)?.checkerRunId ?? "checker-root",complete,archived:false,queuedInputs:queued,recoverableInputs:recoverable,pendingDeliveries:pending,tasks:[...(store.getGoNativeIdentity(1)?.executorRunIds ?? ["executor-root"]).map((runId:string,i:number)=>({taskId:i?`followup-${i}`:"root",runId,parentTaskId:null,state:busy,deliveryState:delivery})),...(child?[{taskId:"child",runId:"child-run",parentTaskId:"root",state:"running",deliveryState:"pending"}]:[])]});
 client.rpc=async(method:string,p:any)=>{
  if(method==="chat.history") return {inputReceipts:p.inputRunIds.flatMap((id:string)=>admissions.has(id)?[{runId:id,state:"consumed",consumedByEventId:"event"}]:[])};
  if(method!=="chat.send") throw new Error(`unsupported synthetic RPC ${method}`);
  const session=sessions.get(p.sessionKey.replace(/^agent:main:/,""));
  if(!session || session.archived || session.sessionId!==p.sessionId || session.activeLeafEntryId!==p.expectedLeafEntryId || !p.suppressCommandInterpretation) throw new Error("admission guard rejected");
  if(admissions.has(p.idempotencyKey)) return admissions.get(p.idempotencyKey);
  sends.push(p);const receipt={runId:p.idempotencyKey};admissions.set(p.idempotencyKey,receipt);
  if(lost){lost=false;throw new Error("accepted, response lost");}return receipt;
 };
 client.collectGoRun=async(p:any)=>{expect(admissions.has(p.runId)).toBe(true);return outputs.shift() ?? "executor finished";};
 client.collectGoExecutorRun=async(p:any)=>({sessionKey:p.sessionKey,sessionId:p.sessionId,runId:p.runId,disposition:"visible",text:await client.collectGoRun(p)});
 client.readGoExecutorRunResult=async(p:any)=>({sessionKey:p.sessionKey,sessionId:p.sessionId,runId:p.runId,disposition:"visible",text:"recovered original executor result"});
 client.getSessionRuntimeStatus=async()=>({running:busy==="running"});
 client.initializeGoRuntime=async(p:any)=>{policy.bind({checkerSessionKey:`agent:main:${p.checkerSessionKey}`,checkerSessionId:p.checkerSessionId,executorSessionKey:`agent:main:${p.executorSessionKey}`,executorSessionId:p.executorSessionId,goalId:"native"});return {nativeGoalId:"native",executorSessionId:p.executorSessionId,checkerSessionId:p.checkerSessionId,checkerRunId:"checker-root",executorRunIds:["executor-root"],goalUpdatedAt:1,goalRevision:revision};};
 client.readGoRuntimeSnapshot=async(key:string,sid:string)=>snapshot(key,sid);
 client.verifyGoSafety=async()=>({checkerToolsIsolated: Boolean(checkTool(policy.list().length ? policy.list() : [{checkerSessionKey:"synthetic-checker",checkerSessionId:"checker-generation",executorSessionKey:"lma-synthetic-chat",executorSessionId:"executor-generation",goalId:"native"}],{toolName:"exec",params:{}},{sessionId:"checker-generation"})?.block),exactTaskAndDeliveryGate:typeof client.readGoRuntimeSnapshot==="function",guardedSend:typeof client.sendGoGuarded==="function"});
 const make=()=>new GoController({botName:"synthetic",fallbackModel:"synthetic/model",store,client,executorSessionKeyFor:()=>"lma-synthetic-chat",notify:async(_chat,text)=>{notices.push(text);return "synthetic-notice";},reply:async()=>"synthetic-reply",deliverExecutorResult:async()=>{}});
 let controller=make();
 const start=async()=>{await controller.handleGoCommand("chat","start","授权合成目标：生成报告与附件");const job=store.getActiveGoJob("synthetic","chat")!;store.finishGoBootstrap(job.id,"done");return job;};
 const evidence=(id:number,key:string,attachments:any[]=[])=>{store.recordGoVisibleEvidence(id,key,{sessionId:"executor-generation",runId:"executor-root",kind:"assistant_visible",text:"synthetic report",attachments});store.recordGoDeliveryReceipt(id,key,{messages:[{messageId:`message-${key}`} ]});controller.notifyRunOutcome("chat","assistant_reply",key,"synthetic report");};
 const cycle=()=> (controller as any).runCheckCycle("chat");
 return {dir,store,client,policy,sends,outputs,notices,start,evidence,cycle,get controller(){return controller;},restart:async()=>{controller.dispose();controller=make();await controller.recoverOnStartup();},set:(p:any)=>{if(p.revision!==undefined)revision=p.revision;if(p.busy!==undefined)busy=p.busy;if(p.delivery!==undefined)delivery=p.delivery;if(p.queued!==undefined)queued=p.queued;if(p.recoverable!==undefined)recoverable=p.recoverable;if(p.pending!==undefined)pending=p.pending;if(p.complete!==undefined)complete=p.complete;if(p.child!==undefined)child=p.child;if(p.lost!==undefined)lost=p.lost;},cleanup:()=>{controller.dispose();store.close();FeishuBot.getAllBots().clear();rmSync(dir,{recursive:true,force:true});}};
}

describe("Controller/public-admission conservative legacy observation fixtures",()=>{
 it("WAIT → CONTINUE → guarded execution → actual evidence receipts → COMPLETE, no replay on restart",async()=>{
  const h=runtime();try {const job=await h.start();expect(job.state).toBe("WAITING_WORK");expect(checkTool(h.policy.list(),{toolName:"tool_call",params:{id:"exec"}},{sessionId:"checker-generation"})?.block).toBe(true);
   h.evidence(job.id,"first");h.outputs.push('{"action":"WAIT","summary":"report pending"}');await h.cycle();expect(h.store.getGoJobById(job.id)?.lastVerdict).toBe("WAIT");
   h.evidence(job.id,"second");h.outputs.push('{"action":"CONTINUE","summary":"missing attachment","missing":["原目标附件"]}',"executor finished");await h.cycle();expect(h.store.getGoJobById(job.id)?.continueCount).toBe(1);
   const executor=h.sends.filter(s=>s.sessionKey.endsWith("lma-synthetic-chat"));expect(executor).toHaveLength(1);expect(executor[0]).toMatchObject({sessionId:"executor-generation",suppressCommandInterpretation:true});
   h.evidence(job.id,"third",[{path:"/synthetic/report",read:false}]);const seq=h.store.maxGoEventSeq(job.id);h.outputs.push(JSON.stringify({action:"COMPLETE",summary:"all authorized criteria covered",evidence_refs:[`E${seq}`],criteria_evidence:{C1:[`E${seq}`]}}));await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("COMPLETED");const count=h.sends.length;await h.restart();await h.cycle();expect(h.sends).toHaveLength(count);expect(h.notices.some(n=>n.includes("验收通过"))).toBe(true);
  }finally{h.cleanup();}
 });
 it.each([{busy:"running"},{child:true},{delivery:"pending"},{queued:1},{recoverable:1},{pending:1},{complete:false}])("does not invoke models or complete for busy/unknown state %j",async state=>{
  const h=runtime();try{const job=await h.start();h.evidence(job.id,"e");h.set(state);const count=h.sends.length;await h.cycle();expect(h.sends).toHaveLength(count);expect(h.store.getGoJobById(job.id)?.state).toBe("WAITING_WORK");}finally{h.cleanup();}
 });
 it("goal edits invalidate the gate, partial/no receipt cannot certify criteria",async()=>{
  const h=runtime();try{const job=await h.start();h.evidence(job.id,"e");h.set({revision:2});const count=h.sends.length;await h.cycle();expect(h.sends).toHaveLength(count);h.set({revision:1});await h.controller.handleGoCommand("chat","resume","resume");h.outputs.push('{"action":"COMPLETE","summary":"done","evidence_refs":["E1"]}');await h.cycle();expect(h.store.getGoJobById(job.id)?.pauseReason).toContain("criteria");}finally{h.cleanup();}
 });
 it("lost admission response reconciles original public receipt without resending on resume/restart",async()=>{
  const h=runtime();try{const job=await h.start();h.evidence(job.id,"e");h.outputs.push('{"action":"CONTINUE","summary":"missing","missing":["报告"]}');const original=h.client.sendGoGuarded.bind(h.client);h.client.sendGoGuarded=async(p:any)=>{if(p.sessionKey===job.executorSessionKey)h.set({lost:true});return original(p);};await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("PAUSED");const count=h.sends.length;await h.restart();await h.controller.handleGoCommand("chat","resume","resume");expect(h.store.hasUnresolvedGoActions(job.id)).toBe(false);expect(h.sends).toHaveLength(count);expect(h.store.getGoJobById(job.id)?.state).toBe("WAITING_WORK");}finally{h.cleanup();}
 });
 it.each(["pause","stop","reset","input"])("late checker verdict cannot revive after %s",async action=>{
  const h=runtime();try{const job=await h.start();h.evidence(job.id,"e");let release!:(s:string)=>void;h.client.collectGoRun=()=>new Promise<string>(r=>{release=r;});const pending=h.cycle();for(let i=0;!release && i<100;i++)await new Promise(r=>setTimeout(r,1));expect(release).toBeTypeOf("function");if(action==="reset")await h.controller.onExecutorSessionChanged("chat","reset");else if(action==="input")h.controller.onHumanInput("chat");else await h.controller.handleGoCommand("chat","control",action);release('{"action":"COMPLETE","summary":"done","evidence_refs":["E1"],"criteria_evidence":{"C1":["E1"]}}');await pending;expect(h.store.getGoJobById(job.id)?.state).not.toBe("COMPLETED");expect(h.notices.some(n=>n.includes("验收通过"))).toBe(false);}finally{h.cleanup();}
 });
 it("real bridge dispatch captures body, file/image payloads and captions separately; restart never replays",async()=>{
  const h=runtime();let bot:FeishuBot|undefined;try{const job=await h.start();bot=new FeishuBot({name:"synthetic",appId:"synthetic-id",appSecret:"not-a-secret",model:"synthetic/model"},h.client,h.store);
   const api:any=bot;const messages:any[]=[];api.client={im:{message:{create:async(p:any)=>{if(p.data.msg_type==="interactive" && p.data.content.length>4000)throw Object.assign(new Error("length of the message content"),{response:{data:{code:230025,msg:"length of the message content"}}});messages.push(p);return {data:{message_id:`platform-${messages.length}`}};},reply:async(p:any)=>{messages.push(p);return {data:{message_id:`platform-${messages.length}`}};}},file:{create:async()=>({data:{file_key:"synthetic-file"}})},image:{create:async()=>({data:{image_key:"synthetic-image"}})}}};
   api.validateBridgeAttachmentPath=(p:string)=>p;api.readSessionStatus=async()=>({status:"idle",running:false});
   const file=join(h.dir,"report.txt"),image=join(h.dir,"report.png");writeFileSync(file,"synthetic report");writeFileSync(image,"synthetic image fixture");
   await api.enqueueAndDispatchDelivery("chat","assistant_visible","synthetic-outbox","report body ".repeat(1200),[{type:"file",path:file,caption:"file caption"},{type:"image",path:image,caption:"image caption"}],undefined,"synthetic-key",undefined,{sessionKey:job.executorSessionKey,sessionId:job.executorSessionId,runId:"executor-root",final:true});
   const evidence=h.store.listGoVisibleEvidence(job.id).find(e=>e.sourceKey.startsWith("outbox:"));expect(evidence.text.length).toBeGreaterThan(10000);expect(evidence.attachments).toHaveLength(2);expect(evidence.receipt.messages.length).toBeGreaterThanOrEqual(5);expect(evidence.receipt.messages.some((m:any)=>m.payload.msg_type==="file")).toBe(true);expect(evidence.receipt.messages.some((m:any)=>m.payload.msg_type==="image")).toBe(true);expect(evidence.receipt.partial).not.toBe(true);const count=messages.length;await api.dispatchPendingDeliveries("chat");expect(messages).toHaveLength(count);
  }finally{(bot as any)?.goController?.dispose();h.cleanup();}
 });
 it.each(["accepted","unknown"])("durable platform operation %s is not resent after database restart",async outcome=>{
  const h=runtime();let bot:FeishuBot|undefined,reopened:MessageStore|undefined;
  try {
   const job=await h.start();bot=new FeishuBot({name:"synthetic",appId:"synthetic-id",appSecret:"fixture",model:"synthetic/model"},h.client,h.store);
   const api:any=bot;let calls=0;
   api.client={im:{message:{create:async()=>{calls++;if(outcome==="unknown")throw new Error("platform accepted, reply lost");return {data:{message_id:"original-platform-id"}};},reply:async()=>({})}}};api.installGoReceiptCapture();
   const context=()=>({receipts:[],goId:job.id,outboxId:777,stage:"attachment:0",ordinals:new Map(),onReceipt:()=>{}});
   const invoke=()=>api.goDeliveryReceipts.run(context(),()=>api.client.im.message.create({data:{msg_type:"file",content:"original-file-key"}}));
   if(outcome==="unknown")await expect(invoke()).rejects.toThrow("reply lost");else expect((await invoke()).data.message_id).toBe("original-platform-id");
   h.store.close();reopened=new MessageStore(join(h.dir,"db"));api.store=reopened;
   if(outcome==="unknown")await expect(invoke()).rejects.toThrow("cannot be replayed");else expect((await invoke()).data.message_id).toBe("original-platform-id");
   expect(calls).toBe(1);
  } finally {reopened?.close();(bot as any)?.goController?.dispose();h.cleanup();}
 });

 it.each(["pause","stop","reset","input"])("initialization cancelled by %s never admits a checker model run",async action=>{
  const h=runtime();try {
   const original=h.client.initializeGoRuntime;let release!:(v:any)=>void;
   h.client.initializeGoRuntime=async(p:any)=>{const identity=await original(p);return new Promise(r=>{release=()=>r(identity);});};
   const initializing=h.controller.handleGoCommand("chat","init","synthetic goal");
   for(let i=0;!release && i<100;i++)await new Promise(r=>setTimeout(r,1));expect(release).toBeTypeOf("function");
   if(action==="reset")await h.controller.onExecutorSessionChanged("chat","reset");else if(action==="input")h.controller.onHumanInput("chat");else await h.controller.handleGoCommand("chat","control",action);
   release(null);await initializing;expect(h.sends).toHaveLength(0);expect(h.store.getActiveGoJob("synthetic","chat")?.state).not.toBe("WAITING_WORK");
  } finally {h.cleanup();}
 });

});

describe("independent Controller with real production adapter and public local runtime fixture",()=>{
 it("starts, WAIT, CONTINUE, completes and recovers without any native Goal dependency",async()=>{
  const h=runtime();try{
   // Keep model/platform outputs synthetic; exercise the actual production binding/query adapters.
   for(const name of ["verifyGoSafety","initializeGoRuntime","readGoRuntimeSnapshot","getGoSessionInfo"])
    h.client[name]=(OpenClawClient.prototype as any)[name];
   delete h.client.completeGoNativeGoalCas;
   const original=h.client.rpc.bind(h.client);const calls:string[]=[];let pending=0;
   h.client.rpc=async(method:string,p:any)=>{calls.push(method);
    if(method==="lma.go.capabilities")return {mode:"independent",checkerToolsIsolated:true,taskQuery:true,atomicSnapshot:false};
    if(method==="lma.go.bind"){h.policy.bind(p.binding);return {persisted:true,binding:p.binding};}
    if(method==="lma.go.snapshot")return {sessionKey:p.sessionKey,requestedSessionId:p.sessionId,queryAvailable:true,tasks:[]};
    if(method==="chat.history" && !p.inputRunIds){const session=(await h.client.getSessionInfo(p.sessionKey.replace(/^agent:main:/,""))).session;return {sessionInfo:{...session,hasActiveRun:false},pendingInputs:{total:pending}};}
    return original(method,p);
   };
   const job=await h.start();expect(job.state).toBe("WAITING_WORK");expect(h.store.getGoNativeIdentity(job.id).nativeGoalId).toBeUndefined();
   h.evidence(job.id,"one");pending=1;const count=h.sends.length;await h.cycle();expect(h.sends).toHaveLength(count);pending=0;
   h.outputs.push('{"action":"WAIT","summary":"waiting"}');await h.cycle();expect(h.store.getGoJobById(job.id)?.lastVerdict).toBe("WAIT");
   h.evidence(job.id,"two");h.outputs.push('{"action":"CONTINUE","summary":"missing","missing":["report"]}',"executor result");await h.cycle();expect(h.store.getGoJobById(job.id)?.continueCount).toBe(1);
   h.evidence(job.id,"three");h.outputs.push('{"action":"COMPLETE","summary":"done","evidence_refs":["E3"],"criteria_evidence":{"C1":["E3"]}}');await h.cycle();expect(h.store.getGoJobById(job.id)?.state).toBe("COMPLETED");
   await h.restart();expect(calls.some(m=>m.includes("goal"))).toBe(false);
   expect(checkTool(h.policy.list(),{toolName:"tool_call",params:{}},{sessionId:"checker-generation"})?.block).toBe(true);
   expect(checkTool(h.policy.list(),{toolName:"update_goal",params:{}},{sessionId:"executor-generation"})).toBeUndefined();
  }finally{h.cleanup();}
 });
});
