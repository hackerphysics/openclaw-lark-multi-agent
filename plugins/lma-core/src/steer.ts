import { resolveActiveEmbeddedRunSessionId, queueAgentHarnessMessage, onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { join } from "node:path";

type Status = "pending" | "accepted" | "unknown" | "target_changed" | "target_ended" | "stopped";
type Custody = { insertionId: string; sessionKey: string; expectedRunId: string; textHash: string; sessionId: string;
  stopEpoch: number; status: Status; attempted: boolean; attempt: number; reason?: string; everAttempted?: boolean; ordinaryEligible?: boolean; acceptedAt?: number; acceptanceAfterStop?: boolean };
const canonical=(key:string)=>/^agent:/.test(key) ? key : `agent:main:${key}`;
const nonempty=(value:unknown):value is string=>typeof value==='string' && !!value.trim();

/** Short submit/query RPCs. The bridge owns one paced recovery scheduler, so
 * callback lifetime is independent of the RPC deadline. Resolve + queue are
 * synchronous on one event-loop turn. This is session-generation custody and
 * observed lifecycle fencing, NOT a host final-effect original-run CAS. */
export function registerSteer(api: any): () => void {
  const dir=join(resolveStateDir(),'lma-core','steer-custody');
  const active=new Map<string,{runId:string;sessionId?:string;startedAt:number}>(),ended=new Set<string>();
  const unsubscribe=onAgentEvent(event=>{
    if(!event.sessionKey || !event.runId || event.stream!=='lifecycle') return;
    const key=canonical(event.sessionKey),phase=String(event.data?.phase);
    if(['end','error'].includes(phase)) {
      ended.add(`${key}\0${event.runId}`);
      if(active.get(key)?.runId===event.runId) active.delete(key);
      if(ended.size>2048) ended.delete(ended.values().next().value!);
    } else if(phase==='start') {
      const startedAt=Number(event.data?.startedAt) || event.ts;
      if((active.get(key)?.startedAt ?? 0)>startedAt) return;
      active.set(key,{runId:event.runId,sessionId:event.sessionId,startedAt});
      if(active.size>512) active.delete(active.keys().next().value!);
    }
  });
  const pathFor=(id:string)=>join(dir,createHash('sha256').update(id).digest('hex')+'.json');
  const readJson=<T>(path:string):T|undefined=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(e:any){if(e.code==='ENOENT')return;throw e;}};
  // Durable no-replay fence, including power/process loss around rename.
  const writeJson=(path:string,value:unknown)=>{
    mkdirSync(dir,{recursive:true,mode:0o700});const temp=path+'.tmp';
    writeFileSync(temp,JSON.stringify(value),{mode:0o600});
    const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,path);
    // Windows permits opening some directories but fsync then fails EPERM.
    // The file is already durable+renamed: never report a false failed attempt.
    if(process.platform!=='win32') {
      const parent=openSync(dir,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
    }
  };
  const read=(id:string)=>readJson<Custody>(pathFor(id));
  const save=(record:Custody)=>{record.ordinaryEligible=record.attempted===false && record.everAttempted!==true;writeJson(pathFor(record.insertionId),record);};
  const stopPath=(key:string)=>pathFor(`session-stop:${key}`);
  const cutoff=(key:string)=>readJson<{epoch:number}>(stopPath(key))?.epoch ?? 0;
  api.registerGatewayMethod('lma.steer.capabilities',({respond}:any)=>respond(true,{protocol:2,atomicRunBound:false,
    acceptanceCallback:true,durableAttempts:true,sessionGenerationBound:true,
    reason:'Backend callback confirms acceptance, not consumption. Original-run final-effect CAS is unavailable.'}));
  api.registerGatewayMethod('lma.steer.stop',({params,respond}:any)=>{
    try {
      if(!nonempty(params.sessionKey) || !Number.isSafeInteger(params.stopEpoch)) throw new Error('sessionKey and stopEpoch required');
      const key=canonical(params.sessionKey),epoch=Math.max(cutoff(key),params.stopEpoch);
      writeJson(stopPath(key),{epoch});respond(true,{sessionKey:key,stopEpoch:epoch});
    } catch(error) {respond(false,undefined,{code:'INTERNAL',message:String(error)});}
  });
  api.registerGatewayMethod('lma.steer',({params,respond}:any)=>{
    if(!nonempty(params.sessionKey) || !nonempty(params.text) || !nonempty(params.insertionId) || !nonempty(params.expectedRunId) ||
      !nonempty(params.expectedSessionId) || !Number.isSafeInteger(params.stopEpoch)) {
      respond(false,undefined,{code:'INVALID_REQUEST',message:'Immutable input, session/run identity and stopEpoch required'});return;
    }
    const key=canonical(params.sessionKey);
    try {
      let old=read(params.insertionId);
      const textHash=createHash('sha256').update(params.text).digest('hex');
      // Upgrade the prior unpublished no-effect candidate's journal only.
      // Never reinterpret an attempted/unknown row as safe to send.
      if(old && (old.status as string)==='capability_blocked' && old.attempted===false &&
        old.textHash===textHash && old.sessionKey===key && old.expectedRunId===params.expectedRunId &&
        (!old.sessionId || old.sessionId===params.expectedSessionId)) {
        old={...old,sessionId:params.expectedSessionId,stopEpoch:params.stopEpoch,status:'pending',attempt:0};save(old);
      }
      if(old && (old.textHash!==textHash || old.sessionKey!==key || old.expectedRunId!==params.expectedRunId ||
        old.sessionId!==params.expectedSessionId || old.stopEpoch!==params.stopEpoch)) throw new Error('Immutable insertion identity/payload mismatch');
      if(params.queryOnly===true && !old) {
        respond(true,{insertionId:params.insertionId,expectedRunId:params.expectedRunId,sessionId:params.expectedSessionId,
          status:'unknown',attempted:true,reason:'journal unavailable; not replayed'});return;
      }
      const record:Custody=old || {insertionId:params.insertionId,sessionKey:key,expectedRunId:params.expectedRunId,textHash,
        sessionId:params.expectedSessionId,stopEpoch:params.stopEpoch,status:'pending',attempted:false,attempt:0};
      if(params.cancel===true || record.stopEpoch<cutoff(key)) {record.status='stopped';save(record);respond(true,record);return;}
      if(record.attempted || record.status!=='pending' || params.queryOnly===true) {respond(true,record);return;}
      if(params.originalRunEnded===true || ended.has(`${key}\0${record.expectedRunId}`)) {
        record.status='target_ended';record.reason='original run ended without an insertion attempt';save(record);respond(true,record);return;
      }
      const observedRun=active.get(key);
      if(observedRun && observedRun.runId!==record.expectedRunId && (!observedRun.sessionId || observedRun.sessionId===record.sessionId)) {
        // A same-session successor is not a generation/authorization change.
        // Wait for the original exact terminal; never SDK-retarget this retry.
        record.reason='target_not_ready';save(record);respond(true,record);return;
      }
      const sessionId=resolveActiveEmbeddedRunSessionId(key);
      if(!sessionId) {record.reason='target_not_ready';save(record);respond(true,record);return;}
      if(record.sessionId!==sessionId) {
        record.status='target_changed';record.reason='session generation changed; no automatic migration';save(record);respond(true,record);return;
      }
      // Crash even just BEFORE queue invocation remains unknown. queueIdentity
      // is an item identity, NEVER a host dedupe/retry token.
      const previouslyAttempted=record.everAttempted===true;
      record.everAttempted=true;record.attempted=true;record.status='unknown';record.attempt++;record.reason='awaiting_backend_acceptance';save(record);
      const attempt=record.attempt;
      const queued=queueAgentHarnessMessage(sessionId,params.text,{steeringMode:'all',queueIdentity:`${record.insertionId}:${attempt}`,
        onQueueAccepted:(accepted:boolean)=>{
          try {
            const current=read(record.insertionId);
            if(!current || current.attempt!==attempt || current.acceptedAt) return;
            if(current.status==='stopped' || current.stopEpoch<cutoff(key)) {
              current.status='stopped';if(accepted)current.acceptanceAfterStop=true;
            } else if(accepted) {current.status='accepted';current.acceptedAt=Date.now();current.reason='backend_onQueueAccepted_true';}
            else {current.status='pending';current.attempted=false;current.reason='backend_rejected_no_effect';}
            save(current);
          } catch(error) {
            // No durable receipt -> no Get/retry. Never throw into a backend
            // after it accepted input, including an asynchronous callback.
            api.logger?.warn?.(`lma.steer callback journal failure: ${String(error)}`);
          }
        }});
      if(!queued) {
        const current=read(record.insertionId)!;
        if(current.attempt===attempt && !current.acceptedAt) {current.everAttempted=previouslyAttempted;current.attempted=false;current.status='pending';current.reason='target_not_ready';save(current);}
      }
      respond(true,read(record.insertionId));
    } catch(error) {
      respond(false,undefined,{code:'INTERNAL',message:`lma.steer: ${error instanceof Error ? error.message : String(error)}`});
    }
  });
  return unsubscribe;
}
