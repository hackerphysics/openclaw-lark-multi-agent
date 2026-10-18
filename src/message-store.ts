import { errorIdentity, type ErrorProvenance, type ErrorVerdict } from "./terminal-errors.js";
import Database from "better-sqlite3";
import { resolve } from "path";
import { mkdirSync } from "fs";

export type BotChatMode = "normal" | "free" | "mute";

export interface ChatInfo {
  chatId: string;
  chatType: "p2p" | "group";
  chatName: string;
  /** Comma-separated member open_ids */
  members: string;
  /** Comma-separated member names */
  memberNames: string;
  /** Which bot owns this chat (for p2p isolation) */
  ownerBot: string;
  /** Legacy chat-level free discussion flag; per-bot mode is authoritative. */
  freeDiscussion: boolean;
  verbose: boolean;
  discuss: boolean;
  discussMaxRounds: number;
  /** Group-level chairman bot name. Empty means no chairman. */
  chairmanBot?: string;
  locale?: string;
  updatedAt: number;
}

export interface ChatMessage {
  id?: number;
  chatId: string;
  messageId: string; // Feishu message_id for dedup
  senderType: "human" | "bot";
  senderName: string; // human name or bot name (e.g. "Claude", "GPT")
  content: string;
  timestamp: number; // unix ms
  triggerKind?: "normal" | "native_command" | "bridge_command" | "bridge_control_reply";
}

export interface DeliveryOutboxItem {
  id?: number;
  sessionKey: string;
  chatId: string;
  botName: string;
  sourceType: string;
  sourceId: string;
  deliveryKey: string;
  contentHash: string;
  content: string;
  attachmentsJson: string;
  replyToMessageId: string;
  /** Delivery mode. New final replies use `send`; `patch_live_status` is kept
   * for status-only cleanup and restart compatibility with legacy outbox rows. */
  deliveryMode?: "send" | "patch_live_status";
  /** Existing interactive-card message id to patch for patch_live_status. */
  targetMessageId?: string;
  /** Persisted JSON delivery metadata (for example final-reply model footer,
   * or legacy live-status cleanup metadata). */
  deliveryMetaJson?: string;
  /** Durable stage checkpoint: final text/card is already visible. */
  textDelivered?: boolean;
  /** Durable stage checkpoint: number of attachments already delivered. */
  attachmentCursor?: number;
  /** Final status-card cleanup (done summary after fallback/dedupe) is pending. */
  cleanupPending?: boolean;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** A resolved dispatcher promise is not a platform receipt. */
export type DeliveryDispatchOutcome = {
  state: "delivered" | "pending" | "unknown" | "failed" | "suppressed";
  outboxIds: number[];
};

export interface PendingErrorNotice {
  botName: string;
  chatId: string;
  noticeId: string;
  provenance: ErrorProvenance;
  checks: number;
  nextCheckAt: number;
  createdAt: number;
  status: "pending" | "parked" | "terminal" | "suppressed" | "stopped";
  verdict?: ErrorVerdict;
  hasObservedContinuingTask?: boolean;
  recoveryProbeUsed?: boolean;
}

export type GoJobRow = {
  id: number;
  botName: string;
  chatId: string;
  goal: string;
  acceptance: string;
  state: "STARTING" | "WAITING_WORK" | "CHECKING" | "FOLLOWUP_QUEUED" | "COMPLETING" | "COMPLETED" | "PAUSED" | "BLOCKED" | "STOPPED";
  executorSessionKey: string;
  executorSessionId: string;
  checkerSessionKey: string;
  checkerModel: string;
  revision: number;
  continueCount: number;
  waitStreak: number;
  stagnantCount: number;
  parseRetries: number;
  evidenceWatermark: number;
  lastMissingJson: string;
  lastVerdict: string;
  lastVerdictSummary: string;
  pauseReason: string;
  createdAt: number;
  updatedAt: number;
};

export class MessageStore {
  private db: Database.Database;
  private knownDeliveryReceipts=new Map<string,{outbox:number;key:string;record:any}>();

  constructor(dbPath?: string,options:{existingOnly?:boolean}={}) {
    const path = dbPath || resolve(process.cwd(), "data", "messages.db");
    const dir = resolve(path, "..");
    if(!options.existingOnly)mkdirSync(dir, { recursive: true });

    this.db = new Database(path,options.existingOnly ? {fileMustExist:true} : {});
    if(options.existingOnly)return;
    this.db.pragma("journal_mode = WAL");
    this.init();
    this.initGoTables();
    this.initReliabilityTables();
  }

  /** LMA-owned recovery journal. Never edits OpenClaw state. Unknown attempts
   * remain durable and are never selected by the ordinary pending drain. */
  private initReliabilityTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lma_database_identity (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL);
      INSERT OR IGNORE INTO lma_database_identity VALUES(1,'openclaw-lark-multi-agent:messages:v1');
      CREATE TABLE IF NOT EXISTS bridge_generations(bot_name TEXT NOT NULL,chat_id TEXT NOT NULL,stop_epoch INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_name,chat_id));
      CREATE TABLE IF NOT EXISTS reaction_custody(bot_name TEXT NOT NULL,chat_id TEXT NOT NULL,row_id INTEGER NOT NULL,record_json TEXT NOT NULL,
        PRIMARY KEY(bot_name,chat_id,row_id));
      CREATE TABLE IF NOT EXISTS run_delivery_targets(bot_name TEXT NOT NULL,chat_id TEXT NOT NULL,run_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(bot_name,chat_id,run_id));
      -- UI-only custody: never read by admission, dispatch or business replay.
      CREATE TABLE IF NOT EXISTS presentation_custody (
        bot_name TEXT NOT NULL,app_id TEXT NOT NULL,chat_id TEXT NOT NULL,cohort_id TEXT NOT NULL,
        record_json TEXT NOT NULL,PRIMARY KEY(bot_name,app_id,chat_id,cohort_id));
      CREATE TABLE IF NOT EXISTS dispatch_custody(bot_name TEXT NOT NULL,chat_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(bot_name,chat_id));
      CREATE TABLE IF NOT EXISTS admission_custody(session_key TEXT NOT NULL,submission_id TEXT PRIMARY KEY,state TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_observations (
        session_key TEXT NOT NULL, run_id TEXT NOT NULL, record_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'observing', next_check_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_key,run_id));
      CREATE TABLE IF NOT EXISTS insertion_custody (
        bot_name TEXT NOT NULL,chat_id TEXT NOT NULL,message_row_id INTEGER NOT NULL,
        insertion_id TEXT UNIQUE NOT NULL,record_json TEXT NOT NULL,state TEXT NOT NULL,
        next_check_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_name,chat_id,message_row_id));
      CREATE TABLE IF NOT EXISTS delivery_operations (
        outbox_id INTEGER NOT NULL,operation_key TEXT NOT NULL,state TEXT NOT NULL,
        record_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(outbox_id,operation_key));
      CREATE TABLE IF NOT EXISTS delivery_receipt_custody (
        outbox_id INTEGER NOT NULL,operation_key TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(outbox_id,operation_key));
      CREATE TABLE IF NOT EXISTS delivery_local_obligations (
        outbox_id INTEGER PRIMARY KEY,failures INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_context (
        outbox_id INTEGER NOT NULL,stage TEXT NOT NULL,message_row_id INTEGER,
        PRIMARY KEY(outbox_id,stage));
      CREATE TABLE IF NOT EXISTS platform_message_aliases (
        message_id TEXT PRIMARY KEY,message_row_id INTEGER NOT NULL);
      -- The preceding local candidate never dispatched these blocked inputs.
      -- Migrate ONLY its explicit no-attempt rows; unknown/attempted stay fenced.
      UPDATE insertion_custody SET state='pending',next_check_at=0
        WHERE state='capability_blocked' AND json_extract(record_json,'$.attempted')=0;
    `);
  }

  savePresentation(bot:string,app:string,chat:string,cohort:string,record:object):void {
    this.db.prepare(`INSERT OR REPLACE INTO presentation_custody VALUES(?,?,?,?,?)`).run(bot,app,chat,cohort,JSON.stringify(record));
  }
  getPresentation(bot:string,app:string,chat:string,cohort:string):any {
    const row=this.db.prepare(`SELECT record_json FROM presentation_custody WHERE bot_name=? AND app_id=? AND chat_id=? AND cohort_id=?`)
      .get(bot,app,chat,cohort) as any;
    return row ? JSON.parse(row.record_json) : null;
  }
  listPresentations(bot:string,app:string,chat:string):any[] {
    return (this.db.prepare(`SELECT record_json FROM presentation_custody WHERE bot_name=? AND app_id=? AND chat_id=?`)
      .all(bot,app,chat) as any[]).map(row=>JSON.parse(row.record_json));
  }

  getStopGeneration(bot:string,chat:string):number {
    return (this.db.prepare('SELECT stop_epoch FROM bridge_generations WHERE bot_name=? AND chat_id=?').get(bot,chat) as any)?.stop_epoch || 0;
  }
  bumpStopGeneration(bot:string,chat:string):number {
    this.db.prepare(`INSERT INTO bridge_generations VALUES(?,?,1) ON CONFLICT(bot_name,chat_id) DO UPDATE SET stop_epoch=stop_epoch+1`).run(bot,chat);
    return this.getStopGeneration(bot,chat);
  }
  setReactionIntent(bot:string,chat:string,row:number,record:object):void {
    this.db.prepare(`INSERT INTO reaction_custody VALUES(?,?,?,?) ON CONFLICT(bot_name,chat_id,row_id) DO UPDATE SET record_json=excluded.record_json`).run(bot,chat,row,JSON.stringify(record));
  }
  getReactionIntent(bot:string,chat:string,row:number):any {
    const r=this.db.prepare('SELECT record_json FROM reaction_custody WHERE bot_name=? AND chat_id=? AND row_id=?').get(bot,chat,row) as any;
    return r ? JSON.parse(r.record_json) : null;
  }
  listReactionIntents(bot:string,chat?:string):any[] {
    return (this.db.prepare(`SELECT chat_id,row_id,record_json FROM reaction_custody WHERE bot_name=? ${chat ? 'AND chat_id=?' : ''}
      AND (json_extract(record_json,'$.desired')!=json_extract(record_json,'$.shown') OR json_array_length(json_extract(record_json,'$.cleanupReceipts'))>0) LIMIT 200`).all(bot,...(chat ? [chat] : [])) as any[])
      .map(r=>({...JSON.parse(r.record_json),chatId:r.chat_id,rowId:r.row_id})).filter(r=>r.desired!==r.shown || r.cleanupReceipts?.length);
  }
  bindDeliveryRun(bot:string,chat:string,runId:string,record:object):void {
    this.db.prepare('INSERT OR REPLACE INTO run_delivery_targets VALUES(?,?,?,?)').run(bot,chat,runId,JSON.stringify(record));
  }
  getDeliveryRunTarget(bot:string,chat:string,runId:string):any {
    const row=this.db.prepare('SELECT record_json FROM run_delivery_targets WHERE bot_name=? AND chat_id=? AND run_id=?').get(bot,chat,runId) as any;
    return row ? JSON.parse(row.record_json) : null;
  }
  /** Scheduling custody is independent of exact-run result custody. */
  saveDispatchCustody(bot:string,chat:string,record:object):void {
    this.db.prepare('INSERT OR REPLACE INTO dispatch_custody VALUES(?,?,?)').run(bot,chat,JSON.stringify(record));
  }
  getDispatchCustody(bot:string,chat:string):any {
    const row=this.db.prepare('SELECT record_json FROM dispatch_custody WHERE bot_name=? AND chat_id=?').get(bot,chat) as any;
    const item=row ? JSON.parse(row.record_json) : null;
    return item?.stopEpoch===this.getStopGeneration(bot,chat) ? item : null;
  }
  clearDispatchCustody(bot:string,chat:string,ownerId:string,batchId:string):boolean {
    return this.db.prepare(`DELETE FROM dispatch_custody WHERE bot_name=? AND chat_id=?
      AND json_extract(record_json,'$.id')=? AND json_extract(record_json,'$.batchId')=?`).run(bot,chat,ownerId,batchId).changes===1;
  }
  /** A Gateway-accepted guarded ordinary batch becomes ordinary/synced in one
   * transaction. Until then its unknown input custody remains non-replayable. */
  acceptGuardedFollowup(bot: string, chat: string, rows: number[], submissionId: string, runId: string, syncBatchId: string): void {
    if (!submissionId || !runId || rows.length === 0) throw new Error('Missing guarded followup acceptance identity');
    this.db.transaction(() => {
      for (const id of rows) {
        const item = this.getInsertion(bot, chat, id);
        if (!item || item.admissionSubmissionId !== submissionId || item.attempted !== true ||
          !['unknown', 'ordinary'].includes(item.state) || item.stopEpoch !== this.getStopGeneration(bot, chat)) {
          throw new Error('Guarded followup acceptance custody changed');
        }
        this.saveInsertion(bot, chat, id, item.insertionId, 'ordinary', {...item, attempted: true, admittedRunId: runId});
      }
      this.markMessagesSynced(bot, chat, rows, syncBatchId);
      for (const id of rows) this.clearPendingTrigger(bot, chat, id);
    })();
  }

  /** Atomic release of proven never-attempted reservations only. Unknown and
   * accepted inputs retain their exact target and never enter ordinary drain. */
  releaseDispatchCustody(bot:string,chat:string,ownerId:string,batchId:string,followup?:{sessionKey:string;sessionId:string;expectedLeafEntryId:string}):boolean {
    return this.db.transaction(()=>{
      const custody=this.getDispatchCustody(bot,chat);
      if(!custody || !this.clearDispatchCustody(bot,chat,ownerId,batchId))return false;
      this.db.prepare(`UPDATE run_delivery_targets SET record_json=json_set(record_json,'$.dispatchReleased',json('true'),
        '$.dispatchOwnerId',?,'$.dispatchBatchId',?,'$.sessionId',?) WHERE bot_name=? AND chat_id=? AND run_id=?`)
        .run(ownerId,batchId,custody.sessionId,bot,chat,custody.runId);
      this.db.prepare(`UPDATE insertion_custody SET state='ordinary',next_check_at=0,
        record_json=json_set(record_json,'$.reason','current session confirmed schedulable; no backend attempt'
          ${followup ? ", '$.followupAdmissionGuard',json(COALESCE(json_extract(record_json,'$.followupAdmissionGuard'),?))" : ''})
        WHERE bot_name=? AND chat_id=? AND state='pending'
        AND COALESCE(json_extract(record_json,'$.attempted'),0)=0
        AND json_extract(record_json,'$.ownerId')=? AND json_extract(record_json,'$.batchId')=?
        AND json_extract(record_json,'$.stopEpoch')=?
        ${followup ? `AND json_extract(record_json,'$.sessionId')=?
          AND COALESCE(json_extract(record_json,'$.ordinaryEligible'),1)!=0
          AND json_extract(record_json,'$.sessionKey') IN (?,?)
          AND message_row_id IN (SELECT id FROM messages WHERE sender_type='human' AND trigger_kind='normal')` : ''}`)
        .run(...(followup?[JSON.stringify(followup)]:[]),bot,chat,ownerId,batchId,this.getStopGeneration(bot,chat),...(followup?[followup.sessionId,followup.sessionKey,followup.sessionKey.replace(/^agent:[^:]+:/,'')]:[]));
      return true;
    })();
  }
  /** Reserved is persisted before the send-attempt callback; dispatching is
   * persisted before the RPC. Only reserved + unchanged stop generation proves
   * no business effect and may be restored on startup. Unknown never replays. */
  recoverUnsentReservations(bot:string):number {
    return this.db.transaction(()=>{
      let restored=0;
      const rows=this.db.prepare(`SELECT a.submission_id,t.chat_id,t.record_json FROM admission_custody a
        JOIN run_delivery_targets t ON t.run_id=a.submission_id WHERE t.bot_name=? AND a.state='reserved' LIMIT 100`).all(bot) as any[];
      for(const row of rows) {
        const r=JSON.parse(row.record_json);
        if(r.stopGeneration!==this.getStopGeneration(bot,row.chat_id)) continue;
        for(const id of r.triggerIds || []) {this.markPendingTrigger(bot,row.chat_id,id);restored++;}
        this.db.prepare("UPDATE admission_custody SET state='restored-unsubmitted' WHERE submission_id=? AND state='reserved'").run(row.submission_id);
      }
      return restored;
    })();
  }
  saveAdmission(sessionKey:string,submissionId:string,state:string,record:object):void {
    this.db.prepare(`INSERT INTO admission_custody VALUES(?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET state=excluded.state,record_json=excluded.record_json`).run(sessionKey,submissionId,state,JSON.stringify(record));
  }
  listAdmissions(sessionKey:string):any[] {
    return (this.db.prepare('SELECT * FROM admission_custody WHERE session_key=? ORDER BY rowid DESC LIMIT 100').all(sessionKey) as any[]).map(r=>({...JSON.parse(r.record_json),submissionId:r.submission_id,state:r.state}));
  }
  stopExactRun(sessionKey:string,runId:string):void {
    this.db.prepare(`INSERT INTO run_observations VALUES(?,?,'{}','stopped',0)
      ON CONFLICT(session_key,run_id) DO UPDATE SET state='stopped'`).run(sessionKey,runId);
  }
  isStoppedObservation(sessionKey:string,runId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM run_observations WHERE session_key=? AND run_id=? AND state='stopped'").get(sessionKey,runId);
  }
  hasUnconfirmedRunDelivery(bot:string,chat:string,runId:string):boolean {
    const rows=this.db.prepare(`SELECT delivery_key,source_type FROM delivery_outbox WHERE bot_name=? AND chat_id=?
      AND json_extract(delivery_meta_json,'$.provenance.runId')=?`).all(bot,chat,runId) as any[];
    const finals=rows.filter(row=>row.source_type.startsWith('assistant_visible'));
    return (finals.length ? finals : rows).some(row=>this.getDeliveryDispatchOutcome(bot,chat,row.delivery_key).state!=='delivered');
  }
  /** UI-only witness of an exact run's visible reply in the original Bot/chat.
   * Does not prove any legacy inserted input was committed or consumed. */
  getDeliveredRunReply(bot: string, app: string, chat: string, runId: string, epoch: number):
    {outboxId: number; runId: string; createdAt: number; deliveredAt: number; platformMessageIds: string[]; sessionId?: string} | undefined {
    if (!runId || this.hasUnconfirmedRunDelivery(bot, chat, runId)) return;
    const rows = this.db.prepare(`SELECT id,delivery_key,created_at,updated_at,delivery_meta_json FROM delivery_outbox
      WHERE bot_name=? AND chat_id=? AND status='delivered' AND source_type IN ('assistant_visible','discussion')
      AND json_extract(delivery_meta_json,'$.provenance.runId')=?
      AND json_extract(delivery_meta_json,'$.provenance.final')=1
      AND json_extract(delivery_meta_json,'$.botIdentity')=?
      AND json_extract(delivery_meta_json,'$.deliveryStopEpoch')=? ORDER BY id DESC LIMIT 20`)
      .all(bot, chat, runId, app, epoch) as any[];
    for (const row of rows) {
      if (this.getDeliveryDispatchOutcome(bot, chat, row.delivery_key).state !== 'delivered') continue;
      const receipts = this.listDeliveryReceipts(row.id);
      const ids = [...new Set(receipts.map(receipt => receipt.messageId).filter(Boolean))];
      if (!ids.length || !Number.isFinite(row.created_at) || !Number.isFinite(row.updated_at)) continue;
      const meta = JSON.parse(row.delivery_meta_json || '{}');
      return {outboxId: row.id, runId, createdAt: row.created_at, deliveredAt: row.updated_at, platformMessageIds: ids,
        sessionId: meta.provenance?.sessionId};
    }
  }

  settleRunReactionIntents(bot:string,chat:string,runId:string):void {
    if(this.hasUnconfirmedRunDelivery(bot,chat,runId)) return;
    // A root outcome/visible reply proves nothing about a legacy SDK queue
    // item's commitment or consumption. Only ordinary inputs belong to this
    // bulk completion cohort; even historical committed rows are not repaired
    // or reinterpreted here. No exact host input identity is available for them.
    this.db.prepare(`UPDATE reaction_custody SET record_json=json_set(record_json,'$.desired','DONE')
      WHERE bot_name=? AND chat_id=? AND json_extract(record_json,'$.runId')=?
      AND json_extract(record_json,'$.desired') IN ('Get','Typing')
      AND json_extract(record_json,'$.stopEpoch')=?
      AND NOT EXISTS (SELECT 1 FROM insertion_custody i WHERE i.bot_name=reaction_custody.bot_name
        AND i.chat_id=reaction_custody.chat_id AND i.message_row_id=reaction_custody.row_id AND i.state!='ordinary')`)
      .run(bot,chat,runId,this.getStopGeneration(bot,chat));
  }
  cancelReactionIntents(bot:string,chat:string,epoch:number):void {
    this.db.prepare(`UPDATE reaction_custody SET record_json=json_set(record_json,'$.desired','','$.stopEpoch',?)
      WHERE bot_name=? AND chat_id=? AND json_extract(record_json,'$.desired') IN ('Typing','Get')`).run(epoch,bot,chat);
  }
  saveRunObservation(sessionKey: string, runId: string, record: object, nextCheckAt = Date.now()): void {
    this.db.prepare(`INSERT INTO run_observations VALUES(?,?,?,'observing',?)
      ON CONFLICT(session_key,run_id) DO UPDATE SET record_json=json_patch(run_observations.record_json,excluded.record_json),next_check_at=excluded.next_check_at
      WHERE run_observations.state='observing'`).run(sessionKey,runId,JSON.stringify(record),nextCheckAt);
  }
  hasYieldedObservation(sessionKey:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM run_observations WHERE session_key=? AND json_extract(record_json,'$.yielded')=1 LIMIT 1`).get(sessionKey);
  }
  getRunObservation(sessionKey:string,runId:string):any {
    const row=this.db.prepare('SELECT record_json,state FROM run_observations WHERE session_key=? AND run_id=?').get(sessionKey,runId) as any;
    return row ? {...JSON.parse(row.record_json),state:row.state} : null;
  }
  runObservationState(sessionKey:string,runId:string):string|undefined {
    return (this.db.prepare('SELECT state FROM run_observations WHERE session_key=? AND run_id=?').get(sessionKey,runId) as any)?.state;
  }
  stopSessionObservations(sessionKey:string):void {
    this.db.prepare("UPDATE run_observations SET state='stopped' WHERE session_key=? AND state IN ('observing','outbox_owned')").run(sessionKey);
  }
  settleExactRunReactions(sessionKey:string,runId:string):void {
    const targets=this.db.prepare('SELECT bot_name,chat_id FROM run_delivery_targets WHERE run_id=?').all(runId) as any[];
    for(const target of targets) {
      // run ids can repeat across gateways/sessions: require the exact durable target.
      const row=this.getDeliveryRunTarget(target.bot_name,target.chat_id,runId);
      const observed=this.db.prepare("SELECT 1 FROM run_observations WHERE session_key=? AND run_id=? AND state='observing'").get(sessionKey,runId);
      if(observed && (row?.sessionKey || `agent:main:lma-${target.bot_name.toLowerCase()}-${target.chat_id}`)===sessionKey) this.settleRunReactionIntents(target.bot_name,target.chat_id,runId);
    }
  }
  finishRunObservation(sessionKey: string,runId: string,state = 'settled'): void {
    this.db.prepare("UPDATE run_observations SET state=? WHERE session_key=? AND run_id=? AND state='observing'").run(state,sessionKey,runId);
  }
  listRunObservations(sessionKey?: string, due = Date.now(), limit = 50): any[] {
    return (this.db.prepare(`SELECT * FROM run_observations WHERE state='observing' AND next_check_at<=?
      ${sessionKey ? 'AND session_key=?' : ''} ORDER BY next_check_at LIMIT ?`).all(due,...(sessionKey ? [sessionKey] : []),limit) as any[])
      .map(r=>({...JSON.parse(r.record_json),sessionKey:r.session_key,runId:r.run_id}));
  }
  saveInsertion(bot: string,chat: string,row: number,id: string,state: string,record: object,next = Date.now()): void {
    this.db.prepare(`INSERT INTO insertion_custody VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(bot_name,chat_id,message_row_id) DO UPDATE SET state=excluded.state,record_json=excluded.record_json,next_check_at=excluded.next_check_at
      WHERE insertion_custody.state NOT IN ('stopped','committed')`).run(bot,chat,row,id,JSON.stringify(record),state,next);
  }
  /** Purge still-pending insertion status notices once the insertion resolves
   *  (accepted/ordinary): a stale "unknown" notice must not fire after Get. */
  deletePendingInsertionNotices(bot: string, chat: string, insertionId: string): number {
    const r = this.db.prepare(`DELETE FROM delivery_outbox WHERE bot_name=? AND chat_id=? AND delivery_key LIKE ? AND status='pending'`)
      .run(bot, chat, `insertion:${insertionId}:%`);
    return r.changes;
  }
  /** Reminder intent and its outbox row commit together. Never write a stale
   * reconciliation snapshot over a later accepted/stopped insertion. */
  queueInsertionUnknownNotice(bot:string,chat:string,row:number,delivery:Omit<DeliveryOutboxItem,'id'|'status'|'attempts'|'createdAt'|'updatedAt'>):boolean {
    return this.db.transaction(()=>{
      const current=this.getInsertion(bot,chat,row);
      if(current?.state!=='unknown' || current.stopEpoch!==this.getStopGeneration(bot,chat) || current.unknownNotified ||
        !Number.isFinite(current.unknownSince) || Date.now()-current.unknownSince<45_000)return false;
      this.enqueueDelivery(delivery);
      this.saveInsertion(bot,chat,row,current.insertionId,'unknown',{...current,unknownNotified:true},Date.now()+15_000);
      return true;
    })();
  }
  claimInsertionAttempt(bot:string,chat:string,row:number):boolean {
    return this.db.prepare(`UPDATE insertion_custody SET state='dispatching',record_json=json_set(record_json,'$.attempted',json('true'))
      WHERE bot_name=? AND chat_id=? AND message_row_id=? AND state='pending'`).run(bot,chat,row).changes===1;
  }
  getInsertion(bot: string,chat: string,row: number): any {
    const r=this.db.prepare('SELECT * FROM insertion_custody WHERE bot_name=? AND chat_id=? AND message_row_id=?').get(bot,chat,row) as any;
    return r ? {...JSON.parse(r.record_json),state:r.state,insertionId:r.insertion_id,rowId:r.message_row_id} : null;
  }
  listInsertions(bot: string,chat?: string): any[] {
    return (this.db.prepare(`SELECT * FROM insertion_custody WHERE bot_name=? ${chat ? 'AND chat_id=?' : ''}
      AND state IN ('pending','accepted','unknown','dispatching') ORDER BY next_check_at LIMIT 100`).all(bot,...(chat ? [chat] : [])) as any[])
      .map(r=>({...JSON.parse(r.record_json),state:r.state,insertionId:r.insertion_id,rowId:r.message_row_id,chatId:r.chat_id,nextCheckAt:r.next_check_at}));
  }
  /** Legacy queue identities are not canonical host input receipts. Until a
   * genuine host proof is supported, only an explicitly ordinary input may
   * participate in ordinary completion/sync; never guess from text or root ID. */
  isOrdinaryInput(bot:string,chat:string,row:number):boolean {
    return !this.db.prepare(`SELECT 1 FROM insertion_custody WHERE bot_name=? AND chat_id=?
      AND message_row_id=? AND state!='ordinary'`).get(bot,chat,row);
  }
  isInsertionReserved(bot: string,chat: string,row: number): boolean {
    const item=this.getInsertion(bot,chat,row);
    return !!item && !['ordinary','stopped'].includes(item.state);
  }
  stopInsertionAtEpoch(bot:string,chat:string,row:number,epoch:number):void {
    this.db.prepare(`UPDATE insertion_custody SET state='stopped' WHERE bot_name=? AND chat_id=? AND message_row_id=?
      AND json_extract(record_json,'$.stopEpoch')=? AND (state NOT IN ('committed','ordinary') OR state='ordinary' AND json_type(record_json,'$.followupAdmissionGuard')='object')`).run(bot,chat,row,epoch);
  }
  stopInsertions(bot: string,chat: string): void {
    this.db.prepare("UPDATE insertion_custody SET state='stopped' WHERE bot_name=? AND chat_id=? AND (state NOT IN ('committed','ordinary') OR state='ordinary' AND json_type(record_json,'$.followupAdmissionGuard')='object')").run(bot,chat);
  }
  hasUnknownDeliveryOperation(outbox:number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM delivery_operations o WHERE outbox_id=? AND state IN ('attempted','unknown')
      AND NOT EXISTS(SELECT 1 FROM delivery_receipt_custody k WHERE k.outbox_id=o.outbox_id AND k.operation_key=o.operation_key) LIMIT 1`).get(outbox);
  }
  /** Includes non-visible uploads/doc creation: absence of a message_id is
   * not proof that no SDK effect has been attempted or accepted. */
  getDeliveryEffectState(outbox:number):'not_attempted'|'unknown'|'accepted'|'rejected' {
    if(this.hasUnknownDeliveryOperation(outbox)) return 'unknown';
    if([...this.knownDeliveryReceipts.values()].some(item=>item.outbox===outbox) ||
      this.db.prepare(`SELECT 1 FROM delivery_operations WHERE outbox_id=? AND state='accepted'
        UNION ALL SELECT 1 FROM delivery_receipt_custody WHERE outbox_id=? LIMIT 1`).get(outbox,outbox)) return 'accepted';
    return this.db.prepare('SELECT 1 FROM delivery_operations WHERE outbox_id=? LIMIT 1').get(outbox) ? 'rejected' : 'not_attempted';
  }
  /** Retain the full known result BEFORE the fallible main-journal checkpoint.
   * The memory copy survives local SQLite failures while this process is alive;
   * the independent insert journal also survives an interrupted UPDATE/reopen. */
  rememberKnownDeliveryReceipt(outbox:number,key:string,record:any):void {
    this.knownDeliveryReceipts.set(`${outbox}:${key}`,{outbox,key,record});
    this.flushKnownDeliveryReceipts(outbox);
  }
  flushKnownDeliveryReceipts(outbox:number):void {
    for(const [identity,item] of this.knownDeliveryReceipts)if(item.outbox===outbox){
      this.db.prepare('INSERT OR REPLACE INTO delivery_receipt_custody VALUES(?,?,?)').run(outbox,item.key,JSON.stringify(item.record));
      this.knownDeliveryReceipts.delete(identity);
    }
  }
  listDeliveryReceipts(outbox:number): Array<{messageId:string;operation:string;payload:any;stage:string}> {
    const records=new Map<string,any>();
    for(const r of this.db.prepare(`SELECT operation_key,record_json FROM delivery_operations WHERE outbox_id=? AND state='accepted'
      UNION ALL SELECT operation_key,record_json FROM delivery_receipt_custody WHERE outbox_id=?`).all(outbox,outbox) as any[]) records.set(r.operation_key,JSON.parse(r.record_json));
    for(const item of this.knownDeliveryReceipts.values())if(item.outbox===outbox)records.set(item.key,item.record);
    return [...records].map(([key,r])=>({...r,stage:key.split(':').slice(2,-1).join(':')}))
      .filter(r=>r.result?.data?.message_id || r.result?.message_id)
      .map(r=>({messageId:r.result?.data?.message_id || r.result?.message_id,operation:r.operation,payload:r.payload,stage:r.stage}));
  }
  getDeliveryOperation(outbox: number,key: string): any {
    const known=this.knownDeliveryReceipts.get(`${outbox}:${key}`)?.record;
    const receipt=this.db.prepare('SELECT record_json FROM delivery_receipt_custody WHERE outbox_id=? AND operation_key=?').get(outbox,key) as any;
    if(known || receipt)return {state:'accepted',...(known || JSON.parse(receipt.record_json))};
    const r=this.db.prepare('SELECT * FROM delivery_operations WHERE outbox_id=? AND operation_key=?').get(outbox,key) as any;
    return r ? {state:r.state,...JSON.parse(r.record_json)} : null;
  }
  deferLocalDelivery(id:number,reason:string):number {
    return this.db.transaction(()=>{
      this.db.prepare(`INSERT INTO delivery_local_obligations VALUES(?,1,?,?) ON CONFLICT(outbox_id)
        DO UPDATE SET failures=failures+1,reason=excluded.reason,updated_at=excluded.updated_at`).run(id,reason,Date.now());
      // Local persistence and unknown audit custody consume no platform retry budget.
      this.db.prepare(`UPDATE delivery_outbox SET status='pending',
        attempts=CASE WHEN status='delivering' THEN MAX(0,attempts-1) ELSE attempts END,updated_at=?
        WHERE id=? AND status IN ('delivering','delivered')`).run(Date.now(),id);
      return (this.db.prepare('SELECT failures FROM delivery_local_obligations WHERE outbox_id=?').get(id) as any).failures;
    })();
  }
  saveDeliveryOperation(outbox: number,key: string,state: string,record: object = {}): void {
    this.db.prepare(`INSERT INTO delivery_operations VALUES(?,?,?,?) ON CONFLICT(outbox_id,operation_key)
      DO UPDATE SET state=excluded.state,record_json=excluded.record_json`).run(outbox,key,state,JSON.stringify(record));
  }
  /** Context registration and the corresponding payload checkpoint are one
   * SQLite transaction. Receipt aliases deduplicate platform echoes by identity,
   * not by text (two identical legitimate tasks must remain two tasks). */
  confirmDeliveryStage(id: number,stage: string,content: string,receipts: Array<{messageId:string}>,checkpoint: 'text' | 'none' | number): void {
    this.db.transaction(()=>{
      const item=this.db.prepare('SELECT * FROM delivery_outbox WHERE id=?').get(id) as any;
      if(!item) throw new Error('Missing outbox identity');
      if(!this.db.prepare('SELECT 1 FROM delivery_context WHERE outbox_id=? AND stage=?').get(id,stage)) {
        const worthy=['assistant_visible','discussion','proactive'].some(k=>item.source_type.startsWith(k));
        let row: number | null=null;
        if(worthy && content.trim() && content.trim().toUpperCase()!=='NO_REPLY') {
          const existing=receipts.map(r=>this.getMessageId(r.messageId)).find(Boolean);
          if(existing) {
            const source=this.db.prepare('SELECT chat_id,sender_type,sender_name FROM messages WHERE id=?').get(existing) as any;
            if(source?.chat_id!==item.chat_id || source?.sender_type!=='bot' || source?.sender_name!==item.bot_name) throw new Error('Platform receipt identity conflicts with existing message origin');
          }
          const identity=JSON.parse(item.delivery_meta_json || '{}').botIdentity || item.bot_name;
          const messageId=`lma:${JSON.stringify([identity,item.bot_name,item.chat_id,item.delivery_key,stage])}`;
          row=existing ?? this.insert({chatId:item.chat_id,messageId,
            senderType:'bot',senderName:item.bot_name,content,timestamp:Date.now()});
          if(row===-1) row=this.getMessageId(messageId);
          for(const receipt of receipts) if(row) this.db.prepare('INSERT OR IGNORE INTO platform_message_aliases VALUES(?,?)').run(receipt.messageId,row);
        }
        this.db.prepare('INSERT INTO delivery_context VALUES(?,?,?)').run(id,stage,row);
      }
      if(checkpoint==='text') this.markDeliveryTextDelivered(id);
      else if(typeof checkpoint==='number') this.markDeliveryAttachmentCursor(id,checkpoint);
    })();
  }
  registerPartialBodyContext(id:number,onlyIfAlreadyPartial=false):void {
    const hasPartial=!!this.db.prepare("SELECT 1 FROM delivery_context WHERE outbox_id=? AND stage LIKE 'body:partial:%' LIMIT 1").get(id);
    if(onlyIfAlreadyPartial && !hasPartial)return;
    for(const receipt of this.listDeliveryReceipts(id).filter(r=>r.stage==='body' && r.payload?.msg_type==='text')) {
      let text='';try{text=JSON.parse(receipt.payload.content).text || '';}catch{continue;}
      this.confirmDeliveryStage(id,`body:partial:${receipt.messageId}`,text,[receipt],'none');
    }
  }
  registerPartialAttachmentContext(id:number):void {
    for(const receipt of this.listDeliveryReceipts(id).filter(r=>/^attachment:\d+$/.test(r.stage))) {
      // Only confirmed, visible file/image payload. A document upload is not a message.
      if(!['file','image'].includes(receipt.payload?.msg_type))continue;
      let payload:any;try{payload=JSON.parse(receipt.payload.content);}catch{continue;}
      this.confirmDeliveryStage(id,`${receipt.stage}:partial:${receipt.messageId}`,
        `[Attachment: ${receipt.payload.msg_type}] ${JSON.stringify(payload)}`,[receipt],'none');
    }
  }
  /** Read-only preview. Historical text_delivered alone is not a receipt.
   * Explicit repair requires supplied exact outbox+platform IDs, never resends. */
  previewMissingDeliveryContext(bot: string,limit = 100): any[] {
    return this.db.prepare(`SELECT d.id,d.chat_id,d.delivery_key,d.source_type,d.text_delivered,d.attachment_cursor
      FROM delivery_outbox d WHERE bot_name=? AND (status='delivered' AND NOT EXISTS(SELECT 1 FROM delivery_context c WHERE c.outbox_id=d.id)
        OR EXISTS(SELECT 1 FROM delivery_operations o WHERE o.outbox_id=d.id AND o.state IN ('attempted','unknown'))) ORDER BY d.id LIMIT ?`).all(bot,limit);
  }
  registerHistoricalDeliveryContext(id: number,bot: string,chat: string,messageIds: string[]): void {
    const item=this.db.prepare("SELECT * FROM delivery_outbox WHERE id=? AND bot_name=? AND chat_id=?").get(id,bot,chat) as any;
    if(!item || !messageIds.length || messageIds.some(x=>!x) || new Set(messageIds).size!==messageIds.length) throw new Error('Exact outbox and independently verified platform receipts required');
    if(item.status==='delivered') {
      this.confirmDeliveryStage(id,'body',item.content,messageIds.map(messageId=>({messageId})),'text');return;
    }
    // Explicit operator reconciliation, never an automatic rejection or resend.
    // Match every supplied message to exactly one unresolved visible operation.
    const unknown=(this.db.prepare("SELECT * FROM delivery_operations WHERE outbox_id=? AND state IN ('attempted','unknown') ORDER BY operation_key").all(id) as any[])
      .map(r=>({...r,record:JSON.parse(r.record_json)}));
    const legacyBody=(r:any)=>r.record.visible===undefined && r.operation_key.split(':').slice(2,-1).join(':')==='body';
    if(unknown.length!==messageIds.length || unknown.some(r=>(!r.record.visible || !r.record.payload) && !legacyBody(r) || this.getDeliveryOperation(id,r.operation_key)?.state==='accepted')) throw new Error('Exact visible unknown operations and independent receipts required');
    this.db.transaction(()=>{
      unknown.forEach((r,i)=>{
        const record={...r.record,visible:true,result:{code:0,data:{message_id:messageIds[i],chat_id:chat}},reconciliation:{independentlyVerified:true,at:Date.now(),bot,chat}};
        this.rememberKnownDeliveryReceipt(id,r.operation_key,record);
        this.saveDeliveryOperation(id,r.operation_key,'accepted',record);
      });
      this.registerPartialBodyContext(id);
      this.registerPartialAttachmentContext(id);
      if(unknown.every(r=>r.operation_key.split(':').slice(2,-1).join(':')==='body'))this.confirmDeliveryStage(id,'body',item.content,messageIds.map(messageId=>({messageId})),'text');
      this.db.prepare("UPDATE delivery_outbox SET status='pending' WHERE id=?").run(id);
    })();
  }

  /** Go / Go-Checker supervision state (design: artifacts/lma-go-checker-design-20260917 §10). */
  private initGoTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS go_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'WAITING_WORK',
        executor_session_key TEXT NOT NULL,
        executor_session_id TEXT NOT NULL DEFAULT '',
        checker_session_key TEXT NOT NULL,
        checker_model TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        continue_count INTEGER NOT NULL DEFAULT 0,
        wait_streak INTEGER NOT NULL DEFAULT 0,
        stagnant_count INTEGER NOT NULL DEFAULT 0,
        parse_retries INTEGER NOT NULL DEFAULT 0,
        evidence_watermark INTEGER NOT NULL DEFAULT 0,
        last_missing_json TEXT NOT NULL DEFAULT '[]',
        last_verdict TEXT NOT NULL DEFAULT '',
        last_verdict_summary TEXT NOT NULL DEFAULT '',
        pause_reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_go_jobs_active ON go_jobs(bot_name, chat_id, state);
      CREATE TABLE IF NOT EXISTS go_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        go_id INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(go_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS go_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        go_id INTEGER NOT NULL,
        check_id TEXT NOT NULL,
        evidence_max_seq INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        action TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        raw TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(go_id, check_id)
      );
      CREATE TABLE IF NOT EXISTS go_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        go_id INTEGER NOT NULL,
        action_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '',
        receipt TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(go_id, action_key)
      );
      CREATE TABLE IF NOT EXISTS go_model_prefs (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        model TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(bot_name, chat_id)
      );
    `);
  }

  private ensureGoIntegrationSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS go_native_bindings (
      go_id INTEGER PRIMARY KEY, identity_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS go_action_lifecycle (
      go_id INTEGER NOT NULL, action_key TEXT NOT NULL, state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, receipt_json TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(go_id, action_key));
      CREATE TABLE IF NOT EXISTS go_visible_evidence (
      go_id INTEGER NOT NULL, source_key TEXT NOT NULL, payload_json TEXT NOT NULL,
      receipt_json TEXT NOT NULL DEFAULT '', PRIMARY KEY(go_id, source_key));`);
  }
  bindGoNativeIdentity(goId: number, identity: { nativeGoalId?: string; executorSessionId: string; checkerSessionId: string; checkerRunId?: string; executorRunIds: string[]; goalUpdatedAt?: number; goalRevision?: number | null }) {
    this.ensureGoIntegrationSchema();
    this.db.prepare('INSERT INTO go_native_bindings VALUES (?, ?)').run(goId, JSON.stringify(identity));
  }
  getGoNativeIdentity(goId: number) {
    this.ensureGoIntegrationSchema();
    const row = this.db.prepare('SELECT identity_json FROM go_native_bindings WHERE go_id=?').get(goId) as any;
    return row ? JSON.parse(row.identity_json) : null;
  }
  setGoCriteria(goId:number, criteria:Array<{id:string;text:string}>) {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_criteria(go_id INTEGER PRIMARY KEY,criteria_json TEXT NOT NULL)");
    this.db.prepare("INSERT OR REPLACE INTO go_criteria VALUES (?,?)").run(goId,JSON.stringify(criteria));
  }
  getGoCriteria(goId:number): Array<{id:string;text:string}> {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_criteria(go_id INTEGER PRIMARY KEY,criteria_json TEXT NOT NULL)");
    const row=this.db.prepare("SELECT criteria_json FROM go_criteria WHERE go_id=?").get(goId) as any;
    return row ? JSON.parse(row.criteria_json) : [];
  }
  getGoDeliveryOperation(goId:number,key:string): any {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_delivery_operations(go_id INTEGER,operation_key TEXT,state TEXT,response_json TEXT,PRIMARY KEY(go_id,operation_key))");
    return this.db.prepare("SELECT * FROM go_delivery_operations WHERE go_id=? AND operation_key=?").get(goId,key);
  }
  recordGoDeliveryOperation(goId:number,key:string,state:"attempted"|"accepted"|"unknown"|"rejected",response?:unknown) {
    this.getGoDeliveryOperation(goId,key);
    this.db.prepare("INSERT INTO go_delivery_operations VALUES (?,?,?,?) ON CONFLICT(go_id,operation_key) DO UPDATE SET state=excluded.state,response_json=excluded.response_json WHERE go_delivery_operations.state!='accepted'").run(goId,key,state,response===undefined?"":JSON.stringify(response));
  }
  /** Durable initial-execution intent, separate from the at-most-once send ledger. */
  createGoBootstrap(goId:number): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_bootstrap(go_id INTEGER PRIMARY KEY,state TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO go_bootstrap VALUES (?,'pending')").run(goId);
  }
  getGoBootstrap(goId:number): string | null {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_bootstrap(go_id INTEGER PRIMARY KEY,state TEXT NOT NULL)");
    return (this.db.prepare("SELECT state FROM go_bootstrap WHERE go_id=?").get(goId) as any)?.state ?? null;
  }
  finishGoBootstrap(goId:number,state:"done"|"superseded"): void {
    this.getGoBootstrap(goId);
    this.db.prepare("UPDATE go_bootstrap SET state=? WHERE go_id=?").run(state,goId);
  }
  isGoActionComplete(goId:number,actionKey:string): boolean {
    return (this.db.prepare("SELECT done FROM go_actions WHERE go_id=? AND action_key=?").get(goId,actionKey) as any)?.done===1;
  }
  listGoSends(goId:number): Array<{actionKey:string;idempotencyKey:string;sessionKey:string;sessionId:string}> {
    this.listUnresolvedGoSends(goId);
    return (this.db.prepare("SELECT s.*,l.idempotency_key FROM go_send_identities s JOIN go_action_lifecycle l ON s.go_id=l.go_id AND s.action_key=l.action_key WHERE s.go_id=?").all(goId) as any[])
      .map(r=>({actionKey:r.action_key,idempotencyKey:r.idempotency_key,...JSON.parse(r.identity_json)}));
  }
  recordGoRunResult(goId:number,actionKey:string,result:{state:"complete"|"unknown";text?:string;runId:string;executorResult?:import("./go-execution.js").GoExecutorResult}) {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_run_results(go_id INTEGER,action_key TEXT,result_json TEXT,PRIMARY KEY(go_id,action_key))");
    this.db.prepare("INSERT OR REPLACE INTO go_run_results VALUES (?,?,?)").run(goId,actionKey,JSON.stringify(result));
  }
  getGoRunResult(goId:number,actionKey:string) {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_run_results(go_id INTEGER,action_key TEXT,result_json TEXT,PRIMARY KEY(go_id,action_key))");
    const row=this.db.prepare("SELECT result_json FROM go_run_results WHERE go_id=? AND action_key=?").get(goId,actionKey) as any;
    return row ? JSON.parse(row.result_json) : null;
  }
  listUnknownGoRunResults(goId:number): Array<{actionKey:string;runId:string;sessionKey:string;sessionId:string}> {
    this.getGoRunResult(goId,"");this.listUnresolvedGoSends(goId);
    return (this.db.prepare("SELECT r.action_key,r.result_json,s.identity_json FROM go_run_results r JOIN go_send_identities s ON r.go_id=s.go_id AND r.action_key=s.action_key WHERE r.go_id=?").all(goId) as any[]).flatMap(r=>{
      const result=JSON.parse(r.result_json);
      return result.state==="unknown" ? [{actionKey:r.action_key,runId:result.runId,...JSON.parse(r.identity_json)}] : [];
    });
  }
  hasUnknownGoRunResults(goId:number) {
    this.getGoRunResult(goId,"");
    return (this.db.prepare("SELECT result_json FROM go_run_results WHERE go_id=?").all(goId) as any[]).some(r=>JSON.parse(r.result_json).state==="unknown");
  }
  associateGoAdmittedRun(goId:number,runId:string,executor:boolean): void {
    const identity=this.getGoNativeIdentity(goId);
    if(!identity) throw new Error("Missing independent identity");
    if(executor) identity.executorRunIds=[...new Set([...identity.executorRunIds,runId])];
    else identity.checkerRunId=runId;
    this.db.prepare("UPDATE go_native_bindings SET identity_json=? WHERE go_id=?").run(JSON.stringify(identity),goId);
  }
  /** Durable delivery ownership includes completed/stopped jobs, not only active ones. */
  ownsGoExecutorRun(botName:string,chatId:string,sessionKey:string,sessionId:string,runId:string): boolean {
    this.ensureGoIntegrationSchema();
    return (this.db.prepare("SELECT j.executor_session_key,j.executor_session_id,b.identity_json FROM go_jobs j JOIN go_native_bindings b ON j.id=b.go_id WHERE j.bot_name=? AND j.chat_id=? AND j.executor_session_id=?").all(botName,chatId,sessionId) as any[])
      .some(row=>[row.executor_session_key,`agent:main:${row.executor_session_key}`].includes(sessionKey) && JSON.parse(row.identity_json).executorRunIds.includes(runId));
  }
  recordGoVisibleEvidence(goId: number, sourceKey: string, payload: { sessionId: string; runId: string; kind: string; text: string; attachments: unknown[] }) {
    this.ensureGoIntegrationSchema();
    return this.db.prepare('INSERT OR IGNORE INTO go_visible_evidence (go_id,source_key,payload_json) VALUES (?,?,?)').run(goId, sourceKey, JSON.stringify(payload)).changes === 1;
  }
  recordGoDeliveryReceipt(goId: number, sourceKey: string, receipt: unknown) {
    this.ensureGoIntegrationSchema();
    this.db.prepare('UPDATE go_visible_evidence SET receipt_json=? WHERE go_id=? AND source_key=?').run(JSON.stringify(receipt), goId, sourceKey);
  }
  listGoVisibleEvidence(goId: number) {
    this.ensureGoIntegrationSchema();
    return (this.db.prepare('SELECT * FROM go_visible_evidence WHERE go_id=? ORDER BY rowid').all(goId) as any[])
      .map(r => ({ sourceKey: r.source_key, ...JSON.parse(r.payload_json), receipt: r.receipt_json ? JSON.parse(r.receipt_json) : null }));
  }
  bindGoSendIdentity(goId:number,actionKey:string,identity:{sessionKey:string;sessionId:string}) {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_send_identities(go_id INTEGER,action_key TEXT,identity_json TEXT,PRIMARY KEY(go_id,action_key))");
    this.db.prepare("INSERT OR IGNORE INTO go_send_identities VALUES (?,?,?)").run(goId,actionKey,JSON.stringify(identity));
  }
  listUnresolvedGoSends(goId:number): Array<{actionKey:string;idempotencyKey:string;sessionKey:string;sessionId:string}> {
    this.db.exec("CREATE TABLE IF NOT EXISTS go_send_identities(go_id INTEGER,action_key TEXT,identity_json TEXT,PRIMARY KEY(go_id,action_key))");
    return (this.db.prepare("SELECT s.*,l.idempotency_key FROM go_send_identities s JOIN go_action_lifecycle l ON s.go_id=l.go_id AND s.action_key=l.action_key WHERE s.go_id=? AND l.state!='accepted'").all(goId) as any[]).map(r=>({actionKey:r.action_key,idempotencyKey:r.idempotency_key,...JSON.parse(r.identity_json)}));
  }
  recordGoActionAttempt(goId: number, actionKey: string) {
    this.ensureGoIntegrationSchema();
    const idempotencyKey = `lma-go:${goId}:${actionKey}`;
    this.db.prepare("INSERT OR IGNORE INTO go_action_lifecycle (go_id,action_key,state,idempotency_key) VALUES (?,?,'attempted',?)").run(goId, actionKey, idempotencyKey);
    return this.getGoActionLifecycle(goId, actionKey);
  }
  getGoActionLifecycle(goId: number, actionKey: string) {
    this.ensureGoIntegrationSchema();
    return this.db.prepare('SELECT * FROM go_action_lifecycle WHERE go_id=? AND action_key=?').get(goId, actionKey) as {state:string;idempotency_key:string;receipt_json:string} | undefined;
  }
  recordGoActionOutcome(goId: number, actionKey: string, state: 'accepted' | 'unknown', receipt?: unknown) {
    this.ensureGoIntegrationSchema();
    this.db.prepare('UPDATE go_action_lifecycle SET state=?,receipt_json=? WHERE go_id=? AND action_key=? AND state!=?').run(state, receipt === undefined ? '' : JSON.stringify(receipt), goId, actionKey, 'accepted');
  }

  observeRunError(botName: string, chatId: string, provenance: ErrorProvenance): PendingErrorNotice {
    const noticeId = errorIdentity(provenance.sessionKey, provenance.runId);
    const previous = this.getErrorNotice(botName, chatId, noticeId);
    if (previous) {
      if (provenance.userStop) {
        previous.provenance.userStop = true;
        previous.status = "stopped";
        previous.verdict = { state: "stopped", reason: "explicit_bridge_stop" };
        this.saveErrorNotice(previous);
      }
      // A committed transcript abort is weaker than a gateway terminal error.
      // One stronger envelope can wake a parked observation; repeats cannot.
      const terminalChat = (p: ErrorProvenance) => p.source === "chat" && (p.state === "error" || (p.state === "final" && p.stopReason === "error"));
      if (!provenance.userStop && !previous.provenance.userStop && terminalChat(provenance) && !terminalChat(previous.provenance)
          && ["pending", "parked"].includes(previous.status)) {
        previous.provenance = provenance;
        previous.status = "pending";
        previous.checks = Math.min(previous.checks, 5);
        previous.nextCheckAt = Date.now();
        this.saveErrorNotice(previous);
      }
      return previous; // duplicate/late events never reset the budget
    }
    const record: PendingErrorNotice = { botName, chatId, noticeId, provenance, checks: 0,
      nextCheckAt: Date.now(), createdAt: Date.now(), status: "pending" };
    this.saveErrorNotice(record);
    return record;
  }

  getErrorNotice(botName: string, chatId: string, noticeId: string): PendingErrorNotice | undefined {
    const row = this.db.prepare("SELECT record_json FROM error_notices WHERE bot_name=? AND chat_id=? AND notice_id=?")
      .get(botName, chatId, noticeId) as any;
    return row ? JSON.parse(row.record_json) : undefined;
  }

  saveErrorNotice(record: PendingErrorNotice): void {
    this.db.prepare(`INSERT INTO error_notices (bot_name,chat_id,notice_id,record_json,next_check_at,status)
      VALUES (?,?,?,?,?,?) ON CONFLICT(bot_name,chat_id,notice_id) DO UPDATE SET
      record_json=excluded.record_json,next_check_at=excluded.next_check_at,status=excluded.status`)
      .run(record.botName, record.chatId, record.noticeId, JSON.stringify(record), record.nextCheckAt, record.status);
  }

  listPendingErrorNotices(botName: string, chatId: string): PendingErrorNotice[] {
    return (this.db.prepare("SELECT record_json FROM error_notices WHERE bot_name=? AND chat_id=? AND status='pending' ORDER BY next_check_at LIMIT 100")
      .all(botName, chatId) as any[]).map(row => JSON.parse(row.record_json));
  }

  /** A later exact final may be content-deduped against its own transcript.
   * Upgrade only identical payloads with the same canonical session/run; never
   * infer identity from text similarity or another run's successful answer. */
  promoteExactRunFinal(botName: string, chatId: string, sessionKey: string, runId: string, contentHash: string, content: string, attachmentsJson: string): void {
    this.db.prepare(`UPDATE delivery_outbox
      SET delivery_meta_json=json_set(delivery_meta_json,'$.provenance.final',json('true'))
      WHERE bot_name=? AND chat_id=? AND source_type='assistant_visible' AND content_hash=?
      AND content=? AND attachments_json=?
      AND json_valid(delivery_meta_json)
      AND json_extract(delivery_meta_json,'$.provenance.sessionKey')=?
      AND json_extract(delivery_meta_json,'$.provenance.runId')=?`).run(botName, chatId, contentHash, content, attachmentsJson, sessionKey, runId);
  }

  hasExactRunFinalPayload(botName: string, chatId: string, p: { sessionKey: string; runId: string }, content: string, attachmentsJson: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM delivery_outbox
      WHERE bot_name=? AND chat_id=? AND source_type='assistant_visible'
      AND content=? AND attachments_json=? AND status IN ('pending','delivering','delivered')
      AND json_valid(delivery_meta_json) AND json_extract(delivery_meta_json,'$.provenance.final')=1
      AND json_extract(delivery_meta_json,'$.provenance.sessionKey')=?
      AND json_extract(delivery_meta_json,'$.provenance.runId')=? LIMIT 1`)
      .get(botName, chatId, content, attachmentsJson, p.sessionKey, p.runId));
  }

  hasRunFinalDelivery(botName: string, chatId: string, p: ErrorProvenance, confirmed: boolean): boolean {
    return Boolean(p.runId && this.db.prepare(`SELECT 1 FROM delivery_outbox
      WHERE bot_name=? AND chat_id=? AND source_type='assistant_visible'
      AND json_valid(delivery_meta_json)
      AND json_extract(delivery_meta_json,'$.provenance.final')=1
      AND json_extract(delivery_meta_json,'$.provenance.sessionKey')=?
      AND json_extract(delivery_meta_json,'$.provenance.runId')=?
      AND ${confirmed ? "status='delivered'" : "status IN ('pending','delivering')"} LIMIT 1`)
      .get(botName, chatId, p.sessionKey, p.runId));
  }

  renewUnsentErrorDelivery(id: number, content: string, contentHash: string, metadata: string): void {
    this.db.prepare(`UPDATE delivery_outbox SET status='pending',content=?,content_hash=?,delivery_meta_json=?,updated_at=?
      WHERE id=? AND source_type='run_error' AND status='failed' AND text_delivered=0`)
      .run(content, contentHash, metadata, Date.now(), id);
  }

  /** Withdraw only an unsent error notice. Never claim it was delivered or touch a result row. */
  withdrawErrorDelivery(id: number): void {
    // claimDelivery reserves a send attempt before the asynchronous evidence
    // guard. Withdrawing here means no platform send was attempted: refund only
    // that current claim, never an earlier failed/ambiguous platform attempt.
    this.db.prepare("UPDATE delivery_outbox SET status='failed', attempts=MAX(0,attempts-1), updated_at=? WHERE id=? AND source_type='run_error' AND status='delivering' AND text_delivered=0")
      .run(Date.now(), id);
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS error_notices (
        bot_name TEXT NOT NULL, chat_id TEXT NOT NULL, notice_id TEXT NOT NULL,
        record_json TEXT NOT NULL, next_check_at INTEGER NOT NULL,
        status TEXT NOT NULL, PRIMARY KEY(bot_name, chat_id, notice_id)
      );
      CREATE INDEX IF NOT EXISTS idx_error_notices_due ON error_notices(bot_name, chat_id, status, next_check_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT UNIQUE NOT NULL,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        trigger_kind TEXT NOT NULL DEFAULT 'normal'
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);

      CREATE TABLE IF NOT EXISTS chat_info (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL DEFAULT 'group',
        chat_name TEXT NOT NULL DEFAULT '',
        members TEXT NOT NULL DEFAULT '',
        member_names TEXT NOT NULL DEFAULT '',
        verbose INTEGER NOT NULL DEFAULT 0,
        discuss INTEGER NOT NULL DEFAULT 0,
        discuss_max_rounds INTEGER NOT NULL DEFAULT 10,
        chairman_bot TEXT NOT NULL DEFAULT '',
        locale TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- Legacy high-water mark for which messages have been synced to each
      -- bot's OpenClaw session. Kept for compatibility and quick inspection.
      CREATE TABLE IF NOT EXISTS sync_state (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        last_synced_msg_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Per-message sync ledger. This lets a bot catch up on all missed group
      -- messages without relying only on a coarse high-water mark.
      CREATE TABLE IF NOT EXISTS message_sync (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_row_id INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        sync_batch_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (bot_name, chat_id, message_row_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_sync_bot_chat ON message_sync(bot_name, chat_id, message_row_id);

      -- Tracks which messages have been processed by each bot (multi-bot dedup).
      CREATE TABLE IF NOT EXISTS processed_events (
        bot_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (bot_name, message_id)
      );

      -- Tracks recalled human messages. Recalled messages are kept in the raw
      -- message ledger for audit, but excluded from future OpenClaw context and
      -- pending trigger processing.
      CREATE TABLE IF NOT EXISTS recalled_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        recalled_at INTEGER NOT NULL,
        recall_type TEXT NOT NULL DEFAULT ''
      );

      -- Tracks messages that should actively trigger a bot reply.
      -- Other unsynced messages remain local context and are sent only when a trigger arrives.
      CREATE TABLE IF NOT EXISTS pending_triggers (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_row_id INTEGER NOT NULL,
        PRIMARY KEY (bot_name, chat_id, message_row_id)
      );

      -- Tracks replies already delivered for a trigger message.
      -- Prevents duplicate user-visible replies after restarts/race conditions.
      CREATE TABLE IF NOT EXISTS delivered_replies (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        trigger_message_row_id INTEGER NOT NULL,
        delivered_at INTEGER NOT NULL,
        reply_message_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (bot_name, chat_id, trigger_message_row_id)
      );

      -- Per-bot, per-chat settings. A group can contain multiple bots, so settings
      -- like verbose/free discussion must not be shared globally at chat level.
      CREATE TABLE IF NOT EXISTS bot_chat_settings (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        verbose INTEGER NOT NULL DEFAULT 0,
        live_status INTEGER NOT NULL DEFAULT 1,
        free_discussion INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'normal',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Durable positive membership signal. Feishu does not reliably expose bot
      -- members via chat_members, so receiving an event in a chat is the strongest
      -- proof that this bot app is actually installed in that group.
      CREATE TABLE IF NOT EXISTS bot_chat_seen (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Durable negative membership cache. Feishu message create returns 230002
      -- when a bot app is not in a chat; cache that so discussion scheduling and
      -- later proactive deliveries do not keep generating ghost participants.
      CREATE TABLE IF NOT EXISTS bot_chat_unavailable (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Durable delivery ledger for user-visible assistant outputs. All final
      -- text/attachment outputs should be inserted here first and dispatched
      -- once, regardless of whether they came from chat final, proactive
      -- session.message, subagent announce, or delayed error handling.
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        reply_to_message_id TEXT NOT NULL DEFAULT '',
        delivery_mode TEXT NOT NULL DEFAULT 'send',
        target_message_id TEXT NOT NULL DEFAULT '',
        delivery_meta_json TEXT NOT NULL DEFAULT '{}',
        text_delivered INTEGER NOT NULL DEFAULT 0,
        attachment_cursor INTEGER NOT NULL DEFAULT 0,
        cleanup_pending INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(bot_name, chat_id, delivery_key),
        UNIQUE(session_key, source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_pending ON delivery_outbox(status, created_at);
    `);

    // Migration: add per-bot live status toggle if missing
    try {
      this.db.exec(`ALTER TABLE bot_chat_settings ADD COLUMN live_status INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column already exists
    }

    // Migration: add delivery_outbox delivery key columns if missing
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN delivery_key TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN reply_to_message_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'send'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN target_message_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN delivery_meta_json TEXT NOT NULL DEFAULT '{}'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN text_delivered INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN attachment_cursor INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    // Backfill stable keys for rows created by earlier outbox experiments before
    // creating indexes that reference the new columns.
    this.db.exec(`
      UPDATE delivery_outbox
      SET delivery_key = source_id
      WHERE delivery_key IS NULL OR delivery_key = '';
    `);
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_key ON delivery_outbox(bot_name, chat_id, delivery_key)`);
    } catch {
      // Legacy experimental databases may contain duplicate logical deliveries.
      // Keep the earliest owner (and its stage checkpoints) deterministically,
      // remove later duplicates, then REQUIRE the unique index. Continuing
      // without it would allow duplicate visible finals on explicit trigger keys.
      // Merge durable progress into the earliest owner before deleting later
      // duplicates. Prefer the most-complete state so upgrading a dirty legacy DB
      // cannot replay already-visible text/attachments or lose delivered state.
      this.db.exec(`
        UPDATE delivery_outbox AS owner
        SET
          text_delivered = (
            SELECT MAX(d.text_delivered) FROM delivery_outbox d
            WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key
          ),
          attachment_cursor = (
            SELECT MAX(d.attachment_cursor) FROM delivery_outbox d
            WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key
          ),
          cleanup_pending = (
            SELECT MAX(d.cleanup_pending) FROM delivery_outbox d
            WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key
          ),
          attempts = (
            SELECT MAX(d.attempts) FROM delivery_outbox d
            WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key
          ),
          status = CASE
            WHEN EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key AND d.status='delivered') THEN 'delivered'
            WHEN EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key AND d.status='pending') THEN 'pending'
            WHEN EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.bot_name=owner.bot_name AND d.chat_id=owner.chat_id AND d.delivery_key=owner.delivery_key AND d.status='delivering') THEN 'pending'
            ELSE 'failed'
          END
        WHERE owner.id IN (
          SELECT MIN(id) FROM delivery_outbox GROUP BY bot_name, chat_id, delivery_key HAVING COUNT(*) > 1
        );
        DELETE FROM delivery_outbox
        WHERE id NOT IN (
          SELECT MIN(id) FROM delivery_outbox GROUP BY bot_name, chat_id, delivery_key
        );
      `);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_key ON delivery_outbox(bot_name, chat_id, delivery_key)`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_outbox_content ON delivery_outbox(bot_name, chat_id, content_hash, created_at)`);

    // Migration: add delivery_outbox reply target if missing
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN reply_to_message_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add verbose column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN verbose INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: add locale column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN locale TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add chairman column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN chairman_bot TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add discuss columns if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN discuss INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN discuss_max_rounds INTEGER NOT NULL DEFAULT 10`);
    } catch {
      // Column already exists
    }
    // Migration: promote the old discuss default (3 rounds) to the new default
    // (10 rounds). Explicit non-default values such as 1/2/5/8 are preserved.
    this.db.prepare(`UPDATE chat_info SET discuss_max_rounds = 10 WHERE discuss_max_rounds = 3`).run();

    // Migration: add owner_bot column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN owner_bot TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add trigger_kind column if missing
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'normal'`);
    } catch {
      // Column already exists
    }

    // Migration: add free_discussion column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN free_discussion INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: make free discussion per-bot per-chat.
    try {
      this.db.exec(`ALTER TABLE bot_chat_settings ADD COLUMN free_discussion INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: replace independent free/mute booleans with one mutually exclusive mode.
    try {
      this.db.exec(`ALTER TABLE bot_chat_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'`);
    } catch {
      // Column already exists
    }
    this.db.exec(`
      UPDATE bot_chat_settings
      SET mode = 'free'
      WHERE free_discussion = 1 AND (mode IS NULL OR mode = '' OR mode = 'normal')
    `);
  }

  /**
   * Insert a message. Returns the auto-increment id, or -1 if duplicate.
   */
  insert(msg: ChatMessage): number {
    try {
      if(this.db.prepare('SELECT 1 FROM platform_message_aliases WHERE message_id=?').get(msg.messageId)) return -1;
      const result = this.db.prepare(`
        INSERT INTO messages (chat_id, message_id, sender_type, sender_name, content, timestamp, trigger_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(msg.chatId, msg.messageId, msg.senderType, msg.senderName, msg.content, msg.timestamp, msg.triggerKind || "normal");
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return -1;
      throw err;
    }
  }

  getMessageId(messageId: string): number | null {
    const row = this.db.prepare(`SELECT id FROM messages WHERE message_id = ?`).get(messageId) as any;
    return row?.id || (this.db.prepare('SELECT message_row_id FROM platform_message_aliases WHERE message_id=?').get(messageId) as any)?.message_row_id || null;
  }

  getMessageByRowId(rowId: number): ChatMessage | null {
    const row = this.db.prepare('SELECT message_id FROM messages WHERE id = ?').get(rowId) as {message_id: string} | undefined;
    return row ? this.getMessageByMessageId(row.message_id) : null;
  }

  getMessageByMessageId(messageId: string): ChatMessage | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE message_id = ?`).get(messageId) as any;
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      senderType: row.sender_type,
      senderName: row.sender_name,
      content: row.content,
      timestamp: row.timestamp,
      triggerKind: row.trigger_kind || "normal",
    };
  }

  getLatestMessageId(chatId: string): number {
    const row = this.db.prepare(`SELECT MAX(id) as id FROM messages WHERE chat_id = ?`).get(chatId) as any;
    return row?.id || 0;
  }

  markMessageRecalled(messageId: string, chatId: string, recalledAt: number = Date.now(), recallType: string = ''): void {
    this.db.prepare(`
      INSERT INTO recalled_messages (message_id, chat_id, recalled_at, recall_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET chat_id = excluded.chat_id, recalled_at = excluded.recalled_at, recall_type = excluded.recall_type
    `).run(messageId, chatId, recalledAt, recallType || '');
  }

  isMessageRecalled(messageId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM recalled_messages WHERE message_id = ?`).get(messageId);
    return !!row;
  }

  markPendingTrigger(botName: string, chatId: string, messageRowId: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO pending_triggers (bot_name, chat_id, message_row_id)
      VALUES (?, ?, ?)
    `).run(botName, chatId, messageRowId);
  }

  getPendingTriggerIds(botName: string, chatId: string): Set<number> {
    const rows = this.db.prepare(`
      SELECT message_row_id FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ?
      ORDER BY message_row_id ASC
    `).all(botName, chatId) as any[];
    return new Set(rows.map((r) => Number(r.message_row_id)));
  }

  getPendingTriggerMessages(botName: string, chatId: string): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT messages.* FROM pending_triggers
      JOIN messages ON messages.id = pending_triggers.message_row_id
      LEFT JOIN recalled_messages ON recalled_messages.message_id = messages.message_id
      WHERE pending_triggers.bot_name = ? AND pending_triggers.chat_id = ? AND recalled_messages.message_id IS NULL
      ORDER BY messages.timestamp ASC
    `).all(botName, chatId) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
      triggerKind: r.trigger_kind || "normal",
    }));
  }

  clearPendingTriggers(botName: string, chatId: string, upToId: number): void {
    this.db.prepare(`
      DELETE FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ? AND message_row_id <= ?
    `).run(botName, chatId, upToId);
  }

  clearAllPendingTriggers(botName: string, chatId: string): number {
    const result = this.db.prepare(`
      DELETE FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ?
    `).run(botName, chatId);
    return result.changes;
  }

  clearPendingTrigger(botName: string, chatId: string, messageRowId: number): void {
    this.db.prepare(`
      DELETE FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ? AND message_row_id = ?
    `).run(botName, chatId, messageRowId);
  }

  hasDeliveredReply(botName: string, chatId: string, triggerMessageRowId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM delivered_replies
      WHERE bot_name = ? AND chat_id = ? AND trigger_message_row_id = ?
    `).get(botName, chatId, triggerMessageRowId);
    return !!row;
  }

  markDeliveredReply(botName: string, chatId: string, triggerMessageRowId: number, replyMessageId: string = ''): void {
    if(!this.isOrdinaryInput(botName,chatId,triggerMessageRowId))return;
    this.db.prepare(`
      INSERT OR IGNORE INTO delivered_replies (bot_name, chat_id, trigger_message_row_id, delivered_at, reply_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(botName, chatId, triggerMessageRowId, Date.now(), replyMessageId);
  }

  enqueueDelivery(item: Omit<DeliveryOutboxItem, "id" | "status" | "attempts" | "createdAt" | "updatedAt">): number | null {
    return this.db.transaction(()=>{
    const p=JSON.parse(item.deliveryMetaJson || '{}').provenance;
    if(p?.final && p.sessionKey && p.runId && this.isStoppedObservation(p.sessionKey,p.runId)) return null;
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO delivery_outbox
        (session_key, chat_id, bot_name, source_type, source_id, delivery_key, content_hash, content, attachments_json, reply_to_message_id, delivery_mode, target_message_id, delivery_meta_json, text_delivered, attachment_cursor, cleanup_pending, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      item.sessionKey,
      item.chatId,
      item.botName,
      item.sourceType,
      item.sourceId,
      item.deliveryKey,
      item.contentHash,
      item.content,
      item.attachmentsJson,
      item.replyToMessageId || '',
      item.deliveryMode || 'send',
      item.targetMessageId || '',
      item.deliveryMetaJson || '{}',
      item.textDelivered ? 1 : 0,
      item.attachmentCursor || 0,
      item.cleanupPending ? 1 : 0,
      now,
      now,
    );
    if(p?.final===true && p.sessionKey && p.runId) this.finishRunObservation(p.sessionKey,p.runId,'outbox_owned');
    return result.changes ? Number(result.lastInsertRowid) : null;
    })();
  }

  getDeliveryBySource(sessionKey: string, sourceType: string, sourceId: string): DeliveryOutboxItem | null {
    const row = this.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE session_key = ? AND source_type = ? AND source_id = ?
    `).get(sessionKey, sourceType, sourceId) as any;
    return row ? this.mapDelivery(row) : null;
  }

  getDeliveryByKey(botName: string, chatId: string, deliveryKey: string): DeliveryOutboxItem | null {
    const row = this.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND delivery_key = ?
    `).get(botName, chatId, deliveryKey) as any;
    return row ? this.mapDelivery(row) : null;
  }

  listDeliveriesByKeyPrefix(botName: string, chatId: string, prefix: string): DeliveryOutboxItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND delivery_key LIKE ?
      ORDER BY id ASC
    `).all(botName, chatId, `${prefix}%`) as any[];
    return rows.map((row) => this.mapDelivery(row));
  }

  bindDeliveryCompletionTriggers(bot:string,chat:string,key:string,ids:number[]):void {
    const row=this.getDeliveryByKey(bot,chat,key);
    if(!row) return;
    const meta=JSON.parse(row.deliveryMetaJson || '{}');
    meta.completionTriggerIds=[...new Set([...(meta.completionTriggerIds || []),...ids])];
    this.db.prepare('UPDATE delivery_outbox SET delivery_meta_json=? WHERE id=?').run(JSON.stringify(meta),row.id);
  }

  /** Include stable correction/supplement rows: the first accepted body alone
   * cannot settle a logical final whose remaining attachments are unknown. */
  getDeliveryDispatchOutcome(bot:string,chat:string,key:string):DeliveryDispatchOutcome {
    const root=this.getDeliveryByKey(bot,chat,key);
    const rows=[...(root ? [root] : []),...this.listDeliveriesByKeyPrefix(bot,chat,`${key}:`).filter(row=>
      ['authoritative:','attachments:','recovery:'].some(kind=>row.deliveryKey.startsWith(`${key}:${kind}`)))];
    const outboxIds=rows.map(row=>row.id!);
    if(!rows.length) return {state:'unknown',outboxIds};
    if(rows.some(row=>this.hasUnknownDeliveryOperation(row.id!))) return {state:'unknown',outboxIds};
    const confirmed=rows.every(row=>row.status==='delivered' &&
      (!row.content.trim() || this.listDeliveryReceipts(row.id!).some(r=>r.stage==='body')) &&
      (JSON.parse(row.attachmentsJson || '[]') as unknown[]).every((_,i)=>this.listDeliveryReceipts(row.id!).some(r=>r.stage===`attachment:${i}`)));
    return {state:confirmed ? 'delivered' : rows.some(row=>row.status==='failed') ? 'failed' : 'pending',outboxIds};
  }

  getPendingDeliveries(chatId?: string, botName?: string, maxCount: number = 20): DeliveryOutboxItem[] {
    if (chatId && botName) {
      const rows = this.db.prepare(`
        SELECT * FROM delivery_outbox
        WHERE status = 'pending' AND chat_id = ? AND bot_name = ?
        ORDER BY created_at ASC LIMIT ?
      `).all(chatId, botName, maxCount) as any[];
      return rows.map((r) => this.mapDelivery(r));
    }
    const rows = this.db.prepare(`
      SELECT * FROM delivery_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).all(maxCount) as any[];
    return rows.map((r) => this.mapDelivery(r));
  }

  markBotSeenInChat(botName: string, chatId: string): void {
    this.db.prepare(`
      INSERT INTO bot_chat_seen(bot_name, chat_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(bot_name, chat_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(botName, chatId, Date.now());
    // If the bot is receiving events from this chat again, it is no longer out
    // of the chat. This recovers automatically when a bot is re-added to a group.
    this.clearBotUnavailableInChat(botName, chatId);
  }

  hasBotSeenInChat(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM bot_chat_seen WHERE bot_name = ? AND chat_id = ? LIMIT 1`).get(botName, chatId);
    return !!row;
  }

  markBotUnavailableInChat(botName: string, chatId: string, reason = ''): void {
    this.db.prepare(`
      INSERT INTO bot_chat_unavailable(bot_name, chat_id, reason, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_name, chat_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
    `).run(botName, chatId, reason, Date.now());
  }

  clearBotUnavailableInChat(botName: string, chatId: string): void {
    this.db.prepare(`DELETE FROM bot_chat_unavailable WHERE bot_name = ? AND chat_id = ?`).run(botName, chatId);
  }

  isBotUnavailableInChat(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM bot_chat_unavailable WHERE bot_name = ? AND chat_id = ? LIMIT 1`).get(botName, chatId);
    return !!row;
  }

  hasAnyDeliveredToChat(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND status = 'delivered'
      LIMIT 1
    `).get(botName, chatId);
    return !!row;
  }

  hasRecentSimilarDelivery(botName: string, chatId: string, contentHash: string, windowMs: number, sourceTypes?: string[]): boolean {
    if (!contentHash) return false;
    const sourceFilter = sourceTypes?.length ? ` AND source_type IN (${sourceTypes.map(() => "?").join(",")})` : "";
    const row = this.db.prepare(`
      SELECT 1 FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND content_hash = ? AND created_at >= ? AND status IN ('pending', 'delivering', 'delivered')${sourceFilter}
      LIMIT 1
    `).get(botName, chatId, contentHash, Date.now() - windowMs, ...(sourceTypes || []));
    return !!row;
  }

  hasRecentOverlappingDelivery(botName: string, chatId: string, content: string, attachmentsJson: string, windowMs: number, minShortLength: number = 8, sourceTypes?: string[]): boolean {
    const normalized = content.trim();
    if (normalized.length < minShortLength) return false;
    const sourceFilter = sourceTypes?.length ? ` AND source_type IN (${sourceTypes.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`
      SELECT content, attachments_json FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND created_at >= ? AND status IN ('pending', 'delivering', 'delivered')${sourceFilter}
      ORDER BY created_at DESC
      LIMIT 20
    `).all(botName, chatId, Date.now() - windowMs, ...(sourceTypes || [])) as any[];
    for (const row of rows) {
      if ((row.attachments_json || '[]') !== attachmentsJson) continue;
      const existing = String(row.content || '').trim();
      if (existing.length < minShortLength) continue;
      const shorter = existing.length <= normalized.length ? existing : normalized;
      const longer = existing.length <= normalized.length ? normalized : existing;
      if (shorter.length >= minShortLength && longer.includes(shorter)) return true;
    }
    return false;
  }

  /** Recover in-flight rows after process restart. A new process cannot own a
   * legitimate delivering row, so every matching row returns to pending—even if
   * the previous process crashed on its nominal final attempt. The restarted
   * process gets another chance to finish rather than silently losing payload. */
  resetDeliveringOnStartup(botName: string): number {
    const result = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = 'pending', updated_at = ?
      WHERE bot_name = ? AND (status = 'delivering' OR status='failed' AND EXISTS(
        SELECT 1 FROM delivery_operations o WHERE o.outbox_id=delivery_outbox.id AND o.state IN ('accepted','attempted','unknown')))
    `).run(Date.now(), botName);
    return result.changes;
  }

  resetStaleDeliveries(botName: string, staleMs: number, maxAttempts: number): { restored: number; failed: number } {
    const cutoff = Date.now() - staleMs;
    const fail = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = 'failed', updated_at = ?
      WHERE bot_name = ? AND status = 'delivering' AND updated_at <= ? AND attempts >= ?
    `).run(Date.now(), botName, cutoff, maxAttempts);
    const restore = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = 'pending', updated_at = ?
      WHERE bot_name = ? AND status = 'delivering' AND updated_at <= ? AND attempts < ?
    `).run(Date.now(), botName, cutoff, maxAttempts);
    return { restored: restore.changes, failed: fail.changes };
  }

  claimDelivery(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE delivery_outbox SET status = 'delivering', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(Date.now(), id);
    return result.changes === 1;
  }

  markDeliveryTextDelivered(id: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET text_delivered = 1, updated_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  /** Atomically checkpoint fallback text and the remaining card cleanup. */
  markDeliveryTextDeliveredWithCleanup(id: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox
      SET text_delivered = 1, cleanup_pending = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  }

  markDeliveryAttachmentCursor(id: number, cursor: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET attachment_cursor = ?, updated_at = ? WHERE id = ?
    `).run(cursor, Date.now(), id);
  }

  /** Return a failed in-flight delivery to pending until its retry budget is spent. */
  retryDelivery(id: number, maxAttempts: number): boolean {
    const result = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = 'pending', updated_at = ?
      WHERE id = ? AND status = 'delivering' AND attempts < ?
    `).run(Date.now(), id, maxAttempts);
    return result.changes === 1;
  }

  markDeliveryCleanupPending(id: number, pending: boolean): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET cleanup_pending = ?, updated_at = ? WHERE id = ?
    `).run(pending ? 1 : 0, Date.now(), id);
  }

  markDeliveryDelivered(id: number): void {
    this.db.transaction(()=>{
      this.db.prepare(`UPDATE delivery_outbox SET status = 'delivered', updated_at = ? WHERE id = ?`).run(Date.now(), id);
      this.db.prepare('DELETE FROM delivery_local_obligations WHERE outbox_id=?').run(id);
    })();
  }

  markDeliveryFailed(id: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET status = 'failed', updated_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  /** Give a later explicit duplicate another chance after terminal failure. */
  requeueFailedDelivery(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = 'pending', attempts = 0, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(Date.now(), id);
    return result.changes === 1;
  }

  private mapDelivery(row: any): DeliveryOutboxItem {
    return {
      id: row.id,
      sessionKey: row.session_key,
      chatId: row.chat_id,
      botName: row.bot_name,
      sourceType: row.source_type,
      sourceId: row.source_id,
      deliveryKey: row.delivery_key || row.source_id,
      contentHash: row.content_hash || '',
      content: row.content || '',
      attachmentsJson: row.attachments_json || '[]',
      replyToMessageId: row.reply_to_message_id || '',
      deliveryMode: row.delivery_mode === 'patch_live_status' ? 'patch_live_status' : 'send',
      targetMessageId: row.target_message_id || '',
      deliveryMetaJson: row.delivery_meta_json || '{}',
      textDelivered: Boolean(row.text_delivered),
      attachmentCursor: Number(row.attachment_cursor || 0),
      cleanupPending: Boolean(row.cleanup_pending),
      status: row.status,
      attempts: row.attempts || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get messages that haven't been synced to a bot's session yet.
   * Returns messages ordered by timestamp ascending.
   */
  getUnsyncedMessages(
    botName: string,
    chatId: string,
    maxCount: number = 50
  ): ChatMessage[] {
    const row = this.db.prepare(`
      SELECT last_synced_msg_id FROM sync_state
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;

    const lastId = row?.last_synced_msg_id || 0;

    const rows = this.db.prepare(`
      SELECT messages.* FROM messages
      LEFT JOIN recalled_messages ON recalled_messages.message_id = messages.message_id
      WHERE messages.chat_id = ? AND messages.id > ? AND recalled_messages.message_id IS NULL
      ORDER BY messages.timestamp ASC
      LIMIT ?
    `).all(chatId, lastId, maxCount) as any[];

    return rows.map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
      triggerKind: r.trigger_kind || "normal",
    }));
  }

  /**
   * Get all messages at or before triggerRowId that have not been synced to a
   * bot's session yet. Ordered by timestamp ascending.
   */
  getUnsyncedMessagesForBot(botName: string, chatId: string, triggerRowId: number): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT messages.* FROM messages
      LEFT JOIN recalled_messages ON recalled_messages.message_id = messages.message_id
      LEFT JOIN message_sync ON message_sync.bot_name = ?
        AND message_sync.chat_id = messages.chat_id
        AND message_sync.message_row_id = messages.id
      WHERE messages.chat_id = ?
        AND messages.id <= ?
        AND recalled_messages.message_id IS NULL
        AND message_sync.message_row_id IS NULL
        -- A held insertion must not be replayed later as group catch-up simply
        -- because acceptance removed its pending trigger. Custody is not sync.
        AND NOT EXISTS (SELECT 1 FROM insertion_custody i WHERE i.bot_name=?
          AND i.chat_id=messages.chat_id AND i.message_row_id=messages.id AND i.state!='ordinary')
      ORDER BY messages.timestamp ASC
    `).all(botName, chatId, triggerRowId, botName) as any[];

    return rows.map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
      triggerKind: r.trigger_kind || "normal",
    }));
  }

  markMessagesSynced(botName: string, chatId: string, messageRowIds: number[], syncBatchId: string = ''): void {
    const ids = Array.from(new Set(messageRowIds.filter((id) => Number.isFinite(id) && id > 0 && this.isOrdinaryInput(botName,chatId,id))));
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO message_sync (bot_name, chat_id, message_row_id, synced_at, sync_batch_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) stmt.run(botName, chatId, id, now, syncBatchId);
    });
    tx(ids);
  }

  /**
   * Mark all messages up to (and including) the given id as synced for a bot.
   */
  markSynced(botName: string, chatId: string, upToId: number): void {
    this.db.prepare(`
      INSERT INTO sync_state (bot_name, chat_id, last_synced_msg_id)
      VALUES (?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET last_synced_msg_id = MAX(sync_state.last_synced_msg_id, excluded.last_synced_msg_id)
    `).run(botName, chatId, upToId);
  }

  /**
   * Get recent messages for a chat, ordered by timestamp ascending.
   */
  getRecent(chatId: string, maxCount: number = 50): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chatId, maxCount) as any[];

    return rows.reverse().map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
      triggerKind: r.trigger_kind || "normal",
    }));
  }

  /**
   * Count consecutive messages from one bot at the tail of a chat.
   *
   * Other bots do not consume this bot's anti-loop budget. Human messages reset
   * the streak. This lets multiple bots free-discuss without a global bot-streak
   * guard shutting everyone down after N total bot messages.
   */
  getBotStreak(chatId: string, botName: string): number {
    const rows = this.db.prepare(`
      SELECT sender_type, sender_name FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `).all(chatId) as any[];

    let count = 0;
    for (const r of rows) {
      if ((r as any).sender_type === "human") break;
      if ((r as any).sender_type === "bot" && (r as any).sender_name === botName) count++;
    }
    return count;
  }

  // --- Chat info ---

  upsertChatInfo(info: ChatInfo): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, members, member_names, verbose, free_discussion, owner_bot, discuss, discuss_max_rounds, chairman_bot, locale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        chat_name = excluded.chat_name,
        members = excluded.members,
        member_names = excluded.member_names,
        verbose = excluded.verbose,
        free_discussion = excluded.free_discussion,
        owner_bot = CASE WHEN excluded.owner_bot != '' THEN excluded.owner_bot ELSE chat_info.owner_bot END,
        discuss = CASE WHEN excluded.discuss != 0 THEN excluded.discuss ELSE chat_info.discuss END,
        discuss_max_rounds = CASE WHEN excluded.discuss_max_rounds != 10 THEN excluded.discuss_max_rounds ELSE chat_info.discuss_max_rounds END,
        chairman_bot = CASE WHEN excluded.chairman_bot != '' THEN excluded.chairman_bot ELSE chat_info.chairman_bot END,
        locale = CASE WHEN excluded.locale != '' THEN excluded.locale ELSE chat_info.locale END,
        updated_at = excluded.updated_at
    `).run(info.chatId, info.chatType, info.chatName, info.members, info.memberNames, info.verbose ? 1 : 0, info.freeDiscussion ? 1 : 0, info.ownerBot || '', info.discuss ? 1 : 0, info.discussMaxRounds || 10, info.chairmanBot || '', info.locale || '', info.updatedAt);
  }

  setFreeDiscussion(chatId: string, on: boolean): void {
    this.db.prepare(`UPDATE chat_info SET free_discussion = ? WHERE chat_id = ?`).run(on ? 1 : 0, chatId);
  }

  setVerbose(chatId: string, verbose: boolean): void {
    this.db.prepare(`
      UPDATE chat_info SET verbose = ? WHERE chat_id = ?
    `).run(verbose ? 1 : 0, chatId);
  }

  setDiscussMode(chatId: string, on: boolean): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, discuss, discuss_max_rounds, updated_at)
      VALUES (?, 'group', '', ?, 10, ?)
      ON CONFLICT (chat_id) DO UPDATE SET discuss = excluded.discuss, updated_at = excluded.updated_at
    `).run(chatId, on ? 1 : 0, Date.now());
  }

  setDiscussMaxRounds(chatId: string, rounds: number): void {
    const normalized = Math.max(1, Math.min(10, Math.round(rounds)));
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, discuss, discuss_max_rounds, updated_at)
      VALUES (?, 'group', '', 0, ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET discuss_max_rounds = excluded.discuss_max_rounds, updated_at = excluded.updated_at
    `).run(chatId, normalized, Date.now());
  }



  setChatLocale(chatId: string, locale: string): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, locale, updated_at)
      VALUES (?, 'group', '', ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at
    `).run(chatId, locale, Date.now());
  }

  getChatLocale(chatId: string): string {
    const row = this.db.prepare(`SELECT locale FROM chat_info WHERE chat_id = ?`).get(chatId) as any;
    return row?.locale || '';
  }

  setChairmanBot(chatId: string, botName: string): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, chairman_bot, updated_at)
      VALUES (?, 'group', '', ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET chairman_bot = excluded.chairman_bot, updated_at = excluded.updated_at
    `).run(chatId, botName, Date.now());
  }

  clearChairmanBot(chatId: string): void {
    // Persist both fields atomically so reopening cannot revive Discuss after off.
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, chairman_bot, discuss, updated_at)
      VALUES (?, 'group', '', '', 0, ?)
      ON CONFLICT (chat_id) DO UPDATE SET chairman_bot = '', discuss = 0, updated_at = excluded.updated_at
    `).run(chatId, Date.now());
  }

  getChairmanBot(chatId: string): string {
    const row = this.db.prepare(`SELECT chairman_bot FROM chat_info WHERE chat_id = ?`).get(chatId) as any;
    return row?.chairman_bot || '';
  }

  setBotVerbose(botName: string, chatId: string, verbose: boolean): void {
    this.db.prepare(`
      INSERT INTO bot_chat_settings (bot_name, chat_id, verbose, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET
        verbose = excluded.verbose,
        updated_at = excluded.updated_at
    `).run(botName, chatId, verbose ? 1 : 0, Date.now());
  }

  getBotVerbose(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`
      SELECT verbose FROM bot_chat_settings
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;
    return !!row?.verbose;
  }

  setBotLiveStatus(botName: string, chatId: string, on: boolean): void {
    this.db.prepare(`
      INSERT INTO bot_chat_settings (bot_name, chat_id, live_status, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET
        live_status = excluded.live_status,
        updated_at = excluded.updated_at
    `).run(botName, chatId, on ? 1 : 0, Date.now());
  }

  getBotLiveStatus(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`
      SELECT live_status FROM bot_chat_settings
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;
    return row ? row.live_status !== 0 : true;
  }

  setBotMode(botName: string, chatId: string, mode: BotChatMode): void {
    const freeDiscussion = mode === "free" ? 1 : 0;
    this.db.prepare(`
      INSERT INTO bot_chat_settings (bot_name, chat_id, mode, free_discussion, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET
        mode = excluded.mode,
        free_discussion = excluded.free_discussion,
        updated_at = excluded.updated_at
    `).run(botName, chatId, mode, freeDiscussion, Date.now());
  }

  getBotMode(botName: string, chatId: string): BotChatMode {
    const row = this.db.prepare(`
      SELECT mode, free_discussion FROM bot_chat_settings
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;
    if (row?.mode === "free" || row?.mode === "mute" || row?.mode === "normal") return row.mode;
    return row?.free_discussion ? "free" : "normal";
  }

  setBotFreeDiscussion(botName: string, chatId: string, on: boolean): void {
    this.setBotMode(botName, chatId, on ? "free" : "normal");
  }

  getBotFreeDiscussion(botName: string, chatId: string): boolean {
    return this.getBotMode(botName, chatId) === "free";
  }

  getChatInfo(chatId: string): ChatInfo | null {
    const row = this.db.prepare(`SELECT * FROM chat_info WHERE chat_id = ?`).get(chatId) as any;
    if (!row) return null;
    return {
      chatId: row.chat_id,
      chatType: row.chat_type,
      chatName: row.chat_name,
      members: row.members,
      memberNames: row.member_names,
      ownerBot: row.owner_bot || '',
      freeDiscussion: !!row.free_discussion,
      verbose: !!row.verbose,
      discuss: !!row.discuss,
      discussMaxRounds: row.discuss_max_rounds || 10,
      chairmanBot: row.chairman_bot || '',
      locale: row.locale || '',
      updatedAt: row.updated_at,
    };
  }

  getAllChatInfo(): ChatInfo[] {
    const rows = this.db.prepare(`SELECT * FROM chat_info ORDER BY updated_at DESC`).all() as any[];
    return rows.map((r: any) => ({
      chatId: r.chat_id,
      chatType: r.chat_type,
      chatName: r.chat_name,
      members: r.members,
      memberNames: r.member_names,
      ownerBot: r.owner_bot || '',
      freeDiscussion: !!r.free_discussion,
      verbose: !!r.verbose,
      discuss: !!r.discuss,
      discussMaxRounds: r.discuss_max_rounds || 10,
      chairmanBot: r.chairman_bot || '',
      locale: r.locale || '',
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Check if a message already exists in the store.
   */
  hasMessage(messageId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM messages WHERE message_id = ?`).get(messageId);
    return !!row;
  }

  /**
   * Get total message count for a chat.
   */
  getMessageCount(chatId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?`).get(chatId) as any;
    return row?.cnt || 0;
  }

  /**
   * Check if a specific bot has already processed a message.
   */
  hasBotProcessed(botName: string, messageId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM processed_events WHERE bot_name = ? AND message_id = ?`).get(botName, messageId);
    return !!row;
  }

  /**
   * Mark a message as processed by a specific bot.
   */
  markBotProcessed(botName: string, messageId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO processed_events (bot_name, message_id) VALUES (?, ?)`).run(botName, messageId);
  }

  tryMarkBotProcessed(botName: string, messageId: string): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO processed_events (bot_name, message_id) VALUES (?, ?)`).run(botName, messageId);
    return result.changes === 1;
  }

  // --- Go / Go-Checker supervision (DESIGN.md §10) ---

  createGoJob(j: {
    botName: string; chatId: string; goal: string; acceptance: string;
    executorSessionKey: string; executorSessionId: string;
    checkerSessionKey: string; checkerModel: string; state?: "STARTING" | "WAITING_WORK";
  }): number {
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO go_jobs
      (bot_name, chat_id, goal, acceptance, state, executor_session_key, executor_session_id, checker_session_key, checker_model, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(j.botName, j.chatId, j.goal, j.acceptance, j.state || "WAITING_WORK", j.executorSessionKey, j.executorSessionId, j.checkerSessionKey, j.checkerModel, now, now);
    return Number(r.lastInsertRowid);
  }

  private rowToGoJob(row: any): GoJobRow {
    return {
      id: row.id, botName: row.bot_name, chatId: row.chat_id, goal: row.goal, acceptance: row.acceptance,
      state: row.state, executorSessionKey: row.executor_session_key, executorSessionId: row.executor_session_id,
      checkerSessionKey: row.checker_session_key, checkerModel: row.checker_model, revision: row.revision,
      continueCount: row.continue_count, waitStreak: row.wait_streak, stagnantCount: row.stagnant_count,
      parseRetries: row.parse_retries, evidenceWatermark: row.evidence_watermark,
      lastMissingJson: row.last_missing_json, lastVerdict: row.last_verdict, lastVerdictSummary: row.last_verdict_summary,
      pauseReason: row.pause_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getActiveGoJob(botName: string, chatId: string): GoJobRow | null {
    const row = this.db.prepare(`SELECT * FROM go_jobs WHERE bot_name=? AND chat_id=? AND state NOT IN ('COMPLETED','STOPPED') ORDER BY id DESC LIMIT 1`).get(botName, chatId) as any;
    return row ? this.rowToGoJob(row) : null;
  }

  getGoJobById(id: number): GoJobRow | null {
    const row = this.db.prepare(`SELECT * FROM go_jobs WHERE id=?`).get(id) as any;
    return row ? this.rowToGoJob(row) : null;
  }

  listActiveGoJobs(botName?: string): GoJobRow[] {
    const rows = botName
      ? this.db.prepare(`SELECT * FROM go_jobs WHERE bot_name=? AND state NOT IN ('COMPLETED','STOPPED')`).all(botName)
      : this.db.prepare(`SELECT * FROM go_jobs WHERE state NOT IN ('COMPLETED','STOPPED')`).all();
    return (rows as any[]).map((r) => this.rowToGoJob(r));
  }

  /** CAS update: only applies when the current revision matches. Returns success. */
  updateGoJobCas(id: number, expectedRevision: number, patch: Partial<Record<"state" | "pauseReason" | "continueCount" | "waitStreak" | "stagnantCount" | "parseRetries" | "evidenceWatermark" | "lastMissingJson" | "lastVerdict" | "lastVerdictSummary" | "executorSessionId", unknown>>): boolean {
    const sets: string[] = [];
    const vals: any[] = [];
    const colMap: Record<string, string> = {
      state: "state", pauseReason: "pause_reason", continueCount: "continue_count", waitStreak: "wait_streak",
      stagnantCount: "stagnant_count", parseRetries: "parse_retries", evidenceWatermark: "evidence_watermark",
      lastMissingJson: "last_missing_json", lastVerdict: "last_verdict", lastVerdictSummary: "last_verdict_summary",
      executorSessionId: "executor_session_id",
    };
    for (const [k, v] of Object.entries(patch)) {
      const col = colMap[k];
      if (!col) continue;
      sets.push(`${col}=?`);
      vals.push(v as any);
    }
    if (sets.length === 0) return false;
    sets.push("revision=revision+1", "updated_at=?");
    vals.push(Date.now());
    const r = this.db.prepare(`UPDATE go_jobs SET ${sets.join(", ")} WHERE id=? AND revision=?`).run(...vals, id, expectedRevision);
    return r.changes === 1;
  }

  /** Insert evidence; returns the new event seq, or -1 when deduplicated. */
  insertGoEvent(goId: number, sourceKey: string, kind: string, content: string): number {
    const r = this.db.prepare(`INSERT OR IGNORE INTO go_events (go_id, source_key, kind, content, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(goId, sourceKey, kind, content, Date.now());
    if (r.changes === 0) return -1;
    return Number(r.lastInsertRowid);
  }

  listGoEventsSince(goId: number, afterSeq: number): Array<{ seq: number; kind: string; sourceKey: string; content: string; delivered: number }> {
    const rows = this.db.prepare(`SELECT id, kind, source_key, content, delivered FROM go_events WHERE go_id=? AND id>? ORDER BY id`).all(goId, afterSeq) as any[];
    return rows.map((r) => ({ seq: r.id, kind: r.kind, sourceKey: r.source_key, content: r.content, delivered: r.delivered }));
  }

  maxGoEventSeq(goId: number): number {
    const r = this.db.prepare(`SELECT MAX(id) AS m FROM go_events WHERE go_id=?`).get(goId) as any;
    return r?.m || 0;
  }

  insertGoCheck(goId: number, checkId: string, evidenceMaxSeq: number): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO go_checks (go_id, check_id, evidence_max_seq, state, created_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(goId, checkId, evidenceMaxSeq, Date.now()).changes === 1;
  }

  finishGoCheck(goId: number, checkId: string, state: string, action: string, summary: string, raw: string): void {
    this.db.prepare(`UPDATE go_checks SET state=?, action=?, summary=?, raw=? WHERE go_id=? AND check_id=?`)
      .run(state, action, summary, raw.slice(0, 4000), goId, checkId);
  }

  /** Idempotent action claim: returns true when newly claimed (caller performs the action), false when it already existed. */
  claimGoAction(goId: number, actionKey: string, kind: string, payload: string): boolean {
    this.recordGoActionAttempt(goId, actionKey);
    return this.db.prepare(`INSERT OR IGNORE INTO go_actions (go_id, action_key, kind, payload, done, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .run(goId, actionKey, kind, payload, Date.now()).changes === 1;
  }

  hasUnresolvedGoActions(goId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM go_actions WHERE go_id=? AND done=0 LIMIT 1`).get(goId) || this.listUnresolvedGoSends(goId).length>0 || this.hasUnknownGoRunResults(goId);
  }

  completeGoAction(goId: number, actionKey: string, receipt: string): void {
    this.recordGoActionOutcome(goId, actionKey, "accepted", receipt);
    this.db.prepare(`UPDATE go_actions SET done=1, receipt=? WHERE go_id=? AND action_key=?`).run(receipt.slice(0, 500), goId, actionKey);
  }

  setGoModelPref(botName: string, chatId: string, model: string | null): void {
    this.db.prepare(`INSERT INTO go_model_prefs (bot_name, chat_id, model, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_name, chat_id) DO UPDATE SET model=excluded.model, updated_at=excluded.updated_at`)
      .run(botName, chatId, model, Date.now());
  }

  getGoModelPref(botName: string, chatId: string): string | null {
    const r = this.db.prepare(`SELECT model FROM go_model_prefs WHERE bot_name=? AND chat_id=?`).get(botName, chatId) as any;
    return r?.model ?? null;
  }

  private closeObservers = new Set<() => void>();
  onClose(callback: () => void) { this.closeObservers.add(callback); return () => this.closeObservers.delete(callback); }

  close() {
    for (const observer of this.closeObservers) observer();
    this.closeObservers.clear();
    this.db.close();
  }
}
