import type { GoExecutorResult } from "./go-execution.js";
import WebSocket from "ws";
import { safeErrorSummary, rawErrorExcerpt } from "./provider-errors.js";
import { RunTerminalError, closedStopReason, inspectError, genericFailure, announceCandidate, type ErrorProvenance, type ProactiveMessageMeta } from "./terminal-errors.js";
import { SessionWaitPaused, normalizeSessionRuntimeStatus, isWaitTimeout, FOREGROUND_WAIT_MS, IDLE_GUARD_MS, type SessionRuntimeStatus } from "./session-status.js";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, resolve, sep } from "path";
import { OpenClawConfig } from "./config.js";
import { MessageStore, ChatMessage } from "./message-store.js";
import { getBridgeAttachmentsDir, getDataDir } from "./paths.js";

export type ProgressEvent =
  | { kind: "tool"; phase: "start" | "end" | "error"; name: string; text: string }
  | { kind: "assistant_note"; text: string }
  | { kind: "steer"; text: string }
  | { kind: "lifecycle"; text: string };

export class InactiveRunObservation extends Error {
  constructor() {
    super("Gateway 确认当前会话已空闲，但旧运行结果未能确认；追加消息将继续处理，未停止任何后台任务。");
    this.name = "InactiveRunObservation";
  }
}

/** The local collectReply observation was fenced because a newer batch took
 *  over this session's queue custody. Purely local: no Gateway run was stopped,
 *  and the superseded run's eventual reply still flows through the proactive
 *  delivery path. Introduced for the 2026-10-16 stale-collector regression:
 *  an alive old poller destructively consumed the replacement batch's frames
 *  from the shared session bucket, starving the new collector's idle clock and
 *  swallowing its final. */
export class SupersededObservation extends Error {
  constructor(reason = "本地观察已被更新的批次取代") {
    super(`${reason}（未停止网关运行）`);
    this.name = "SupersededObservation";
  }
}

/** Local observer only: the exact background result remains owned by durable recovery. */
export class CollectorStalledError extends Error {
  constructor() { super('本地状态观察未及时返回，已转为后台结果监听；没有停止任务或自动重发输入。'); this.name='CollectorStalledError'; }
}

export class AdmissionUnconfirmed extends Error {
  constructor(readonly submissionId:string,cause?:unknown) {
    super('消息提交结果尚未确认；本地保留原提交身份，不会自动重复发送。',{cause});this.name='AdmissionUnconfirmed';
  }
}

/** A genuinely observed physical session + nonempty transcript leaf. The
 * public non-steer chat.send branch CAS uses BOTH; sessionId alone is not CAS. */
export type FollowupAdmissionGuard = { sessionKey:string; sessionId:string; expectedLeafEntryId:string; /** Prior verified SDK no-effect target, NOT a current receiver identity. */ nonInjectableRunId?:string };
export class FollowupAdmissionRefused extends Error {
  constructor(readonly reason:string, readonly submissionId:string) {
    super(`Followup admission refused before effect; input retained: ${reason}`);this.name='FollowupAdmissionRefused';
  }
}
export type SessionDispatchStatus = {
  idleConfirmed:boolean;sessionId?:string;archived?:boolean;activeRunId?:string;busyConfirmed?:boolean;
  /** Explicit incompatible identity is not a genuinely unknown observation. */
  identityConflict?:boolean;
  /** Independent admission proof, NOT an assertion that aggregate work ended. */
  followupAdmissionEligible?:boolean;expectedLeafEntryId?:string;
};

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

export const GATEWAY_PROTOCOL_MIN = 4;
export const GATEWAY_PROTOCOL_MAX = 4;
const REQUIRED_GATEWAY_METHODS = [
  "agent.wait",
  "chat.abort",
  "chat.send",
  "sessions.compact",
  "sessions.create",
  "sessions.delete",
  "sessions.describe",
  "sessions.messages.subscribe",
  "sessions.patch",
  "sessions.reset",
] as const;
const REQUIRED_GATEWAY_EVENTS = ["agent", "chat", "session.message"] as const;

const BRIDGE_ATTACHMENTS_DIR = getBridgeAttachmentsDir();
const CONTEXT_SYNC_DIR = join(getDataDir(), "context-sync");
const FEISHU_DOCS_DIR = join(getDataDir(), "feishu-docs");
const MAX_FEISHU_DOC_ATTACHMENT_BYTES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_FEISHU_DOC_ATTACHMENT_BYTES || 1024 * 1024);
const MAX_INLINE_CONTEXT_MESSAGES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_INLINE_CONTEXT_MESSAGES || 20);
// Byte budgets apply to lossy progress projections, NEVER authoritative terminal
// text. Terminal records stay complete until exact readers + ACK reservations
// release, then successful result/durable observation custody can retire them.
const EVENT_PROGRESS_BUCKET_BYTES = 256 * 1024;
const EVENT_PROGRESS_TOTAL_BYTES = 4 * 1024 * 1024;
const EVENT_PROGRESS_FIELD_CHARS = 2048;
const MAX_INLINE_CONTEXT_BYTES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_INLINE_CONTEXT_BYTES || 128 * 1024);

const reasonPriority=(r:unknown)=>r==='superseded'||r==='restart'?4:r==='timeout'?3:r==='error'||r==='aborted'?2:closedStopReason(r)?1:0;
const terminalReason=(...values:unknown[])=>values.map(closedStopReason).sort((a,b)=>reasonPriority(b)-reasonPriority(a)).find(Boolean);

type PendingReq = {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onSuccess?: (data:any)=>void;
};

/**
 * OpenClaw Gateway WebSocket client.
 * Full agent pipeline — tools, memory, skills, context management by OpenClaw.
 */
export class OpenClawClient {
  private goEvidenceObservers = new Set<(event: { channel: string; payload: unknown }) => void>();
  /** Raw full event observer. Observation is NOT a Feishu delivery receipt. */
  observeGoEvidence(callback: (event: { channel: string; payload: unknown }) => void): () => void {
    this.goEvidenceObservers.add(callback);
    return () => { this.goEvidenceObservers.delete(callback); };
  }
  private config: OpenClawConfig;
  private ws: WebSocket | null = null;
  private pending: Map<string, PendingReq> = new Map();
  private admissionResponseHooks=new Map<string,(data:any)=>void>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private agentEvents: Map<string, any[]> = new Map();
  private eventProgressSizes=new WeakMap<object,number>();
  private runEventReaders=new Map<string,number>();
  private runEventReservations=new Map<string,number>();
  private completedRunEventCustody=new Set<string>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  /** Read-only reconciliation for a collector whose plugin reports no active run. */
  private runStateChecks = new Map<string, () => Promise<void>>();
  /** Callbacks for tool events (verbose mode) */
  private toolEventCallbacks: Map<string, (toolName: string, toolInput: string, toolOutput: string) => void> = new Map();
  private lastToolNamesByItemId: Map<string, string> = new Map();
  /** Deduplicates 2026.8 canonical `agent.stream=tool` events against legacy
   * `stream=item` mirrors when a runtime emits both representations. */
  private recentToolEventKeys: Map<string, number> = new Map();
  private privateInputToolCalls = new Set<string>();
  private publicToolCalls = new Set<string>();
  private sessionSettlementCallbacks=new Map<string,(meta:ProactiveMessageMeta)=>void|Promise<void>>();
  private sessionMessageCallbacks: Map<string, (text: string, meta?: ProactiveMessageMeta) => void> = new Map();
  private progressCallbacks: Map<string, (event: ProgressEvent) => void | Promise<void>> = new Map();
  private progressGenerations=new Map<string,number>();
  private progressRuns=new Map<string,string>();
  /** Live collectReply fences per canonical session key. The most recent
   *  collector for a session owns the shared event bucket; a new batch (or a
   *  queue-custody revocation) fences stale ones synchronously so they cannot
   *  steal frames from the replacement (2026-10-16 regression). */
  private sessionCollectorFences: Map<string, Set<() => void>> = new Map();
  /** Per-session steered messages awaiting consumption confirmation. Each
   * accepted message is retained independently so identical/overlapping text
   * cannot overwrite another correlation. */
  private pendingSteerTexts: Map<string, Array<{ submittedText: string; displayText: string }>> = new Map();
  /** Sessions where verbose mode should deliver visible transcript text even when mixed with tool blocks. */
  private verboseTranscriptSessions: Set<string> = new Set();
  private verboseAssistantTimers: Map<string, NodeJS.Timeout> = new Map();
  private verboseAssistantLatest: Map<string, string> = new Map();
  private verboseAssistantSent: Map<string, string> = new Map();
  private verboseAssistantLastTouched: Map<string, number> = new Map();
  /** Session keys that should be re-subscribed on reconnect */
  private subscribedKeys: Set<string> = new Set();
  /** Session keys whose transcript/session.message updates are currently suppressed. */
  private suppressedSessions: Set<string> = new Set();
  private suppressedSessionTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Run ids whose final delivery is owned by chatSend/collectReply. Delivery
   * ownership must be run-scoped: a concurrent queueMode=steer admission may
   * fall through to a separate ordinary run in the same session. */
  private ownedDeliveryRuns: Set<string> = new Set();
  private ownedDeliveryRunTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Session keys whose proactive messages must be dropped by the bridge (e.g. discussion scheduler owns delivery). */
  private mutedProactiveSessions: Set<string> = new Set();
  private mutedProactiveSessionCounts: Map<string, number> = new Map();
  /** Sessions force-aborted by /stop; collectReply should finish immediately instead of waiting for idle timeout. */
  private forceAbortedSessions: Set<string> = new Set();
  /** Explicit-stop evidence comes from exact authorized abort response run IDs,
   * never the persistent session flag used by the original collector. */
  private explicitlyStoppedRuns = new Map<string, number>();
  private pendingExplicitStops = new Map<string, Promise<void>>();
  private isExplicitlyStoppedRun(sessionKey: string, runId?: string): boolean {
    if (!runId) return false;
    if(this.recoveryStore?.isStoppedObservation(this.canonicalSessionKey(sessionKey),runId)) return true;
    const key = JSON.stringify([this.canonicalSessionKey(sessionKey), runId]);
    const at = this.explicitlyStoppedRuns.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > 24 * 60 * 60_000) { this.explicitlyStoppedRuns.delete(key); return false; }
    return true;
  }
  /** Global limiter for chat.send RPC calls; large multi-bot fan-out can
   * saturate the Gateway before collectReply even starts. The slot is released
   * as soon as the chat.send RPC returns a runId; collectReply does not hold it.
   */
  private chatSendConcurrency = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_CHAT_SEND_CONCURRENCY || 3);
  private activeChatSends = 0;
  private chatSendWaiters: Array<() => void> = [];
  /** Maintenance RPCs like sessions.compact are heavy and should not fan out. */
  private maintenanceConcurrency = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAINTENANCE_CONCURRENCY || 1);
  private activeMaintenanceRpcs = 0;
  private maintenanceWaiters: Array<() => void> = [];

  private observationEpoch = new Map<string, number>();
  private stopGenerations = new Map<string, number>();
  private recoveryStore?: MessageStore;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryChecking = false;
  private eventCollectors = new Set<() => void>();
  private forwardedFinals = new Map<string,string>();
  /** One paced recovery scheduler for all persisted exact runs. No business
   * replay, no per-run infinite timers, and each query has its own deadline. */
  bindRecoveryStore(store: MessageStore): void {
    this.recoveryStore=store;
    store.onClose(()=>{if(this.recoveryStore===store){this.recoveryStore=undefined;if(this.recoveryTimer)clearTimeout(this.recoveryTimer);this.recoveryTimer=undefined;}});
    this.scheduleRecovery();
  }
  private scheduleRecovery(): void {
    if(this.recoveryTimer || !this.shouldReconnect || !this.recoveryStore) return;
    this.recoveryTimer=setTimeout(()=>{this.recoveryTimer=undefined;void this.recoverExactRuns().finally(()=>this.scheduleRecovery());},30_000);
    this.recoveryTimer.unref?.();
  }
  private async recoverExactRuns(): Promise<void> {
    if(this.recoveryChecking || !this.recoveryStore) return;
    this.recoveryChecking=true;
    try {
      for(const item of this.recoveryStore.listRunObservations(undefined,Date.now(),20)) {
        if(!this.recoveryStore)return;
        // Advance every selected row, including temporarily unsubscribed/owned
        // ones, so a due page cannot starve recoverable runs behind it.
        this.recoveryStore.saveRunObservation(item.sessionKey,item.runId,item,Date.now()+60_000);
        if(!this.sessionMessageCallbacks.has(item.sessionKey) && !this.sessionMessageCallbacks.has(this.shortKey(item.sessionKey))) continue;
        if(this.ownedDeliveryRuns.has(item.runId)) continue;
        try {
          const snapshot=item.terminalObserved ? {runId:item.runId,status:'ok',endedAt:Date.now(),terminalReply:{disposition:item.terminalDisposition || (String(item.terminalText).trim().toUpperCase()==='NO_REPLY'?'silent':'visible'),text:item.terminalText}} : await this.rpc('agent.wait',{runId:item.runId,timeoutMs:1},2500);
          if(this.recoveryStore.runObservationState(item.sessionKey,item.runId)!=='observing' || this.isExplicitlyStoppedRun(item.sessionKey,item.runId) || this.ownedDeliveryRuns.has(item.runId)) continue;
          if(snapshot?.runId!==item.runId || !Number.isFinite(snapshot.endedAt) || snapshot.endedAt<=0 || snapshot.yielded || snapshot.pendingError || ['queue','gateway_draining'].includes(snapshot.timeoutPhase) || typeof snapshot.startedAt==='number' && snapshot.endedAt<snapshot.startedAt) continue;
          const terminal=snapshot.terminalReply;
          const callback=this.sessionMessageCallbacks.get(item.sessionKey) || this.sessionMessageCallbacks.get(this.shortKey(item.sessionKey));
          if(['error','timeout'].includes(snapshot.status)) {
            // endedAt + exact run is terminal evidence; bare query timeouts never get here.
            await callback?.(String(snapshot.error || snapshot.status),{sourceType:'run_error',sessionKey:item.sessionKey,runId:item.runId,
              error:{sessionKey:item.sessionKey,sessionId:item.sessionId,runId:item.runId,source:'chat',state:'error',stopReason:closedStopReason(snapshot.stopReason) || (snapshot.status==='timeout'?'timeout':undefined),detail:String(snapshot.error || snapshot.status)}});
            this.recoveryStore.settleExactRunReactions(item.sessionKey,item.runId);
            this.recoveryStore.finishRunObservation(item.sessionKey,item.runId);
            await this.sessionSettlementCallbacks.get(this.canonicalSessionKey(item.sessionKey))?.({sessionKey:item.sessionKey,runId:item.runId,sessionId:item.sessionId,final:true});
            continue;
          }
          if(snapshot.status!=='ok' || !['visible','silent','empty'].includes(terminal?.disposition)) continue;
          if(terminal.disposition==='visible' && typeof terminal.text==='string' && terminal.text.trim()) {
            const callback=this.sessionMessageCallbacks.get(item.sessionKey) || this.sessionMessageCallbacks.get(this.shortKey(item.sessionKey));
            await callback?.(terminal.text,{sessionKey:item.sessionKey,runId:item.runId,sessionId:item.sessionId,final:true});
          }
          if(terminal.disposition!=='visible') {
            this.recoveryStore.settleExactRunReactions(item.sessionKey,item.runId);
            this.recoveryStore.finishRunObservation(item.sessionKey,item.runId);
            await this.sessionSettlementCallbacks.get(this.canonicalSessionKey(item.sessionKey))?.({sessionKey:item.sessionKey,runId:item.runId,sessionId:item.sessionId,final:true});
          }
          // Visible custody ends only when the receiver's durable outbox has
          // claimed it. A callback resolving alone is not a delivery receipt.
        } catch { /* Query failed, not the task. Leave exact custody in SQLite. */ }
      }
    } finally {this.recoveryChecking=false;}
  }

  private runEventKey(sessionKey:string|undefined,runId:string):string {
    return JSON.stringify([sessionKey===undefined?null:this.shortKey(sessionKey),runId]);
  }

  private retainRunEventCustody(kind:'reader'|'reservation',sessionKey:string|undefined,runId:string):()=>void {
    const key=this.runEventKey(sessionKey,runId);
    const refs=kind==='reader'?this.runEventReaders:this.runEventReservations;
    refs.set(key,(refs.get(key)||0)+1);
    let released=false;
    return ()=>{
      if(released)return;released=true;
      const count=(refs.get(key)||1)-1;
      if(count)refs.set(key,count);else refs.delete(key);
      for(const completed of this.completedRunEventCustody) {
        if(JSON.parse(completed)[1]===runId)this.retireCompletedRunEvents(completed);
      }
    };
  }

  private retireCompletedRunEvents(key:string):void {
    const [session,runId]=JSON.parse(key) as [string,string];
    // A same-run second reader or receiver ACK reservation can still need the
    // exact terminal. Never reclaim on merely seeing another session's frame.
    if(this.runEventReaders.has(key) || this.runEventReaders.has(this.runEventKey(undefined,runId)) || this.runEventReservations.has(key))return;
    for(const [bucketKey,bucket] of this.agentEvents) {
      const retained=bucket.filter(ev=>!(ev.runId===runId && this.shortKey(ev.sessionKey || bucketKey)===session));
      if(retained.length!==bucket.length)this.agentEvents.set(bucketKey,retained);
    }
    this.completedRunEventCustody.delete(key);
  }

  private isTerminalBufferedEvent(event:any):boolean {
    return event.stream==='chatFinal' || event.stream==='chatError'
      || event.stream==='lifecycle' && event.data?.phase==='error';
  }

  /** Buffers are observation indexes, not raw tool-output/transcript caches.
   * Presentation/evidence callbacks still see the already privacy-filtered wire
   * payload. Keep only the fields collectReply actually consumes here. */
  private projectBufferedEvent(event:any):any {
    const data=event.data || {},clip=(value:any)=>typeof value==='string'?value.slice(0,EVENT_PROGRESS_FIELD_CHARS):value;
    const out:any={runId:event.runId,sessionKey:event.sessionKey,sessionId:event.sessionId,stream:event.stream,seq:event.seq,data:{}};
    if(event.stream==='chatFinal') {
      out.data={text:data.gatewayYielded===true?'':typeof data.text==='string'?data.text:'',gatewayYielded:data.gatewayYielded===true};
      return out; // Entire authority, not a preview; no duplicated message body.
    }
    if(event.stream==='chatError'){out.data={error:data.error,state:data.state,stopReason:closedStopReason(data.stopReason)};return out;}
    const keep=event.stream==='lifecycle'
      ?['phase','livenessState','status','stopReason','replayInvalid','aborted',...(data.phase==='error'?['error']:[])]
      :event.stream==='tool' || event.stream==='item'
        ?['kind','phase','name','toolName','toolCallId','itemId','id','isError']
        :['text','deltaText','delta','replace'];
    for(const key of keep)if(data[key]!==undefined)out.data[key]=key==='error'?data[key]:clip(data[key]);
    if(['assistant','chatDelta','transcriptAssistant'].includes(event.stream)) {
      const full=typeof data.text==='string'?data.text:'';
      const chunk=full || data.deltaText || data.delta;
      if(typeof chunk==='string' && chunk.length>EVENT_PROGRESS_FIELD_CHARS) {
        // Activity identity must notice changes beyond a retained preview, and
        // dedup cumulative snapshots/mirrors, without retaining the raw draft.
        if(chunk.trim())out.data.activityFingerprint=createHash('sha256').update(chunk).digest('hex');
        else out.data.text=out.data.deltaText=out.data.delta='';
      }
    }
    if(event.stream==='tool' || event.stream==='item') {
      if(typeof data.meta==='string')out.data.meta=clip(data.meta);
      // The ONLY tool-result semantic consumed by collectReply is a top-level
      // message terminate hint. Preserve that boolean, not an echoed body.
      if(String(data.name || data.toolName)==='message') {
        let value=data.output ?? data.result ?? data.error;
        if(typeof value==='string') {try {value=JSON.parse(value);}catch {value=/^terminate\s*=\s*true$/i.test(value.trim())?{terminate:true}:undefined;}}
        if(value && typeof value==='object' && value.terminate===true)out.data.output={terminate:true};
      }
    }
    return out;
  }

  private progressEventBytes(event:any):number {
    if(this.isTerminalBufferedEvent(event))return 0;
    let bytes=this.eventProgressSizes.get(event);
    if(bytes===undefined) {
      bytes=Buffer.byteLength(JSON.stringify(event),'utf8')+2;
      this.eventProgressSizes.set(event,bytes);
    }
    return bytes;
  }

  private enforceEventProgressBudget():void {
    let total=0;
    for(const [key,bucket] of this.agentEvents) {
      let bytes=bucket.reduce((n,event)=>n+this.progressEventBytes(event),0);
      let excessCount=Math.max(0,bucket.length-2048);
      for(let i=0;i<bucket.length && (bytes>EVENT_PROGRESS_BUCKET_BYTES || excessCount>0);) {
        const event=bucket[i];
        if(this.isTerminalBufferedEvent(event)){i++;continue;}
        bytes-=this.progressEventBytes(event);bucket.splice(i,1);excessCount--;
      }
      total+=bytes;
    }
    if(total>EVENT_PROGRESS_TOTAL_BYTES)for(const [key,bucket] of this.agentEvents) {
      for(let i=0;i<bucket.length && total>EVENT_PROGRESS_TOTAL_BYTES;) {
        if(this.isTerminalBufferedEvent(bucket[i])){i++;continue;}
        total-=this.progressEventBytes(bucket[i]);bucket.splice(i,1);
      }
      if(total<=EVENT_PROGRESS_TOTAL_BYTES)break;
    }
    // Empty/nonterminal-only idle buckets may go; unknown terminal custody is
    // explicitly exempt, not silently discarded to satisfy a count ceiling.
    if(this.agentEvents.size>512)for(const [key,bucket] of this.agentEvents) {
      if(this.agentEvents.size<=512)break;
      if(!this.sessionCollectorFences.has(this.canonicalSessionKey(key)) && !bucket.some(ev=>this.isTerminalBufferedEvent(ev)))this.agentEvents.delete(key);
    }
  }

  private bufferEvent(key:string,event:any):void {
    let bucket=this.agentEvents.get(key);
    if(!bucket){bucket=[];this.agentEvents.set(key,bucket);}
    bucket.push(this.projectBufferedEvent(event));
  }

  private dispatchBufferedEvents():void {
    // Deliver the just-received projection to every current exact reader BEFORE
    // applying lossy progress pressure, even if this is the oldest session in
    // the map. Progress pressure must never manufacture effective silence.
    for(const wake of this.eventCollectors)wake();
    this.enforceEventProgressBudget();
  }

  constructor(config: OpenClawConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    try {
      this.connectPromise = this._doConnect();
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.baseUrl.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl);
      let handshakeDone = false;

      this.ws.on("open", () => {});

      this.ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());

        if (!handshakeDone) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            this.ws!.send(
              JSON.stringify({
                type: "req",
                id: "connect-1",
                method: "connect",
                params: {
                  minProtocol: GATEWAY_PROTOCOL_MIN,
                  maxProtocol: GATEWAY_PROTOCOL_MAX,
                  client: {
                    id: "gateway-client",
                    version: "1.0.0",
                    platform: "linux",
                    mode: "backend",
                  },
                  role: "operator",
                  scopes: ["operator.read", "operator.write", "operator.admin"],
                  caps: ["tool-events"],
                  auth: { token: this.config.token },
                  userAgent: "openclaw-lark-multi-agent/1.0.0",
                },
              })
            );
          } else if (frame.type === "res" && frame.ok && frame.payload?.type === "hello-ok") {
            const negotiatedProtocol = Number(frame.payload.protocol);
            if (negotiatedProtocol !== GATEWAY_PROTOCOL_MAX) {
              reject(new Error(`Unsupported Gateway protocol ${frame.payload.protocol}; LMA requires protocol ${GATEWAY_PROTOCOL_MAX}`));
              this.ws?.close();
              return;
            }
            const advertisedMethods = Array.isArray(frame.payload.features?.methods)
              ? new Set<string>(frame.payload.features.methods)
              : null;
            if (advertisedMethods) {
              const missing = REQUIRED_GATEWAY_METHODS.filter((method) => !advertisedMethods.has(method));
              if (missing.length > 0) {
                reject(new Error(`Gateway is missing required methods: ${missing.join(", ")}`));
                this.ws?.close();
                return;
              }
            }
            const advertisedEvents = Array.isArray(frame.payload.features?.events)
              ? new Set<string>(frame.payload.features.events)
              : null;
            if (advertisedEvents) {
              const missing = REQUIRED_GATEWAY_EVENTS.filter((event) => !advertisedEvents.has(event));
              if (missing.length > 0) {
                reject(new Error(`Gateway is missing required events: ${missing.join(", ")}`));
                this.ws?.close();
                return;
              }
            }
            handshakeDone = true;
            this.connected = true;
            console.log("[OpenClaw] Connected to Gateway WS");
            // Re-subscribe all previously subscribed sessions
            for (const key of this.subscribedKeys) {
              this.rpc("sessions.messages.subscribe", { key: this.canonicalSessionKey(key) }).catch(() => {});
            }
            resolve();
          } else if (frame.type === "res" && !frame.ok) {
            reject(new Error(`Handshake failed: ${JSON.stringify(frame.error)}`));
          }
          return;
        }

        // Responses
        if (frame.type === "res" && frame.id) {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            clearTimeout(p.timer);
            if (frame.ok) {
              p.onSuccess?.(frame.payload);
              p.resolve(frame.payload);
            }
            else p.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`));
          }
        }

        if(frame.event==='agent' && ['tool','item','command_output'].includes(frame.payload?.stream))this.redactPrivateInputTool(frame.payload);
        if(frame.event==='session.message')this.redactPrivateTranscriptTools(frame.payload);

        // Public transcript projections can render an INPUT as role=assistant
        // (forwarded sessions_send / internal receipts). Reject its structured
        // identity before any collector, proactive callback or progress buffer.
        // Do not classify by text, run ownership, or a wrapping prompt prefix:
        // genuine replies/quotes and external Cron/child outputs remain valid.
        if ((frame.event==='chat' ||
          frame.event==='agent' && ['assistant','chatDelta'].includes(frame.payload?.stream)) && this.isInputRecord(frame.payload)) return;

        // Agent events — store per session key
        if (frame.event === "agent" || frame.event === "chat") {
          const sk = frame.payload?.sessionKey || "__default__";
          if (!this.agentEvents.has(sk)) this.agentEvents.set(sk, []);
          // Normalize chat events to look like agent events for collectReply
          if (frame.event === "chat") {
            const state = frame.payload?.state;
            this.trackChatEventSession(sk, state, frame.payload);
            const msg = frame.payload?.message;
            if (state === "delta") {
              // v4: chat delta events carry deltaText (incremental text chunk)
              const deltaText = frame.payload?.deltaText;
              if (deltaText) {
                this.bufferEvent(sk,{
                  ...frame.payload,
                  stream: "chatDelta",
                  data: {
                    deltaText,
                    delta: deltaText,  // v3 compat
                    replace: frame.payload?.replace || false,
                  },
                });
              }
            } else if (state === "final") {
              // Store chat final text as fallback (only used if agent stream had no text)
              const textParts: string[] = [];
              if (msg?.content) {
                for (const part of (Array.isArray(msg.content) ? msg.content : [])) {
                  if (part.type === "text" && part.text) textParts.push(part.text);
                }
              }
              // Store as a special chatFinal event (not assistant delta to avoid double-counting)
              this.bufferEvent(sk,{
                ...frame.payload,
                stream: "chatFinal",
                // Only the Gateway chat-final envelope confirms a handoff.
                // Never infer it from tool names, arguments or raw tool output.
                data: { text: textParts.join("\n"), gatewayYielded: frame.payload?.yielded === true },
              });
            } else if (state === "error" || state === "aborted") {
              // A chat-level error (e.g. "Request timed out before a response")
              // must NOT be silently dropped — otherwise mid-run delta text gets
              // surfaced as if it were a normal reply and the run neither errors
              // nor retries. Record it so the collect loop can surface/handle it.
              this.bufferEvent(sk,{
                ...frame.payload,
                stream: "chatError",
                data: { error: frame.payload?.errorMessage || frame.payload?.error || (state === 'aborted' ? 'aborted' : 'chat error'),
                  state, stopReason: terminalReason(frame.payload?.stopReason,frame.payload?.message?.stopReason) },
              });
            }
          } else {
            this.bufferEvent(sk,frame.payload);
          }
        }

        if (frame.type === "event" && ["agent", "chat"].includes(frame.event)) {
          // No unconditional count splice: a foreign progress burst cannot
          // evict a reserved/unknown full terminal.
          this.dispatchBufferedEvents();
        }
        if (frame.type === "event" && ["agent", "chat", "session.message"].includes(frame.event) &&
          !(frame.event==='session.message' && this.isInputRecord(frame.payload))) {
          for (const observer of this.goEvidenceObservers) {
            try { observer({ channel: frame.event, payload: frame.payload }); }
            catch (error) { console.warn("[OpenClaw] Go evidence observer failed:", (error as Error).message); }
          }
        }
        // Log all events for debugging
        if (frame.type === "event" && frame.event !== "tick") {
          console.log(`[OpenClaw] Event: ${frame.event}`, JSON.stringify(frame.payload || {}).substring(0, 200));
        }

        // Session message events (agent-initiated / proactive + tool calls for verbose)
        if (frame.event === "session.message" && frame.payload) {
          const rawKey = frame.payload.sessionKey || "";
          // Try both raw key and without agent:main: prefix
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const msg = frame.payload.message || frame.payload;
          const visibleUserText = this.extractVisibleUserText(msg);
          if (visibleUserText) {
            if (!this.agentEvents.has(rawKey)) this.agentEvents.set(rawKey, []);
            this.bufferEvent(rawKey,{
              runId: frame.payload.runId,
              sessionKey: rawKey,
              stream: "sessionUser",
              data: { text: visibleUserText },
            });
            // If this user message is one we steered into the run, the model has
            // now actually consumed it (session.message is emitted as the message
            // is committed to the transcript). Render it on the live-status card
            // in correct time order and flip the reaction to Get.
            this.handleSteerConsumption(rawKey, visibleUserText, frame.payload.runId);
          }
          const inputRecord=this.isInputRecord(frame.payload);
          const visibleAssistantText = inputRecord ? "" : this.extractVisibleAssistantText(msg);
          if (visibleAssistantText) {
            if (!this.agentEvents.has(rawKey)) this.agentEvents.set(rawKey, []);
            this.bufferEvent(rawKey,{
              runId: frame.payload.runId,
              sessionKey: rawKey,
              stream: "transcriptAssistant",
              data: { deltaText: visibleAssistantText, delta: visibleAssistantText, replace: true },
            });
          }
          if(!inputRecord)this.handleProactiveSessionMessage(rawKey, msg, frame.payload.runId, frame.payload.sessionId);
          this.dispatchBufferedEvents();

          // Tool calls in assistant messages — skip, using agent item events instead
          // (session.message toolCall events are batched, not real-time)
        }

        // Agent assistant streams — verbose mode buffers intermediate text and
        // flushes it only on a real boundary (for example, before a tool starts).
        // This keeps a single assistant preface together instead of leaking it
        // as multiple debounce-sized Feishu messages.
        if (frame.event === "agent" && (frame.payload?.stream === "assistant" || frame.payload?.stream === "chatDelta")) {
          this.handleVerboseAssistantStream(frame.payload);
        }
        if (frame.event === "agent" && frame.payload?.stream === "lifecycle" && frame.payload?.data?.phase === "end") {
          const rawKey = frame.payload.sessionKey || "";
          this.flushVerboseAssistantState(rawKey, frame.payload.runId);
          this.clearVerboseAssistantState(rawKey, frame.payload.runId);
        }

        // Agent item / command output events — real-time tool tracking for verbose mode.
        if (frame.event === "agent" && frame.payload?.stream === "item") {
          const data = frame.payload.data || {};
          const rawKey = frame.payload.sessionKey || "";
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const toolCb = this.toolEventCallbacks.get(rawKey) || this.toolEventCallbacks.get(shortKey);
          if (data.itemId && data.name) this.lastToolNamesByItemId.set(String(data.itemId), String(data.name));

          if (data.kind === "tool" && data.phase === "start") {
            this.flushVerboseAssistantState(rawKey, frame.payload.runId);
            this.clearVerboseAssistantState(rawKey, frame.payload.runId);
          }

          if (data.kind === "tool" && data.name && (data.phase === "start" || data.phase === "end" || data.phase === "error")) {
            const phase = data.phase as "start" | "end" | "error";
            const eventId = String(data.toolCallId || data.itemId || data.id || data.name);
            if (this.claimToolEvent(rawKey, eventId, phase, Date.now(), frame.payload.runId)) {
              const meta = data.meta || data.input || data.args || "";
              const output = data.output || data.result || data.error || "";
              const inputText = this.formatToolValue(meta, String(data.name), "start");
              const outputText = this.formatToolValue(output, String(data.name), phase);
              if (toolCb) toolCb(`${data.name} ${phase}`.trim(), inputText, outputText);
              const progressCb = this.progressForRun(rawKey, frame.payload.runId);
              if (progressCb) {
                const detail = phase === "start" ? inputText : (outputText || inputText);
                void progressCb({ kind: "tool", phase, name: String(data.name), text: `${data.name} ${phase}${detail ? `: ${detail}` : ""}` });
              }
            }
          }
        }
        // OpenClaw 2026.8 canonical tool stream. Some runtimes also emit the
        // legacy item mirror, so claimToolEvent suppresses duplicate start/end.
        if (frame.event === "agent" && frame.payload?.stream === "tool") {
          const data = frame.payload.data || {};
          const rawKey = frame.payload.sessionKey || "";
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const rawPhase = String(data.phase || "");
          const phase: "start" | "end" | "error" | undefined = rawPhase === "start"
            ? "start"
            : rawPhase === "result"
              ? (data.isError || data.error ? "error" : "end")
              : undefined;
          const name = String(data.name || data.toolName || "tool");
          const eventId = String(data.toolCallId || data.itemId || data.id || name);
          if (phase && this.claimToolEvent(rawKey, eventId, phase, Date.now(), frame.payload.runId)) {
            if (phase === "start") {
              this.flushVerboseAssistantState(rawKey, frame.payload.runId);
              this.clearVerboseAssistantState(rawKey, frame.payload.runId);
            }
            const input = data.input || data.args || data.meta || "";
            const output = data.output || data.result || data.error || "";
            const inputText = this.formatToolValue(input, name, "start");
            const outputText = this.formatToolValue(output, name, phase);
            const toolCb = this.toolEventCallbacks.get(rawKey) || this.toolEventCallbacks.get(shortKey);
            if (toolCb) toolCb(`${name} ${phase}`, inputText, outputText);
            const progressCb = this.progressForRun(rawKey, frame.payload.runId);
            if (progressCb) {
              const detail = phase === "start" ? inputText : (outputText || inputText);
              void progressCb({ kind: "tool", phase, name, text: `${name} ${phase}${detail ? `: ${detail}` : ""}` });
            }
          }
        }
        if (frame.event === "agent" && frame.payload?.stream === "command_output") {
          const data = frame.payload.data || {};
          const rawKey = frame.payload.sessionKey || "";
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const toolCb = this.toolEventCallbacks.get(rawKey) || this.toolEventCallbacks.get(shortKey);
          if (toolCb && process.env.OPENCLAW_LARK_MULTI_AGENT_VERBOSE_FULL === "1") {
            const itemId = String(data.itemId || "");
            const name = data.name || this.lastToolNamesByItemId.get(itemId.replace(/^command:/, "tool:")) || "command_output";
            const output = data.text || data.output || data.stdout || data.stderr || data.content || data.result || JSON.stringify(data).slice(0, 2000);
            toolCb(`${name} output`.trim(), "", String(output || ""));
          }
        }
      });

      this.ws.on("error", (err) => {
        if (!handshakeDone) reject(err);
        else console.error("[OpenClaw] WS error:", safeErrorSummary(err));
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.connectPromise = null;
        console.log("[OpenClaw] WS disconnected");
        // Reject all in-flight RPCs so callers fail fast instead of hanging until
        // their timeout. Combined with the collectReply disconnect check, this
        // lets the bridge release busy locks promptly on a gateway restart.
        if (this.pending.size > 0) {
          const err = new Error("Gateway disconnected");
          for (const [id, entry] of this.pending) {
            if (entry.timer) clearTimeout(entry.timer);
            try { entry.reject(err); } catch { /* ignore */ }
            this.pending.delete(id);
          }
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private extractVisibleUserText(msg: any): string {
    if (msg?.role !== "user") return "";
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
  }

  /** Role is presentation, not authorship. Core's public forwarded-message
   * projection preserves these input markers even when it changes user to
   * assistant. Stream events without a message/role remain supported; never
   * inspect run-level inputProvenance (a real reply may answer such an input). */
  private isInputRecord(record:any):boolean {
    if(!record || typeof record!=='object')return false;
    if(typeof record.role==='string' && record.role!=='assistant')return true;
    if(['external_user','inter_session','internal_system'].includes(record.provenance?.kind))return true;
    if(record.senderSession && typeof record.senderSession==='object')return true;
    const inputKey=record.idempotencyKey ?? record.__openclaw?.idempotencyKey;
    if(typeof inputKey==='string' && inputKey.endsWith(':user'))return true;
    return this.isInputRecord(record.message) || this.isInputRecord(record.data);
  }

  private extractVisibleAssistantText(msg: any, options: { allowMixedToolText?: boolean } = {}): string {
    if (msg?.role !== "assistant" || this.isInputRecord(msg)) return "";
    const content = msg.content;

    // Extract only visible text parts and ignore thinking/tool blocks.
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";

    const hasToolBlock = content.some((part: any) => {
      const type = String(part?.type || "").toLowerCase();
      return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use" || type === "toolresult" || type === "tool_result";
    });
    // Do not deliver mixed text+toolCall assistant messages through the
    // final-text path; those are usually intermediate tool-loop status.
    // Verbose mode opts into these visible text fragments so tool-call preface
    // and follow-up narration are not lost while tool events are being shown.
    if (hasToolBlock && !options.allowMixedToolText) return "";

    return content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
  }

  private isVerboseTranscriptEnabled(rawKey: string): boolean {
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    return this.verboseTranscriptSessions.has(rawKey) || this.verboseTranscriptSessions.has(shortKey);
  }

  private progressKey(sessionKey:string,runId?:string):string {
    return JSON.stringify([this.canonicalSessionKey(sessionKey),runId || ""]);
  }

  private progressForRun(sessionKey:string,runId?:string) {
    const key=this.canonicalSessionKey(this.shortKey(sessionKey));
    // Installed public agent events already map runtime continuations to the
    // admitted client runId. Session proximity/lifecycle starts are not lineage.
    if(!runId || this.progressRuns.get(key)!==runId)return undefined;
    return this.progressCallbacks.get(key) || this.progressCallbacks.get(this.shortKey(key));
  }

  private clearVerboseAssistantState(sessionKey: string, runId?:string): void {
    const canonical=this.canonicalSessionKey(sessionKey);
    const keys=runId!==undefined ? [this.progressKey(sessionKey,runId)]
      : [...this.verboseAssistantLastTouched.keys()].filter(key=>{try{return JSON.parse(key)[0]===canonical;}catch{return false;}});
    for (const key of keys) {
      const timer = this.verboseAssistantTimers.get(key);
      if (timer) clearTimeout(timer);
      this.verboseAssistantTimers.delete(key);
      this.verboseAssistantLatest.delete(key);
      this.verboseAssistantSent.delete(key);
      this.verboseAssistantLastTouched.delete(key);
    }
  }

  private canonicalToolName(name:unknown):string {
    return String(name || "").split(/[.:]/).pop() || "";
  }

  /** Inspect supported public wrappers recursively, including JSON arguments.
   * A wrapper containing any private coordination call has private results too;
   * do not try to salvage arbitrary echoed result/error strings. */
  private isPrivateCoordination(name:unknown,value:unknown,depth=0):boolean {
    const tool=this.canonicalToolName(name);
    if(['sessions_spawn','sessions_send','sessions_yield'].includes(tool))return true;
    if(depth>16)return ['tool_call','parallel'].includes(tool);
    let args:any=value;
    if(typeof args==='string'){try{args=JSON.parse(args);}catch{return false;}}
    if(!args || typeof args!=='object')return false;
    if(tool==='tool_call')return this.isPrivateCoordination(args.id || args.name,args.args ?? args.parameters,depth+1);
    if(tool==='parallel' && Array.isArray(args.tool_uses))return args.tool_uses.some((call:any)=>
      this.isPrivateCoordination(call?.recipient_name || call?.name || call?.id,call?.parameters ?? call?.args,depth+1));
    return false;
  }

  private knownPublicWrapper(name:unknown,value:unknown,depth=0):boolean {
    if(depth>16)return false;
    const tool=this.canonicalToolName(name);
    if(['sessions_spawn','sessions_send','sessions_yield'].includes(tool))return false;
    if(!['tool_call','parallel'].includes(tool))return Boolean(tool);
    let args:any=value;
    if(typeof args==='string'){try{args=JSON.parse(args);}catch{return false;}}
    if(!args || typeof args!=='object')return false;
    if(tool==='tool_call')return this.knownPublicWrapper(args.id || args.name,args.args ?? args.parameters,depth+1);
    return Array.isArray(args.tool_uses) && args.tool_uses.every((call:any)=>
      this.knownPublicWrapper(call?.recipient_name || call?.name || call?.id,call?.parameters ?? call?.args,depth+1));
  }

  /** Redact BEFORE event buffers, logging, observers, cards and verbose sinks.
   * Call custody is session+run+id scoped, so item/command/result mirrors stay
   * private even after the original wrapper arguments have disappeared. */
  private redactPrivateInputTool(payload:any):boolean {
    const data=payload?.data;
    if(!data || payload.stream==='item' && data.kind!=='tool')return false;
    const eventId=String(data.toolCallId || data.itemId || data.id || '').replace(/^(?:tool|command):/,'');
    const key=this.progressKey(payload.sessionKey || '',payload.runId)+':'+eventId;
    const name=data.name || data.toolName;
    const wrapper=['tool_call','parallel'].includes(this.canonicalToolName(name));
    const privateBody=[data.input,data.args,data.meta,data.output,data.result,data.error].some(value=>this.isPrivateCoordination(name,value));
    if(data.phase==='start' && eventId && !privateBody && this.knownPublicWrapper(name,data.input ?? data.args ?? data.meta)) {
      this.publicToolCalls.add(key);
      if(this.publicToolCalls.size>2048)this.publicToolCalls.delete(this.publicToolCalls.values().next().value!);
    }
    // An orphan wrapper result can echo hidden arguments. Only a correlated
    // known-public call may expose its arbitrary scalar output.
    const ambiguousResult=(wrapper || ['', 'tool', 'command_output'].includes(this.canonicalToolName(name))) && data.phase!=='start' && !this.publicToolCalls.has(key);
    if(privateBody && eventId) {
      this.privateInputToolCalls.add(key);
      if(this.privateInputToolCalls.size>2048)this.privateInputToolCalls.delete(this.privateInputToolCalls.values().next().value!);
    }
    if(!privateBody && !ambiguousResult && (!eventId || !this.privateInputToolCalls.has(key)))return false;
    payload.data=Object.fromEntries(['kind','phase','name','toolName','toolCallId','itemId','id','isError'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
    return true;
  }

  private redactPrivateTranscriptTools(payload:any):void {
    const msg=payload?.message || payload;
    if(!msg || typeof msg!=='object')return;
    const redact=(part:any,phase:string)=>{
      const synthetic={sessionKey:payload?.sessionKey,runId:payload?.runId,stream:'tool',data:{
        ...part,name:part?.name || part?.toolName,toolCallId:part?.toolCallId || part?.tool_use_id || part?.id,
        phase,input:part?.arguments ?? part?.input ?? part?.args,result:part?.content ?? part?.output ?? part?.result,
      }};
      return this.redactPrivateInputTool(synthetic);
    };
    if(['tool','toolResult'].includes(msg.role) && redact(msg,'result')) {
      msg.content=[];delete msg.output;delete msg.result;delete msg.error;delete msg.arguments;delete msg.input;delete msg.args;
    }
    if(Array.isArray(msg.content))msg.content=msg.content.map((part:any)=>{
      const type=String(part?.type || '').toLowerCase();
      const phase=['toolcall','tool_call','tooluse','tool_use'].includes(type)?'start'
        : ['toolresult','tool_result'].includes(type)?'result':undefined;
      if(!phase || !redact(part,phase))return part;
      return Object.fromEntries(['type','id','name','toolName','toolCallId','tool_use_id','isError'].filter(k=>part[k]!==undefined).map(k=>[k,part[k]]));
    });
  }


  /** Render protocol-4 structured tool args/results without `[object Object]`.
   * Prefer useful, non-secret fields and keep the fallback bounded. */
  private formatToolValue(value: unknown, toolName: string, phase: "start" | "end" | "error"): string {
    if(this.isPrivateCoordination(toolName,value))return "";
    toolName=this.canonicalToolName(toolName);
    if(phase==='start' && ['tool_call','parallel'].includes(toolName)) {
      let args:any=value;
      if(typeof args==='string'){try{args=JSON.parse(args);}catch{return "";}}
      if(toolName==='tool_call' && args?.id) {
        const name=this.canonicalToolName(args.id),detail=this.formatToolValue(args.args ?? args.parameters,name,phase);
        return `${name}${detail ? ': '+detail : ''}`;
      }
      if(toolName==='parallel' && Array.isArray(args?.tool_uses))return args.tool_uses.slice(0,4).map((call:any)=>{
        const name=this.canonicalToolName(call?.recipient_name || call?.name || call?.id),detail=this.formatToolValue(call?.parameters ?? call?.args,name,phase);
        return `${name}${detail ? ': '+detail : ''}`;
      }).join('; ');
      return "";
    }
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, 4).map((item) => this.formatToolValue(item, toolName, phase)).filter(Boolean);
      return items.join("; ");
    }
    if (typeof value !== "object") return String(value);

    const record = value as Record<string, unknown>;
    const read = (key: string) => this.formatToolValue(record[key], toolName, phase);
    const first = (...keys: string[]) => {
      for (const key of keys) {
        if (!(key in record)) continue;
        const text = read(key);
        if (text) return text;
      }
      return "";
    };

    // Tool-specific start summaries put the primary operation first.
    if (phase === "start") {
      if (toolName === "exec") {
        const command = first("command", "cmd", "script");
        const cwd = first("workdir", "cwd");
        if (command) return cwd ? `${command} (cwd: ${cwd})` : command;
      }
      if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
        const path = first("path", "file", "filename");
        if (path) return path;
      }
      if (toolName === "web_fetch") {
        const url = first("url");
        if (url) return url;
      }
      if (toolName === "web_search") {
        const query = first("query");
        if (query) return query;
      }
    }

    const primary = phase === "start"
      ? first("command", "path", "url", "query", "action", "target", "sessionKey", "key", "name", "description", "text")
      : first("error", "message", "status", "exitCode", "output", "stdout", "stderr", "text", "result");
    if (primary) return primary;

    // Safe generic fallback: omit fields that commonly carry credentials or
    // large payloads, then serialize a few scalar fields only.
    const blocked = /token|secret|password|auth|credential|cookie|buffer|content|data|env/i;
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(record)) {
      if (blocked.test(key) || raw === null || raw === undefined || typeof raw === "object") continue;
      parts.push(`${key}=${String(raw)}`);
      if (parts.length >= 4) break;
    }
    return parts.join(", ");
  }

  private claimToolEvent(sessionKey: string, eventId: string, phase: "start" | "end" | "error", now = Date.now(), runId?:string): boolean {
    const normalizedPhase = phase === "error" ? "end" : phase;
    const normalizedId = eventId.replace(/^(?:tool|command):/, "");
    const key = `${this.progressKey(sessionKey,runId)}:${normalizedId}:${normalizedPhase}`;
    const seenAt = this.recentToolEventKeys.get(key);
    if (seenAt !== undefined && now - seenAt < 60_000) return false;
    this.recentToolEventKeys.set(key, now);
    if (this.recentToolEventKeys.size > 2000) {
      for (const [candidate, ts] of this.recentToolEventKeys) {
        if (now - ts > 60_000) this.recentToolEventKeys.delete(candidate);
      }
    }
    return true;
  }

  private pruneVerboseCaches(now = Date.now()): void {
    for (const [key, ts] of this.verboseAssistantLastTouched) {
      if (now - ts > 10 * 60_000) {
        const timer = this.verboseAssistantTimers.get(key);
        if (timer) clearTimeout(timer);
        this.verboseAssistantTimers.delete(key);
        this.verboseAssistantLatest.delete(key);
        this.verboseAssistantSent.delete(key);
        this.verboseAssistantLastTouched.delete(key);
      }
    }
    if (this.lastToolNamesByItemId.size > 1000) {
      const overflow = this.lastToolNamesByItemId.size - 1000;
      for (const key of Array.from(this.lastToolNamesByItemId.keys()).slice(0, overflow)) this.lastToolNamesByItemId.delete(key);
    }
    for (const [key, ts] of this.recentToolEventKeys) {
      if (now - ts > 60_000) this.recentToolEventKeys.delete(key);
    }
  }

  private flushVerboseAssistantState(rawKey: string,runId?:string): boolean {
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
    const progressCb = this.progressForRun(rawKey, runId);
    if (!this.isVerboseTranscriptEnabled(rawKey) && !progressCb) return false;
    if (!cb && !progressCb) return false;
    const key = this.progressKey(rawKey,runId);
    const latest = this.verboseAssistantLatest.get(key)?.trim() || "";
    if (!latest) return false;
    const sent = this.verboseAssistantSent.get(key) || "";
    if (latest === sent) return false;
    let toSend = latest;
    if (sent && latest.startsWith(sent)) {
      toSend = latest.slice(sent.length).trim();
    }
    if (!toSend) return false;
    this.verboseAssistantSent.set(key, latest);
    if (this.isVerboseTranscriptEnabled(rawKey) && cb) cb(toSend, { sourceType: "verbose_transcript",...(runId?{runId,sessionKey:this.canonicalSessionKey(rawKey)}:{}) });
    if (progressCb) void progressCb({ kind: "assistant_note", text: toSend });
    return true;
  }

  private handleVerboseAssistantStream(payload: any): void {
    if(this.isInputRecord(payload))return;
    const rawKey = payload?.sessionKey || "";
    if (!rawKey) return;
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
    const progressCb = this.progressForRun(rawKey, payload.runId);
    if (!this.isVerboseTranscriptEnabled(rawKey) && !progressCb) return;
    if (!cb && !progressCb) return;
    const data = payload.data || {};
    const fullText = typeof data.text === "string" ? data.text : typeof data.deltaText === "string" && data.replace ? data.deltaText : "";
    const deltaText = !fullText && typeof data.delta === "string" ? data.delta : !fullText && typeof data.deltaText === "string" ? data.deltaText : "";
    const key = this.progressKey(rawKey,payload.runId);
    const previous = this.verboseAssistantLatest.get(key) || "";
    const text = (fullText || (previous + deltaText)).trim().slice(-1024*1024);
    if (!text) return;
    const now = Date.now();
    this.verboseAssistantLatest.set(key, text);
    this.verboseAssistantLastTouched.set(key, now);
    this.pruneVerboseCaches(now);
    if (text.length >= 3000) {
      this.flushVerboseAssistantState(rawKey, payload.runId);
    }
  }

  private handleProactiveSessionMessage(rawKey: string, msg: any, runId?: string, sessionId?: string): boolean {
    if(this.isInputRecord(msg))return false;
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");

    // Proactive assistant text messages. Cron/session-targeted runs often emit
    // structured content arrays rather than a plain string. Extract only visible
    // text parts and ignore thinking/tool blocks so the bridge can deliver final
    // cron results via the bot.
    if (msg?.role === "assistant" && ["error", "aborted", "timeout", "restart", "superseded"].includes(msg?.stopReason)) {
      if (this.mutedProactiveSessions.has(rawKey) || this.mutedProactiveSessions.has(shortKey)) return false;
      if (runId && this.ownedDeliveryRuns.has(runId)) return false;
      return this.emitProactiveForSession(rawKey, String(msg.errorMessage || "Agent run failed"), {
        sourceType: "run_error", runId,
        error: { sessionKey: this.canonicalSessionKey(rawKey), runId: runId || "", source: "session.message",
          state: "final", sessionId, stopReason: closedStopReason(msg.stopReason), detail: String(msg.errorMessage || ""),
          ...(this.isExplicitlyStoppedRun(rawKey, runId) ? { userStop: true } : {}) },
      });
    }
    const allowVerboseTranscript = this.isVerboseTranscriptEnabled(rawKey);
    const proactiveText = this.extractVisibleAssistantText(msg, { allowMixedToolText: allowVerboseTranscript });
    if (!proactiveText) return false;
    if (runId && this.ownedDeliveryRuns.has(runId)) {
      console.log(`[OpenClaw] Dropping proactive msg for ${shortKey}; run delivery is owned by chatSend`);
      return false;
    }
    if (this.mutedProactiveSessions.has(rawKey) || this.mutedProactiveSessions.has(shortKey)) {
      console.log(`[OpenClaw] Dropping proactive msg for ${shortKey}; delivery is owned by the caller`);
      return false;
    }
    if (this.suppressedSessions.has(rawKey) || this.suppressedSessions.has(shortKey)) {
      console.log(`[OpenClaw] Dropping proactive transcript msg for ${shortKey}; waiting for final delivery path`);
      return false;
    }
    if(runId && this.isExplicitlyStoppedRun(rawKey,runId)) return false;
    return this.emitProactiveForSession(rawKey,proactiveText,runId ? {runId,sessionId,sessionKey:this.canonicalSessionKey(rawKey),final:msg?.stopReason==='stop',
      ...(!msg?.stopReason && genericFailure(proactiveText) ? {genericErrorCandidate:true} : {})} : undefined);

  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    console.log(`[OpenClaw] Reconnecting in ${delay}ms...`);
    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectDelay = 1000; // reset on success
        console.log("[OpenClaw] Reconnected successfully");
      } catch (err) {
        console.error("[OpenClaw] Reconnect failed:", safeErrorSummary(err));
        if (this.shouldReconnect) this.scheduleReconnect();
      }
    }, delay);
  }

  private rpc(method: string, params: any, timeoutMs = 120000): Promise<any> {
    return new Promise(async (resolve, reject) => {
      if (!this.ws || !this.connected) {
        try {
          await this.connect();
        } catch (err) {
          reject(new Error("Not connected and reconnect failed"));
          return;
        }
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer,
        onSuccess:method==='chat.send' ? this.admissionResponseHooks.get(params?.idempotencyKey) : undefined });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Exact admitted-root observation with non-destructive event cursors.
   * Gateway maps runtime continuations to its public client runId; an unrelated
   * session lifecycle start is not lineage. Separate requester/task continuation
   * lineage remains owned by handoffLinkedContinuation + exact root recovery.
   * Effective silence prompts read-only reconciliation, never a lifetime cutoff.
   */
private collectReply(runId: string, timeoutMs = FOREGROUND_WAIT_MS, targetSessionKey?: string, options?: { exactRunIdentity?: boolean; emptyFinalAsNoReply?: boolean; expectedUserText?: string; expectedSessionId?:string; onWaitPaused?: (notice: SessionWaitPaused) => void | Promise<void>; onYieldHandoff?: (runId:string)=>void }): Promise<string> {
    let cleanupObservation = () => {};
    return new Promise<string>((resolveResult, rejectResult) => {
      // Whether we were connected when the run started. We only treat a later
      // disconnect as a mid-run gateway drop (fail fast) if we began connected;
      // this keeps unit tests that drive collectReply without a live socket from
      // tripping the disconnect path.
      const startedConnected = this.connected;
      let chatFinalText = "";
      let sessionKey = targetSessionKey ? `agent:main:${targetSessionKey.replace(/^agent:[^:]+:/, "")}` : "";
      let shortSessionKey = targetSessionKey ? targetSessionKey.replace(/^agent:[^:]+:/, "") : "";
      let chatFinalTimer: ReturnType<typeof setTimeout> | null = null;
      let lifecycleEndTimer: ReturnType<typeof setTimeout> | null = null;
      let replayInvalidTimer: ReturnType<typeof setTimeout> | null = null;
      let genericChatErrorTimer: ReturnType<typeof setTimeout> | null = null;
      // A terminating message-tool send schedules ONE deferred exact-run
      // reconciliation. The timer carries no settlement or delivery authority
      // of its own; checkRunState still requires the gateway to confirm the
      // root's recorded terminal state (all tools settled, no error, no async
      // pending) before anything resolves.
      let terminatingReconcileTimer: ReturnType<typeof setTimeout> | null = null;
      let terminalHint: ErrorProvenance | undefined;
      let pendingRuntimeFailureText = "";
      let lastActivitySummary = "";
      let lastActivityAt = 0;
      const collectStartedAt = Date.now();
      let lifecycleStartedLogged = false;
      const activeRunIds = new Set<string>([runId]);
      const seenEvents=new WeakSet<object>();
      const releaseEventReader=this.retainRunEventCustody('reader',targetSessionKey,runId);

      let idleTimer: ReturnType<typeof setTimeout>;
      let observationClosed = false;
      // Close synchronously: a deferred yield notice must not overtake a final
      // or error just because Promise.finally cleanup has not run yet.
      const resolve = (value: string) => { observationClosed = true; resolveResult(value); };
      const reject = (error: Error) => { observationClosed = true; rejectResult(error); };
      let checkingState = false;
      let lastStateCheckAt = -Infinity;
      let quietNotified = false;
      let decidingTimeout = false;
      let waitNoticeSent = false;
      let foregroundPaused = false;
      let turnYielded = false;
      const handleTimeoutResult = async (error: Error, stillCurrent=()=>true) => {
        collectEvents();
        if (observationClosed) return;
        if(!stillCurrent()){decidingTimeout=false;return;}
        if (chatFinalText.trim()) { finish(chatFinalText); return; }
        if (error instanceof SessionWaitPaused) {
          // Presentation only. A separate trusted-yield callback may transfer
          // scheduling custody; an ordinary timeout never authorizes that handoff.
          foregroundPaused = true;
          if (!waitNoticeSent) {
            waitNoticeSent = true;
            try { await options?.onWaitPaused?.(error); }
            catch { console.warn("[OpenClaw] wait notice delivery pending; observation retained"); }
          }
          decidingTimeout = false;
          if (!observationClosed && stillCurrent()) resetIdleTimer(60_000, false);
          return;
        }
        reject(error);
      };
      const checkRunState = async (idleStillCurrent = () => true, force = false) => {
        if (observationClosed || checkingState || !force && Date.now() - lastStateCheckAt < 60_000) return;
        checkingState = true;
        lastStateCheckAt = Date.now();
        const decisionGeneration=idleGeneration;
        try {
          const snapshot = await this.rpc("agent.wait", { runId, timeoutMs: 1500 }, 2500);
          // A query can return a terminal projection sampled before a newer
          // same-root continuation made real progress. Drain the received wire
          // first and fence that stale cut; a fresh exact query may still fail.
          collectEvents();
          if(!idleStillCurrent() || idleGeneration!==decisionGeneration)return;
          if (observationClosed || snapshot?.runId !== runId || options?.expectedSessionId && snapshot?.sessionId && snapshot.sessionId!==options.expectedSessionId || snapshot?.pendingError === true
            || snapshot?.yielded === true || snapshot?.timeoutPhase === "queue" || snapshot?.timeoutPhase === "gateway_draining") return;
          // A bare wait timeout is not an execution timeout. Require a recorded
          // terminal time; never infer failure from stopReason or replay flags.
          const ended = snapshot.endedAt;
          if (typeof ended !== "number" || !Number.isFinite(ended) || ended <= 0
            || (snapshot.startedAt !== undefined && (typeof snapshot.startedAt !== 'number' || !Number.isFinite(snapshot.startedAt) || snapshot.startedAt<0 || ended < snapshot.startedAt))) return;
          if (snapshot.status === "ok" && snapshot.yielded !== true) {
            const terminal = snapshot.terminalReply;
            // B6 (2026-10-16 audit): disposition "empty" is an authoritative
            // no-visible-text terminal — never recycle an interim draft as the
            // final answer. Unspecified/malformed metadata retains observation.
            const visible = terminal?.disposition === "visible" && typeof terminal.text === "string"
              ? terminal.text
              : terminal?.disposition === "silent" || terminal?.disposition === "empty"
                ? "NO_REPLY"
                : "";
            if (!visible.trim()) return;
            resolve(visible);
          } else if (snapshot.status === "error" || snapshot.status === "timeout") {
            if (observationClosed) return;
            reject(new RunTerminalError({sessionKey,sessionId:options?.expectedSessionId,runId,source:'chat',state:'error',
              stopReason:closedStopReason(snapshot.stopReason) || (snapshot.status==='timeout' ? 'timeout' : undefined),
              detail:typeof snapshot.error==='string' ? snapshot.error : undefined}));
          }
        } catch { /* Unavailable evidence means keep waiting, never abort/replay. */ }
        finally { checkingState = false; }
      };
      // One clock for foreground silence and subsequent low-frequency observation.
      // A generation fences status RPCs that complete after newer real activity.
      let idleGeneration = 0;
      let idleGuardTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdleGuard = () => { if(idleGuardTimer) clearTimeout(idleGuardTimer); idleGuardTimer=undefined; };
      const resetIdleTimer = (delayMs = timeoutMs, activity = true) => {
        if (activity) { if (!foregroundPaused) waitNoticeSent = false; quietNotified = false; }
        const generation = ++idleGeneration;
        const idleStillCurrent = () => !observationClosed && generation === idleGeneration;
        if (idleTimer) clearTimeout(idleTimer);
        clearIdleGuard();
        if (observationClosed) return;
        idleTimer = setTimeout(() => {
          const ownGuard = setTimeout(() => {
            if(!idleStillCurrent()) return;
            // Remove success suppression synchronously BEFORE closing this exact
            // observer. Late final/error stays on its durable original route.
            this.releasePausedWait(runId);
            cleanupObservation();
            reject(new CollectorStalledError());
          }, IDLE_GUARD_MS);
          idleGuardTimer=ownGuard;
          ownGuard.unref?.();
          void (async () => {
          // Drain already-received frames before judging silence: the 50ms
          // collection poll may otherwise run just after this deadline.
          collectEvents();
          if (!idleStillCurrent()) return;
          if (!quietNotified) {
            quietNotified = true;
            console.warn(`[OpenClaw] quiet run ${runId}; checking Gateway state without stopping execution`);
          }
          await checkRunState(idleStillCurrent);
          if (!idleStillCurrent()) return;
          const status = await this.getSessionRuntimeStatus(targetSessionKey || sessionKey);
          collectEvents();
          if (!idleStillCurrent()) return;
          // With a foreground callback, silence freezes presentation even when
          // status is unknown/idle; never invent running. Without one, retain
          // the published running-only typed outcome and background checks.
          if (status.running || options?.onWaitPaused) {
            await handleTimeoutResult(new SessionWaitPaused(status), idleStillCurrent);
            return;
          }
          resetIdleTimer(60_000, false);
          })().catch(error => { if(idleStillCurrent()) reject(error instanceof Error ? error : new Error(String(error))); })
            .finally(() => {
              // An obsolete callback must never clear a newer callback's guard.
              clearTimeout(ownGuard);
              if(idleGuardTimer===ownGuard) idleGuardTimer=undefined;
            });
        }, delayMs);
      };
      // Activity filtering is deliberately separate from reply assembly/matching:
      // legacy session fallback must keep delivering replies as before, but an
      // unrelated/unidentified run must not extend this run's foreground wait.
      const activityKeys = new Set<string>();
      const activityText = new Map<string, string>();
      const claimActivity = (value: string) => {
        // Retain fingerprints rather than copies of cumulative/private text.
        const key = createHash("sha256").update(value).digest("hex");
        if (activityKeys.has(key)) return false;
        activityKeys.add(key);
        if(activityKeys.size>4096) activityKeys.delete(activityKeys.values().next().value!);
        return true;
      };
      const hasEffectiveActivity = (ev: any): boolean => {
        if (!ev.runId || !activeRunIds.has(ev.runId)) return false;
        const data = ev.data || {};
        const run = String(ev.runId);
        if (ev.stream === "tool" || (ev.stream === "item" && data.kind === "tool")) {
          const phase = data.phase === "result" ? (data.isError || data.error ? "error" : "end") : data.phase;
          if (phase !== "start" && phase !== "end" && phase !== "error") return false;
          // Canonical tool and legacy item mirrors share identity and phase.
          // Without a call id, conservatively recognize each name/phase once.
          const id = data.toolCallId || data.itemId || data.id || data.name || data.toolName;
          return Boolean(id) && claimActivity(JSON.stringify([run, "tool", id, phase]));
        }
        if (ev.stream === "lifecycle" && data.phase === "start") {
          return claimActivity(JSON.stringify([run, "start"]));
        }
        if (ev.stream === "assistant" || ev.stream === "chatDelta" || ev.stream === "transcriptAssistant") {
          const fullText = typeof data.text === "string" ? data.text : "";
          const rawChunk = fullText || data.deltaText || data.delta;
          const chunk = typeof data.activityFingerprint==='string'
            ? `[activity-sha256:${data.activityFingerprint}]`:rawChunk;
          const replace = Boolean(fullText || data.replace);
          if (typeof chunk !== "string" || !chunk.trim()) return false;
          const source = JSON.stringify([run, ev.stream]);
          // seq identifies repeated incremental frames, not progress by itself.
          // No-seq identical fragments are ambiguous: do not let replay extend idle.
          if (!claimActivity(JSON.stringify([source, ev.seq ?? null, replace, chunk]))) return false;
          const previous = activityText.get(source) || "";
          const next = replace ? chunk : previous + chunk;
          activityText.set(source, next.slice(-256*1024));
          if (next === previous || (replace && previous.includes(next))) return false;
          // Replayed replacement snapshots and assistant/chat/transcript mirrors
          // with the same accumulated text are not additional task progress.
          return claimActivity(JSON.stringify([run, "text", next]));
        }
        // Usage, ticks, user receipts, status/wait responses and unknown streams
        // are not verified task progress. Tool output is counted at completion.
        return false;
      };
      const summarizeActivity = (ev: any): string => {
        if (ev.stream === "item") {
          const data = ev.data || {};
          if (data.kind === "tool") {
            const phase = data.phase ? ` ${data.phase}` : "";
            const meta = typeof data.meta === "string" && data.meta.trim() ? `: ${data.meta.trim().slice(0, 300)}` : "";
            return `工具${phase}${data.name ? ` ${data.name}` : ""}${meta}`;
          }
          return `运行事件 item${data.kind ? `/${data.kind}` : ""}`;
        }
        if (ev.stream === "assistant" || ev.stream === "chatDelta" || ev.stream === "transcriptAssistant") {
          const chunk = String(ev.data?.deltaText || ev.data?.delta || "").trim();
          return chunk ? `模型输出片段: ${chunk.slice(0, 300)}` : "模型输出片段";
        }
        if (ev.stream === "chatFinal") return "收到 chat final 事件";
        if (ev.stream === "lifecycle") {
          const state = ev.data?.livenessState || ev.data?.status || ev.data?.phase || "unknown";
          const reason = ev.data?.stopReason ? `, reason=${ev.data.stopReason}` : "";
          const replay = ev.data?.replayInvalid ? ", replayInvalid" : "";
          return `运行状态: ${state}${replay}${reason}`;
        }
        return `事件: ${ev.stream || "unknown"}`;
      };
      const rememberActivity = (ev: any) => {
        // A replay-invalid lifecycle end is the terminal symptom, not the useful
        // last activity. Keep the previous tool/model activity so user-visible
        // timeout messages explain what the agent was actually doing.
        if (ev.stream === "lifecycle" && ev.data?.phase === "end" && ev.data?.replayInvalid && lastActivitySummary) return;
        const summary = summarizeActivity(ev);
        if (summary) {
          lastActivitySummary = summary;
          lastActivityAt = Date.now();
        }
      };
      resetIdleTimer();

      const finish = (finalText: string) => {
        clearTimeout(idleTimer);
        clearInterval(poller);
        if (chatFinalTimer) clearTimeout(chatFinalTimer);
        if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
        if (replayInvalidTimer) clearTimeout(replayInvalidTimer);
        if (genericChatErrorTimer) clearTimeout(genericChatErrorTimer);
        if (terminatingReconcileTimer) clearTimeout(terminatingReconcileTimer);
        resolve(finalText);
      };

      // One bounded public exact-run reconciliation for generic aborts. A
      // closed wire cause wins over generic later prose, never another run.
      const deferTerminal = (ev: any, detail: string) => {
        const reason = closedStopReason(ev.data?.stopReason);
        const p: ErrorProvenance = {sessionKey,sessionId:options?.expectedSessionId || ev.sessionId,runId,
          source:'chat',state:ev.data?.state==='aborted' || reason ? 'aborted' : 'error',stopReason:reason,detail};
        if (!terminalHint || reasonPriority(reason)>reasonPriority(terminalHint.stopReason)) terminalHint=p;
        if (genericChatErrorTimer) return;
        const abortGeneration=idleGeneration;
        genericChatErrorTimer=setTimeout(() => {
          genericChatErrorTimer=null;
          void (async () => {
            collectEvents();
            if(observationClosed)return;
            if(!terminalHint?.stopReason && idleGeneration!==abortGeneration){terminalHint=undefined;return;}
            if(chatFinalText.trim()){finish(chatFinalText);return;}
            let candidate=terminalHint!;
            if(!candidate.stopReason) {
              try {
                const snapshot=await this.rpc('agent.wait',{runId,timeoutMs:1},2000);
                collectEvents();if(observationClosed)return;
                if(options?.expectedSessionId && snapshot?.sessionId && snapshot.sessionId!==options.expectedSessionId)return;
                if(chatFinalText.trim()){finish(chatFinalText);return;}
                // The query sampled the provisional abort's old liveness cut.
                // Drain first, then fence even a recorded terminal snapshot if
                // verified same-run progress advanced while this read awaited.
                if(!terminalHint?.stopReason && idleGeneration!==abortGeneration){terminalHint=undefined;return;}
                if(terminalHint?.stopReason) candidate=terminalHint;
                else if(snapshot?.runId===runId && !snapshot.pendingError && !snapshot.yielded &&
                  !['queue','gateway_draining'].includes(snapshot.timeoutPhase) && Number.isFinite(snapshot.endedAt) && snapshot.endedAt>0 &&
                  (snapshot.startedAt===undefined || typeof snapshot.startedAt==='number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt>=0 && snapshot.endedAt>=snapshot.startedAt)) {
                  if(snapshot.status==='ok' && snapshot.terminalReply?.disposition==='visible' && typeof snapshot.terminalReply.text==='string') {finish(snapshot.terminalReply.text);return;}
                  if(snapshot.status==='ok' && ['silent','empty'].includes(snapshot.terminalReply?.disposition)){finish('NO_REPLY');return;}
                  if(!['error','timeout'].includes(snapshot.status))return;
                  candidate={...candidate,state:'error',stopReason:closedStopReason(snapshot.stopReason) || (snapshot.status==='timeout'?'timeout':undefined),
                    detail:typeof snapshot.error==='string'?snapshot.error:candidate.detail};
                } else {
                  if(snapshot?.pendingError || snapshot?.yielded || ['queue','gateway_draining'].includes(snapshot?.timeoutPhase)){terminalHint=undefined;return;}
                  // A wait-only timeout adds NO terminal cause. The actual
                  // abort/error envelope can still be reported as unknown.
                  candidate={...candidate,state:'error',stopReason:undefined};
                }
              } catch { /* No cause proof: preserve the generic, unclassified diagnostic. */ }
            }
            // A rejected lookup crosses the same await boundary. It cannot
            // revive a stale generic hint either; new wire final/closed metadata
            // and explicit-stop receipts still outrank that provisional cut.
            collectEvents();
            if(observationClosed)return;
            if(chatFinalText.trim()){finish(chatFinalText);return;}
            if(!terminalHint?.stopReason && idleGeneration!==abortGeneration){terminalHint=undefined;return;}
            if(terminalHint?.stopReason && reasonPriority(terminalHint.stopReason)>reasonPriority(candidate.stopReason))candidate=terminalHint;
            if(this.isExplicitlyStoppedRun(sessionKey,runId)){finish('NO_REPLY');return;}
            reject(new RunTerminalError(candidate));
          })().catch(error=>{if(!observationClosed)reject(error);});
        },350);
      };
      const collectEvents = () => {
        if (observationClosed) return;
        // Gateway connection dropped mid-run (e.g. gateway restart): the run will
        // never deliver a reply on this connection, so stop waiting instead of
        // hanging until the idle timeout. Failing fast lets the bridge
        // release its busy lock so new messages are not stuck "waiting".
        // A disconnect is an observation gap, not an execution failure. The
        // connection resubscribes and the paced exact-run query reconciles it.
        // /stop force-abort: finish immediately instead of waiting for the
        // cancelled lifecycle to be treated as a transient state (idle timeout).
        if (sessionKey && (this.forceAbortedSessions.has(sessionKey) || this.forceAbortedSessions.has(shortSessionKey))) {
          this.forceAbortedSessions.delete(sessionKey);
          this.forceAbortedSessions.delete(shortSessionKey);
          finish("NO_REPLY");
          return;
        }
        const bucketsToScan = sessionKey
          ? Array.from(new Set([sessionKey,shortSessionKey,...[...this.agentEvents.keys()].filter(k=>this.shortKey(k)===shortSessionKey && this.agentEvents.get(k)?.some(ev=>activeRunIds.has(ev.runId)))].filter(Boolean)))
          : Array.from(this.agentEvents.keys());

        for (const bucketKey of bucketsToScan) {
          const bucket = this.agentEvents.get(bucketKey);
          if (!bucket) continue;

          let i = 0;
          while (i < bucket.length) {
            const ev = bucket[i++];
            if(seenEvents.has(ev))continue;
            const evRunId = typeof ev.runId === "string" ? ev.runId : "";
            const eventSessionMatches = Boolean(sessionKey && this.shortKey(ev.sessionKey || bucketKey)===this.shortKey(sessionKey));
            const matchesRun = evRunId ? activeRunIds.has(evRunId) : false;
            // Non-destructive per-observer cursor: ACK and a replacement final
            // may be delivered synchronously before the awaiting sender resumes.
            // Leave every foreign/unidentified frame available to its own owner.
            if(!matchesRun || sessionKey && !eventSessionMatches || options?.expectedSessionId && ev.sessionId && ev.sessionId!==options.expectedSessionId)continue;
            seenEvents.add(ev);
            if (!sessionKey && ev.sessionKey) {
              shortSessionKey = String(ev.sessionKey).replace(/^agent:[^:]+:/, "");
              sessionKey = this.canonicalSessionKey(ev.sessionKey);
            }
            if(ev.stream==='sessionUser')continue;
            if (hasEffectiveActivity(ev)) resetIdleTimer();
            rememberActivity(ev);
            // Terminating channel-send detection (2026-10-16 frozen-card
            // incident, remediated per independent review): a message-tool
            // result carrying a top-level terminate=true is a batch-control
            // hint — NOT a delivery receipt and NOT settlement authority for
            // this collector. It only nudges the exact-run reconciliation:
            // checkRunState requires a recorded terminal time, all tools
            // settled, no error and no async pending before resolving; a run
            // that is still executing keeps waiting normally. No tool input is
            // ever re-delivered to the source chat by this path.
            {
              const tdata = ev.data || {};
              if (ev.stream === "tool" || (ev.stream === "item" && tdata.kind === "tool")) {
                const toolName = String(tdata.name || tdata.toolName || "");
                const tphase = tdata.phase === "result" ? (tdata.isError || tdata.error ? "error" : "end") : tdata.phase;
                if (toolName === "message" && (tphase === "end" || tphase === "error")) {
                  const rawOut = tdata.output ?? tdata.result ?? tdata.error ?? null;
                  let terminating = false;
                  try {
                    if (rawOut && typeof rawOut === "object") terminating = (rawOut as any).terminate === true;
                    else if (typeof rawOut === "string") {
                      const trimmed = rawOut.trim();
                      if (trimmed.startsWith("{")) {
                        const parsed = JSON.parse(trimmed);
                        terminating = parsed && typeof parsed === "object" && parsed.terminate === true;
                      } else terminating = /^terminate\s*=\s*true$/i.test(trimmed);
                    }
                  } catch { /* unparseable output is not evidence */ }
                  if (terminating && !terminatingReconcileTimer) {
                    terminatingReconcileTimer = setTimeout(() => {
                      terminatingReconcileTimer = null;
                      if (observationClosed) return;
                      void checkRunState(() => true, true);
                    }, 10_000);
                    terminatingReconcileTimer.unref?.();
                  }
                }
              }
            }
            // If more events arrive after a replay-invalid lifecycle end, that lifecycle
            // was not terminal for the user-visible run. Keep waiting for the real final.
            if (replayInvalidTimer) {
              clearTimeout(replayInvalidTimer);
              replayInvalidTimer = null;
            }
            if (ev.stream !== "lifecycle") {
              pendingRuntimeFailureText = "";
            }

            // A matched resumed turn can again complete via the existing
            // assistant/transcript + lifecycle path, even without chat final.
            if (ev.stream === "lifecycle" && ev.data?.phase === "start") turnYielded = false;
            if (ev.stream === "lifecycle" && ev.data?.phase === "start" && !lifecycleStartedLogged) {
              lifecycleStartedLogged = true;
              console.log(`[OpenClaw] lifecycle start for runId=${runId} after ${Date.now() - collectStartedAt}ms`);
            }
            if (ev.stream === "chatFinal") {
              // Only the exact admitted root's public chat envelope can yield
              // scheduling custody. Session fallback/foreign/tool flags cannot.
              if(ev.data?.gatewayYielded===true && (evRunId!==runId || !eventSessionMatches)) continue;
              if (ev.data?.gatewayYielded === true) {
                // A yielded turn is not a terminal answer, even if its buffered
                // message contains a preface. Keep the final key unclaimed;
                // opt-in durable handoff can retire only foreground observation.
                if (chatFinalText.trim()) continue; // an actual final wins
                turnYielded = true;
                if (chatFinalTimer) { clearTimeout(chatFinalTimer); chatFinalTimer = null; }
                if (lifecycleEndTimer) { clearTimeout(lifecycleEndTimer); lifecycleEndTimer = null; }
                // Finish scanning this batch first so an already-arrived real
                // final/error wins over a stale waiting notice. No status RPC
                // (or ten-minute silence) is needed to confirm this wire fact.
                void Promise.resolve().then(() => {
                  if(observationClosed || chatFinalText.trim())return;
                  void handleTimeoutResult(new SessionWaitPaused(normalizeSessionRuntimeStatus(undefined),false,"yield"));
                  if(options?.onYieldHandoff) {
                    try {
                      // Commit recoverable exact observation BEFORE opening
                      // proactive delivery and fencing this destructive consumer.
                      this.recoveryStore?.saveRunObservation(sessionKey,runId,{yielded:true});
                      options.onYieldHandoff(runId);
                      fenceSuperseded();
                    } catch(error) { console.warn('[OpenClaw] yield handoff retained by collector:',safeErrorSummary(error)); }
                  }
                });
                continue;
              }
              chatFinalText = ev.data?.text || "";
              if (chatFinalText.trim()) turnYielded = false;
              else if (turnYielded) continue;
              // A nonempty exact root chat terminal is authoritative. Empty
              // envelopes/timers never promote streaming/transcript drafts.
              if (!chatFinalTimer) {
                chatFinalTimer = setTimeout(() => {
                  chatFinalTimer = null;
                  if(chatFinalText.trim())finish(chatFinalText);
                  else void checkRunState(()=>true,true);
                }, 5000);
              }
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "end") {
              if(chatFinalText.trim()){finish(chatFinalText);return;}
              // Lifecycle can precede chat final and can describe a yielded or
              // abandoned turn. It is only a read-only reconciliation hint.
              void checkRunState(()=>true,true);
              continue;
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "error") {
              const errText = String(ev.data?.error || "unknown");
              if(closedStopReason(ev.data?.stopReason) && ev.data.stopReason!=='error' || /^(?:agent run )?aborted$/i.test(errText.trim()) || terminalHint) {deferTerminal(ev,errText);continue;}
              // Some agent errors are recoverable: OpenClaw emits a lifecycle
              // error (e.g. "Context overflow: prompt too large") and then
              // auto-compacts and KEEPS RUNNING the same run, eventually emitting
              // a real final. If we reject immediately the user sees a scary
              // "没有完成回复" while the agent is in fact still working. So for
              // recoverable errors we defer: record the failure text and keep
              // waiting. Subsequent delta/item events reset the idle timer, so a
              // real final wins; if the run truly stalls, the idle timeout falls
              // back to this text.
              if (this.isRecoverableAgentError(errText)) {
                pendingRuntimeFailureText = `⚠️ Agent 未正常完成\n原因: ${safeErrorSummary(errText)}`;
                console.warn(`[OpenClaw] recoverable lifecycle error for runId=${evRunId || runId}; deferring (agent may auto-recover): ${safeErrorSummary(errText)}`);
                return;
              }
              if (isWaitTimeout(errText)) {
                // B5 (2026-10-16 audit): already dequeued by the unified splice
                // above; a second splice here deleted the NEXT buffered frame
                // (a real chatFinal following a timeout error was swallowed).
                if (!decidingTimeout) {
                  decidingTimeout = true;
                  const decisionGeneration=idleGeneration;
                  void this.classifyWaitTimeout(errText, targetSessionKey || sessionKey).then(error=>handleTimeoutResult(error,()=>idleGeneration===decisionGeneration));
                }
                continue;
              }
              clearTimeout(idleTimer);
              clearInterval(poller);
              if (chatFinalTimer) clearTimeout(chatFinalTimer);
              if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
              reject(new Error(`Agent error: ${errText}`));
              return;
            }
            if (ev.stream === "chatError") {
              // Chat-level error (most commonly a request timeout). Treat it like
              // a lifecycle error: recoverable ones defer (agent may auto-recover
              // and still produce a real final); otherwise reject so the bridge
              // surfaces the failure / lets auto-retry kick in — instead of
              // surfacing whatever mid-run delta text happened to be collected.
              const errText = String(ev.data?.error || "chat error");
              if(ev.data?.state==='aborted' || closedStopReason(ev.data?.stopReason) && ev.data.stopReason!=='error' || /^(?:agent run )?aborted$/i.test(errText.trim()) || terminalHint) {deferTerminal(ev,errText);continue;}
              if (this.isGenericChatError(errText)) {
                // Gateway can emit a terminal chat error without errorMessage,
                // then persist a richer terminal snapshot a moment later. Do
                // not expose the placeholder "chat error" to users. Reconcile
                // through agent.wait, whose snapshot includes timeout phase,
                // stop reason, and the real upstream error when available.
                if (!genericChatErrorTimer) {
                  genericChatErrorTimer = setTimeout(() => {
                    genericChatErrorTimer = null;
                    if(terminalHint){deferTerminal({data:terminalHint},terminalHint.detail || 'aborted');return;}
                    const decisionGeneration=idleGeneration;
                    void this.resolveTerminalChatError(evRunId || runId, targetSessionKey || sessionKey, options?.expectedSessionId).then((detail) => {
                      collectEvents();
                      if (observationClosed || idleGeneration!==decisionGeneration) return;
                      if (chatFinalText.trim()) { finish(chatFinalText); return; }
                      if(terminalHint){deferTerminal({data:terminalHint},terminalHint.detail || 'aborted');return;}
                      clearTimeout(idleTimer);
                      clearInterval(poller);
                      if (chatFinalTimer) clearTimeout(chatFinalTimer);
                      if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
                      reject(detail);
                    }, error => {
                      if(terminalHint){deferTerminal({data:terminalHint},terminalHint.detail || 'aborted');return;}
                      void handleTimeoutResult(error,()=>idleGeneration===decisionGeneration);
                    });
                  }, 350);
                }
                continue;
              }
              if (this.isRecoverableAgentError(errText)) {
                pendingRuntimeFailureText = `⚠️ Agent 未正常完成\n原因: ${safeErrorSummary(errText)}`;
                console.warn(`[OpenClaw] recoverable chat error for runId=${evRunId || runId}; deferring: ${safeErrorSummary(errText)}`);
                // B5: already dequeued above — no second splice.
                continue;
              }
              if (isWaitTimeout(errText)) {
                // B5 (2026-10-16 audit): already dequeued by the unified splice
                // above; a second splice here deleted the NEXT buffered frame
                // (a real chatFinal following a timeout error was swallowed).
                if (!decidingTimeout) {
                  decidingTimeout = true;
                  const decisionGeneration=idleGeneration;
                  void this.classifyWaitTimeout(errText, targetSessionKey || sessionKey).then(error=>handleTimeoutResult(error,()=>idleGeneration===decisionGeneration));
                }
                continue;
              }
              clearTimeout(idleTimer);
              clearInterval(poller);
              if (chatFinalTimer) clearTimeout(chatFinalTimer);
              if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
              if (genericChatErrorTimer) clearTimeout(genericChatErrorTimer);
        if (terminatingReconcileTimer) clearTimeout(terminatingReconcileTimer);
              reject(new Error(`Agent error: ${errText}`));
              return;
            }
          }
        }
      };
      let poller: ReturnType<typeof setTimeout>;
      const poll = () => {
        collectEvents();
        if(!observationClosed) {
          const quiet=Date.now()-(lastActivityAt || collectStartedAt);
          poller=setTimeout(poll,!startedConnected || quiet<1000 ? 50 : quiet<10_000 ? 1000 : 30_000);
          poller.unref?.();
        }
      };
      poller=setTimeout(poll,50);
      const wakeCollector=()=>{if(!observationClosed) collectEvents();};
      this.eventCollectors.add(wakeCollector);
      const observationKey = targetSessionKey ? this.canonicalSessionKey(targetSessionKey) : "";
      const checkAfterNoActiveRun = async () => {
        const decisionGeneration=idleGeneration;
        await checkRunState();
        if (observationClosed || !observationKey || decisionGeneration!==idleGeneration) return;
        try {
          // Used only after the plugin reports no active run. Missing terminal
          // history is not failure, but an explicit idle session must not keep
          // a phantom queue owner blocking this newly-arrived user message.
          const dispatch = await this.getSessionDispatchStatus(observationKey);
          collectEvents();
          if (!observationClosed && decisionGeneration===idleGeneration && dispatch.idleConfirmed && !dispatch.archived && (!options?.expectedSessionId || dispatch.sessionId===options.expectedSessionId)) {
            reject(new InactiveRunObservation());
          }
        } catch { /* Unknown activity cannot authorize releasing an active owner. */ }
      };
      if (observationKey) this.runStateChecks.set(observationKey, checkAfterNoActiveRun);
      cleanupObservation = () => {
        observationClosed = true;
        releaseEventReader();
        clearIdleGuard();
        clearTimeout(idleTimer);
        this.eventCollectors.delete(wakeCollector);
        clearInterval(poller);
        if (chatFinalTimer) clearTimeout(chatFinalTimer);
        if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
        if (replayInvalidTimer) clearTimeout(replayInvalidTimer);
        if (genericChatErrorTimer) clearTimeout(genericChatErrorTimer);
        if (terminatingReconcileTimer) clearTimeout(terminatingReconcileTimer);
        if (observationKey && this.runStateChecks.get(observationKey) === checkAfterNoActiveRun) this.runStateChecks.delete(observationKey);
      };
      // Fence registration: a newer batch on this session must be able to end
      // THIS observation synchronously (local cleanup + superseded settlement)
      // so the shared bucket is no longer destructively consumed by a stale
      // poller. The Gateway run is never aborted by fencing.
      const fenceSuperseded = () => {
        if (observationClosed) return;
        // Atomic custody transfer BEFORE closing the old consumer; a final
        // arriving in this tick is immediately eligible for exact proactive.
        this.releasePausedWait(runId);
        cleanupObservation();
        reject(new SupersededObservation());
      };
      if (observationKey) {
        let fences = this.sessionCollectorFences.get(observationKey);
        if (!fences) { fences = new Set(); this.sessionCollectorFences.set(observationKey, fences); }
        fences.add(fenceSuperseded);
        const unregisterFence = () => {
          const current = this.sessionCollectorFences.get(observationKey);
          if (current) {
            current.delete(fenceSuperseded);
            if (current.size === 0) this.sessionCollectorFences.delete(observationKey);
          }
        };
        const baseCleanup = cleanupObservation;
        cleanupObservation = () => { baseCleanup(); unregisterFence(); };
      }
    }).finally(() => cleanupObservation());
  }

  /**
   * Recoverable agent errors are lifecycle errors that OpenClaw can self-heal
   * (it auto-compacts and keeps running the same run, then emits a real final).
   * For these we must not reject collectReply immediately, or the bridge reports
   * "没有完成回复" while the agent is still working. Currently this covers
   * context-overflow / prompt-too-large, which OpenClaw recovers from via its
   * context-overflow-recovery + auto-compaction path.
   */
  private isGenericChatError(errText: string): boolean {
    const t = (errText || "").trim().toLowerCase();
    return t === "chat error" || t === "agent error: chat error";
  }

  private async resolveTerminalChatError(runId: string, sessionKey?: string, expectedSessionId?:string): Promise<RunTerminalError> {
    try {
      const snapshot = await this.rpc("agent.wait", { runId, timeoutMs: 1500 }, 2500);
      if(snapshot?.runId!==runId || expectedSessionId && snapshot?.sessionId && snapshot.sessionId!==expectedSessionId || !Number.isFinite(snapshot.endedAt) || snapshot.endedAt<=0 || snapshot.yielded || snapshot.pendingError
        || ['queue','gateway_draining'].includes(snapshot.timeoutPhase) || snapshot.startedAt!==undefined &&
          (typeof snapshot.startedAt!=='number' || !Number.isFinite(snapshot.startedAt) || snapshot.startedAt<0 || snapshot.endedAt<snapshot.startedAt)
        || !['error','timeout'].includes(snapshot.status)) {
        throw new SessionWaitPaused(await this.getSessionRuntimeStatus(sessionKey || ''),true);
      }
      return new RunTerminalError({sessionKey:this.canonicalSessionKey(sessionKey || ''),sessionId:expectedSessionId || snapshot.sessionId,runId,source:'chat',state:'error',
        stopReason:closedStopReason(snapshot.stopReason) || (snapshot.status==='timeout'?'timeout':undefined),detail:typeof snapshot.error==='string'?snapshot.error:undefined});
    } catch (err) {
      if (err instanceof SessionWaitPaused) throw err;
      // Failed read-only reconciliation is not the execution's failure.
      throw new SessionWaitPaused(normalizeSessionRuntimeStatus(undefined),true);
    }
  }

  private isRecoverableAgentError(errText: string): boolean {
    const t = (errText || "").toLowerCase();
    return t.includes("context overflow")
      || t.includes("prompt too large")
      || t.includes("context length")
      || t.includes("too many tokens")
      || t.includes("maximum context");
  }

  // --- Session management ---

  async createSession(params: { key: string; model: string; label?: string }): Promise<any> {
    return this.rpc("sessions.create", { ...params, key: this.canonicalSessionKey(params.key) });
  }

  async patchSession(params: { key: string; model?: string; label?: string; expectedSessionId?:string }): Promise<any> {
    return this.rpc("sessions.patch", { ...params, key: this.canonicalSessionKey(params.key) }, 10000);
  }

  /** True when an RPC error is the Gateway's "session is archived" refusal. */
  isArchivedSessionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return /is archived[.,]|Restore it before starting new work/i.test(msg);
  }

  /**
   * Restore an archived session (e.g. auto-archived by the Gateway's
   * active-session-cap) so new work can start. sessions.patch requires
   * expectedSessionId, so describe first, then patch archived=false.
   */
  async unarchiveSession(key: string): Promise<boolean> {
    const canonical = this.canonicalSessionKey(key);
    try {
      const info = await this.rpc("sessions.describe", { key: canonical }, 15000);
      const sessionId = info?.session?.sessionId;
      if (!sessionId) return false;
      if (info?.session?.archived !== true) return true; // already active
      const res = await this.rpc(
        "sessions.patch",
        { key: canonical, expectedSessionId: sessionId, archived: false },
        15000,
      );
      console.log(`[OpenClaw] unarchived session ${key}: ${res?.ok === true ? "ok" : "unexpected response"}`);
      return res?.ok === true;
    } catch (err) {
      console.warn(`[OpenClaw] unarchive failed for ${key}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  async getSessionStatus(key: string,timeoutMs=120000): Promise<any> {
    return this.rpc("sessions.describe", { key: this.canonicalSessionKey(key) },timeoutMs);
  }


  async injectAssistantMessage(params: { sessionKey: string; message: string; label?: string }): Promise<any> {
    return this.rpc("chat.inject", { ...params, sessionKey: this.canonicalSessionKey(params.sessionKey) }, 10000);
  }

  /** Real-time session input uses the coordinated plugin's durable callback
   * receipt protocol. SDK eligibility/text mirrors never prove acceptance;
   * missing/legacy plugin observations stay pending without blind mutation. */
  async exactRunSettled(runId:string): Promise<boolean> {
    try {const r=await this.rpc('agent.wait',{runId,timeoutMs:1},2500);
      return r?.runId===runId && !r.pendingError && !r.yielded && ['ok','error','timeout'].includes(r.status) && Number.isFinite(r.endedAt) && r.endedAt>0 && (r.status!=='ok' || ['visible','silent','empty'].includes(r.terminalReply?.disposition));
    } catch {return false;}
  }

  async cancelSteerSession(sessionKey:string,stopEpoch:number):Promise<void> {
    await this.rpc('lma.steer.stop',{sessionKey:this.canonicalSessionKey(sessionKey),stopEpoch},2500);
  }

  private readinessCause(error:unknown):string {
    let detail=error instanceof Error ? error.message : '';
    let code='';
    if(detail.startsWith('RPC error:')) {
      try {const value=JSON.parse(detail.slice('RPC error:'.length));
        if(typeof value.code==='string' && /^[A-Z_]{1,48}$/.test(value.code))code=value.code;
        detail=typeof value.message==='string' ? value.message : '';
      } catch {detail='';}
    }
    return [code,rawErrorExcerpt(new Error(detail)) || safeErrorSummary(error)].filter(Boolean).join(': ');
  }

  async steer(sessionKey: string,text: string,displayText?: string,identity?: {
    insertionId:string;expectedRunId:string;expectedSessionId?:string;stopEpoch?:number;cancel?:boolean;queryOnly?:boolean;originalRunEnded?:boolean;
  }): Promise<{
    status:'pending'|'accepted'|'rejected'|'unknown'|'target_changed'|'target_ended'|'stopped'|'capability_blocked'|'unavailable'|'no_active_run';
    attempted?:boolean;ordinaryEligible?:boolean;sessionId?:string;reason?:string;insertionId?:string;expectedRunId?:string;
  }> {
    if(!identity?.insertionId || !identity.expectedRunId) return {status:'pending',attempted:false,reason:'exact target not admitted yet'};
    let attempted=false;
    let stage='capabilities';
    const base={insertionId:identity.insertionId,expectedRunId:identity.expectedRunId,sessionId:identity.expectedSessionId};
    try {
      const capability=await this.rpc('lma.steer.capabilities',{},2500);
      // This is an LMA protocol-version check, NOT a fictitious source-CAS
      // requirement. Builtin callbacks can be used with atomicRunBound=false.
      if(capability?.protocol!==2 || capability?.durableAttempts!==true || capability?.acceptanceCallback!==true)
        return {...base,status:'unavailable',attempted:identity.queryOnly===true,reason:'Update the coordinated LMA plugin; legacy booleans are not acceptance receipts'};
      stage='sessions.describe';
      const info=await this.getSessionStatus(sessionKey,1500);
      const currentId=info?.session?.sessionId;
      if(info?.session?.archived===true || (identity.expectedSessionId && currentId && currentId!==identity.expectedSessionId))
        return {...base,status:'target_changed',attempted:identity.queryOnly===true,reason:'session archived or generation changed; no automatic migration'};
      if(!currentId) return {...base,status:'pending',attempted:identity.queryOnly===true,reason:'session generation observation unavailable'};
      base.sessionId=currentId;
      attempted=true;stage='lma.steer';
      const result=await this.rpc('lma.steer',{sessionKey:this.canonicalSessionKey(sessionKey),text,...identity,
        expectedSessionId:identity.expectedSessionId || currentId,stopEpoch:identity.stopEpoch ?? 0},2500);
      if(result?.insertionId!==identity.insertionId || result?.expectedRunId!==identity.expectedRunId || result?.sessionId!==currentId ||
        !['pending','accepted','rejected','unknown','target_changed','target_ended','stopped'].includes(result.status))
        return {...base,status:'unknown',attempted:true,reason:'Invalid or legacy plugin receipt; not replayed'};
      if(result.status==='pending' && result.attempted===false && result.reason==='target_not_ready') await this.runStateChecks.get(this.canonicalSessionKey(sessionKey))?.();
      return result;
    } catch(error) {
      return {...base,status:attempted?'unknown':'pending',attempted:attempted || identity.queryOnly===true,
        reason:`${attempted?'Insertion receipt unknown; query stable identity only':'Readiness observation unavailable; retained for paced recovery'} [${stage}: ${this.readinessCause(error)}]`};
    }
  }

  /** Callbacks fired when a steered message is confirmed consumed by the model
   *  (matching sessionUser event). Keyed by bare/short session key. Multiple may
   *  be registered when several messages are steered during one run; each is
   *  invoked with the consumed text and decides whether it is the one it wants.
   *  Callbacks are one-shot: returning true removes them. */
  private steerConsumedCallbacks: Map<string, Array<{
    matchText: string;
    cb: (text: string) => boolean | void;
  }>> = new Map();

  /** Register a callback (per bare session key) invoked when a steered message
   *  is actually consumed by the active run. This legacy text observer is
   *  presentation-only; it cannot authorize a receipt reaction.
   *  Return true from the callback to consume/remove it (one-shot). */
  onSteerConsumed(sessionKey: string, matchText: string, cb: (text: string) => boolean | void): () => void {
    const key = this.shortKey(sessionKey);
    const normalizedMatch = matchText.replace(/\s+/g, " ").trim();
    let list = this.steerConsumedCallbacks.get(key);
    if (!list) { list = []; this.steerConsumedCallbacks.set(key, list); }
    const entry = { matchText: normalizedMatch, cb };
    list.push(entry);
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      clearTimeout(expiry);
      const current = this.steerConsumedCallbacks.get(key);
      if (!current) return;
      const next = current.filter((candidate) => candidate !== entry);
      if (next.length > 0) this.steerConsumedCallbacks.set(key, next);
      else this.steerConsumedCallbacks.delete(key);
    };
    const expiry = setTimeout(remove, 30 * 60_000);
    expiry.unref?.();
    return remove;
  }

  private shortKey(sessionKey: string): string {
    return sessionKey.replace(/^agent:[^:]+:/, "");
  }

  private canonicalSessionKey(sessionKey: string): string {
    return /^agent:[^:]+:/.test(sessionKey) ? sessionKey : `agent:main:${sessionKey}`;
  }

  private registerPendingSteer(sessionKey: string, text: string, displayText?: string): () => void {
    const key = this.shortKey(sessionKey);
    const submittedText = text.replace(/\s+/g, " ").trim();
    if (!submittedText) return () => {};
    const displayTextValue = (displayText || text).trim();
    const queue = this.pendingSteerTexts.get(key) || [];
    const entry = { submittedText, displayText: displayTextValue };
    queue.push(entry);
    this.pendingSteerTexts.set(key, queue);
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      clearTimeout(expiry);
      const current = this.pendingSteerTexts.get(key);
      if (!current) return;
      const next = current.filter((candidate) => candidate !== entry);
      if (next.length > 0) this.pendingSteerTexts.set(key, next);
      else this.pendingSteerTexts.delete(key);
    };
    // Expire only this provisional correlation. A much later transcript must
    // not consume a stale duplicate while another identical steer is pending.
    const expiry = setTimeout(remove, 30 * 60_000);
    expiry.unref?.();
    return remove;
  }

  /**
   * Called when a sessionUser event is seen for a session. If its text matches a
   * pending steered message, fire the live-status `steer` line (correct time
   * order, showing the ORIGINAL text) and the steer-consumed callback, then
   * clear that pending entry. Returns true if it matched a steered message.
   */
  private handleSteerConsumption(sessionKey: string, text: string,runId?:string): boolean {
    const key = this.shortKey(sessionKey);
    const queue = this.pendingSteerTexts.get(key);
    if (!queue || queue.length === 0) return false;
    const norm = (text || "").replace(/\s+/g, " ").trim();
    if (!norm) return false;
    // One transcript event consumes exactly one pending steer. Prefer an exact
    // match, otherwise the longest submitted wrapper contained in the event.
    let matchedIndex = queue.findIndex((pending) => norm === pending.submittedText);
    if (matchedIndex < 0) {
      let matchedLength = -1;
      for (let i = 0; i < queue.length; i++) {
        const pending = queue[i];
        if (norm.includes(pending.submittedText) && pending.submittedText.length > matchedLength) {
          matchedIndex = i;
          matchedLength = pending.submittedText.length;
        }
      }
    }
    if (matchedIndex < 0) return false;
    const [matched] = queue.splice(matchedIndex, 1);
    if (queue.length === 0) this.pendingSteerTexts.delete(key);
    const progressCb = this.progressForRun(sessionKey,runId);
    if (progressCb) void progressCb({ kind: "steer", text: matched.displayText });
    const list = this.steerConsumedCallbacks.get(key);
    if (list && list.length > 0) {
      // Match and remove exactly one observer for this consumed steer. This is
      // important for duplicate text: one session.message must acknowledge one
      // Feishu message, never all identical messages at once.
      let callbackIndex = list.findIndex((entry) => entry.matchText === matched.submittedText);
      if (callbackIndex < 0) callbackIndex = list.findIndex((entry) => norm.includes(entry.matchText));
      if (callbackIndex >= 0) {
        const [entry] = list.splice(callbackIndex, 1);
        try { entry.cb(matched.submittedText); } catch { /* observer failures are isolated */ }
      }
      if (list.length === 0) this.steerConsumedCallbacks.delete(key);
    }
    return true;
  }

  /**
   * Get session info (model, tokens, etc.) for status display.
   */
  /** Stop claiming an exact run's final output after observation has paused. */
  releasePausedWait(runId: string): void {
    if (!runId) return;
    const timer = this.ownedDeliveryRunTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.ownedDeliveryRunTimers.delete(runId);
    this.ownedDeliveryRuns.delete(runId);
  }

  /** Synchronously fence every live collectReply observation for a session.
   *  Local only — never aborts a Gateway run. Returns the number superseded.
   *  Used when queue custody is revoked or a new chat.send takes over, so a
   *  stale poller cannot steal the replacement batch's frames (2026-10-16). */
  revokeSessionCollectors(sessionKey: string, reason: string): number {
    const key = this.canonicalSessionKey(sessionKey);
    this.observationEpoch.set(key,(this.observationEpoch.get(key)||0)+1);
    const fences = this.sessionCollectorFences.get(key);
    if (!fences || fences.size === 0) return 0;
    const count = fences.size;
    for (const fence of [...fences]) {
      try { fence(); } catch { /* each fence is isolated */ }
    }
    console.warn(`[OpenClaw] superseded ${count} stale collector(s) for ${key.slice(-24)}: ${reason}`);
    return count;
  }

  async waitForSessionStop(sessionKey:string):Promise<void> {
    await this.pendingExplicitStops.get(this.canonicalSessionKey(sessionKey));
  }

  async getSessionRuntimeStatus(sessionKey: string): Promise<SessionRuntimeStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        this.rpc("sessions.describe", { key: this.canonicalSessionKey(sessionKey) }, 5000),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("status lookup timeout")), 5000); }),
      ]);
      return normalizeSessionRuntimeStatus(value);
    } catch { return normalizeSessionRuntimeStatus(undefined); }
    finally { if (timer) clearTimeout(timer); }
  }

  /** Execution-idle proof remains a complete pending scan. Independently,
   * receiving a serialized followup does not require idle or empty pending
   * work. A positive admission proof never turns an incomplete scan idle. */
  async getSessionDispatchStatus(sessionKey:string):Promise<SessionDispatchStatus> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const key=this.canonicalSessionKey(sessionKey),deadline=Date.now()+8000;
    let admissionProof:Pick<SessionDispatchStatus,'followupAdmissionEligible'|'expectedLeafEntryId'>={};
    const admissionFrom=(history:any):typeof admissionProof=>{
      const info=history?.sessionInfo,run=history?.inFlightRun;
      const knownTarget=run===undefined || run===null || typeof run?.runId==='string' && !!run.runId.trim();
      return info?.archived===false && knownTarget && typeof info?.activeLeafEntryId==='string' && !!info.activeLeafEntryId.trim()
        ? {followupAdmissionEligible:true,expectedLeafEntryId:info.activeLeafEntryId} : {};
    };
    // One budget covers the entire public pending scan, not 1500ms per page.
    // Retained interrupted/cancelled inputs are recovery records, NOT runnable
    // queue entries. Never delete, mutate or replay them to prove schedulability.
    const scan=async()=>{
      let sessionId:string|undefined,total:number|undefined,before:number|undefined;
      const seen=new Set<string>(),cursors=new Set<number>();
      let headSignature='';
      const unknown=()=>({idleConfirmed:false,sessionId});
      const validId=(value:any)=>value===undefined || typeof value==='string' && !!value.trim();
      for(let page=0;page<32;page++) {
        admissionProof={};
        const history:any=await this.rpc('chat.history',{sessionKey:key,limit:20,...(before?{pendingBefore:before}:{})},1500);
        if(Date.now()>=deadline)return unknown();
        const info=history?.sessionInfo;
        const id=info?.sessionId || history?.sessionId;
        if(typeof history?.sessionKey==='string' && !!history.sessionKey && history.sessionKey!==key ||
          typeof info?.sessionId==='string' && !!info.sessionId && typeof history?.sessionId==='string' && !!history.sessionId && info.sessionId!==history.sessionId ||
          sessionId && typeof id==='string' && !!id && sessionId!==id)return {...unknown(),identityConflict:true};
        if(!validId(info?.sessionId) || !validId(history?.sessionId) || history?.sessionKey!==key || typeof id!=='string' || !id.trim() ||
          info?.sessionId && history?.sessionId && info.sessionId!==history.sessionId || sessionId && sessionId!==id)return unknown();
        sessionId=id;
        const base={sessionId,archived:info?.archived===true};
        if(base.archived)return {...base,idleConfirmed:false};
        admissionProof=admissionFrom(history);
        const pending=history?.pendingInputs;
        // Existing queued/interrupted/hidden inputs are not a receiving veto.
        // Core owns FIFO/cap/drop. Below, idle still requires complete evidence.
        if(info?.hasActiveRun===true || history?.inFlightRun)return {...base,idleConfirmed:false,busyConfirmed:true,
          activeRunId:typeof history?.inFlightRun?.runId==='string'?history.inFlightRun.runId:undefined};
        if(!Number.isSafeInteger(pending?.total) || pending.total<0 || total!==undefined && total!==pending.total)return unknown();
        total=pending.total;
        if(pending.queuedCount!==undefined && (!Number.isSafeInteger(pending.queuedCount) || pending.queuedCount<0))return unknown();
        if(pending.queuedCount>0)return {...base,idleConfirmed:false,busyConfirmed:true};
        // Legacy empty pending responses omit items. Only total=0 can safely
        // support that shape; a hidden/nonempty retained set is never guessed.
        const items=pending.items===undefined && total===0?[]:pending.items;
        if(!Array.isArray(items))return unknown();
        for(const item of items) {
          if(typeof item?.id!=='string' || !item.id || !['queued','cancelled','interrupted'].includes(item.state) || seen.has(item.id))return unknown();
          seen.add(item.id);
          if(item.state==='queued')return {...base,idleConfirmed:false,busyConfirmed:true};
        }
        if(seen.size>total!)return unknown();
        // Every page must positively confirm inactivity. Otherwise a malformed
        // head/middle page could be laundered by a valid final page.
        if(info?.hasActiveRun!==false)return unknown();
        const next=pending.nextBefore;
        if(next!==undefined && (!Number.isSafeInteger(next) || next<=0 || cursors.has(next) || before!==undefined && next>=before))return unknown();
        const signature=JSON.stringify([id,total,info?.hasActiveRun,items.map((item:any)=>[item.id,item.state]),next]);
        if(page===0)headSignature=signature;
        if(next!==undefined) {cursors.add(next);before=next;continue;}
        if(info?.hasActiveRun!==false || seen.size!==total)return unknown();
        if(page>0) {
          // Pagination is not an atomic snapshot. Re-read the current head and
          // identity/activity before returning positive evidence to local CAS.
          admissionProof={};
          const head:any=await this.rpc('chat.history',{sessionKey:key,limit:20},1500);
          if(Date.now()>=deadline)return unknown();
          const hi=head?.sessionInfo,hp=head?.pendingInputs,hid=hi?.sessionId || head?.sessionId;
          if(!validId(hi?.sessionId) || !validId(head?.sessionId) || head?.sessionKey!==key || hid!==id || hi?.sessionId && head?.sessionId && hi.sessionId!==head.sessionId)return unknown();
          if(hi?.archived===true)return {...base,archived:true,idleConfirmed:false};
          admissionProof=admissionFrom(head);
          if(hi?.hasActiveRun===true || head?.inFlightRun || Number.isSafeInteger(hp?.queuedCount) && hp.queuedCount>0)
            return {...base,idleConfirmed:false,busyConfirmed:true,activeRunId:typeof head?.inFlightRun?.runId==='string'?head.inFlightRun.runId:undefined};
          if(hi?.hasActiveRun!==false)return unknown();
          if(hp?.total!==total || hp?.queuedCount!==undefined && (!Number.isSafeInteger(hp.queuedCount) || hp.queuedCount<0))return unknown();
          if(Array.isArray(hp?.items) && hp.items.some((item:any)=>typeof item?.id==='string' && item.id && item.state==='queued'))return {...base,idleConfirmed:false,busyConfirmed:true};
          if(!Array.isArray(hp?.items) || JSON.stringify([hid,hp.total,hi?.hasActiveRun,hp.items.map((item:any)=>[item?.id,item?.state]),hp.nextBefore])!==headSignature)return unknown();
        }
        return {...base,idleConfirmed:true,busyConfirmed:false};
      }
      return unknown();
    };
    try {
      // The outer race must honor the SAME total budget as the scan itself
      // (audit P1 2026-10-17: an 8000ms scan raced against a 1500ms timer was
      // still killed at 1500ms — three real 650ms pages never got to finish).
      const result=await Promise.race([scan(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('activity lookup timeout')),8000);
      })]);
      return {...result,...admissionProof};
    } catch {return {idleConfirmed:false};}
    finally {if(timer)clearTimeout(timer);}
  }

  private async classifyWaitTimeout(text: string, sessionKey: string): Promise<Error> {
    const status = await this.getSessionRuntimeStatus(sessionKey).catch(() => normalizeSessionRuntimeStatus(undefined));
    // A wait timeout plus session idle/unknown is still not exact terminal proof.
    return new SessionWaitPaused(status, true);
  }

  async getSessionInfo(sessionKey: string,timeoutMs=120000): Promise<any> {
    return this.rpc("sessions.describe", { key: this.canonicalSessionKey(sessionKey) },timeoutMs);
  }

  /**
   * Ensure session is using the expected model. If not, patch it back.
   * Returns true if a correction was made.
   */
  async ensureModel(sessionKey: string, expectedModel: string, held?:{sessionId:string;guard:()=>void}): Promise<boolean> {
    const info = await this.getSessionInfo(sessionKey).catch(() => null);
    const session = info?.session;
    held?.guard();
    if(held && (session?.sessionId!==held.sessionId || session?.archived))throw new SupersededObservation('held model target changed');
    const modelId = typeof session?.model === "string" ? session.model.trim() : "";
    const provider = typeof session?.modelProvider === "string"
      ? session.modelProvider.trim()
      : typeof session?.provider === "string" ? session.provider.trim() : "";
    const currentModel = modelId.includes("/") ? modelId : provider && modelId ? `${provider}/${modelId}` : modelId;
    if (currentModel === expectedModel) return false;

    try {
      await this.patchSession({ key: sessionKey, model: expectedModel,...(held?{expectedSessionId:held.sessionId}:{}) });
    } catch (firstErr) {
      // Older gateways occasionally require the fully-qualified key. Do not hide
      // model-policy/capability errors: retry only when the key itself was not
      // resolved, otherwise surface the actionable rejection to the caller.
      const message = (firstErr as Error).message || String(firstErr);
      if (!/session (?:not found|unknown)|unknown session|invalid session key/i.test(message)) throw firstErr;
      const fullKey = sessionKey.startsWith("agent:") ? sessionKey : `agent:main:${sessionKey}`;
      held?.guard();
      await this.patchSession({ key: fullKey, model: expectedModel,...(held?{expectedSessionId:held.sessionId}:{}) });
    }
    console.log(`[OpenClaw] Model ensured: ${sessionKey} → ${expectedModel}`);
    return Boolean(currentModel && currentModel !== expectedModel);
  }

  async deleteSession(key: string, deleteTranscript = true): Promise<any> {
    return this.rpc("sessions.delete", { key: this.canonicalSessionKey(key), deleteTranscript });
  }

  async resetSession(key: string): Promise<any> {
    const canonical=this.canonicalSessionKey(key);
    this.stopGenerations.set(canonical,(this.stopGenerations.get(canonical)||0)+1);
    this.revokeSessionCollectors(canonical,'explicit session reset');
    this.recoveryStore?.stopSessionObservations(canonical);
    let release!:()=>void;
    const barrier=new Promise<void>(resolve=>release=resolve);
    this.pendingExplicitStops.set(canonical,barrier);
    try {
      // sessions.reset may not return a response; this is only the RPC deadline.
      return await this.rpc("sessions.reset", { key: canonical }, 5000).catch(() => {});
    } finally {release();if(this.pendingExplicitStops.get(canonical)===barrier)this.pendingExplicitStops.delete(canonical);}
  }

  /** One-shot ToolTrim compaction: route the native semantic compaction
   *  through the lma-core plugin's lma-tooltrim provider (keep text, keep only
   *  the 10 most recent tool calls, drop the rest of the tool payload).
   *  Orchestration (validated E2E 2026-10-10): config.set {raw, baseHash} →
   *  sessions.compact → restore the original config (always). */
  async toolTrimCompact(key: string, keepRecentToolCalls = 10, effectGuard?:()=>Promise<void>): Promise<any> {
    const release = await this.acquireMaintenanceSlot("tooltrim");
    const startedAt = Date.now();
    const PROVIDER = "lma-tooltrim";
    let restoreInfo: { raw: string; baseHash: string } | null = null;
    const restoreProvider = async () => {
      if (!restoreInfo) return;
      try {
        await this.rpc("config.set", { raw: restoreInfo.raw, baseHash: restoreInfo.baseHash }, 30000);
        console.log(`[OpenClaw] tooltrim: compaction provider config restored`);
      } catch (err) {
        console.warn(`[OpenClaw] tooltrim: config restore failed:`, (err as Error).message);
      }
    };
    try {
      // 1. Read the full config + its base hash (optimistic-concurrency token).
      const full = await this.rpc("config.get", {}, 30000);
      const hash = full?.hash;
      const cfg = full?.config ?? full?.parsed;
      if (typeof hash !== "string" || !cfg || typeof cfg !== "object") {
        return { compacted: false, reason: "无法读取网关配置（config.get）" };
      }
      const compNode0 = (cfg as any)?.agents?.defaults?.compaction;
      if (compNode0?.provider !== PROVIDER) {
        // Provider is not the persistent default: toggle it on for this run and
        // restore afterwards (portable path for hosts without the default set).
        const originalRaw = typeof full?.raw === "string" ? full.raw : JSON.stringify(cfg);
        const agentsNode = ((cfg as any).agents ??= {});
        const defaultsNode = (agentsNode.defaults ??= {});
        const comp = (defaultsNode.compaction ??= {});
        comp.provider = PROVIDER;
        await effectGuard?.();
        const setRes = await this.rpc("config.set", { raw: JSON.stringify(cfg), baseHash: hash }, 30000);
        if (setRes?.ok !== true || typeof setRes?.hash !== "string") {
          return { compacted: false, reason: `config.set 失败: ${JSON.stringify(setRes).slice(0, 160)}` };
        }
        restoreInfo = { raw: originalRaw, baseHash: setRes.hash };
      }
      // 2. Native semantic compaction now routes through our provider.
      await effectGuard?.();
      const result = await this.rpc("sessions.compact", { key: this.canonicalSessionKey(key) }, 10 * 60 * 1000);
      await restoreProvider();
      const ok = result?.compacted === true;
      return {
        compacted: ok,
        method: "tooltrim",
        detail: ok
          ? `文本保留；工具载荷已过滤（保留最近 ${keepRecentToolCalls} 条工具调用）`
          : (typeof result?.reason === "string" ? result.reason : "网关未执行压缩（会话可能正在运行或不需压缩）"),
        tokensBefore: result?.result?.tokensBefore,
      };
    } catch (err) {
      await restoreProvider();
      return { compacted: false, method: "tooltrim", reason: (err as Error).message };
    } finally {
      console.log(`[OpenClaw] tooltrim finished for ${key} in ${Date.now() - startedAt}ms`);
      release();
    }
  }

  /** Explicit LLM-summarize compaction (/compact semantic). Since lma-tooltrim
   *  is the persistent default provider, temporarily unset it so the built-in
   *  summarization pipeline runs, then restore the original config (always). */
  async semanticCompact(key: string, effectGuard?:()=>Promise<void>): Promise<any> {
    const release = await this.acquireMaintenanceSlot("semantic");
    const PROVIDER = "lma-tooltrim";
    let restoreInfo: { raw: string; baseHash: string } | null = null;
    const restoreProvider = async () => {
      if (!restoreInfo) return;
      try {
        await this.rpc("config.set", { raw: restoreInfo.raw, baseHash: restoreInfo.baseHash }, 30000);
        console.log(`[OpenClaw] semantic: compaction provider config restored`);
      } catch (err) {
        console.warn(`[OpenClaw] semantic: config restore failed:`, (err as Error).message);
      }
    };
    try {
      const full = await this.rpc("config.get", {}, 30000);
      const hash = full?.hash;
      const cfg = full?.config ?? full?.parsed;
      const comp = cfg && typeof cfg === "object" ? (cfg as any)?.agents?.defaults?.compaction : undefined;
      if (typeof hash === "string" && cfg && typeof cfg === "object" && comp?.provider) {
        const originalRaw = typeof full?.raw === "string" ? full.raw : JSON.stringify(cfg);
        delete comp.provider;
        await effectGuard?.();
        const setRes = await this.rpc("config.set", { raw: JSON.stringify(cfg), baseHash: hash }, 30000);
        if (setRes?.ok === true && typeof setRes?.hash === "string") {
          restoreInfo = { raw: originalRaw, baseHash: setRes.hash };
        }
        // If the toggle failed we still compact below: routing through the
        // default provider is a degraded-but-useful outcome vs not compacting.
      }
      await effectGuard?.();
      const result = await this.rpc("sessions.compact", { key: this.canonicalSessionKey(key) }, 10 * 60 * 1000);
      await restoreProvider();
      return result;
    } catch (err) {
      await restoreProvider();
      throw err;
    } finally {
      release();
    }
  }

  async compactSession(key: string, options: { maxLines?: number; effectGuard?:()=>Promise<void> } = {}): Promise<any> {
    const release = await this.acquireMaintenanceSlot("sessions.compact");
    const startedAt = Date.now();
    const maxLines = Number.isFinite(options.maxLines)
      ? Math.max(1, Math.floor(options.maxLines!))
      : undefined;
    const sendCompact = async () => { await options.effectGuard?.(); return this.rpc(
      "sessions.compact",
      { key: this.canonicalSessionKey(key), ...(maxLines !== undefined ? { maxLines } : {}) },
      10 * 60 * 1000,
    ); };
    try {
      try {
        return await sendCompact();
      } catch (err) {
        if (options.effectGuard || !this.isArchivedSessionError(err)) throw err;
        console.warn(`[OpenClaw] sessions.compact hit archived session for ${key}; restoring and retrying once`);
        const restored = await this.unarchiveSession(key);
        if (!restored) throw err;
        return await sendCompact();
      }
    } finally {
      const mode = maxLines === undefined ? "semantic" : `maxLines=${maxLines}`;
      console.log(`[OpenClaw] sessions.compact (${mode}) finished for ${key} in ${Date.now() - startedAt}ms`);
      release();
    }
  }

  // --- Chat ---

  /**
   * Send a message to a session and get the agent reply.
   * deliver=false prevents OpenClaw from auto-posting to channels.
   */
  async abortChat(sessionKey: string, runId?: string): Promise<any> {
    const key = this.canonicalSessionKey(sessionKey);
    // chat.abort supports { sessionKey } with no runId to abort ALL active runs
    // for that session. Used by /stop to force-clear a stuck run.
    if (!runId) {
      this.stopGenerations.set(key,(this.stopGenerations.get(key)||0)+1);
      this.revokeSessionCollectors(key,'explicit stop');
      this.recoveryStore?.stopSessionObservations(key);
      for (const [identity, at] of this.explicitlyStoppedRuns) if (Date.now() - at > 24 * 60 * 60_000) this.explicitlyStoppedRuns.delete(identity);
      // Mark the session so any in-flight collectReply finishes immediately
      // instead of treating the cancelled lifecycle as a transient state.
      if (this.runStateChecks.has(key)) {
        this.forceAbortedSessions.add(key);
        this.forceAbortedSessions.add(this.shortKey(key));
      }
    }
    const params: any = runId ? { sessionKey: key, runId } : { sessionKey: key };
    if (runId) return this.rpc("chat.abort", params, 5000).catch(() => {});
    let resolveStop!: () => void;
    const barrier = new Promise<void>(resolve => { resolveStop = resolve; });
    this.pendingExplicitStops.set(key, barrier);
    try {
      const result = await this.rpc("chat.abort", params, 5000).catch(() => undefined);
      // The authorized abort response names the exact runs actually stopped;
      // it also covers queued/unseen runs with no local status/delta event.
      if (result?.aborted === true && Array.isArray(result.runIds)) {
        for (const stopped of result.runIds) if (typeof stopped === "string" && stopped) {
          this.explicitlyStoppedRuns.set(JSON.stringify([key, stopped]), Date.now());
          this.recoveryStore?.stopExactRun(key,stopped);
        }
      }
      return result;
    } finally {
      resolveStop();
      if (this.pendingExplicitStops.get(key) === barrier) this.pendingExplicitStops.delete(key);
    }
  }

  private sessionKeyVariants(key: string): string[] {
    const shortKey = this.shortKey(key);
    return Array.from(new Set([shortKey, this.canonicalSessionKey(key), key]));
  }

  private trackChatEventSession(sessionKey: string, state: string | undefined, payload: any): void {
    if (!sessionKey || sessionKey === "__default__") return;
    const keys = this.sessionKeyVariants(sessionKey);
    const runId = typeof payload?.runId === "string" ? payload.runId : "";
    if (runId && this.ownedDeliveryRuns.has(runId)) {
      // collectReply owns this exact run. Do not suppress the whole session:
      // queueMode=steer may concurrently create another ordinary run that must
      // still reach the proactive callback.
      return;
    }
    if(runId && this.isExplicitlyStoppedRun(sessionKey,runId) && state==='final') return;
    const stopReason = terminalReason(payload?.stopReason,payload?.message?.stopReason);
    const isError = state === "error" || state === "aborted" || ['error','aborted','timeout','restart','superseded'].includes(stopReason || '');
    if (isError) {
      const detail = String(payload?.errorMessage || payload?.message?.errorMessage || payload?.error || payload?.reason || "").trim();
      const aborted = state === "aborted" || stopReason === "aborted";
      const text = `⚠️ Agent run ${aborted ? "was aborted" : "failed"}${detail ? `: ${detail}` : ""}`;
      this.emitProactiveForSession(sessionKey, text, {
        sourceType: "run_error", runId,
        error: { sessionKey: this.canonicalSessionKey(sessionKey), runId, source: "chat", state: state || "final", sessionId:typeof payload?.sessionId==='string'?payload.sessionId:undefined,
          ...(closedStopReason(stopReason) ? { stopReason:closedStopReason(stopReason) } : {}), detail,
          ...(this.isExplicitlyStoppedRun(sessionKey, runId) ? { userStop: true } : {}) },
      });
      this.releaseSuppressedSessionKeysAfter(keys, 0);
    } else if (state === "delta") {
      this.suppressSessionKeys(keys);
    } else if (state === "final") {
      // A yielded acknowledgment is presentation, never a final delivery key,
      // including repeats after foreground collector custody was handed off.
      if(payload?.yielded===true)return;
      const text = this.extractTextFromChatMessage(payload?.message);
      if (text) this.emitProactiveForSession(sessionKey, text, {
        runId, sessionKey: this.canonicalSessionKey(sessionKey), final: payload?.yielded !== true,
        ...(!stopReason && genericFailure(text) ? { genericErrorCandidate: true } : {}),
      });
      this.releaseSuppressedSessionKeysAfter(keys, 30000);
    }
  }

  async inspectRunError(provenance: ErrorProvenance) {
    await this.pendingExplicitStops.get(this.canonicalSessionKey(provenance.sessionKey));
    if (this.isExplicitlyStoppedRun(provenance.sessionKey, provenance.runId)) {
      return { state: "stopped" as const, reason: "exact_run_abort_receipt" };
    }
    const verdict = await inspectError(provenance, (method, params, timeout) => this.rpc(method, params, timeout));
    // A stop request can begin while task/wait evidence is in flight.
    await this.pendingExplicitStops.get(this.canonicalSessionKey(provenance.sessionKey));
    return this.isExplicitlyStoppedRun(provenance.sessionKey, provenance.runId)
      ? { state: "stopped" as const, reason: "exact_run_abort_receipt" } : verdict;
  }

  private extractTextFromChatMessage(message: any): string {
    if(this.isInputRecord(message))return "";
    const parts = Array.isArray(message?.content) ? message.content : [];
    return parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
  }

  private continuationChecks=new Map<string,Promise<void>>();
  /** A child/requester continuation is not automatically its parent's final.
   * Public task parentage selects the original root; only that exact root's
   * committed terminalReply may enter its old trigger/outbox. */
  private async handoffLinkedContinuation(sessionKey:string,meta:ProactiveMessageMeta):Promise<boolean> {
    if(!this.recoveryStore || !meta.runId)return false;
    const key=this.canonicalSessionKey(sessionKey);
    const candidate=announceCandidate({sessionKey:key,runId:meta.runId,source:'chat',state:'final',detail:''});
    if(!candidate)return false;
    try {
      const matches=(task:any)=>task?.kind==='subagent' && task.runId===candidate.runId && task.sessionKey===key && task.ownerKey===key &&
        typeof task.childSessionKey==='string' && (!candidate.childSessionKey || task.childSessionKey===candidate.childSessionKey);
      const found=new Set<string>();let cursor:string|undefined;
      for(let page=0;page<2;page++) {
        const result=await this.rpc('tasks.list',{sessionKey:key,limit:100,...(cursor?{cursor}:{})},1500);
        if(!Array.isArray(result?.tasks))return false;
        for(const task of result.tasks)if(matches(task) && typeof task.id==='string')found.add(task.id);
        cursor=typeof result.nextCursor==='string'?result.nextCursor:undefined;if(!cursor)break;
      }
      if(cursor || found.size!==1)return false;
      const child=(await this.rpc('tasks.get',{taskId:[...found][0]},1500))?.task;
      if(!matches(child) || !child.parentTaskId || child.id!==[...found][0])return false;
      const parent=(await this.rpc('tasks.get',{taskId:child.parentTaskId},1500))?.task;
      if(parent?.id!==child.parentTaskId || parent.sessionKey!==key || parent.ownerKey!==key || typeof parent.runId!=='string')return false;
      if(!this.recoveryStore)return true;
      const root=this.recoveryStore.getRunObservation(key,parent.runId);
      if(!root?.yielded)return false;
      if(root.state!=='observing' || this.isExplicitlyStoppedRun(key,parent.runId))return true;
      this.recoveryStore.saveRunObservation(key,parent.runId,{...root,continuationRunId:meta.runId,continuationTaskId:child.id},0);
      await this.recoverExactRuns();
      return true;
    } catch {return false;}
  }

  private emitProactiveForSession(sessionKey: string,text: string,meta?: ProactiveMessageMeta,lineageChecked=false): boolean {
    const keys=this.sessionKeyVariants(sessionKey);
    const callback=keys.map(k=>this.sessionMessageCallbacks.get(k)).find(Boolean);
    if(!callback) return false;
    if(!lineageChecked && meta?.final && meta.runId?.startsWith('announce:') && this.recoveryStore?.hasYieldedObservation(this.canonicalSessionKey(sessionKey))) {
      const candidate=announceCandidate({sessionKey:this.canonicalSessionKey(sessionKey),runId:meta.runId,source:'chat',state:'final',detail:''});
      if(candidate) {
        const identity=JSON.stringify([this.canonicalSessionKey(sessionKey),meta.runId]);
        if(!this.continuationChecks.has(identity)) {
          const store=this.recoveryStore;
          const work=this.handoffLinkedContinuation(sessionKey,meta).then(handled=>{if(!handled && this.recoveryStore===store && this.shouldReconnect)this.emitProactiveForSession(sessionKey,text,meta,true);})
            .catch(()=>{}).finally(()=>this.continuationChecks.delete(identity));
          this.continuationChecks.set(identity,work);
        }
        return true;
      }
    }
    const identity=meta?.final && meta.runId ? JSON.stringify([this.canonicalSessionKey(sessionKey),meta.runId]) : '';
    const fingerprint=createHash('sha256').update(text).digest('hex');
    if(identity && this.forwardedFinals.get(identity)===fingerprint) return true;
    if(identity) {
      this.forwardedFinals.set(identity,fingerprint);
      if(this.forwardedFinals.size>2048) this.forwardedFinals.delete(this.forwardedFinals.keys().next().value!);
    }
    if(identity) this.recoveryStore?.saveRunObservation(this.canonicalSessionKey(sessionKey),meta!.runId!,{sessionId:meta?.sessionId,terminalText:text,terminalObserved:true,
      ...(text.trim().toUpperCase()==='NO_REPLY'?{terminalDisposition:'silent'}:{})},Date.now()+60_000);
    if(identity && text.trim().toUpperCase()==='NO_REPLY' && this.recoveryStore) {
      const key=this.canonicalSessionKey(sessionKey),runId=meta!.runId!;
      this.recoveryStore.settleExactRunReactions(key,runId);
      this.recoveryStore.finishRunObservation(key,runId);
      void Promise.resolve(this.sessionSettlementCallbacks.get(key)?.({...meta,sessionKey:key,runId,final:true})).catch(()=>{});
      return true;
    }
    try {
      const result=meta ? callback(text,meta) : callback(text);
      if(identity) void Promise.resolve(result).catch(()=>this.forwardedFinals.delete(identity));
    } catch(error) {if(identity)this.forwardedFinals.delete(identity);throw error;}
    return true;
  }

  private suppressSessionKeys(keys: string[]): void {
    for (const key of keys) {
      const timer = this.suppressedSessionTimers.get(key);
      if (timer) clearTimeout(timer);
      this.suppressedSessionTimers.delete(key);
      this.suppressedSessions.add(key);
    }
  }

  private releaseSuppressedSessionKeysAfter(keys: string[], delayMs: number): void {
    for (const key of keys) {
      const oldTimer = this.suppressedSessionTimers.get(key);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        this.suppressedSessions.delete(key);
        this.suppressedSessionTimers.delete(key);
      }, delayMs);
      this.suppressedSessionTimers.set(key, timer);
    }
  }

  private ownDeliveryRun(runId: string): void {
    if (!runId) return;
    const timer = this.ownedDeliveryRunTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.ownedDeliveryRunTimers.delete(runId);
    this.ownedDeliveryRuns.add(runId);
  }

  private releaseOwnedDeliveryRunAfter(runId: string, delayMs: number): void {
    if (!runId) return;
    const oldTimer = this.ownedDeliveryRunTimers.get(runId);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      this.ownedDeliveryRuns.delete(runId);
      this.ownedDeliveryRunTimers.delete(runId);
    }, delayMs);
    timer.unref?.();
    this.ownedDeliveryRunTimers.set(runId, timer);
  }

  private addMutedProactiveKey(key: string): void {
    const count = this.mutedProactiveSessionCounts.get(key) || 0;
    this.mutedProactiveSessionCounts.set(key, count + 1);
    this.mutedProactiveSessions.add(key);
  }

  private releaseMutedProactiveKey(key: string): void {
    const count = this.mutedProactiveSessionCounts.get(key) || 0;
    if (count <= 1) {
      this.mutedProactiveSessionCounts.delete(key);
      this.mutedProactiveSessions.delete(key);
    } else {
      this.mutedProactiveSessionCounts.set(key, count - 1);
    }
  }

  muteProactiveDelivery(sessionKey: string): (delayMs?: number) => void {
    const shortKey = sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
    const fullKey = `agent:main:${shortKey}`;
    const keys = [shortKey, fullKey];
    for (const key of keys) this.addMutedProactiveKey(key);
    let released = false;
    return (delayMs = 0) => {
      if (released) return;
      released = true;
      const release = () => {
        for (const key of keys) this.releaseMutedProactiveKey(key);
      };
      if (delayMs > 0) setTimeout(release, delayMs);
      else release();
    };
  }

  private async acquireChatSendSlot(): Promise<() => void> {
    const limit = Math.max(1, this.chatSendConcurrency || 1);
    if (this.activeChatSends < limit) {
      this.activeChatSends++;
      return () => this.releaseChatSendSlot();
    }
    const startedWaitingAt = Date.now();
    await new Promise<void>((resolve) => this.chatSendWaiters.push(resolve));
    this.activeChatSends++;
    console.log(`[OpenClaw] chat.send waited ${Date.now() - startedWaitingAt}ms for concurrency slot (active=${this.activeChatSends}/${limit})`);
    return () => this.releaseChatSendSlot();
  }

  private releaseChatSendSlot(): void {
    this.activeChatSends = Math.max(0, this.activeChatSends - 1);
    const next = this.chatSendWaiters.shift();
    if (next) next();
  }

  private async acquireMaintenanceSlot(kind: string): Promise<() => void> {
    const limit = Math.max(1, this.maintenanceConcurrency || 1);
    if (this.activeMaintenanceRpcs < limit) {
      this.activeMaintenanceRpcs++;
      return () => this.releaseMaintenanceSlot();
    }
    const startedWaitingAt = Date.now();
    await new Promise<void>((resolve) => this.maintenanceWaiters.push(resolve));
    this.activeMaintenanceRpcs++;
    console.log(`[OpenClaw] ${kind} waited ${Date.now() - startedWaitingAt}ms for maintenance slot (active=${this.activeMaintenanceRpcs}/${limit})`);
    return () => this.releaseMaintenanceSlot();
  }

  private releaseMaintenanceSlot(): void {
    this.activeMaintenanceRpcs = Math.max(0, this.activeMaintenanceRpcs - 1);
    const next = this.maintenanceWaiters.shift();
    if (next) next();
  }

  /** Public native Goal protocol. Completion deliberately unavailable without host revision CAS. */
  async createGoNativeGoal(p: { sessionKey: string; sessionId: string; objective: string; operationId: string; issuedAtMs: number }) {
    return this.rpc("chat.send", { sessionKey: this.canonicalSessionKey(p.sessionKey), sessionId: p.sessionId,
      message: p.objective, idempotencyKey: p.operationId, deliver: false,
      intent: { kind: "session-goal-start", version: 1, issuedAtMs: p.issuedAtMs } });
  }
  async readGoNativeGoal(sessionKey: string, sessionId: string) {
    const info = await this.getSessionInfo(sessionKey);
    if (info?.session?.sessionId !== sessionId || info?.session?.archived) throw new Error("Go session generation changed or archived");
    return { session: info.session, goal: info.session.goal ?? null, revisionCAS: "unsupported" as const };
  }
  async updateGoNativeGoal(p: { sessionKey: string; sessionId: string; goalId: string; operationId: string; issuedAtMs: number; action: "edit" | "pause" | "resume" | "block"; objective?: string; note?: string }) {
    if (!( ["edit", "pause", "resume", "block"] as string[]).includes(p.action)) throw new Error("Native Goal completion CAS unsupported");
    const { objective, note, ...identity } = p;
    return this.rpc("sessions.goal.update", { ...identity, sessionKey: this.canonicalSessionKey(p.sessionKey),
      ...(p.action === "edit" ? { objective } : note === undefined ? {} : { note }) });
  }
  /** Admission receipt, not delivery. No restore, random retry key, or generation fallback. */
  async sendGoGuarded(p: { sessionKey: string; sessionId: string; expectedLeafEntryId: string | null; message: string; idempotencyKey: string }) {
    if (!p.sessionId || !p.idempotencyKey || p.expectedLeafEntryId === undefined) throw new Error("Missing Go send guards");
    // Own delivery before admission: events can beat the RPC response. Mute only
    // this brief admission window; afterwards exact run ownership avoids hiding
    // unrelated proactive work. A lost receipt retains the conservative fence.
    const release = this.muteProactiveDelivery(p.sessionKey);
    this.ownDeliveryRun(p.idempotencyKey);
    try {
      const result = await this.rpc("chat.send", { ...p, message:p.message + this.bridgeAttachmentHint(p.message),
        sessionKey: this.canonicalSessionKey(p.sessionKey), deliver: false, suppressCommandInterpretation: true });
      if (typeof result?.runId !== "string" || !result.runId) throw new Error("Unknown Go admission receipt");
      this.ownDeliveryRun(result.runId);
      return { runId: result.runId, sessionId: p.sessionId, idempotencyKey: p.idempotencyKey, raw: result };
    } finally { release(); }
  }
  /** Checker collection accepts only the admitted run, never a session-key fallback. */
  async collectGoRun(p: { runId: string; sessionKey: string; sessionId?:string; timeoutMs: number }) {
    if (p.sessionId && (await this.getGoSessionInfo(p.sessionKey))?.session?.sessionId!==p.sessionId) throw new Error("Go result generation changed");
    const text=await this.collectReply(p.runId, p.timeoutMs, p.sessionKey, {exactRunIdentity:true});
    if (p.sessionId && (await this.getGoSessionInfo(p.sessionKey))?.session?.sessionId!==p.sessionId) throw new Error("Go result generation changed");
    return text;
  }
  /** Public committed terminalReply is the authority, including explicit empty
   * and terminal error. Stream prefaces, lifecycle end alone and timeout are not. */
  async readGoExecutorRunResult(p:{sessionKey:string;sessionId:string;runId:string}, waitMs=1): Promise<GoExecutorResult|null> {
    const before=await this.getGoSessionInfo(p.sessionKey);
    if(before?.session?.sessionId!==p.sessionId || before.session.archived) return null;
    this.ownDeliveryRun(p.runId);
    const result=await this.rpc("agent.wait",{runId:p.runId,timeoutMs:waitMs},Math.max(2500,waitMs+1500));
    const after=await this.getGoSessionInfo(p.sessionKey);
    if(after?.session?.sessionId!==p.sessionId || after.session.archived || result?.runId!==p.runId ||
      (result.sessionId!==undefined && result.sessionId!==p.sessionId) || !Number.isFinite(result.endedAt) || result.endedAt<=0 ||
      (Number.isFinite(result.startedAt) && result.endedAt<result.startedAt) || result.yielded || result.pendingError) return null;
    const identity={sessionKey:this.canonicalSessionKey(p.sessionKey),sessionId:p.sessionId,runId:p.runId};
    if(result.status==="error" || result.status==="timeout") return {...identity,disposition:"error",text:"",error:String(result.error || `Run ended: ${result.status}`)};
    if(result.status!=="ok") return null;
    const reply=result.terminalReply;
    if(reply?.disposition==="silent") return {...identity,disposition:"silent",text:""};
    if(reply?.disposition==="empty") return {...identity,disposition:"empty",text:""};
    if(reply?.disposition!=="visible" || typeof reply.text!=="string") return null;
    return {...identity,disposition:reply.text.trim()==="NO_REPLY" ? "silent" : reply.text.trim() ? "visible" : "empty",text:reply.text};
  }
  async collectGoExecutorRun(p:{sessionKey:string;sessionId:string;runId:string;timeoutMs:number}): Promise<GoExecutorResult> {
    const deadline=Date.now()+p.timeoutMs;
    do {
      const result=await this.readGoExecutorRunResult(p,Math.min(1500,Math.max(1,deadline-Date.now())));
      if(result) return result;
      if(Date.now()<deadline) await new Promise(r=>setTimeout(r,250));
    } while(Date.now()<deadline);
    throw new Error("Exact Go executor terminal result unknown; no replay");
  }
  async readGoRunResult(p: {sessionKey:string;sessionId:string;runId:string}) {
    const result=await this.readGoExecutorRunResult(p);
    return !result || result.disposition==="error" || result.disposition==="empty" ? null : result.disposition==="silent" ? "NO_REPLY" : result.text;
  }
  /** Public generation-pinned original input receipts; absence is unknown, not permission to resend. */
  async reconcileGoSend(p: { sessionKey: string; sessionId: string; idempotencyKey: string }) {
    const result = await this.rpc("chat.history", { sessionKey: this.canonicalSessionKey(p.sessionKey),
      sessionId: p.sessionId, inputRunIds: [p.idempotencyKey], limit: 1 });
    const receipt = result?.inputReceipts?.find((r: any) => r.runId === p.idempotencyKey);
    return receipt ? { runId: receipt.runId, sessionId: p.sessionId, raw: receipt } : null;
  }
  async bindGoPolicy(binding: Record<string, string>) { return this.rpc("lma.go.bind", { binding }); }
  /** History publicly projects active leaf/run/recovery; describe alone does not. */
  async getGoSessionInfo(sessionKey:string) {
    const history = await this.rpc("chat.history", {sessionKey:this.canonicalSessionKey(sessionKey),limit:1});
    return {session:history?.sessionInfo};
  }
  async verifyGoSafety(_executorKey: string) {
    const capability = await this.rpc("lma.go.capabilities", {});
    return { checkerToolsIsolated: capability?.mode === "independent" && capability.checkerToolsIsolated === true,
      exactTaskAndDeliveryGate: capability?.taskQuery === true, guardedSend: true };
  }
  async initializeGoRuntime(p: {goId:number;goal:string;executorSessionKey:string;executorSessionId:string;checkerSessionKey:string;checkerSessionId:string}) {
    const binding = { checkerSessionKey:this.canonicalSessionKey(p.checkerSessionKey), checkerSessionId:p.checkerSessionId,
      executorSessionKey:this.canonicalSessionKey(p.executorSessionKey), executorSessionId:p.executorSessionId };
    const result = await this.bindGoPolicy(binding);
    if (result?.persisted !== true || JSON.stringify(result.binding) !== JSON.stringify(binding)) throw new Error("Checker restriction binding not confirmed");
    return {executorSessionId:p.executorSessionId,checkerSessionId:p.checkerSessionId,checkerRunId:"",executorRunIds:[]};
  }
  async readGoRuntimeSnapshot(sessionKey: string, sessionId: string) {
    const key = this.canonicalSessionKey(sessionKey);
    const before = await this.getGoSessionInfo(key);
    const query = await this.rpc("lma.go.snapshot", {sessionKey:key,sessionId});
    const history = await this.rpc("chat.history", {sessionKey:key,sessionId,limit:1});
    const live = history?.sessionInfo;
    const after = await this.getGoSessionInfo(key);
    return { sessionKey:key,sessionId,archived:after?.session?.archived===true,
      complete: false, independent:true, atomicSnapshot:false,
      queryAvailable:query?.queryAvailable===true && query.sessionKey===key && query.requestedSessionId===sessionId && live?.sessionId===sessionId && before?.session?.sessionId===sessionId && after?.session?.sessionId===sessionId &&
        before.session.activeLeafEntryId===after.session.activeLeafEntryId && typeof live?.hasActiveRun==="boolean",
      running:history?.inFlightRun ? true : live?.hasActiveRun, activeRunIds:live?.activeRunIds,
      queuedInputs:history?.pendingInputs?.total,
      tasks:(query?.tasks ?? []).map((t:any)=>({taskId:t.id,runId:t.runId ?? "",parentTaskId:t.parentTaskId ?? null,
        state:t.status==="succeeded" ? "completed" : t.status,deliveryState:t.deliveryStatus==="not_applicable" ? "not_required" : t.deliveryStatus})) };
  }

  async chatSend(params: {
    sessionKey: string;
    message: string;
    attachments?: ChatAttachment[];
    deliver?: boolean;
    /** Consecutive effective-activity silence after admission/collector start; default 10 minutes, not total run time. */
    timeoutMs?: number;
    emptyFinalAsNoReply?: boolean;
    /** Restricted busy/no-target admission. No archive restore or unguarded retry. */
    followupAdmissionGuard?: FollowupAdmissionGuard;
    /** Original physical target of a retained identity input; never restore or retarget. */
    expectedSessionId?: string;
    /** Local stop/owner/batch/admission CAS, checked around every async boundary. */
    admissionGuard?: () => void;
    /** Called immediately before issuing chat.send RPC; use for at-most-once bookkeeping. */
    onSendAttempt?: (submissionId:string) => void | Promise<void>;
    /** Called after chat.send RPC succeeds and OpenClaw has accepted the user message. */
    onSubmitted?: (runId: string) => void | Promise<void>;
    /** Identifies collection target; not an acceptance receipt. */
    onRunIdentified?: (runId:string,identity?:{sessionId?:string})=>void | Promise<void>;
    onProgress?: (event: ProgressEvent) => void | Promise<void>;
    onWaitPaused?: (notice: SessionWaitPaused) => void | Promise<void>;
    /** Synchronous durable scheduling handoff; never a task settlement. */
    onYieldHandoff?: (runId:string)=>void;
    onCollectionStarted?: (runId:string)=>void;
  }): Promise<string> {
    const sk = this.shortKey(params.sessionKey);
    const fullSessionKey = this.canonicalSessionKey(params.sessionKey);
    const generation=(this.observationEpoch.get(fullSessionKey)||0)+1;
    this.observationEpoch.set(fullSessionKey,generation);
    const stopGeneration=this.stopGenerations.get(fullSessionKey)||0;
    const isCurrent=()=>this.observationEpoch.get(fullSessionKey)===generation && (this.stopGenerations.get(fullSessionKey)||0)===stopGeneration;
    const assertCurrent=()=>{if(!isCurrent()) throw new SupersededObservation('admission generation revoked');params.admissionGuard?.();};
    const submissionId=randomUUID();
    let ownedRunId = "";
    let eventReservationRunId='';
    let releaseEventReservation=()=>{};
    const reserveEvents=(runId:string)=>{
      if(eventReservationRunId===runId)return;
      releaseEventReservation();eventReservationRunId=runId;
      releaseEventReservation=this.retainRunEventCustody('reservation',fullSessionKey,runId);
    };
    let waitPaused = false;
    try {
      // New user inputs arriving after /stop are admitted only AFTER that
      // authorized session-wide abort returns. They are not part of its cutoff.
      const stopBarrier=this.pendingExplicitStops.get(fullSessionKey);
      if(stopBarrier) await stopBarrier;
      assertCurrent();
      const releaseChatSendSlot = await this.acquireChatSendSlot();
      let result: any;
      const sendStartedAt = Date.now();
      try {
        assertCurrent();
        const restricted=params.followupAdmissionGuard;
        if(params.expectedSessionId && restricted && restricted.sessionId!==params.expectedSessionId)
          throw new SupersededObservation('retained target conflicts with followup target');
        if(params.expectedSessionId) {
          const info=await this.getSessionInfo(fullSessionKey,2000);assertCurrent();
          if(info?.session?.archived || info?.session?.sessionId!==params.expectedSessionId)throw new SupersededObservation("retained original physical target changed");
        }
        if(restricted) {
          const refuse=(reason:string):never=>{throw new FollowupAdmissionRefused(reason,submissionId);};
          if(restricted.sessionKey!==fullSessionKey || !restricted.sessionId?.trim() || !restricted.expectedLeafEntryId?.trim())refuse('missing or incompatible observed generation/leaf');
          const activity=await this.getSessionDispatchStatus(fullSessionKey);
          assertCurrent();
          const runtime=await this.getSessionRuntimeStatus(fullSessionKey);
          assertCurrent();
          if(!activity.followupAdmissionEligible || activity.identityConflict || activity.archived || runtime.archived ||
            activity.activeRunId && !restricted.nonInjectableRunId ||
            activity.sessionId!==restricted.sessionId || runtime.sessionId!==restricted.sessionId)
            refuse('current session/leaf/archive/admission evidence changed');
        }
        this.recoveryStore?.saveAdmission(fullSessionKey,submissionId,'reserved',{generation,stopGeneration,
          ...(params.expectedSessionId?{expectedSessionId:params.expectedSessionId}:{}),...(restricted?{followupAdmissionGuard:restricted}:{})});
        await params.onSendAttempt?.(submissionId);
        assertCurrent();
        const idempotencyKey=submissionId;
        const sendChat = () => { assertCurrent();
          this.recoveryStore?.saveAdmission(fullSessionKey,idempotencyKey,'dispatching',{generation,stopGeneration,
            ...(params.expectedSessionId?{expectedSessionId:params.expectedSessionId}:{}),payloadDigest:createHash('sha256').update(params.message).digest('hex')});
          this.recoveryStore?.saveRunObservation(fullSessionKey,submissionId,{admissionOnly:true,...(params.expectedSessionId?{sessionId:params.expectedSessionId}:{})},Date.now()+30_000);
          // Claim exact output custody synchronously in the WS ACK handler.
          // ws.Receiver can emit ACK + final before any await continuation runs.
          // Failed admission never runs this hook and cannot revoke the old owner.
          this.admissionResponseHooks.set(idempotencyKey,receipt=>{
            if(isCurrent() && typeof receipt?.runId==='string' && receipt.runId &&
              (!params.expectedSessionId || !receipt.sessionId || receipt.sessionId===params.expectedSessionId) && !this.isExplicitlyStoppedRun(fullSessionKey,receipt.runId)) {
              ownedRunId=receipt.runId;
              reserveEvents(ownedRunId);
              this.ownDeliveryRun(ownedRunId);
            }
          });
          return this.rpc("chat.send", {
          sessionKey: this.canonicalSessionKey(sk),
          message: params.message,
          attachments: params.attachments,
          // Ordinary admission is a separate serialized turn, not a request to
          // inherit stored interrupt/steer policy or its commit-wait finalizer.
          queueMode: "followup",
          ...(params.expectedSessionId ? {sessionId:params.expectedSessionId} : {}),
          ...(restricted ? {sessionId:restricted.sessionId,expectedLeafEntryId:restricted.expectedLeafEntryId,suppressCommandInterpretation:true} : {}),
          deliver: params.deliver ?? false,
          idempotencyKey,
        }); };
        try {
          result = await sendChat();
        } catch (err) {
          if(params.expectedSessionId && !restricted) {
            const rejected=err instanceof Error && /^RPC error:/.test(err.message);
            this.recoveryStore?.saveAdmission(fullSessionKey,idempotencyKey,rejected?'rejected':'unknown',
              {generation,stopGeneration,expectedSessionId:params.expectedSessionId});
            if(rejected){this.recoveryStore?.finishRunObservation(fullSessionKey,submissionId,'rejected');throw err;}
            throw new AdmissionUnconfirmed(idempotencyKey,err);
          }
          if(restricted) {
            // Only named public pre-effect guard refusals prove zero effect.
            // Other RPC errors/transport failures retain the ORIGINAL identity;
            // an error string alone must never authorize a new-ID replay.
            let detail:any;
            if(err instanceof Error && err.message.startsWith('RPC error:')) {
              try {detail=JSON.parse(err.message.slice('RPC error:'.length));} catch { /* unknown */ }
            }
            const noEffect=detail?.code==='INVALID_REQUEST' && ['active-leaf-changed','session-changed'].includes(detail?.details?.reason);
            this.recoveryStore?.saveAdmission(fullSessionKey,idempotencyKey,noEffect?'rejected':'unknown',{generation,stopGeneration,followupAdmissionGuard:restricted});
            if(noEffect) {
              this.recoveryStore?.finishRunObservation(fullSessionKey,submissionId,'rejected');
              throw new FollowupAdmissionRefused(detail.details.reason,submissionId);
            }
            throw new AdmissionUnconfirmed(idempotencyKey,err);
          }
          // The Gateway auto-archives sessions past the active-session cap; an
          // archived session refuses new work. Restore it once and retry — the
          // user should never have to fix this by hand.
          if (!this.isArchivedSessionError(err)) {
            const rejected=err instanceof Error && /^RPC error:/.test(err.message);
            this.recoveryStore?.saveAdmission(fullSessionKey,idempotencyKey,rejected?'rejected':'unknown',{generation,stopGeneration});
            if(rejected) {this.recoveryStore?.finishRunObservation(fullSessionKey,submissionId,'rejected');throw err;}
            throw new AdmissionUnconfirmed(idempotencyKey,err);
          }
          console.warn(`[OpenClaw] chat.send hit archived session for ${sk}; restoring and retrying once`);
          const restored = await this.unarchiveSession(sk);
          if (!restored) throw err;
          result = await sendChat();
        }
      } finally {
        releaseChatSendSlot();
      }
      ownedRunId = typeof result?.runId === "string" ? result.runId : "";
      if(!ownedRunId) throw new AdmissionUnconfirmed('unidentified-receipt');
      if(params.expectedSessionId && result.sessionId && result.sessionId!==params.expectedSessionId)throw new AdmissionUnconfirmed(submissionId);
      const resultSessionId=result.sessionId || params.expectedSessionId;
      this.recoveryStore?.saveAdmission(fullSessionKey,submissionId,['started','ok'].includes(result.status)?'accepted':'unconfirmed',
        {generation,stopGeneration,runId:ownedRunId,...(params.expectedSessionId?{expectedSessionId:params.expectedSessionId}:{})});
      if(ownedRunId!==submissionId) this.recoveryStore?.finishRunObservation(fullSessionKey,submissionId,'identified');
      this.recoveryStore?.saveRunObservation(fullSessionKey,ownedRunId,{sessionId:resultSessionId});
      if(this.isExplicitlyStoppedRun(fullSessionKey,ownedRunId) || (this.stopGenerations.get(fullSessionKey)||0)!==stopGeneration) {
        this.recoveryStore?.finishRunObservation(fullSessionKey,ownedRunId,'stopped');
        throw new SupersededObservation('late stopped admission');
      }
      if(!isCurrent()) throw new SupersededObservation('late admission is not current');
      // Commit replacement only AFTER confirmed admission. A failed new send
      // must leave the healthy old collector and its custody intact.
      const previous=this.sessionCollectorFences.get(fullSessionKey);
      if(previous) for(const fence of [...previous]) fence();
      reserveEvents(ownedRunId); // mocked/legacy transports may not use the WS ACK hook
      this.ownDeliveryRun(ownedRunId);
      console.log(`[OpenClaw] chat.send runId: ${result.runId} (rpc=${Date.now() - sendStartedAt}ms, attachments=${params.attachments?.length || 0})`);
      await params.onRunIdentified?.(result.runId,{sessionId:resultSessionId});
      assertCurrent();
      // A reservation/in_flight reply is not confirmed acceptance. Keep UI
      // Typing while exact collection/read-only receipt reconciliation proceeds.
      if(result.status==='started' || result.status==='ok' || Number.isSafeInteger(result.messageSeq) && result.messageSeq>=0) await params.onSubmitted?.(result.runId);
      assertCurrent();
      if (params.onProgress) {
        this.progressRuns.set(fullSessionKey,ownedRunId);
        this.progressCallbacks.set(sk, params.onProgress);
        this.progressCallbacks.set(fullSessionKey, params.onProgress);
        this.progressGenerations.set(sk,generation);
        this.progressGenerations.set(fullSessionKey,generation);
        void params.onProgress({ kind: "lifecycle", text: "等待 OpenClaw 回复" });
      }
      const collecting=this.collectReply(result.runId, params.timeoutMs || FOREGROUND_WAIT_MS, sk, { emptyFinalAsNoReply: params.emptyFinalAsNoReply, expectedUserText: params.message, expectedSessionId:resultSessionId, onWaitPaused: params.onWaitPaused, onYieldHandoff:params.onYieldHandoff });
      // Reader registration is synchronous inside collectReply. Only now may
      // the receiver's ACK reservation release its same-run terminal custody.
      releaseEventReservation();
      params.onCollectionStarted?.(result.runId);
      const reply=await collecting;
      if(reply.trim().toUpperCase()==='NO_REPLY') this.recoveryStore?.finishRunObservation(fullSessionKey,ownedRunId);
      else this.recoveryStore?.saveRunObservation(fullSessionKey,ownedRunId,{sessionId:resultSessionId,terminalText:reply,terminalObserved:true},Date.now()+30_000);
      // Do not retire on lifecycle/timeout/cleanup alone. Successful full result
      // custody (and synchronous durable save when bound) precedes retirement.
      const durable=this.recoveryStore?.getRunObservation(fullSessionKey,ownedRunId);
      const durableResult=!this.recoveryStore || (reply.trim().toUpperCase()==='NO_REPLY'
        ? durable?.state==='settled'
        : durable?.terminalObserved===true && durable?.terminalText===reply);
      if(durableResult) {
        const completedKey=this.runEventKey(fullSessionKey,ownedRunId);
        this.completedRunEventCustody.add(completedKey);
        this.retireCompletedRunEvents(completedKey);
      }
      return reply;
    } catch (error) {
      waitPaused = error instanceof SessionWaitPaused || error instanceof SupersededObservation || error instanceof CollectorStalledError;
      throw error;
    } finally {
      this.admissionResponseHooks.delete(submissionId);
      releaseEventReservation();
      // OpenClaw can emit the final assistant session.message a moment after
      // collectReply returns. Keep a short grace window so normal chat replies
      // are not delivered twice via the proactive-message path. Cron/LMA runs
      // are unaffected because they do not go through chatSend.
      // CAS: a superseded send's finally must not delete a newer send's
      // progress callback (the fence settles the old promise after the new
      // batch may already have registered its own callback).
      if (params.onProgress) {
        if (this.progressGenerations.get(sk)===generation && this.progressCallbacks.get(sk) === params.onProgress) {this.progressCallbacks.delete(sk);this.progressGenerations.delete(sk);}
        if (this.progressGenerations.get(fullSessionKey)===generation && this.progressCallbacks.get(fullSessionKey) === params.onProgress) {this.progressCallbacks.delete(fullSessionKey);this.progressGenerations.delete(fullSessionKey);this.progressRuns.delete(fullSessionKey);}
      }
      if (waitPaused) this.releasePausedWait(ownedRunId);
      else this.releaseOwnedDeliveryRunAfter(ownedRunId, 30000);
    }
  }

  private shouldInjectBridgeAttachmentHint(text: string): boolean {
    // Require an action word combined with an artifact word, so ordinary talk
    // that merely mentions "文档/图片/投递" does not trigger the long hint.
    const action = /(发送|发到|发给|发一[张份个]|上传|生成|做一?[张份个]|画一?[张份个]|创建|导出|保存|附上|附件形式|attach|upload|export|generate|create|save)/i;
    const artifact = /(图片|图像|照片|配图|海报|封面|文件|文档|附件|表格|pdf|docx?|xlsx?|pptx?|markdown|\bmd\b|\.png|\.jpe?g|\.gif|\.webp|image|file|document)/i;
    return action.test(text) && artifact.test(text);
  }

  private bridgeAttachmentHint(text: string): string {
    if (!this.shouldInjectBridgeAttachmentHint(text)) return "";
    return `

[Bridge attachment capability hint: This is an OpenClaw Lark Multi-Agent bridge session. You cannot send Feishu files/images directly from inside OpenClaw. Do NOT call message, sessions_send, Feishu tools, or proactive send tools for this request. If the user asks you to send an image/file/document to Feishu, save or copy the real file under ${BRIDGE_ATTACHMENTS_DIR}/, or use an existing real file under the OpenClaw workspace. NEVER use placeholder paths such as /absolute/path, /real/path, /path/to/file, or example paths; the path must be the actual file you created and it must exist. Include this exact marker at the very end of your final reply (do not explain or expose the marker as normal text): <LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"image","path":"${BRIDGE_ATTACHMENTS_DIR}/replace-with-actual-created-file.png","caption":"optional"}]}</LMA_BRIDGE_ATTACHMENTS>. Replace the example path with the actual existing file path before replying. The bridge layer will parse this marker and send the attachment. Use type=image for images; use type=document for Markdown documents (.md) so the bridge creates a Feishu cloud document and sends its link; use type=file for other ordinary files.]`;
  }

  /**
   * Build and send a context catch-up message followed by the actual message.
   *
   * Batches unsynced messages into a single context block to minimize agent runs.
   * Format:
   *   [Context: messages you missed]
   *   [Alice 00:30]: blah
   *   [GPT 00:31]: blah
   *   ---
   *   Now respond to: <actual message>
   *
   * If there are no unsynced messages, just sends the actual message directly.
   */
  async chatSendWithContext(params: {
    sessionKey: string;
    unsyncedMessages: ChatMessage[];
    currentMessage: string;
    currentSenderName: string;
    deliver?: boolean;
    /** Consecutive effective-activity silence after admission/collector start; default 10 minutes, not total run time. */
    timeoutMs?: number;
    emptyFinalAsNoReply?: boolean;
    /** Native escaped commands (//status -> /status) should not receive catch-up context. */
    includeContext?: boolean;
    /** Disable bridge attachment hints for native commands and other exact pass-through messages. */
    includeBridgeAttachmentHint?: boolean;
    /** Restricted busy/no-target admission. No archive restore or unguarded retry. */
    followupAdmissionGuard?: FollowupAdmissionGuard;
    /** Original physical target of a retained identity input; never restore or retarget. */
    expectedSessionId?: string;
    /** Local stop/owner/batch/admission CAS, checked around every async boundary. */
    admissionGuard?: () => void;
    /** Called immediately before issuing chat.send RPC; use for at-most-once bookkeeping. */
    onSendAttempt?: (submissionId:string) => void | Promise<void>;
    /** Called after chat.send RPC succeeds and OpenClaw has accepted the combined message. */
    onSubmitted?: (runId: string) => void | Promise<void>;
    /** Identifies collection target; not an acceptance receipt. */
    onRunIdentified?: (runId:string,identity?:{sessionId?:string})=>void | Promise<void>;
    onProgress?: (event: ProgressEvent) => void | Promise<void>;
    onWaitPaused?: (notice: SessionWaitPaused) => void | Promise<void>;
    /** Synchronous durable scheduling handoff; never a task settlement. */
    onYieldHandoff?: (runId:string)=>void;
    onCollectionStarted?: (runId:string)=>void;
  }): Promise<string> {
    const includeContext = params.includeContext !== false;
    const includeBridgeAttachmentHint = params.includeBridgeAttachmentHint !== false;
    const contextForAttachments = includeContext ? params.unsyncedMessages : [];
    const attachments = this.extractImageAttachments([
      ...contextForAttachments.map((m) => m.content),
      params.currentMessage,
    ]);
    const bridgeAttachmentHint = includeBridgeAttachmentHint ? this.bridgeAttachmentHint(params.currentMessage) : "";
    const unsyncedMessages = includeContext ? params.unsyncedMessages : [];
    if (unsyncedMessages.length === 0) {
      // No context to catch up, send directly
      return this.chatSend({
        sessionKey: params.sessionKey,
        message: params.currentMessage + bridgeAttachmentHint,
        attachments,
        deliver: params.deliver,
        timeoutMs: params.timeoutMs,
        emptyFinalAsNoReply: params.emptyFinalAsNoReply,
        followupAdmissionGuard: params.followupAdmissionGuard,
        expectedSessionId: params.expectedSessionId,
        admissionGuard: params.admissionGuard,
        onSendAttempt: params.onSendAttempt,
        onSubmitted: params.onSubmitted,
        onRunIdentified: params.onRunIdentified,
        onProgress: params.onProgress,
        onWaitPaused: params.onWaitPaused,
        onYieldHandoff: params.onYieldHandoff,
        onCollectionStarted: params.onCollectionStarted,
      });
    }

    // Build context block + actual message in one chat.send, or write the
    // full context to a local transcript file when it is too large.
    const contextLines = this.formatContextLines(unsyncedMessages);
    const inlineContext = contextLines.join("\n");
    const inlineBytes = Buffer.byteLength(inlineContext, "utf8");
    const useFileContext = unsyncedMessages.length > MAX_INLINE_CONTEXT_MESSAGES || inlineBytes > MAX_INLINE_CONTEXT_BYTES;

    let combined: string;
    if (useFileContext) {
      const filePath = this.writeContextSyncFile(params.sessionKey, unsyncedMessages, contextLines);
      combined =
        `[当前消息]\n` +
        `[${params.currentSenderName}]: ${params.currentMessage}\n\n` +
        `[以下是此前未同步的长历史对话上下文，因消息数或大小超过直接内联阈值，已写入本地文件，仅作参考]\n` +
        `文件路径：${filePath}\n\n` +
        `如需参考历史，请使用 read 工具读取这个文件；如果无法读取文件，请明确说明。\n` +
        `回答时必须优先处理上面的当前消息。`;
    } else {
      combined =
        `[当前消息]\n` +
        `[${params.currentSenderName}]: ${params.currentMessage}\n\n` +
        `[以下是群里其他成员刚发、你还没看到的发言，仅作参考]\n` +
        inlineContext;
    }

    return this.chatSend({
      sessionKey: params.sessionKey,
      message: combined + bridgeAttachmentHint,
      attachments,
      deliver: params.deliver,
      timeoutMs: params.timeoutMs,
      emptyFinalAsNoReply: params.emptyFinalAsNoReply,
      followupAdmissionGuard: params.followupAdmissionGuard,
      expectedSessionId: params.expectedSessionId,
      admissionGuard: params.admissionGuard,
      onSendAttempt: params.onSendAttempt,
      onSubmitted: params.onSubmitted,
      onRunIdentified: params.onRunIdentified,
      onProgress: params.onProgress,
      onWaitPaused: params.onWaitPaused,
      onYieldHandoff: params.onYieldHandoff,
      onCollectionStarted: params.onCollectionStarted,
    });
  }

  private formatContextLines(messages: ChatMessage[]): string[] {
    return messages.map((m) => {
      const time = new Date(m.timestamp).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const tag = m.senderType === "bot" ? `${m.senderName} (AI)` : m.senderName;
      return `[${tag} ${time}]: ${m.content}`;
    });
  }

  private writeContextSyncFile(sessionKey: string, messages: ChatMessage[], contextLines: string[]): string {
    const safeSessionKey = sessionKey.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    const dir = join(CONTEXT_SYNC_DIR, safeSessionKey);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`);
    const first = messages[0];
    const last = messages[messages.length - 1];
    const markdown = [
      `# LMA 群聊历史上下文同步`,
      ``,
      `- Session: ${sessionKey}`,
      `- Messages: ${messages.length}`,
      `- Range: ${first?.id ?? "?"} → ${last?.id ?? "?"}`,
      `- Generated: ${new Date().toISOString()}`,
      ``,
      `## Messages`,
      ``,
      contextLines.join("\n\n"),
      ``,
    ].join("\n");
    writeFileSync(filePath, markdown, "utf8");
    return filePath;
  }

  private extractImageAttachments(contents: string[]): ChatAttachment[] {
    const attachments: ChatAttachment[] = [];
    const seen = new Set<string>();
    const imagePattern = /\[Image: ([^\]\n]+)\]/g;
    const docPattern = /\[FeishuDoc: [^\]\n]*? -> ([^\]\n]+\.md)\]/g;
    for (const content of contents) {
      for (const match of content.matchAll(imagePattern)) {
        const imagePath = match[1]?.trim();
        if (!imagePath || imagePath.startsWith("download failed") || seen.has(imagePath)) continue;
        seen.add(imagePath);
        try {
          const ext = extname(imagePath).toLowerCase();
          const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
          attachments.push({
            type: "image",
            mimeType,
            fileName: basename(imagePath),
            content: readFileSync(imagePath).toString("base64"),
          });
        } catch (err) {
          console.warn(`[OpenClaw] failed to attach image ${imagePath}:`, (err as Error).message);
        }
      }
      for (const match of content.matchAll(docPattern)) {
        const docPath = match[1]?.trim();
        if (!docPath || seen.has(docPath)) continue;
        seen.add(docPath);
        try {
          const resolvedDocPath = resolve(docPath);
          const allowedRoot = resolve(FEISHU_DOCS_DIR);
          if (resolvedDocPath !== allowedRoot && !resolvedDocPath.startsWith(`${allowedRoot}${sep}`)) {
            throw new Error(`Feishu doc markdown path outside hydration dir: ${docPath}`);
          }
          const size = statSync(resolvedDocPath).size;
          let docContent = readFileSync(resolvedDocPath, "utf8");
          if (size > MAX_FEISHU_DOC_ATTACHMENT_BYTES) {
            const truncated = Buffer.from(docContent, "utf8").subarray(0, MAX_FEISHU_DOC_ATTACHMENT_BYTES).toString("utf8");
            docContent = `${truncated}\n\n---\n[文档过大，LMA 已截断到 ${MAX_FEISHU_DOC_ATTACHMENT_BYTES} bytes；如需完整内容，请让 LMA 扩大 OPENCLAW_LARK_MULTI_AGENT_MAX_FEISHU_DOC_ATTACHMENT_BYTES 或改用本地路径读取。]`;
          }
          attachments.push({
            type: "file",
            mimeType: "text/markdown",
            fileName: basename(resolvedDocPath),
            content: Buffer.from(docContent, "utf8").toString("base64"),
          });
        } catch (err) {
          console.warn(`[OpenClaw] failed to attach Feishu doc markdown ${docPath}:`, (err as Error).message);
        }
      }
    }
    return attachments;
  }

  async disconnect() {
    this.shouldReconnect = false;
    for(const key of [...this.sessionCollectorFences.keys()]) this.revokeSessionCollectors(key,'bridge disconnected; durable exact observation retained');
    if(this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer=undefined;
    for (const timer of this.suppressedSessionTimers.values()) clearTimeout(timer);
    this.suppressedSessionTimers.clear();
    this.suppressedSessions.clear();
    this.mutedProactiveSessions.clear();
    this.mutedProactiveSessionCounts.clear();
    for (const timer of this.ownedDeliveryRunTimers.values()) clearTimeout(timer);
    this.ownedDeliveryRunTimers.clear();
    for (const timer of this.verboseAssistantTimers.values()) clearTimeout(timer);
    this.verboseAssistantTimers.clear();
    this.verboseAssistantLatest.clear();
    this.verboseAssistantSent.clear();
    this.verboseAssistantLastTouched.clear();
    this.lastToolNamesByItemId.clear();
    this.privateInputToolCalls.clear();
    this.recentToolEventKeys.clear();
    this.pendingSteerTexts.clear();
    this.steerConsumedCallbacks.clear();
    this.ownedDeliveryRuns.clear();
    this.explicitlyStoppedRuns.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  // --- Session event subscription ---

  /**
   * Subscribe to message events for a session.
   * When the agent proactively produces a message, the callback fires.
   */
  async subscribeSession(
    sessionKey: string,
    onMessage: (text: string, meta?: ProactiveMessageMeta) => void,
    onSettled?: (meta:ProactiveMessageMeta)=>void|Promise<void>
  ): Promise<void> {
    // Register under both the short key and the full key with agent:main: prefix
    if(onSettled)this.sessionSettlementCallbacks.set(this.canonicalSessionKey(sessionKey),onSettled);
    this.sessionMessageCallbacks.set(sessionKey, onMessage);
    this.sessionMessageCallbacks.set(`agent:main:${sessionKey}`, onMessage);
    this.subscribedKeys.add(sessionKey);
    try {
      await this.rpc("sessions.messages.subscribe", { key: this.canonicalSessionKey(sessionKey) });
    } catch (err) {
      console.warn(`[OpenClaw] Failed to subscribe ${sessionKey}:`, (err as Error).message);
    }
  }

  setVerboseTranscriptDelivery(sessionKey: string, enabled: boolean): void {
    const keys = [sessionKey, `agent:main:${sessionKey}`];
    for (const key of keys) {
      if (enabled) this.verboseTranscriptSessions.add(key);
      else this.verboseTranscriptSessions.delete(key);
    }
    if (!enabled) this.clearVerboseAssistantState(sessionKey);
  }

  async unsubscribeSession(sessionKey: string): Promise<void> {
    this.sessionSettlementCallbacks.delete(this.canonicalSessionKey(sessionKey));
    this.sessionMessageCallbacks.delete(sessionKey);
    this.sessionMessageCallbacks.delete(`agent:main:${sessionKey}`);
    this.toolEventCallbacks.delete(sessionKey);
    this.toolEventCallbacks.delete(`agent:main:${sessionKey}`);
    this.setVerboseTranscriptDelivery(sessionKey, false);
    this.subscribedKeys.delete(sessionKey);
    try {
      await this.rpc("sessions.messages.unsubscribe", { key: this.canonicalSessionKey(sessionKey) });
    } catch {
      // ignore
    }
  }

  /**
   * Register a callback for tool call events on a session.
   */
  onToolEvent(
    sessionKey: string,
    callback: (toolName: string, toolInput: string, toolOutput: string) => void
  ): void {
    this.toolEventCallbacks.set(sessionKey, callback);
    this.toolEventCallbacks.set(`agent:main:${sessionKey}`, callback);
  }
}
