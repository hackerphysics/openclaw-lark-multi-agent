import type { ProgressEvent } from "./openclaw-client";

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS || 800);
const DEFAULT_MAX_CHARS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS || 120);
// Feishu caps a single message at 20 edits (code=230072 once exhausted). We make
// every edit count by spacing them out as an arithmetic progression: the k-th
// edit gap is k * STEP seconds (k = 1..MAX_EDITS). With STEP=5s and 20 edits the
// total coverage is 5*(1+2+...+20) = 5*210 = 1050s ≈ 17.5 minutes on a single
// status message, while still refreshing frequently early on.
const DEFAULT_STEP_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_STEP_MS || 5000);
const DEFAULT_MAX_EDITS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_EDITS || 20);
// Width (in cells) of the horizontal progress bar that shows how much of the
// edit-refresh budget has been consumed. Colored emoji blocks are wider than
// plain block chars, so keep this modest to avoid line wrapping on mobile.
const PROGRESS_BAR_CELLS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_BAR_CELLS || 8);

export type LiveStatusCallbacks = {
  create: (text: string) => Promise<string | undefined>;
  edit: (messageId: string, text: string) => Promise<void>;
  remove?: (messageId: string) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
};

export type LiveStatusOptions = {
  botName: string;
  locale?: "zh" | "en";
  delayMs?: number;
  maxChars?: number;
  stepMs?: number;
  maxEdits?: number;
};

export class LiveStatusController {
  private messageId?: string;
  private lastSentText = "";
  /** Latest real progress detail (without bar/elapsed prefix). */
  private detail = "";
  private lastSentAt = 0;
  /** Number of edits already issued against the live message (excludes create). */
  private editCount = 0;
  private startedAt = Date.now();
  private createTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  /** True once the refresh budget (maxEdits) is spent; status no longer refreshes. */
  private budgetExhausted = false;
  private createPromise?: Promise<void>;
  private finalized = false;
  private disabled = false;

  constructor(private readonly callbacks: LiveStatusCallbacks, private readonly opts: LiveStatusOptions) {}

  get id(): string | undefined { return this.messageId; }

  start(initialDetail?: string): void {
    if (this.disabled || this.finalized || this.createTimer || this.messageId) return;
    this.startedAt = Date.now();
    this.detail = initialDetail || (this.opts.locale === "en" ? "working" : "正在处理");
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  async progress(event: ProgressEvent | string): Promise<void> {
    if (this.disabled || this.finalized) return;
    const raw = typeof event === "string" ? event : event.text;
    this.detail = (raw || "").trim() || this.detail || (this.opts.locale === "en" ? "working" : "正在处理");
    // Real progress only updates the in-memory detail. The actual edit cadence is
    // driven by the arithmetic-progression scheduler (scheduleNextTick), so a
    // burst of tool events can never blow the limited edit budget. The next
    // scheduled refresh will pick up this latest detail.
  }

  /**
   * Finish the live status when the real (final) reply is delivered separately.
   * The final answer is sent by the normal interactive-card path, so the status
   * message must NOT be overwritten with the answer (text type does not render
   * Markdown). Instead: delete the status message if possible; otherwise mark it
   * as done so the group is not left with a stale "processing" message.
   */
  async complete(): Promise<void> {
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    if (this.callbacks.remove) {
      try {
        await this.callbacks.remove(this.messageId);
        return;
      } catch (err) {
        this.callbacks.warn?.("live status delete failed; marking done instead", err);
      }
    }
    const doneText = this.opts.locale === "en"
      ? `\u2705 ${this.opts.botName} done (${this.formatElapsed()})`
      : `\u2705 ${this.opts.botName} \u5df2\u5b8c\u6210\uff08\u7528\u65f6 ${this.formatElapsed()}\uff09`;
    await this.safeEdit(doneText, true);
  }

  /**
   * Finish the live status when the run failed and the error is delivered by the
   * normal path. Same policy as complete(): delete if possible, else mark done.
   */
  async fail(): Promise<void> {
    await this.complete();
  }

  dispose(): void {
    this.finalized = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.createTimer) { clearTimeout(this.createTimer); this.createTimer = undefined; }
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = undefined; }
  }

  private async ensureCreated(): Promise<void> {
    if (this.disabled || this.finalized || this.messageId) return;
    const text = this.formatStatus();
    try {
      const id = await this.callbacks.create(text);
      if (!id) {
        this.disabled = true;
        return;
      }
      this.messageId = id;
      this.lastSentText = text;
      this.lastSentAt = Date.now();
      this.scheduleNextTick();
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status create failed", err);
    }
  }

  /**
   * Schedule the next auto-refresh using an arithmetic progression: the gap
   * before the k-th edit is k * stepMs. This front-loads frequent refreshes and
   * gradually slows down, so the limited edit budget stretches over a long run
   * (STEP=5s, 20 edits -> ~17.5 min). When the budget is exhausted we render one
   * final "refresh limit reached, still running" frame and stop editing.
   */
  private scheduleNextTick(): void {
    if (this.tickTimer || this.disabled || this.finalized || this.budgetExhausted) return;
    const stepMs = this.opts.stepMs ?? DEFAULT_STEP_MS;
    // editCount edits already issued; the next edit is number (editCount + 1).
    const nextEditNumber = this.editCount + 1;
    const gap = nextEditNumber * stepMs;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      void this.tick();
    }, gap);
    // Don't keep the process alive solely for the refresh timer.
    this.tickTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.finalized || this.disabled || !this.messageId) return;
    const maxEdits = this.opts.maxEdits ?? DEFAULT_MAX_EDITS;
    const ok = await this.safeEdit(this.formatStatus());
    if (!ok) return; // disabled/failed; safeEdit handled cleanup
    if (this.editCount >= maxEdits) {
      // Budget spent: show a final frame and stop refreshing.
      this.budgetExhausted = true;
      await this.safeEdit(this.formatStatus(true), true).catch(() => {});
      return;
    }
    this.scheduleNextTick();
  }

  private async safeEdit(text: string, force = false): Promise<boolean> {
    if (!this.messageId || this.disabled) return false;
    if (!force && this.finalized) return false;
    if (!force && text === this.lastSentText) return true;
    try {
      await this.callbacks.edit(this.messageId, text);
      this.lastSentText = text;
      this.lastSentAt = Date.now();
      if (!force) this.editCount++;
      return true;
    } catch (err) {
      this.disabled = true;
      this.stopTimers();
      this.callbacks.warn?.("live status edit failed", err);
      return false;
    }
  }

  /** mm:ss elapsed since the run started. */
  private formatElapsed(): string {
    const totalSec = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /**
   * Horizontal progress bar showing how much of the edit budget is consumed.
   * Uses colored emoji blocks (Feishu text cannot color plain characters): the
   * filled portion shifts green -> yellow -> red as the budget runs out, so the
   * bar doubles as a "refresh budget almost gone" signal.
   */
  private progressBar(): string {
    const maxEdits = this.opts.maxEdits ?? DEFAULT_MAX_EDITS;
    const cells = PROGRESS_BAR_CELLS;
    const ratio = maxEdits > 0 ? Math.min(1, this.editCount / maxEdits) : 1;
    const filled = Math.min(cells, Math.round(ratio * cells));
    let bar = "";
    for (let i = 0; i < cells; i++) {
      if (i >= filled) { bar += "\u2B1C"; continue; } // ⬜ white box (empty)
      const r = i / cells;
      // 🟩 green / 🟨 yellow / 🟥 red
      bar += r < 0.5 ? "\uD83D\uDFE9" : r < 0.8 ? "\uD83D\uDFE8" : "\uD83D\uDFE5";
    }
    return bar;
  }

  private formatStatus(exhausted = false): string {
    const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    const maxEdits = this.opts.maxEdits ?? DEFAULT_MAX_EDITS;
    const clean = (this.detail || "").replace(/\s+/g, " ").trim();
    const clipped = clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}\u2026` : clean;
    const bar = this.progressBar();
    const count = `${Math.min(this.editCount, maxEdits)}/${maxEdits}`;
    const elapsed = this.formatElapsed();
    if (exhausted) {
      return this.opts.locale === "en"
        ? `${bar} ${count} \u00b7 ${this.opts.botName} \u00b7 ${elapsed} \u00b7 (refresh limit reached, still running\u2026)`
        : `${bar} ${count} \u00b7 ${this.opts.botName} \u00b7 ${elapsed} \u00b7 \uff08\u5237\u65b0\u5df2\u8fbe\u4e0a\u9650\uff0c\u4ecd\u5728\u6267\u884c\u4e2d\u2026\uff09`;
    }
    return this.opts.locale === "en"
      ? `${bar} ${count} \u00b7 ${this.opts.botName} \u00b7 ${elapsed} \u00b7 ${clipped}`
      : `${bar} ${count} \u00b7 ${this.opts.botName} \u00b7 ${elapsed} \u00b7 ${clipped}`;
  }
}
