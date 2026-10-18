import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoPolicyRegistry } from "../plugins/lma-go/src/registry.js";
import { checkTool } from "../plugins/lma-go/src/policy.js";
import { OpenClawClient } from "../src/openclaw-client.js";
import { MessageStore } from "../src/message-store.js";
const binding = {checkerSessionKey:"agent:main:checker",checkerSessionId:"checker-generation",executorSessionKey:"agent:main:executor",executorSessionId:"executor-generation",goalId:"native-goal"};
describe("Go public integration isolated synthetic loop", () => {
  it("persists exact restrictions, generation conflict fails and restart denies tools", () => {
    const dir = mkdtempSync(join(tmpdir(),"go-policy-"));
    try {
      const path=join(dir,"bindings.json"); const registry=new GoPolicyRegistry(path);registry.bind(binding); registry.bind(binding);
      expect(()=>registry.bind({...binding,checkerSessionId:"changed"})).toThrow();
      expect(checkTool(new GoPolicyRegistry(path).list(),{toolName:"tool_call",params:{}},{sessionId:binding.checkerSessionId})?.block).toBe(true);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("uses public guarded admission and native goal shape; no archive restore or unsafe completion", async () => {
    const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any; const calls:any[]=[];
    client.rpc=async(method:string,params:any)=>{calls.push({method,params});return {runId:"checker-run"};};
    const p={sessionKey:binding.checkerSessionKey,sessionId:binding.checkerSessionId,expectedLeafEntryId:null,message:"/stop is evidence",idempotencyKey:"stable"};
    expect((await client.sendGoGuarded(p)).runId).toBe("checker-run");
    expect(calls[0].params).toMatchObject({suppressCommandInterpretation:true,idempotencyKey:"stable",sessionId:binding.checkerSessionId});
    await client.createGoNativeGoal({sessionKey:binding.executorSessionKey,sessionId:binding.executorSessionId,objective:"report",operationId:"goal-start",issuedAtMs:1});
    expect(calls[1].params.intent).toEqual({kind:"session-goal-start",version:1,issuedAtMs:1});
    await expect(client.updateGoNativeGoal({action:"complete"})).rejects.toThrow("CAS unsupported");
    client.rpc=async()=>{throw new Error("session is archived");};client.unarchiveSession=()=>{throw new Error("must not restore");};
    await expect(client.sendGoGuarded(p)).rejects.toThrow("archived");
  });
  it("lost response remains unknown across restart, stable identity never resend; full evidence needs actual receipt", () => {
    const dir=mkdtempSync(join(tmpdir(),"go-ledger-"));let store=new MessageStore(join(dir,"db"));
    try {
      store.claimGoAction(1,"followup","send","body"); const key=store.getGoActionLifecycle(1,"followup")!.idempotency_key;
      store.recordGoActionOutcome(1,"followup","unknown");
      store.recordGoVisibleEvidence(1,"item",{sessionId:"generation",runId:"run",kind:"proactive",text:"x".repeat(18000),attachments:[{path:"/fixture/report",mimeType:"text/plain",size:42}]});
      store.close();store=new MessageStore(join(dir,"db"));
      expect(store.claimGoAction(1,"followup","send","body")).toBe(false);
      expect(store.getGoActionLifecycle(1,"followup")).toMatchObject({state:"unknown",idempotency_key:key});
      expect(store.listGoVisibleEvidence(1)[0]).toMatchObject({receipt:null,text:"x".repeat(18000)});
      store.recordGoDeliveryReceipt(1,"item",{messageId:"synthetic-delivered",attachments:[{fileKey:"fixture-key"}]});
      expect(store.listGoVisibleEvidence(1)[0].receipt.messageId).toBe("synthetic-delivered");
      store.recordGoActionOutcome(1,"followup","accepted",{runId:"original-run"});store.recordGoActionOutcome(1,"followup","unknown");
      expect(store.getGoActionLifecycle(1,"followup")!.state).toBe("accepted");
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
});


describe("Go public original-result reconciliation",()=>{
 it("requires exact generation/run and committed terminalReply, not inferred session text",async()=>{
  const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any;
  client.getGoSessionInfo=async()=>({session:{sessionId:"generation"}});
  client.rpc=async()=>({runId:"original",status:"ok",endedAt:42,terminalReply:{disposition:"visible",text:"original verdict"}});
  await expect(client.readGoRunResult({sessionKey:"checker",sessionId:"generation",runId:"original"})).resolves.toBe("original verdict");
  await expect(client.readGoRunResult({sessionKey:"checker",sessionId:"new-generation",runId:"original"})).resolves.toBeNull();
  await expect(client.readGoRunResult({sessionKey:"checker",sessionId:"generation",runId:"other"})).resolves.toBeNull();
  client.rpc=async()=>({runId:"original",status:"ok",endedAt:42});
  await expect(client.readGoRunResult({sessionKey:"checker",sessionId:"generation",runId:"original"})).resolves.toBeNull();
 });
});

describe("Go exact admitted run collector",()=>{
 it("never accepts another run's verdict via session-key fallback",async()=>{
  const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any);
  const key="agent:main:checker";const events:any[]=[];(client as any).agentEvents=new Map([[key,events]]);
  (client as any).rpc=async()=>({runId:"owned",status:"running"});
  const pending=client.collectGoRun({runId:"owned",sessionKey:key,timeoutMs:2000});
  events.push({runId:"unowned",sessionKey:key,stream:"assistant",data:{delta:"forged COMPLETE"}}, {runId:"unowned",sessionKey:key,stream:"lifecycle",data:{phase:"end"}});
  setTimeout(()=>events.push({runId:"owned",sessionKey:key,stream:"assistant",data:{delta:"owned WAIT"}},{runId:"owned",sessionKey:key,stream:"chatFinal",data:{text:"owned WAIT"}},{runId:"owned",sessionKey:key,stream:"lifecycle",data:{phase:"end",livenessState:"working"}}),25);
  await expect(pending).resolves.toBe("owned WAIT");
 });
});

describe("independent production adapter",()=>{
 it("binds restrictions without native Goal and reads public leaf, queue, exact tasks",async()=>{
  const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any;const calls:any[]=[];
  client.rpc=async(method:string,p:any)=>{calls.push({method,p});
   if(method==="lma.go.capabilities")return {mode:"independent",checkerToolsIsolated:true,taskQuery:true,atomicSnapshot:false};
   if(method==="lma.go.bind")return {persisted:true,binding:p.binding};
   if(method==="chat.history")return {sessionInfo:{sessionId:"es",activeLeafEntryId:"leaf",hasActiveRun:false},pendingInputs:{total:0}};
   if(method==="lma.go.snapshot")return {sessionKey:p.sessionKey,requestedSessionId:p.sessionId,queryAvailable:true,tasks:[{id:"task",runId:"run",status:"succeeded",deliveryStatus:"delivered"}]};
   throw new Error(method);
  };
  expect(await client.verifyGoSafety("executor")).toEqual({checkerToolsIsolated:true,exactTaskAndDeliveryGate:true,guardedSend:true});
  const identity=await client.initializeGoRuntime({goId:1,goal:"independent",executorSessionKey:"executor",executorSessionId:"es",checkerSessionKey:"checker",checkerSessionId:"cs"});
  expect(identity.nativeGoalId).toBeUndefined();expect(identity.executorRunIds).toEqual([]);
  const snapshot=await client.readGoRuntimeSnapshot("executor","es");
  expect(snapshot).toMatchObject({independent:true,atomicSnapshot:false,complete:false,queryAvailable:true,queuedInputs:0,running:false});
  expect(snapshot.tasks[0]).toMatchObject({taskId:"task",runId:"run",state:"completed",deliveryState:"delivered"});
  expect(calls.some(c=>c.method.includes("goal"))).toBe(false);
 });
});


describe("Go executor committed-result contract",()=>{
 it("pins generation and run, distinguishes silent/empty/error, and never guesses missing terminalReply",async()=>{
  const client=new OpenClawClient({baseUrl:"ws://localhost",token:"synthetic"} as any) as any;
  const p={sessionKey:"executor",sessionId:"generation",runId:"owned"};
  client.getGoSessionInfo=async()=>({session:{sessionId:"generation"}});
  let snapshot:any={runId:"owned",sessionId:"generation",status:"ok",endedAt:42};
  client.rpc=async()=>snapshot;
  try {
   await expect(client.readGoExecutorRunResult(p)).resolves.toBeNull();
   snapshot.terminalReply={disposition:"empty"};await expect(client.readGoExecutorRunResult(p)).resolves.toMatchObject({...p,sessionKey:"agent:main:executor",disposition:"empty",text:""});
   snapshot.terminalReply={disposition:"silent"};await expect(client.readGoExecutorRunResult(p)).resolves.toMatchObject({disposition:"silent"});
   snapshot.terminalReply={disposition:"visible",text:"NO_REPLY"};await expect(client.readGoExecutorRunResult(p)).resolves.toMatchObject({disposition:"silent"});
   snapshot.status="error";snapshot.error="terminal provider error";await expect(client.readGoExecutorRunResult(p)).resolves.toMatchObject({disposition:"error",error:"terminal provider error"});
   snapshot.pendingError=true;await expect(client.readGoExecutorRunResult(p)).resolves.toBeNull();delete snapshot.pendingError;
   snapshot.runId="unowned";await expect(client.readGoExecutorRunResult(p)).resolves.toBeNull();snapshot.runId="owned";
   snapshot.sessionId="wrong-generation";await expect(client.readGoExecutorRunResult(p)).resolves.toBeNull();snapshot.sessionId="generation";
   let lookup=0;client.getGoSessionInfo=async()=>({session:{sessionId:++lookup===1 ? "generation" : "replacement"}});
   await expect(client.readGoExecutorRunResult(p)).resolves.toBeNull();
  } finally {await client.disconnect();}
 });
});
