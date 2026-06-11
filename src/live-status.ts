import type { ProgressEvent } from "./openclaw-client";

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS || 800);
const DEFAULT_MAX_CHARS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS || 120);
// Feishu caps a single message at 20 edits (code=230072 once exhausted). Keep the
// final edit for the completion marker; running-state updates may consume at most
// maxEdits - 1, with the last running edit reserved for an explicit limit notice.
const DEFAULT_MAX_EDITS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_EDITS || 20);

export type LiveStatusCallbacks = {
  create: (text: string) => Promise<string | undefined>;
  edit: (messageId: string, text: string) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
};

export type LiveStatusOptions = {
  botName: string;
  locale?: "zh" | "en";
  delayMs?: number;
  maxChars?: number;
  maxEdits?: number;
};

export class LiveStatusController {
  private messageId?: string;
  private lastSentText = "";
  private detail = "";
  /** Number of edits already issued against the live message (excludes create). */
  private editCount = 0;
  private createTimer?: NodeJS.Timeout;
  private createPromise?: Promise<void>;
  private finalized = false;
  private disabled = false;
  /** True after the running-state budget is spent; future progress is ignored. */
  private runningLimitReached = false;

  constructor(private readonly callbacks: LiveStatusCallbacks, private readonly opts: LiveStatusOptions) {}

  get id(): string | undefined { return this.messageId; }

  start(initialDetail?: string): void {
    if (this.disabled || this.finalized || this.createTimer || this.messageId) return;
    this.detail = initialDetail || "";
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  async progress(event: ProgressEvent | string): Promise<void> {
    if (this.disabled || this.finalized || this.runningLimitReached) return;
    // Only tool-call start is meaningful enough to spend one of Feishu's limited
    // edit slots. Ignore verbose assistant notes, lifecycle ticks, tool end, and
    // tool error; the final/error answer is delivered by the normal message path.
    if (typeof event !== "string") {
      if (event.kind !== "tool" || event.phase !== "start") return;
      this.detail = this.formatToolStart(event);
    } else {
      // String progress is kept for tests/backwards compatibility, but in normal
      // runtime OpenClaw progress is structured and only tool start passes above.
      this.detail = event.trim();
    }
    if (!this.detail) return;
    await this.ensureCreatedNow();
    await this.editRunningStatus();
  }

  /**
   * Finish the live status when the real (final) reply is delivered separately.
   * The final answer is sent by the normal interactive-card path, so the status
   * message must NOT be overwritten with the answer (text type does not render
   * Markdown). Feishu renders message deletion as a visible "recalled a message"
   * tombstone, so keep the status message and mark it done instead.
   */
  async complete(): Promise<void> {
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    const doneText = this.opts.locale === "en"
      ? `\u2705 ${this.opts.botName} done`
      : `\u2705 ${this.opts.botName} \u5df2\u5b8c\u6210`;
    await this.safeEdit(doneText, true);
  }

  /**
   * Finish the live status when the run failed and the error is delivered by the
   * normal path. Use a neutral/negative marker so it does not contradict the
   * separately delivered error message.
   */
  async fail(): Promise<void> {
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    const failedText = this.opts.locale === "en"
      ? `\u26A0\uFE0F ${this.opts.botName} stopped`
      : `\u26A0\uFE0F ${this.opts.botName} \u6267\u884c\u4e2d\u65ad`;
    await this.safeEdit(failedText, true);
  }

  dispose(): void {
    this.finalized = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.createTimer) { clearTimeout(this.createTimer); this.createTimer = undefined; }
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
    const text = this.formatStatus();
    try {
      const id = await this.callbacks.create(text);
      if (!id) {
        this.disabled = true;
        return;
      }
      this.messageId = id;
      this.lastSentText = text;
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status create failed", err);
    }
  }

  private async editRunningStatus(): Promise<void> {
    if (!this.messageId || this.disabled || this.finalized || this.runningLimitReached) return;
    const maxEdits = this.opts.maxEdits ?? DEFAULT_MAX_EDITS;
    const runningBudget = Math.max(0, maxEdits - 1); // reserve final edit for complete()
    if (this.editCount >= runningBudget) return;

    const isLimitNotice = this.editCount === runningBudget - 1;
    const text = isLimitNotice ? this.formatLimitNotice() : this.formatStatus();
    const ok = await this.safeEdit(text);
    if (ok && isLimitNotice) this.runningLimitReached = true;
  }

  private async safeEdit(text: string, force = false): Promise<boolean> {
    if (!this.messageId || this.disabled) return false;
    if (!force && this.finalized) return false;
    if (!force && text === this.lastSentText) return true;
    try {
      await this.callbacks.edit(this.messageId, text);
      this.lastSentText = text;
      this.editCount++;
      return true;
    } catch (err) {
      this.disabled = true;
      this.stopTimers();
      this.callbacks.warn?.("live status edit failed", err);
      return false;
    }
  }

  private formatToolStart(event: Extract<ProgressEvent, { kind: "tool" }>): string {
    const raw = event.text || event.name || "";
    const prefix = `${event.name} start`;
    let detail = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw.trim();
    if (detail.startsWith(":")) detail = detail.slice(1).trim();
    return detail ? `${event.name}: ${detail}` : event.name;
  }

  private formatStatus(): string {
    const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    const clean = (this.detail || "").replace(/\s+/g, " ").trim();
    const clipped = clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}\u2026` : clean;
    if (!clipped) {
      return this.opts.locale === "en"
        ? `${this.opts.botName} is working`
        : `${this.opts.botName} \u6b63\u5728\u6267\u884c`;
    }
    return this.opts.locale === "en"
      ? `${this.opts.botName} is working: ${clipped}`
      : `${this.opts.botName} \u6b63\u5728\u6267\u884c\uff1a${clipped}`;
  }

  private formatLimitNotice(): string {
    return this.opts.locale === "en"
      ? `${this.opts.botName} reached the update limit and is still running`
      : `${this.opts.botName} \u5df2\u8fbe\u66f4\u65b0\u9650\u5236\uff0c\u6b63\u5728\u6301\u7eed\u6267\u884c\u4e2d`;
  }
}
