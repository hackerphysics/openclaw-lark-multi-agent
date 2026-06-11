import type { ProgressEvent } from "./openclaw-client";

const DEFAULT_DELAY_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS || 800);
const DEFAULT_THROTTLE_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_THROTTLE_MS || 1200);
const DEFAULT_MAX_CHARS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS || 120);
const SPINNER = ["◐", "◓", "◑", "◒"];

export type LiveStatusCallbacks = {
  create: (text: string) => Promise<string | undefined>;
  edit: (messageId: string, text: string) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
};

export type LiveStatusOptions = {
  botName: string;
  locale?: "zh" | "en";
  delayMs?: number;
  throttleMs?: number;
  maxChars?: number;
};

export class LiveStatusController {
  private messageId?: string;
  private lastSentText = "";
  private pendingText = "";
  private lastSentAt = 0;
  private spinnerIndex = 0;
  private createTimer?: NodeJS.Timeout;
  private createPromise?: Promise<void>;
  private finalized = false;
  private disabled = false;

  constructor(private readonly callbacks: LiveStatusCallbacks, private readonly opts: LiveStatusOptions) {}

  get id(): string | undefined { return this.messageId; }

  start(initialText?: string): void {
    if (this.disabled || this.finalized || this.createTimer || this.messageId) return;
    this.pendingText = initialText || this.formatStatus(this.opts.locale === "en" ? "working" : "正在处理");
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated(this.pendingText);
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  async progress(event: ProgressEvent | string): Promise<void> {
    if (this.disabled || this.finalized) return;
    const raw = typeof event === "string" ? event : event.text;
    const formatted = this.formatStatus(raw || (this.opts.locale === "en" ? "working" : "正在处理"));
    this.pendingText = formatted;
    if (!this.messageId) return;
    const now = Date.now();
    if (now - this.lastSentAt < (this.opts.throttleMs ?? DEFAULT_THROTTLE_MS)) return;
    await this.safeEdit(formatted);
  }

  async finalize(finalText: string): Promise<boolean> {
    this.finalized = true;
    if (this.createTimer) {
      clearTimeout(this.createTimer);
      this.createTimer = undefined;
    }
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return false;
    return this.safeEdit(finalText, true);
  }

  async fail(errorText: string): Promise<boolean> {
    this.finalized = true;
    if (this.createTimer) {
      clearTimeout(this.createTimer);
      this.createTimer = undefined;
    }
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return false;
    return this.safeEdit(errorText, true);
  }

  dispose(): void {
    this.finalized = true;
    if (this.createTimer) clearTimeout(this.createTimer);
    this.createTimer = undefined;
  }

  private async ensureCreated(text: string): Promise<void> {
    if (this.disabled || this.finalized || this.messageId) return;
    try {
      const id = await this.callbacks.create(text);
      if (!id) {
        this.disabled = true;
        return;
      }
      this.messageId = id;
      this.lastSentText = text;
      this.lastSentAt = Date.now();
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status create failed", err);
    }
  }

  private async safeEdit(text: string, force = false): Promise<boolean> {
    if (!this.messageId || this.disabled) return false;
    if (!force && this.finalized) return false;
    if (!force && text === this.lastSentText) return true;
    try {
      await this.callbacks.edit(this.messageId, text);
      this.lastSentText = text;
      this.lastSentAt = Date.now();
      return true;
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status edit failed", err);
      return false;
    }
  }

  private formatStatus(raw: string): string {
    const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
    const clean = raw.replace(/\s+/g, " ").trim();
    const clipped = clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}…` : clean;
    const spin = SPINNER[this.spinnerIndex++ % SPINNER.length];
    return this.opts.locale === "en"
      ? `${spin} ${this.opts.botName} working: ${clipped}`
      : `${spin} ${this.opts.botName} 正在处理：${clipped}`;
  }
}
