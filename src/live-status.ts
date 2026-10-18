import type { ProgressEvent } from "./openclaw-client";

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS || 800);
const DEFAULT_MAX_CHARS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS || 120);
// How many recent activity lines to keep in the card content area.
const DEFAULT_HISTORY = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_HISTORY || 6);
// How often to refresh the elapsed-time footer even when no new activity arrives,
// so the "已用时间" ticks like a live timer. Interactive-card patch has no 20-edit
// cap (unlike text edit), so a 1s cadence is fine.
const DEFAULT_TICK_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_TICK_MS || 1000);
// How many CONSECUTIVE card-edit failures to tolerate before giving up on the
// card. Feishu's im.message.patch can intermittently return code=2200
// "Internal Error" (a transient server-side error); a single failure must not
// freeze the live-status card for the rest of a long run. We skip the failed
// tick, keep the ticker alive, and only disable after this many in a row.
const MAX_CONSECUTIVE_EDIT_FAILURES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_EDIT_FAILURES || 5);

/** One activity line shown in the card content area. */
export type LiveStatusLine = {
  kind: "tool_start" | "tool_end" | "text" | "lifecycle" | "summary" | "steer";
  text: string;
  /** Relative time (seconds since run start) when this line was produced. */
  at: number;
};

/** Structured snapshot the renderer turns into a Feishu interactive card. */
export type LiveStatusView = {
  /** Card title, e.g. "Claude 正在执行" / "✅ Claude 已完成". */
  title: string;
  /** Activity lines (oldest first); when finished this holds a summary instead. */
  lines: LiveStatusLine[];
  /** Footer: elapsed time like "0:42". */
  elapsed: string;
  /** Footer: model name, e.g. "phgeek-gw/claude-opus-4.8". */
  model?: string;
  /** Footer: current thinking level label, e.g. "high" / "adaptive". */
  thinkingLevel?: string;
  /** Total tool calls in the run (for the compact finished summary). */
  toolCalls: number;
  /** True when finished via noReply(): the model produced no user-visible reply. */
  noReply: boolean;
  /** Presentation only: queued/admitted do not claim model execution. */
  state: "queued" | "admitted" | "running" | "done" | "failed";
  phase?: "queued" | "admitted" | "working" | "waiting" | "done" | "failed";
};

/** Persisted metadata needed to turn the live-status card into the final answer. */
export type LiveStatusFinalMeta = {
  messageId: string;
  toolCalls: number;
  elapsed: string;
  model?: string;
  thinkingLevel?: string;
  locale: "zh" | "en";
  noReply?: boolean;
};

/** Optional external presentation owner (e.g. the durable outbox). A local
 * execution outcome is NOT a platform delivery receipt. Once handed off, late
 * card effects request reconciliation from this owner instead of writing a
 * compact done view over its possibly-unknown final payload. */
export type LiveStatusTerminalOwner = {
  onReconcileNeeded: (meta: LiveStatusFinalMeta) => void | Promise<void>;
};

/** The adapter MUST call run inside its ordered callback, immediately around
 * the actual SDK invocation. Its receipt survives an outer queue deadline. */
export type LiveStatusEffect<T> = {
  run: (send: () => Promise<T>) => Promise<T | undefined>;
};

/** A transport/observation error is not proof that a platform effect failed. */
export class LiveStatusEffectUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("live status effect outcome unknown");
    this.name = "LiveStatusEffectUnknownError";
  }
}

/** Only a definitive platform rejection is safe for the terminal retry loop. */
export class LiveStatusEffectRejectedError extends Error {}

/** Proven local no-effect suppression (settings/epoch/lease), not an unknown
 * transport outcome and not permission to retry an attempted SDK operation. */
export class LiveStatusEffectSuppressedError extends Error {}

type EditRequest = {
  view: LiveStatusView;
  generation: number;
  priority: boolean;
  force: boolean;
  started: boolean;
  settled: boolean;
  accepted: boolean;
  rejection?: LiveStatusEffectRejectedError;
};

export type LiveStatusCallbacks = {
  /** Create the status card; returns the new message id. */
  create: (view: LiveStatusView, effect: LiveStatusEffect<string | undefined>) => Promise<string | undefined>;
  /** Patch the existing status card. Reject with LiveStatusEffectRejectedError
   * only for a definitive no-effect failure; all other rejection is unknown. */
  edit: (messageId: string, view: LiveStatusView, effect: LiveStatusEffect<void>) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
  /** Synchronous journal checkpoint, before scheduling any new UI effect. */
  desired?: (view: LiveStatusView) => void;
  /** UI-only cohort completeness. A root outcome is not per-input proof. */
  unconfirmedInputs?: (outcome: "done" | "failed") => { title: string; detail: string } | undefined;
};

export type LiveStatusOptions = {
  botName: string;
  initialPhase?: "queued";
  restore?: { messageId?: string; view?: LiveStatusView; startedAt: number; blockCreate: boolean; blockEdits: boolean };
  locale?: "zh" | "en";
  delayMs?: number;
  maxChars?: number;
  /** Model name shown in the footer. */
  model?: string;
  /** Thinking level label shown after the model name in the footer. */
  thinkingLevel?: string;
  /** Number of recent activity lines kept in the content area. */
  historySize?: number;
  /** Footer/auto-refresh cadence in ms. */
  tickMs?: number;
};

export class LiveStatusController {
  private messageId?: string;
  private lastSentSignature = "";
  /** Recent activity lines (most-recent last), capped at historySize. */
  private lines: LiveStatusLine[] = [];
  private startedAt = Date.now();
  private createTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private createPromise?: Promise<void>;
  private createSuppressed = false;
  private waitingCreateAllowed = false;
  private finalized = false;
  private terminalOutcome = false;
  private disposed = false;
  private generation = 0;
  /** Frozen/terminal presentation wins over every older progress snapshot. */
  private pinnedView?: LiveStatusView;
  private terminalOwner?: LiveStatusTerminalOwner;
  private pendingEdit?: EditRequest;
  private editPump?: Promise<void>;
  /** Timed-out SDK effects retain receipt ownership, but must not be replayed. */
  private unknownEdits = new Set<EditRequest>();
  private waitingForResult = false;
  private updatesFrozen = false;
  private disabled = false;
  /** Consecutive safeEdit failures. A single transient Feishu error (e.g. card
   *  patch code=2200 "Internal Error") must NOT permanently disable the card:
   *  we skip that one tick and keep the ticker running, so the next second's
   *  patch recovers it. Only after this many CONSECUTIVE failures do we give up.
   *  A success resets the counter. */
  private consecutiveEditFailures = 0;
  private state: LiveStatusView["state"] = "running";
  private blockedEdits = false;
  /** Total tool calls (tool_start events) seen during the run, for the summary. */
  private toolCallCount = 0;
  /** True when finished via noReply(): show a "no content" summary. */
  private noReplyResult = false;

  constructor(private readonly callbacks: LiveStatusCallbacks, private readonly opts: LiveStatusOptions) {
    if (opts.initialPhase) this.state = opts.initialPhase;
    const restored = opts.restore;
    if (restored) {
      this.messageId = restored.messageId;
      this.startedAt = restored.startedAt;
      this.blockedEdits = restored.blockEdits;
      if (restored.view) {
        this.state = restored.view.state;
        this.lines = restored.view.lines.map(line => ({ ...line }));
        this.toolCallCount = restored.view.toolCalls;
        this.noReplyResult = restored.view.noReply;
        this.waitingForResult = restored.view.phase === "waiting";
        this.updatesFrozen = this.waitingForResult;
      }
      // Attempted/unknown create survives process loss as a no-create fence.
      if (restored.blockCreate && !this.messageId) this.disabled = true;
    }
  }

  /** Receipt is durable locally, NOT Gateway admission. */
  received(detail: string): void {
    if (this.finalized || this.disposed) return;
    this.pushLine("lifecycle", detail);
    this.callbacks.desired?.(this.buildView());
    void this.safeEdit(this.buildView());
  }

  /** A proven never-attempted ordinary recovery may reuse its queued card.
   * Merely observing an expected root never calls this method. */
  resumeQueued(): void {
    if (this.disposed || this.terminalOutcome) return;
    this.finalized = false;
    this.updatesFrozen = false;
    this.waitingForResult = false;
    this.waitingCreateAllowed = false;
    this.state = "queued";
    this.generation++;
    this.pinnedView = undefined;
    this.pendingEdit = undefined;
    this.callbacks.desired?.(this.buildView());
    if (this.messageId) { this.startTicker(); void this.safeEdit(this.buildView()); }
    else this.start();
  }

  /** Enqueue/local receipt remains waiting, not actual-owner/model evidence.
   * Keep one latest pinned view while allowing another input to coalesce. */
  async showInputWaiting(detail: string, title?: string): Promise<void> {
    if (this.disposed || this.terminalOutcome) return;
    this.updatesFrozen = true;
    this.waitingForResult = true;
    this.waitingCreateAllowed = !this.messageId && !this.disabled;
    this.pushLine("lifecycle", detail);
    this.stopTimers();
    const view = this.buildView();
    if (title) view.title = title;
    // A quick enqueue receipt must not cancel the only queued card before it
    // ever existed. Still exactly one create flight, with the normal unknown
    // fence and effect-time settings/lease checks, never a terminal retry.
    if (!this.messageId && !this.createPromise && !this.disabled) {
      this.pinView(view);
      this.createPromise = this.ensureCreated();
    }
    await this.finishView(view);
  }

  /** Only the exact ACK owner calls this; admission is not model execution. */
  async admitted(successor = false): Promise<void> {
    if (this.finalized || this.disposed || (!successor && this.state !== "queued")) return;
    this.waitingForResult = false;
    this.state = "admitted";
    this.pushLine("lifecycle", this.opts.locale === "en" ? "Gateway accepted; waiting for activity" : "Gateway 已接收，等待执行活动");
    this.callbacks.desired?.(this.buildView());
    await this.safeEdit(this.buildView());
  }

  get id(): string | undefined { return this.messageId; }

  start(initialDetail?: string): void {
    if (this.createSuppressed) { this.createPromise = undefined; this.createSuppressed = false; }
    if (this.disabled || this.finalized || (this.updatesFrozen && !this.waitingCreateAllowed) || this.createTimer || this.createPromise || this.messageId) return;
    if (!this.opts.restore) this.startedAt = Date.now();
    // Presentation may start before chat.send admission. Only the collector's
    // effective-activity idle decision (or confirmed yield) freezes this card;
    // elapsed ticks are presentation, never evidence of task progress.
    if (initialDetail && initialDetail.trim()) {
      this.pushLine("lifecycle", initialDetail.trim());
    }
    this.callbacks.desired?.(this.buildView());
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  setMetadata(model?: string, thinkingLevel?: string): void {
    if (this.disposed || this.finalized) return;
    this.opts.model = model;
    this.opts.thinkingLevel = thinkingLevel;
    this.callbacks.desired?.(this.buildView());
  }

  async progress(event: ProgressEvent | string): Promise<void> {
    if (this.disabled || this.finalized) return;
    if (this.updatesFrozen) {
      // Keep only the cheap local counter for the eventual one-time summary.
      if (typeof event !== "string" && event.kind === "tool" && event.phase === "start") this.toolCallCount++;
      return;
    }
    // Card patch has no 20-edit cap (verified against Feishu im.message.patch),
    // so we can show a small rolling window of recent activity: tool start, tool
    // end, and intermediate assistant text each count as one line. We ignore
    // tool "error" (the error is delivered through the normal message path) and
    // lifecycle ticks after the first.
    if (typeof event === "string") {
      const t = event.trim();
      if (!t || this.isNoReplyText(t)) return;
      this.appendText(t);
    } else if (event.kind === "tool") {
      if (event.phase === "start") { this.toolCallCount++; this.pushLine("tool_start", this.formatTool(event)); }
      else if (event.phase === "end") this.pushLine("tool_end", this.formatTool(event));
      else return; // tool error -> normal error path
    } else if (event.kind === "assistant_note") {
      const t = (event.text || "").trim();
      if (!t || this.isNoReplyText(t)) return;
      this.appendText(t);
    } else if (event.kind === "steer") {
      // A user message that was steered into THIS run and has now actually been
      // consumed by the model at a tool-call boundary. It is appended as its own
      // line so it lands in the correct time-order position (right after the
      // tool that just finished), not merged with assistant text.
      const t = (event.text || "").trim();
      if (!t) return;
      this.pushLine("steer", t);
    } else {
      return; // lifecycle ticks: ignore (footer timer already advances)
    }
    this.waitingForResult = false;
    this.state = "running";
    this.callbacks.desired?.(this.buildView());
    await this.ensureCreatedNow();
    await this.safeEdit(this.buildView());
  }

  /** Freeze recurring/progress edits, not the original result observer.
   * A single final/error summary remains allowed when the real outcome arrives. */
  async showWaitingForResult(detail: string): Promise<void> {
    if (this.disabled || this.finalized || this.updatesFrozen) return;
    this.updatesFrozen = true;
    this.waitingForResult = true;
    this.pushLine("lifecycle", detail);
    this.stopTimers();
    await this.finishView(this.buildView());
  }

  /** Release only local observation of a now-idle session, without claiming
   * the previous task succeeded or was aborted. Normal progress is unchanged. */
  async pauseForUnconfirmedResult(detail: string, title?: string): Promise<void> {
    if (this.finalized) return;
    this.pushLine("lifecycle", detail);
    this.waitingForResult = true;
    this.finalized = true;
    this.stopTimers();
    const view = this.buildView();
    view.title = title || (this.opts.locale === "en" ? `${this.opts.botName} result unconfirmed` : `${this.opts.botName} 结果未确认`);
    await this.finishView(view);
  }

  async complete(): Promise<void> {
    if (this.disposed || this.terminalOutcome) return;
    const pending = this.callbacks.unconfirmedInputs?.("done");
    if (pending) { await this.showInputWaiting(pending.detail, pending.title); return; }
    this.terminalOutcome = true;
    this.state = "done";
    this.finalized = true;
    this.stopTimers();
    await this.finishView(this.buildView());
  }

  /**
   * Freeze any successful terminal state (text, attachment-only, or NO_REPLY)
   * without first emitting the compact done patch. The caller persists this
   * metadata in the outbox, which owns the final patch/cleanup. If no card was
   * created, the caller falls back to normal new-message delivery. Metadata is
   * a target/execution snapshot, never a receipt. B2/outbox callers that may own
   * an unknown or same-card final should supply owner BEFORE attempting it;
   * late IDs/stale effects then delegate reconciliation instead of patching.
   */
  async prepareTerminalDelivery(noReply = false, owner?: LiveStatusTerminalOwner): Promise<LiveStatusFinalMeta | undefined> {
    if (this.disposed || (this.terminalOutcome && this.state !== "done")) return undefined;
    const pending = this.callbacks.unconfirmedInputs?.("done");
    if (pending) { await this.showInputWaiting(pending.detail, pending.title); return undefined; }
    if (owner) {
      this.terminalOwner = owner;
      this.generation++; // retire any queued controller-owned terminal effect
      this.pendingEdit = undefined;
    }
    if (!this.terminalOutcome) {
      this.terminalOutcome = true;
      this.state = "done";
      this.noReplyResult = noReply;
      this.finalized = true;
      this.pinView(this.buildView()); // retire queued progress before handing off
    }
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    return this.finalMeta();
  }

  private finalMeta(): LiveStatusFinalMeta | undefined {
    if (!this.messageId) return undefined;
    return {
      messageId: this.messageId,
      toolCalls: this.toolCallCount,
      elapsed: this.formatElapsed(),
      model: this.opts.model,
      thinkingLevel: this.opts.thinkingLevel,
      locale: this.opts.locale === "en" ? "en" : "zh",
      noReply: this.noReplyResult,
    };
  }

  async prepareFinalDelivery(owner?: LiveStatusTerminalOwner): Promise<LiveStatusFinalMeta | undefined> {
    return this.prepareTerminalDelivery(false, owner);
  }

  async fail(): Promise<void> {
    if (this.disposed || this.terminalOutcome) return;
    const pending = this.callbacks.unconfirmedInputs?.("failed");
    if (pending) { await this.showInputWaiting(pending.detail, pending.title); return; }
    this.terminalOutcome = true;
    this.state = "failed";
    this.finalized = true;
    this.stopTimers();
    await this.finishView(this.buildView());
  }

  /**
   * Finish when the model explicitly produced no reply (NO_REPLY) or an empty
   * final. Mark the card done but show a "no content" summary instead of the
   * activity window, so the user understands the run finished without output.
   */
  async noReply(): Promise<void> {
    if (this.disposed || this.terminalOutcome) return;
    const pending = this.callbacks.unconfirmedInputs?.("done");
    if (pending) { await this.showInputWaiting(pending.detail, pending.title); return; }
    this.terminalOutcome = true;
    this.state = "done";
    this.noReplyResult = true;
    this.finalized = true;
    this.stopTimers();
    await this.finishView(this.buildView());
  }

  dispose(): void {
    this.disposed = true;
    this.finalized = true;
    this.generation++;
    this.pendingEdit = undefined;
    this.stopTimers();
  }

  private pinView(view: LiveStatusView): void {
    this.generation++;
    this.callbacks.desired?.(view);
    this.pinnedView = view;
    this.pendingEdit = undefined;
  }

  private async finishView(view: LiveStatusView): Promise<void> {
    // Pin BEFORE awaiting creation: a create already in flight may finish late.
    this.pinView(view);
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (this.messageId && !this.disposed) await this.reconcilePinnedView();
  }

  private async reconcilePinnedView(force = false): Promise<void> {
    if (!this.pinnedView || this.disposed) return;
    if (!this.terminalOwner) {
      await this.queueEdit(this.pinnedView, true, force);
      return;
    }
    const meta = this.finalMeta();
    if (!meta) return;
    try {
      // This is a custody signal, NOT retry authority. The owner must retain
      // attempted/unknown effects and reconcile its own desired final payload.
      await this.terminalOwner.onReconcileNeeded(meta);
    } catch (err) {
      this.callbacks.warn?.("live status external reconciliation failed (not replayed)", err);
    }
  }

  /**
   * Intermediate assistant text arrives as incremental fragments (each flush
   * sends only the newly-added slice). Consecutive fragments with no tool event
   * in between belong to the same thought, so merge them into ONE line instead
   * of showing each fragment (or each table row) as a separate message. A tool
   * event resets this, so the next text starts a fresh line.
   */
  private appendText(fragment: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.kind === "text") {
      const merged = `${last.text} ${this.normalizeText(fragment)}`.replace(/\s+/g, " ").trim();
      last.text = this.clip(merged);
      return;
    }
    this.pushLine("text", fragment);
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private clip(text: string): string {
    const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}\u2026` : text;
  }

  private pushLine(kind: LiveStatusLine["kind"], text: string): void {
    const clean = this.normalizeText(text);
    if (!clean) return;
    const clipped = this.clip(clean);
    // Collapse consecutive identical lines (e.g. repeated "等待 OpenClaw").
    const last = this.lines[this.lines.length - 1];
    if (last && last.kind === kind && last.text === clipped) return;
    const at = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    this.lines.push({ kind, text: clipped, at });
    const limit = this.opts.historySize ?? DEFAULT_HISTORY;
    if (this.lines.length > limit) this.lines = this.lines.slice(this.lines.length - limit);
  }

  private stopTimers(): void {
    if (this.createTimer) { clearTimeout(this.createTimer); this.createTimer = undefined; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
  }

  private async ensureCreatedNow(): Promise<void> {
    if (this.createTimer) {
      clearTimeout(this.createTimer);
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }
    if (this.createPromise) await this.createPromise.catch(() => {});
  }

  private async ensureCreated(): Promise<void> {
    if (this.disabled || this.finalized || this.messageId) return;
    const view = this.pinnedView || this.buildView();
    let started = false;
    let settled = false;
    const accept = (id: string | undefined) => {
      if (settled) return;
      settled = true;
      if (!id) { this.disabled = true; return; }
      this.messageId = id;
      this.lastSentSignature = this.signature(view);
      if (this.pinnedView && !this.disposed) {
        void this.reconcilePinnedView();
      } else this.startTicker();
    };
    const effect: LiveStatusEffect<string | undefined> = {
      run: async send => {
        // A create waiting behind another chat send is no longer needed once
        // the task finished. Do not create a stale running card at effect time.
        if (this.finalized || (this.updatesFrozen && !this.waitingCreateAllowed) || this.disposed) { settled = true; return undefined; }
        started = true;
        const id = await send();
        accept(id); // do not attach receipt ownership to the deadline promise
        return id;
      },
    };
    try {
      const id = await this.callbacks.create(view, effect);
      if (!settled) accept(id); // direct/non-queued callbacks remain supported
    } catch (err) {
      // No duplicate create, including when the outer deadline expired. The
      // original effect context still adopts a late successful message ID.
      if (err instanceof LiveStatusEffectSuppressedError) {
        this.createSuppressed = true;
        this.createPromise = undefined;
        this.callbacks.warn?.("live status create locally suppressed before transport", err);
        return;
      }
      if (!started) this.disabled = true;
      this.callbacks.warn?.("live status create failed (not replayed)", err);
    }
  }

  /** Refresh the elapsed-time footer periodically even with no new activity. */
  private startTicker(): void {
    if (this.tickTimer || this.disabled || this.finalized || this.updatesFrozen || this.blockedEdits) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.tickTimer = setInterval(() => {
      if (this.finalized || this.disabled || this.updatesFrozen || !this.messageId) return;
      void this.safeEdit(this.buildView());
    }, tickMs);
    this.tickTimer.unref?.();
  }

  private async safeEdit(view: LiveStatusView): Promise<void> {
    if (!this.messageId || this.disabled || this.finalized || this.updatesFrozen) return;
    await this.queueEdit(view, false);
  }

  /** One flight + one latest pending snapshot, regardless of tick/event rate. */
  private queueEdit(view: LiveStatusView, priority: boolean, force = false): Promise<void> {
    this.callbacks.desired?.(view);
    if (this.blockedEdits) return Promise.resolve();
    if (!this.messageId || this.disposed || (priority && view !== this.pinnedView)
      || (!priority && (this.disabled || this.finalized || this.updatesFrozen))) return Promise.resolve();
    if (!priority) this.generation++;
    this.pendingEdit = { view, generation: this.generation, priority, force, started: false, settled: false, accepted: false };
    return this.flushEdits();
  }

  private canRunPendingEdit(): boolean {
    const request = this.pendingEdit;
    if (!request || this.disposed) return false;
    // An unknown progress is not retried by ticking. A new terminal/frozen
    // view may supersede it once; an unknown terminal is never blind retried.
    return ![...this.unknownEdits].some(old => !request.priority
      || (old.priority && old.generation >= request.generation));
  }

  private flushEdits(): Promise<void> {
    if (this.editPump) return this.editPump;
    // Start on a microtask so editPump is installed before callbacks/receipts
    // can re-enter, including immediately resolved test/SDK implementations.
    const pump = Promise.resolve().then(async () => {
      while (this.canRunPendingEdit()) {
        const request = this.pendingEdit!;
        this.pendingEdit = undefined;
        if (!request.force && this.signature(request.view) === this.lastSentSignature) continue;
        await this.performEdit(request);
      }
    });
    const owned: Promise<void> = pump.finally(() => {
      if (this.editPump === owned) this.editPump = undefined;
      // queueEdit can arrive after the loop's last check, while it still sees
      // this flight. Hand runnable work to a NEW owner and adopt its promise:
      // callers awaiting the old flight must also await the terminal handoff.
      // Do not restart blocked unknown work: that would spin microtasks forever.
      if (this.canRunPendingEdit()) return this.flushEdits();
    });
    this.editPump = owned;
    return owned;
  }

  private async performEdit(request: EditRequest): Promise<void> {
    const current = () => !this.disposed && request.generation === this.generation;
    const accept = () => {
      if (request.settled) return;
      request.settled = true;
      request.accepted = true;
      this.unknownEdits.delete(request);
      if (current()) {
        this.lastSentSignature = this.signature(request.view);
        this.consecutiveEditFailures = 0;
      } else if (this.pinnedView && !this.disposed) {
        // A deadline frees the ordered chain, not the SDK operation. If old
        // progress applies AFTER done/frozen, repair it on this same card.
        void this.reconcilePinnedView(true);
      }
      void this.flushEdits();
    };
    const effect: LiveStatusEffect<void> = {
      run: async send => {
        if (!current()) { request.settled = true; return; }
        request.started = true;
        try {
          await send();
          accept();
        } catch (err) {
          if (err instanceof LiveStatusEffectRejectedError) {
            request.settled = true;
            request.rejection = err;
            this.unknownEdits.delete(request);
            // A late definitive rejection also releases the unknown gate.
            void this.flushEdits();
          }
          throw err;
        }
      },
    };
    const attempts = request.priority ? Math.max(1, MAX_CONSECUTIVE_EDIT_FAILURES) : 1;
    for (let i = 0; i < attempts && current(); i++) {
      try {
        await this.callbacks.edit(this.messageId!, request.view, effect);
        if (!request.settled) accept(); // direct/non-queued callback
        return;
      } catch (err) {
        // The low-level receipt can beat this catch even if the outer race
        // already chose its deadline. Never retain "unknown" after acceptance.
        if (request.accepted) return;
        const failure = request.rejection ?? err;
        if (failure instanceof LiveStatusEffectSuppressedError) return;
        const unknown = !(failure instanceof LiveStatusEffectRejectedError);
        if (unknown) {
          this.unknownEdits.add(request);
          this.callbacks.warn?.("live status edit outcome unknown (not replayed)", failure);
          return;
        }
        this.consecutiveEditFailures++;
        this.callbacks.warn?.("live status edit failed", failure);
        if (request.priority && i + 1 < attempts) {
          await new Promise(resolve => setTimeout(resolve, 300 * (i + 1)));
          request.started = false;
          request.settled = false;
          request.rejection = undefined;
        } else if (!request.priority && this.consecutiveEditFailures >= MAX_CONSECUTIVE_EDIT_FAILURES) {
          this.disabled = true;
          this.stopTimers();
        }
      }
    }
  }

  /** Dedupe key includes elapsed so the footer timer ticks even without new
   *  activity, while identical content within the same second is still skipped. */
  private signature(view: LiveStatusView): string {
    return `${view.state}|${view.title}|${view.elapsed}|${view.lines.map((l) => `${l.kind}@${l.at}:${l.text}`).join("|")}`;
  }

  private isNoReplyText(text: string): boolean {
    return text.trim().toUpperCase() === "NO_REPLY";
  }

  private formatTool(event: Extract<ProgressEvent, { kind: "tool" }>): string {
    const raw = event.text || event.name || "";
    const prefix = `${event.name} ${event.phase}`;
    let detail = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw.trim();
    if (detail.startsWith(":")) detail = detail.slice(1).trim();
    return detail ? `${event.name}: ${detail}` : event.name;
  }

  private formatElapsed(): string {
    const totalSec = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  private buildView(): LiveStatusView {
    const en = this.opts.locale === "en";
    let title: string;
    if (this.state === "done") title = en ? `\u2705 ${this.opts.botName} done` : `\u2705 ${this.opts.botName} \u5df2\u5b8c\u6210`;
    else if (this.state === "failed") title = en ? `\u26A0\uFE0F ${this.opts.botName} stopped` : `\u26A0\uFE0F ${this.opts.botName} \u6267\u884c\u4e2d\u65ad`;
    else if (this.waitingForResult) title = en ? `${this.opts.botName} waiting (card frozen)` : `${this.opts.botName} 等待后续结果（已停止刷新）`;
    else if (this.state === "queued") title = en ? `${this.opts.botName} received · queued` : `${this.opts.botName} 已收件 · 排队等待`;
    else if (this.state === "admitted") title = en ? `${this.opts.botName} accepted · waiting` : `${this.opts.botName} 已接收 · 等待活动`;
    else title = en ? `${this.opts.botName} is working` : `${this.opts.botName} \u6b63\u5728\u6267\u884c`;
    // On a clean finish (done / NO_REPLY) show only the compact summary. On a
    // failure (error / killed / timeout) keep the recent activity window too, so
    // the last few steps before the failure are visible for debugging.
    let lines: LiveStatusLine[];
    if (this.state !== "done" && this.state !== "failed") {
      lines = this.lines.map(line => ({ ...line }));
    } else if (this.state === "failed") {
      lines = [...this.lines.map(line => ({ ...line })), this.buildSummaryLine(en)];
    } else {
      lines = [this.buildSummaryLine(en)];
    }
    return {
      title,
      lines,
      elapsed: this.formatElapsed(),
      model: this.opts.model,
      thinkingLevel: this.opts.thinkingLevel,
      toolCalls: this.toolCallCount,
      noReply: this.noReplyResult,
      state: this.state,
      phase: this.state === "done" || this.state === "failed" ? this.state : this.waitingForResult ? "waiting" : this.state === "running" ? "working" : this.state,
    };
  }

  private buildSummaryLine(en: boolean): LiveStatusLine {
    const elapsed = this.formatElapsed();
    const at = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    if (this.noReplyResult) {
      const text = en
        ? `Model returned no content \u00b7 ${this.toolCallCount} tool call${this.toolCallCount === 1 ? "" : "s"} \u00b7 ${elapsed}`
        : `\u6a21\u578b\u6ca1\u6709\u56de\u590d\u5185\u5bb9 \u00b7 \u5171\u8c03\u7528\u5de5\u5177 ${this.toolCallCount} \u6b21 \u00b7 \u8017\u65f6 ${elapsed}`;
      return { kind: "summary", text, at };
    }
    const text = en
      ? `${this.toolCallCount} tool call${this.toolCallCount === 1 ? "" : "s"} \u00b7 ${elapsed}`
      : `\u5171\u8c03\u7528\u5de5\u5177 ${this.toolCallCount} \u6b21 \u00b7 \u8017\u65f6 ${elapsed}`;
    return { kind: "summary", text, at };
  }
}
