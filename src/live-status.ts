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
  /** Total tool calls in the run (for the compact finished summary). */
  toolCalls: number;
  /** True when finished via noReply(): the model produced no user-visible reply. */
  noReply: boolean;
  /** Terminal state: running / done / failed (lets renderer pick color). */
  state: "running" | "done" | "failed";
};

export type LiveStatusCallbacks = {
  /** Create the status card; returns the new message id. */
  create: (view: LiveStatusView) => Promise<string | undefined>;
  /** Patch the existing status card. */
  edit: (messageId: string, view: LiveStatusView) => Promise<void>;
  warn?: (message: string, err?: unknown) => void;
};

export type LiveStatusOptions = {
  botName: string;
  locale?: "zh" | "en";
  delayMs?: number;
  maxChars?: number;
  /** Model name shown in the footer. */
  model?: string;
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
  private finalized = false;
  private disabled = false;
  /** Consecutive safeEdit failures. A single transient Feishu error (e.g. card
   *  patch code=2200 "Internal Error") must NOT permanently disable the card:
   *  we skip that one tick and keep the ticker running, so the next second's
   *  patch recovers it. Only after this many CONSECUTIVE failures do we give up.
   *  A success resets the counter. */
  private consecutiveEditFailures = 0;
  private state: "running" | "done" | "failed" = "running";
  /** Total tool calls (tool_start events) seen during the run, for the summary. */
  private toolCallCount = 0;
  /** True when finished via noReply(): show a "no content" summary. */
  private noReplyResult = false;

  constructor(private readonly callbacks: LiveStatusCallbacks, private readonly opts: LiveStatusOptions) {}

  get id(): string | undefined { return this.messageId; }

  start(initialDetail?: string): void {
    if (this.disabled || this.finalized || this.createTimer || this.messageId) return;
    this.startedAt = Date.now();
    if (initialDetail && initialDetail.trim()) {
      this.pushLine("lifecycle", initialDetail.trim());
    }
    this.createTimer = setTimeout(() => {
      this.createTimer = undefined;
      this.createPromise = this.ensureCreated();
    }, this.opts.delayMs ?? DEFAULT_DELAY_MS);
  }

  async progress(event: ProgressEvent | string): Promise<void> {
    if (this.disabled || this.finalized) return;
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
    await this.ensureCreatedNow();
    await this.safeEdit(this.buildView());
  }

  async complete(): Promise<void> {
    this.state = "done";
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    await this.safeEditFinal(this.buildView());
  }

  async fail(): Promise<void> {
    this.state = "failed";
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    await this.safeEditFinal(this.buildView());
  }

  /**
   * Finish when the model explicitly produced no reply (NO_REPLY) or an empty
   * final. Mark the card done but show a "no content" summary instead of the
   * activity window, so the user understands the run finished without output.
   */
  async noReply(): Promise<void> {
    this.state = "done";
    this.noReplyResult = true;
    this.finalized = true;
    this.stopTimers();
    if (this.createPromise) await this.createPromise.catch(() => {});
    if (!this.messageId || this.disabled) return;
    await this.safeEditFinal(this.buildView());
  }

  dispose(): void {
    this.finalized = true;
    this.stopTimers();
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
    const view = this.buildView();
    try {
      const id = await this.callbacks.create(view);
      if (!id) {
        this.disabled = true;
        return;
      }
      this.messageId = id;
      this.lastSentSignature = this.signature(view);
      this.startTicker();
    } catch (err) {
      this.disabled = true;
      this.callbacks.warn?.("live status create failed", err);
    }
  }

  /** Refresh the elapsed-time footer periodically even with no new activity. */
  private startTicker(): void {
    if (this.tickTimer || this.disabled || this.finalized) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.tickTimer = setInterval(() => {
      if (this.finalized || this.disabled || !this.messageId) return;
      void this.safeEdit(this.buildView());
    }, tickMs);
    this.tickTimer.unref?.();
  }

  private async safeEdit(view: LiveStatusView, force = false): Promise<boolean> {
    if (!this.messageId || this.disabled) return false;
    if (!force && this.finalized) return false;
    const sig = this.signature(view);
    if (!force && sig === this.lastSentSignature) return true;
    try {
      await this.callbacks.edit(this.messageId, view);
      this.lastSentSignature = sig;
      this.consecutiveEditFailures = 0; // recovered
      return true;
    } catch (err) {
      // A single transient Feishu error (e.g. card patch code=2200 "Internal
      // Error", rate limit, network blip) must NOT permanently freeze the card.
      // Skip this tick and keep the ticker running so the next patch recovers it.
      // Only give up after several CONSECUTIVE failures (a persistent problem,
      // e.g. the message was deleted or we truly lost access).
      this.consecutiveEditFailures++;
      const giveUp = this.consecutiveEditFailures >= MAX_CONSECUTIVE_EDIT_FAILURES;
      this.callbacks.warn?.(
        `live status edit failed (${this.consecutiveEditFailures}/${MAX_CONSECUTIVE_EDIT_FAILURES}${giveUp ? ", disabling" : ", will retry next tick"})`,
        err,
      );
      if (giveUp) {
        this.disabled = true;
        this.stopTimers();
      }
      return false;
    }
  }

  /**
   * Terminal edits (complete/fail/noReply) are one-shot — there is no next tick to
   * recover them — so a transient Feishu error (code=2200 etc.) would leave the
   * card stuck on "running". Retry the final patch a few times with small backoff
   * so the card reliably reaches its terminal state.
   */
  private async safeEditFinal(view: LiveStatusView): Promise<void> {
    if (!this.messageId || this.disabled) return;
    const attempts = Math.max(1, MAX_CONSECUTIVE_EDIT_FAILURES);
    for (let i = 0; i < attempts; i++) {
      try {
        await this.callbacks.edit(this.messageId, view);
        this.lastSentSignature = this.signature(view);
        return;
      } catch (err) {
        const last = i === attempts - 1;
        this.callbacks.warn?.(
          `live status final edit failed (${i + 1}/${attempts}${last ? ", giving up" : ", retrying"})`,
          err,
        );
        if (last) return;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
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
    else title = en ? `${this.opts.botName} is working` : `${this.opts.botName} \u6b63\u5728\u6267\u884c`;
    // On a clean finish (done / NO_REPLY) show only the compact summary. On a
    // failure (error / killed / timeout) keep the recent activity window too, so
    // the last few steps before the failure are visible for debugging.
    let lines: LiveStatusLine[];
    if (this.state === "running") {
      lines = [...this.lines];
    } else if (this.state === "failed") {
      lines = [...this.lines, this.buildSummaryLine(en)];
    } else {
      lines = [this.buildSummaryLine(en)];
    }
    return {
      title,
      lines,
      elapsed: this.formatElapsed(),
      model: this.opts.model,
      toolCalls: this.toolCallCount,
      noReply: this.noReplyResult,
      state: this.state,
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
