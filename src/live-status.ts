import type { ProgressEvent } from "./openclaw-client";

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS || 800);
// Minimum gap between any two status edits. Feishu caps a single message at 20
// edits total, so both progress-driven edits and auto-ticks share this budget.
const DEFAULT_THROTTLE_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_THROTTLE_MS || 10000);
const DEFAULT_MAX_CHARS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS || 120);
// How often the status message auto-refreshes (elapsed time + spinner) even when
// no new progress event arrives, so the user sees a live, advancing timer.
// Feishu allows a message to be edited at most 20 times (code=230072 once
// exhausted), so a 10s default keeps a single status message live for ~200s.
const DEFAULT_TICK_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_TICK_MS || 10000);
// Colorful round spinner frames (instead of the black/white ◐◓◑◒).
const SPINNER = ["\uD83D\uDD35", "\uD83D\uDFE2", "\uD83D\uDFE1", "\uD83D\uDFE0", "\uD83D\uDD34", "\uD83D\uDFE3"];

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
  throttleMs?: number;
  maxChars?: number;
  tickMs?: number;
};

export class LiveStatusController {
  private messageId?: string;
  private lastSentText = "";
  /** Latest real progress detail (without spinner/elapsed prefix). */
  private detail = "";
  private lastSentAt = 0;
  private spinnerIndex = 0;
  private startedAt = Date.now();
  private createTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
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
    if (!this.messageId) return;
    const now = Date.now();
    if (now - this.lastSentAt < (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS)) return;
    await this.safeEdit(this.formatStatus());
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
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
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
      this.startTicker();
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status create failed", err);
    }
  }

  /**
   * Auto-refresh the status message on a fixed interval so the elapsed timer and
   * spinner keep advancing even when no new progress event arrives.
   */
  private startTicker(): void {
    if (this.tickTimer || this.disabled || this.finalized) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.tickTimer = setInterval(() => {
      if (this.finalized || this.disabled || !this.messageId) return;
      void this.safeEdit(this.formatStatus());
    }, tickMs);
    // Don't keep the process alive solely for the spinner.
    this.tickTimer.unref?.();
  }

  private async safeEdit(text: string, force = false): Promise<boolean> {
    if (!this.messageId || this.disabled) return false;
    if (!force && this.finalized) return false;
    if (!force && text === this.lastSentText) return true;
    if (!force && Date.now() - this.lastSentAt < (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS)) return false;
    try {
      await this.callbacks.edit(this.messageId, text);
      this.lastSentText = text;
      this.lastSentAt = Date.now();
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

  private formatStatus(): string {
    const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    const clean = (this.detail || "").replace(/\s+/g, " ").trim();
    const clipped = clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}\u2026` : clean;
    const spin = SPINNER[this.spinnerIndex++ % SPINNER.length];
    const elapsed = this.formatElapsed();
    return this.opts.locale === "en"
      ? `${spin} ${this.opts.botName} \u00b7 ${elapsed} \u00b7 ${clipped}`
      : `${spin} ${this.opts.botName} \u00b7 ${elapsed} \u00b7 ${clipped}`;
  }
}
