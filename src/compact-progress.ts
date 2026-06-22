// A tiny live-status controller dedicated to the /compact (and auto-compact)
// flow, so the user gets a visible "正在压缩…" card that ticks while a large
// session is being compacted — instead of staring at nothing for tens of
// seconds while native compaction grinds (and sometimes times out).
//
// It deliberately does NOT reuse LiveStatusController: that one models a tool
// run (activity window, tool-call count, model footer). Compaction has just a
// few coarse phases and a single elapsed timer, so a focused, self-contained
// controller keeps the card clean and the logic trivial to test.

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_COMPACT_STATUS_DELAY_MS || 500);
const DEFAULT_TICK_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_COMPACT_STATUS_TICK_MS || 1000);

/** Coarse phase of the compaction flow, drives the card's primary line. */
export type CompactPhase = "native" | "tool-trim";

/** Terminal outcome used by the renderer to pick color/emoji. */
export type CompactState = "running" | "done" | "failed" | "noop";

/** Structured snapshot the renderer turns into a Feishu interactive card. */
export type CompactProgressView = {
  state: CompactState;
  /** Current phase while running (ignored once terminal). */
  phase: CompactPhase;
  /** Elapsed time like "0:42". */
  elapsed: string;
  /** Terminal detail line, e.g. "12.3M→4.1M (-67%)" or an error/skip reason. */
  detail?: string;
};

export type CompactProgressCallbacks = {
  /** Create the status card; returns the new message id (undefined disables). */
  create: (view: CompactProgressView) => Promise<string | undefined>;
  /** Patch the existing status card. */
  edit: (messageId: string, view: CompactProgressView) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
};

export type CompactProgressOptions = {
  locale?: "zh" | "en";
  /** Delay before the card first appears, to avoid flashing on fast compactions. */
  delayMs?: number;
  /** Footer/auto-refresh cadence in ms. */
  tickMs?: number;
};

/**
 * Lifecycle: start() → (optional) toToolTrim() when native gives up → one of
 * done()/noop()/fail(). The card is created lazily after `delayMs` so a fast
 * compaction that finishes first never shows a card at all. All terminal calls
 * are idempotent and safe even if the card was never created.
 */
export class CompactProgressController {
  private messageId?: string;
  private startedAt = Date.now();
  private phase: CompactPhase = "native";
  private state: CompactState = "running";
  private detail?: string;
  private createTimer?: ReturnType<typeof setTimeout>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private createPromise?: Promise<void>;
  private finalized = false;
  private disabled = false;
  private lastSignature = "";

  constructor(
    private readonly callbacks: CompactProgressCallbacks,
    private readonly opts: CompactProgressOptions = {},
  ) {}

  get id(): string | undefined { return this.messageId; }

  /** Begin the flow; schedules lazy card creation after delayMs. */
  start(): void {
    if (this.disabled || this.finalized || this.createTimer || this.messageId) return;
    this.startedAt = Date.now();
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
    this.createTimer.unref?.();
  }

  /** Native compaction gave up (timeout/no-op); switch the card to fast-trim. */
  async toToolTrim(): Promise<void> {
    if (this.finalized || this.phase === "tool-trim") return;
    this.phase = "tool-trim";
    await this.refresh();
  }

  /** Finished successfully; patch the card to the done state with a detail line. */
  async done(detail?: string): Promise<void> {
    await this.finish("done", detail);
  }

  /** Nothing to compact; patch the card to a neutral "no-op" state. */
  async noop(detail?: string): Promise<void> {
    await this.finish("noop", detail);
  }

  /** Failed; patch the card to the failed state with an error detail line. */
  async fail(detail?: string): Promise<void> {
    await this.finish("failed", detail);
  }

  /** Tear down timers without sending anything (e.g. on unexpected disposal). */
  dispose(): void {
    this.finalized = true;
    this.stopTimers();
  }

  private async finish(state: CompactState, detail?: string): Promise<void> {
    if (this.finalized) return;
    this.state = state;
    this.detail = detail;
    this.finalized = true;
    this.stopTimers();
    // Wait for any in-flight lazy create so we can patch (not orphan) the card.
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    await this.safeEdit(true);
  }

  private async refresh(): Promise<void> {
    if (this.finalized || this.disabled) return;
    await this.ensureCreatedNow();
    await this.safeEdit();
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
    try {
      const id = await this.callbacks.create(this.buildView());
      if (!id) { this.disabled = true; return; }
      this.messageId = id;
      this.lastSignature = this.signature();
      this.startTicker();
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("compact progress create failed", err);
    }
  }

  /** Refresh the elapsed-time footer periodically even with no phase change. */
  private startTicker(): void {
    if (this.tickTimer || this.disabled || this.finalized) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.tickTimer = setInterval(() => {
      if (this.finalized || this.disabled || !this.messageId) return;
      void this.safeEdit();
    }, tickMs);
    this.tickTimer.unref?.();
  }

  private async safeEdit(force = false): Promise<void> {
    if (!this.messageId || this.disabled) return;
    if (!force && this.finalized) return;
    const sig = this.signature();
    if (!force && sig === this.lastSignature) return;
    try {
      await this.callbacks.edit(this.messageId, this.buildView());
      this.lastSignature = sig;
    } catch (err) {
      this.disabled = true;
      this.stopTimers();
      this.callbacks.warn?.("compact progress edit failed", err);
    }
  }

  private stopTimers(): void {
    if (this.createTimer) { clearTimeout(this.createTimer); this.createTimer = undefined; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
  }

  /** Dedupe key; includes elapsed so the ticking footer still advances. */
  private signature(): string {
    return `${this.state}|${this.phase}|${this.formatElapsed()}|${this.detail || ""}`;
  }

  private formatElapsed(): string {
    const totalSec = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  buildView(): CompactProgressView {
    return {
      state: this.state,
      phase: this.phase,
      elapsed: this.formatElapsed(),
      detail: this.detail,
    };
  }
}
