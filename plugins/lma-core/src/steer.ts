import { resolveActiveEmbeddedRunSessionId, onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Status = "pending" | "accepted" | "rejected" | "unknown" | "target_changed" | "stopped" | "capability_blocked";
type Custody = { insertionId: string; sessionKey: string; expectedRunId: string; textHash?: string; sessionId?: string; status: Status; attempted: boolean; reason?: string };
const canonical=(key:string)=>/^agent:/.test(key) ? key : `agent:main:${key}`;
const nonempty=(value:unknown):value is string=>typeof value==='string' && !!value.trim();

/** Short, idempotent query/attempt RPC. Waiting is bridge-owned and paced, not
 * an 8-second handler or an unbounded plugin timer. Journal is LMA-owned only.
 * The deprecated SDK boolean is NEVER promoted to runtime acceptance. */
export function registerSteer(api: any): void {
  const dir=join(process.env.OPENCLAW_STATE_DIR || join(homedir(),'.openclaw'),'lma-core','steer-custody');
  const active=new Map<string,string>();
  onAgentEvent(event=>{
    if(!event.sessionKey || !event.runId) return;
    const key=canonical(event.sessionKey);
    if(event.stream==='lifecycle' && ['end','error'].includes(String(event.data?.phase))) {
      if(active.get(key)===event.runId) active.delete(key);
    } else {
      active.set(key,event.runId);
      if(active.size>512) active.delete(active.keys().next().value!);
    }
  });
  const file=(id:string)=>join(dir,createHash('sha256').update(id).digest('hex')+'.json');
  const read=(id:string):Custody|undefined=>{try{return JSON.parse(readFileSync(file(id),'utf8'));}catch(e:any){if(e.code==='ENOENT')return;throw e;}};
  const save=(record:Custody)=>{mkdirSync(dir,{recursive:true});const path=file(record.insertionId);const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(record),{mode:0o600});renameSync(temp,path);};
  api.registerGatewayMethod('lma.steer.capabilities',({respond}:any)=>respond(true,{protocol:1,atomicRunBound:false,acceptanceCallback:true,durableIntent:true,
    reason:'Public queue API lacks expectedRunId/source authority CAS and durable item query'}));
  api.registerGatewayMethod('lma.steer',async({params,respond}:any)=>{
    if(!nonempty(params.sessionKey) || !nonempty(params.text) || !nonempty(params.insertionId) || !nonempty(params.expectedRunId)) {
      respond(false,undefined,{code:'INVALID_REQUEST',message:'lma.steer requires sessionKey, text, stable insertionId and expectedRunId'});return;
    }
    const key=canonical(params.sessionKey);
    let record:Custody;
    try {
      const old=read(params.insertionId);
      const textHash=createHash('sha256').update(params.text).digest('hex');
      if(old?.textHash && old.textHash!==textHash) throw new Error('Immutable insertion payload mismatch');
      if(params.queryOnly===true && !old) {respond(true,{insertionId:params.insertionId,expectedRunId:params.expectedRunId,sessionKey:key,status:'unknown',attempted:true,reason:'journal unavailable; not replayed'});return;}
      if(old && (old.sessionKey!==key || old.expectedRunId!==params.expectedRunId)) throw new Error('Immutable insertion target mismatch');
      record=old || {insertionId:params.insertionId,sessionKey:key,expectedRunId:params.expectedRunId,textHash,status:'pending',attempted:false};
      if(params.cancel===true) {record.status='stopped';save(record);respond(true,record);return;}
      // After restart an attempted item without a durable positive callback is
      // unknown. Querying it never attempts a second injection.
      if(record.attempted || record.status!=='pending') {respond(true,record);return;}
      const sessionId=resolveActiveEmbeddedRunSessionId(key);
      if(!sessionId) {record.reason='target_not_ready';save(record);respond(true,record);return;}
      const observedRun=active.get(key);
      if(observedRun && observedRun!==record.expectedRunId || record.sessionId && record.sessionId!==sessionId) {
        record.status='target_changed';record.reason='exact target changed; explicit redecision required';save(record);respond(true,record);return;
      }
      if(!observedRun) {
        record.reason='exact_run_unverifiable_from_public_events';save(record);respond(true,record);return;
      }
      record.sessionId=sessionId;
      // Public SDK has no host-owned expectedRunId CAS. sessionId is reused
      // by successor runs, and onAgentEvent is only advisory. Do NOT convert
      // this read/check into final-effect authority, or call the boolean API
      // "just to test readiness" (true already invokes backend mutation).
      // A strict original-run intent stays durably blocked, not silently sent
      // to whichever handle currently occupies this sessionId.
      record.status='capability_blocked';
      record.reason='Public SDK lacks atomic expectedRunId + durable submit/query; no injection attempted';
      save(record);
      respond(true,read(record.insertionId));
    } catch(error) {
      respond(false,undefined,{code:'INTERNAL',message:`lma.steer: ${error instanceof Error ? error.message : String(error)}`});
    }
  });
}
