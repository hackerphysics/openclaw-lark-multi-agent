import { randomUUID } from "node:crypto";
import { MessageStore } from "./message-store.js";
import { LiveStatusController, LiveStatusEffectRejectedError, LiveStatusEffectUnknownError, LiveStatusEffectSuppressedError,
  type LiveStatusCallbacks, type LiveStatusView } from "./live-status.js";

/** UI-only identity. Nothing in this journal may grant business admission,
 * select a run, flip Get/DONE or authorize a business retry. */
type Presentation = {
  id: string; chatId: string; messageId: string; triggerIds: number[]; stopEpoch: number;
  startedAt: number; lease: string; runId?: string; ownerId?: string; batchId?: string;
  createToken?: string; submissionId?: string; ordinaryTriggerIds?: number[]; enqueueAcceptedIds?: number[]; expectedInsertionRoot?: string; acceptedIds?: number[]; insertionRoot?: string; cardId?: string; create: "never" | "attempted" | "accepted" | "unknown" | "rejected";
  editEffects?: Record<string, "attempted" | "unknown">;
  view?: LiveStatusView; retired?: boolean;
};
type Entry = { record: Presentation; live: LiveStatusController };
type JournalRepair = {
  record: Presentation;
  create?: { token: string; lease: string; state: Presentation["create"]; cardId?: string };
  edits: Map<string, { lease: string; state: "unknown" | "clear" }>;
};

/** One unbound cohort per chat, or reuse the exact active-root presentation.
 * Known IDs and desired phase survive restart. Unknown effects are fenced, not
 * retried: the SDK offers no durable query-by-create-key or edit CAS. */
export class QueuedPresentations {
  private entries = new Map<string, Entry>();
  /** Receipt custody only: never a business busy/admission flag or SDK retry. */
  private repairs = new Map<string, JournalRepair>();
  private repairTimer?: ReturnType<typeof setTimeout>;
  private repairDelay = 1000;
  private repairing = false;
  private disposed = false;
  constructor(private readonly storeSource: MessageStore | (() => MessageStore), private readonly bot: string, private readonly app: string,
    private readonly callbacks: (chat: string, replyTo: string) => LiveStatusCallbacks,
    private readonly enabled: (chat: string) => boolean, private readonly english: (chat: string) => boolean) {}

  private get store(): MessageStore { return typeof this.storeSource === "function" ? this.storeSource() : this.storeSource; }

  private normalize(row: Presentation): Presentation {
    // V1 could label expected legacy insertion roots as actual owners. Reopen
    // them as enqueue-only custody; do not repair/promote any business row.
    if (row.runId && (!row.ownerId || !row.batchId)) {
      row.expectedInsertionRoot = row.expectedInsertionRoot || row.insertionRoot || row.runId;
      delete row.runId;
    }
    return row;
  }
  private records(chat: string): Presentation[] { return this.store.listPresentations(this.bot, this.app, chat).map((row: Presentation) => this.observeJournal(row)); }
  private latest(record: Presentation): Presentation | undefined {
    const row = this.store.getPresentation(this.bot, this.app, record.chatId, record.id);
    return row ? this.observeJournal(row) : undefined;
  }
  /** Overlay actual receipts before any later UI decision. Fresh metadata,
   * lease/epoch/retirement and every unrelated unknown token remain untouched. */
  private withReceipts(record: Presentation): Presentation {
    const repair = this.repairs.get(record.id);
    if (!repair) return record;
    const row = { ...record, editEffects: { ...record.editEffects } };
    const create = repair.create;
    if (create?.state === "accepted" && create.cardId) {
      if (row.cardId && row.cardId !== create.cardId) throw new Error("conflicting presentation create receipts; no UI retry");
      if (row.createToken === create.token || row.cardId === create.cardId) {
        row.cardId = create.cardId; row.create = "accepted";
      }
    } else if (create && row.createToken === create.token && !row.cardId) {
      row.create = create.state;
      if (create.state === "never") delete row.createToken; // proven zero SDK
    }
    for (const [token, receipt] of repair.edits) {
      if (receipt.state === "clear") delete row.editEffects![token];
      else if (row.editEffects![token] || row.lease === receipt.lease) row.editEffects![token] = "unknown";
    }
    return row;
  }
  private save(record: Presentation): void {
    const row = this.withReceipts(record);
    this.store.savePresentation(this.bot, this.app, row.chatId, row.id, row);
    this.acknowledgeJournal(row);
  }
  private observeJournal(record: Presentation): Presentation {
    this.acknowledgeJournal(record);
    return this.withReceipts(this.normalize(record));
  }
  private acknowledgeJournal(row: Presentation): void {
    const repair = this.repairs.get(row.id);
    if (repair) {
      const create = repair.create;
      if (create && (create.state === "accepted" ? row.cardId === create.cardId && row.create === "accepted"
        : row.createToken !== create.token || row.create === create.state || row.create === "accepted")) repair.create = undefined;
      for (const [token, receipt] of repair.edits) if (receipt.state === "clear" ? !row.editEffects?.[token]
        : row.editEffects?.[token] === "unknown" || !row.editEffects?.[token] && row.lease !== receipt.lease) repair.edits.delete(token);
      if (!repair.create && !repair.edits.size) this.repairs.delete(row.id);
    }
    if (!this.repairs.size) { clearTimeout(this.repairTimer); this.repairTimer = undefined; this.repairDelay = 1000; }
  }
  private repairFor(record: Presentation): JournalRepair {
    let repair = this.repairs.get(record.id);
    if (!repair) { repair = { record, edits: new Map() }; this.repairs.set(record.id, repair); }
    return repair;
  }
  private createReceipt(record: Presentation, token: string, state: Presentation["create"], cardId?: string): void {
    const repair = this.repairFor(record);
    if (repair.create?.state !== "accepted" || state === "accepted") repair.create = { token, lease: record.lease, state, cardId };
    this.scheduleRepair(true);
  }
  private editReceipt(record: Presentation, token: string, state: "unknown" | "clear"): void {
    const repair = this.repairFor(record);
    if (repair.edits.get(token)?.state !== "clear" || state === "clear") repair.edits.set(token, { lease: record.lease, state });
    this.scheduleRepair(true);
  }
  private scheduleRepair(immediate = false): void {
    if (this.disposed || this.repairTimer || !this.repairs.size) return;
    // A macrotask lets the D2 adopter receive the SDK ID/success first. A
    // failed local write backs off; no timer ever invokes create/edit transport.
    this.repairTimer = setTimeout(() => { this.repairTimer = undefined; this.flushRepairs(); }, immediate ? 0 : this.repairDelay);
    this.repairTimer.unref?.();
  }
  private flushRepairs(): void {
    if (this.repairing || !this.repairs.size) return;
    clearTimeout(this.repairTimer); this.repairTimer = undefined;
    this.repairing = true;
    let failed = false;
    for (const repair of [...this.repairs.values()].slice(0, 32)) {
      try {
        const row = this.store.getPresentation(this.bot, this.app, repair.record.chatId, repair.record.id);
        if (!row) throw new Error("presentation receipt journal row unavailable");
        this.acknowledgeJournal(row);
        if (this.repairs.has(row.id)) this.save(this.normalize(row));
      } catch {
        failed = true;
        // Rotate failures so one unavailable cohort cannot starve another.
        this.repairs.delete(repair.record.id); this.repairs.set(repair.record.id, repair);
      }
    }
    this.repairing = false;
    if (failed) this.repairDelay = Math.min(30_000, this.repairDelay * 2);
    this.scheduleRepair();
  }
  private usable(row: Presentation): boolean {
    return !row.retired && row.stopEpoch === this.store.getStopGeneration(this.bot, row.chatId)
      && row.view?.state !== "done" && row.view?.state !== "failed";
  }
  private current(record: Presentation): boolean {
    const row = this.latest(record);
    return !!row && this.usable(row) && row.lease === record.lease && this.enabled(record.chatId);
  }
  private hydrate(record: Presentation): Entry {
    const cached = this.entries.get(record.id);
    if (cached && cached.record.lease === record.lease) return cached;
    if (cached) { cached.live.dispose(); this.entries.delete(record.id); }
    record = { ...record, lease: randomUUID() };
    this.save(record); // fences callbacks from any replaced process/manager
    const base = this.callbacks(record.chatId, record.messageId);
    const desired = (view: LiveStatusView) => {
      try {
        this.flushRepairs();
        const row = this.latest(record);
        if (!row || row.lease !== record.lease || row.retired || row.stopEpoch !== this.store.getStopGeneration(this.bot, row.chatId)) return;
        // Elapsed-only ticking is derived from startedAt after restart. Do not
        // rewrite desired custody twice for the same phase/content snapshot.
        if (row.view && JSON.stringify({ ...row.view, elapsed: undefined }) === JSON.stringify({ ...view, elapsed: undefined })) return;
        // UI journal outages may suppress UI effects, never business admission.
        // Actual effect checkpoints still MUST succeed before transport.
        this.save({ ...row, view });
      } catch (err) { base.warn?.("presentation desired checkpoint unavailable", err); }
    };
    const live = new LiveStatusController({
      warn: base.warn,
      desired,
      unconfirmedInputs: outcome => {
        try {
          const row = this.latest(record);
          if (!row) return { title: `${this.bot} input status unconfirmed`, detail: "输入保管状态未确认；不把 root 终局当作所有输入完成" };
          const ordinary = row.runId && row.ownerId && row.batchId ? (row.ordinaryTriggerIds || row.triggerIds.filter(id => {
            const insertion = this.store.getInsertion(this.bot, row.chatId, id);
            return !insertion || insertion.state === "ordinary";
          })) : [];
          const pending = row.triggerIds.filter(id => {
            const insertion = this.store.getInsertion(this.bot, row.chatId, id);
            return !ordinary.includes(id) || !!insertion && insertion.state !== "ordinary";
          });
          if (!pending.length) return undefined;
          const en = this.english(row.chatId);
          return {
            title: en ? `${this.bot} ${ordinary.length ? outcome === "failed" ? "run ended · " : "partial result · " : ""}input confirmation pending`
              : `${this.bot} ${ordinary.length ? outcome === "failed" ? "本轮结束 · " : "部分完成 · " : ""}追加输入回执待确认`,
            detail: en ? `${pending.length} additional input(s) have only local/enqueue receipts; actual receiver, commitment and result are unconfirmed. Root completion covers only ordinary inputs; no automatic replay.`
              : `${pending.length} 条追加输入仅确认本地收件/进入队列；实际接收方、提交及处理结果未确认。root 结果仅覆盖普通输入；保留观察，不重放。`,
          };
        } catch { return { title: `${this.bot} input status unconfirmed`, detail: "输入保管状态暂不可读；完成范围未确认，不显示全部完成" }; }
      },
      create: async (view, effect) => {
        const token = randomUUID();
        let attempted = false, settled = false;
        try {
          const result = await base.create(view, { run: send => effect.run(async () => {
            try {
              const row = this.latest(record);
              if (!this.current(record)) throw new LiveStatusEffectSuppressedError("presentation create suppressed before transport");
              if (row?.create !== "never") throw new LiveStatusEffectUnknownError("this presentation create already attempted");
              if (this.records(record.chatId).some(other => other.id !== record.id && !other.retired && other.stopEpoch === row.stopEpoch
                && other.triggerIds.some(id => row.triggerIds.includes(id))
                && ["attempted", "unknown", "accepted"].includes(other.create))) throw new LiveStatusEffectUnknownError("overlapping input presentation create unresolved");
              // A failed preflight, even a write-then-throw, is proven zero SDK.
              try { this.save({ ...row, create: "attempted", createToken: token }); }
              catch (err) { this.createReceipt(record, token, "never"); throw err; }
            } catch (err) {
              if (err instanceof LiveStatusEffectUnknownError || err instanceof LiveStatusEffectSuppressedError) throw err;
              throw new LiveStatusEffectSuppressedError("presentation create checkpoint unavailable before SDK");
            }
            attempted = true;
            let id: string | undefined;
            try { id = await send(); }
            catch (err) {
              settled = true;
              this.createReceipt(record, token, err instanceof LiveStatusEffectRejectedError ? "rejected" : "unknown");
              throw err;
            }
            settled = true;
            // Memory first; no post-SDK journal error may swallow this ID or
            // enter the transport catch. D2 adopts before the repair macrotask.
            this.createReceipt(record, token, id ? "accepted" : "unknown", id);
            return id;
          }) });
          // The adapter's effect context has already delivered the ID to D2.
          this.flushRepairs();
          return result;
        } catch (err) {
          if (attempted && !settled) this.createReceipt(record, token, "unknown"); // outer deadline, not cancellation
          throw err;
        }
      },
      edit: async (id, view, effect) => {
        const token = randomUUID();
        let attempted = false, settled = false;
        try {
          await base.edit(id, view, { run: send => effect.run(async () => {
            try {
              const row = this.latest(record);
              if (!row || row.lease !== record.lease || row.retired || row.stopEpoch !== this.store.getStopGeneration(this.bot, row.chatId)
                || !this.enabled(row.chatId) || row.cardId !== id) throw new LiveStatusEffectSuppressedError("presentation edit suppressed before transport");
              try { this.save({ ...row, editEffects: { ...row.editEffects, [token]: "attempted" } }); }
              catch (err) { this.editReceipt(record, token, "clear"); throw err; }
            } catch (err) {
              if (err instanceof LiveStatusEffectSuppressedError) throw err;
              throw new LiveStatusEffectSuppressedError("presentation edit checkpoint unavailable before SDK");
            }
            attempted = true;
            try { await send(); }
            catch (err) {
              settled = true;
              this.editReceipt(record, token, err instanceof LiveStatusEffectRejectedError ? "clear" : "unknown");
              throw err;
            }
            settled = true;
            // Clear only THIS successful token; do not replay the SDK or erase
            // another unknown progress/terminal operation if SQLite is busy.
            this.editReceipt(record, token, "clear");
          }) });
          // D2 has recorded the successful effect before local persistence.
          this.flushRepairs();
        } catch (err) {
          if (attempted && !settled) this.editReceipt(record, token, "unknown");
          throw err;
        }
      },
    }, {
      botName: this.bot, locale: this.english(record.chatId) ? "en" : "zh", initialPhase: "queued",
      restore: { messageId: record.cardId, view: record.view, startedAt: record.startedAt,
        blockCreate: record.create !== "never", blockEdits: Object.keys(record.editEffects || {}).length > 0 },
    });
    const entry = { record, live };
    this.entries.set(record.id, entry);
    return entry;
  }

  receive(chat: string, rowId: number, messageId: string, native = false, activeRunId?: string): LiveStatusController | undefined {
    if (native || !rowId || !this.enabled(chat)) return undefined;
    const rows = this.records(chat).filter(row => this.usable(row));
    // Repeated ingress and steering bursts reuse one card. A foreign/old run
    // is never selected merely because it happens to have a card in this chat.
    let record = rows.find(row => row.triggerIds.includes(rowId))
      || rows.find(row => !row.runId && !row.submissionId)
      || (activeRunId ? rows.find(row => row.runId === activeRunId && row.view?.phase !== "waiting") : undefined);
    if (!record) {
      record = { id: randomUUID(), chatId: chat, messageId, triggerIds: [], stopEpoch: this.store.getStopGeneration(this.bot, chat),
        startedAt: Date.now(), lease: "", create: "never" };
    }
    if (!record.triggerIds.includes(rowId)) record.triggerIds.push(rowId);
    this.save(record); // local receipt already exists; UI record is separate
    const { live } = this.hydrate(record);
    live.received(this.english(chat) ? "Input durably received locally; acceptance not yet confirmed" : "消息已在本地可靠收件；尚未确认 Gateway 接收");
    live.start();
    return live;
  }

  claim(chat: string, ids: number[], ownerId: string, batchId: string, native = false): LiveStatusController | undefined {
    if (native || !this.enabled(chat)) return undefined;
    const row = this.records(chat).find(row => this.usable(row) && !row.runId && (!row.submissionId || row.ownerId === ownerId && row.batchId === batchId) && row.triggerIds.some(id => ids.includes(id)));
    if (!row) return undefined;
    // An ordinary batch may only adopt its own intersecting, unbound cohort.
    row.ownerId = ownerId; row.batchId = batchId;
    row.triggerIds = [...new Set([...row.triggerIds, ...ids])];
    row.ordinaryTriggerIds = [...ids]; // actual ordinary payload membership, not steer ACKs
    this.save(row);
    const live = this.hydrate(row).live;
    live.resumeQueued();
    return live;
  }

  attempted(live: LiveStatusController | undefined, submissionId: string, ownerId: string, batchId: string): void {
    const entry = [...this.entries.values()].find(entry => entry.live === live);
    if (!entry || !submissionId || !this.current(entry.record)) return;
    const row = this.latest(entry.record)!;
    if (row.ownerId !== ownerId || row.batchId !== batchId || row.submissionId && row.submissionId !== submissionId) return;
    // The actual public submission key seals this cohort. It is NOT a run ID.
    row.submissionId = submissionId;
    this.save(row);
  }

  async insertionAccepted(chat: string, rowId: number, expectedRunId: string): Promise<void> {
    const row = this.records(chat).find(row => this.usable(row) && row.triggerIds.includes(rowId)
      && (!row.runId || row.runId === expectedRunId));
    if (!row || !expectedRunId) return;
    // Legacy accepted means enqueue only. expectedRunId is NOT an actual
    // receiver/commitment witness, even when every cohort member has this ACK.
    if (row.expectedInsertionRoot && row.expectedInsertionRoot !== expectedRunId) return;
    row.expectedInsertionRoot = expectedRunId;
    row.enqueueAcceptedIds = [...new Set([...(row.enqueueAcceptedIds || []), rowId])];
    this.save(row);
    const live = this.hydrate(row).live;
    const detail = this.english(chat) ? "Input enqueued; actual receiver, commitment and result unconfirmed" : "追加输入已进入队列；实际接收方、提交及处理结果未确认";
    if (row.runId) live.received(detail); // ordinary A can still show its own real progress
    else await live.showInputWaiting(detail, this.english(chat) ? `${this.bot} enqueued · input confirmation pending` : `${this.bot} 已排队 · 追加输入回执待确认`);
  }

  async settleRun(chat: string, runId: string): Promise<void> {
    if (!runId || !this.enabled(chat)) return;
    for (const row of this.records(chat)) if (this.usable(row) && row.runId === runId) await this.hydrate(row).live.complete();
  }

  async admit(live: LiveStatusController | undefined, runId: string, ownerId: string, batchId: string): Promise<void> {
    if (!live || !runId) return;
    const entry = [...this.entries.values()].find(entry => entry.live === live);
    if (!entry || !this.current(entry.record)) return;
    const row = this.latest(entry.record)!;
    if (row.ownerId !== ownerId || row.batchId !== batchId || (row.runId && row.runId !== runId)) return;
    row.runId = runId; this.save(row);
    await live.admitted();
  }

  /** A deliberate same-task continuation has its own real ACK. Never infer
   * this transfer from activity, elapsed time or an unrelated proactive final. */
  async advance(live: LiveStatusController | undefined, previousRunId: string | undefined, runId: string, ownerId: string, batchId: string): Promise<void> {
    const entry = [...this.entries.values()].find(entry => entry.live === live);
    if (!entry || !previousRunId || !runId || !this.current(entry.record)) return;
    const row = this.latest(entry.record)!;
    if (row.runId !== previousRunId || row.ownerId !== ownerId || row.batchId !== batchId) return;
    row.runId = runId;
    this.save(row);
    await live!.admitted(true);
  }

  forTarget(chat: string, runId: string, live?: LiveStatusController): LiveStatusController | undefined {
    if (!live) return this.forRun(chat, runId);
    const entry = [...this.entries.values()].find(entry => entry.live === live);
    // Existing discussion/custom controllers retain their original contract.
    if (!entry) return live;
    const row = this.latest(entry.record);
    return row && this.usable(row) && row.runId === runId ? live : undefined;
  }

  forRun(chat: string, runId: string): LiveStatusController | undefined {
    if (!runId || !this.enabled(chat)) return undefined;
    const row = this.records(chat).find(row => this.usable(row) && row.runId === runId);
    return row ? this.hydrate(row).live : undefined;
  }

  retire(chat: string): void {
    // Stop old callbacks even when the UI journal is temporarily unavailable.
    for (const entry of this.entries.values()) if (entry.record.chatId === chat) entry.live.dispose();
    for (const row of this.records(chat)) {
      if (row.retired) continue;
      this.save({ ...row, retired: true });
      this.entries.get(row.id)?.live.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.repairTimer); this.repairTimer = undefined;
    this.flushRepairs(); // one best-effort journal-only shutdown pass, never SDK
    for (const entry of this.entries.values()) entry.live.dispose();
    this.entries.clear();
  }
}
