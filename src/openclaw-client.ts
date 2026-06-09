import WebSocket from "ws";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { OpenClawConfig } from "./config.js";
import { ChatMessage } from "./message-store.js";
import { getBridgeAttachmentsDir, getDataDir } from "./paths.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

export const GATEWAY_PROTOCOL_MIN = 3;
export const GATEWAY_PROTOCOL_MAX = 4;

const BRIDGE_ATTACHMENTS_DIR = getBridgeAttachmentsDir();
const CONTEXT_SYNC_DIR = join(getDataDir(), "context-sync");
const MAX_INLINE_CONTEXT_MESSAGES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_INLINE_CONTEXT_MESSAGES || 20);
const MAX_INLINE_CONTEXT_BYTES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_INLINE_CONTEXT_BYTES || 128 * 1024);

type PendingReq = {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * OpenClaw Gateway WebSocket client.
 * Full agent pipeline — tools, memory, skills, context management by OpenClaw.
 */
export class OpenClawClient {
  private config: OpenClawConfig;
  private ws: WebSocket | null = null;
  private pending: Map<string, PendingReq> = new Map();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private agentEvents: Map<string, any[]> = new Map();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  /** Callbacks for tool events (verbose mode) */
  private toolEventCallbacks: Map<string, (toolName: string, toolInput: string, toolOutput: string) => void> = new Map();
  private lastToolNamesByItemId: Map<string, string> = new Map();
  private sessionMessageCallbacks: Map<string, (text: string, meta?: { sourceType?: string }) => void> = new Map();
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
  /** Session keys whose delivery is owned by this bridge's chatSend final path. */
  private ownedDeliverySessions: Set<string> = new Set();
  private ownedDeliverySessionTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Session keys whose proactive messages must be dropped by the bridge (e.g. discussion scheduler owns delivery). */
  private mutedProactiveSessions: Set<string> = new Set();
  private mutedProactiveSessionCounts: Map<string, number> = new Map();
  /** Sessions force-aborted by /stop; collectReply should finish immediately instead of waiting for idle timeout. */
  private forceAbortedSessions: Set<string> = new Set();
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
                  auth: { token: this.config.token },
                  userAgent: "openclaw-lark-multi-agent/1.0.0",
                },
              })
            );
          } else if (frame.type === "res" && frame.ok && frame.payload?.type === "hello-ok") {
            handshakeDone = true;
            this.connected = true;
            console.log("[OpenClaw] Connected to Gateway WS");
            // Re-subscribe all previously subscribed sessions
            for (const key of this.subscribedKeys) {
              this.rpc("sessions.messages.subscribe", { key }).catch(() => {});
              this.rpc("sessions.messages.subscribe", { key: `agent:main:${key}` }).catch(() => {});
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
            if (frame.ok) p.resolve(frame.payload);
            else p.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`));
          }
        }

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
                this.agentEvents.get(sk)!.push({
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
              this.agentEvents.get(sk)!.push({
                ...frame.payload,
                stream: "chatFinal",
                data: { text: textParts.join("\n") },
              });
            }
          } else {
            this.agentEvents.get(sk)!.push(frame.payload);
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
            this.agentEvents.get(rawKey)!.push({
              runId: frame.payload.runId,
              sessionKey: rawKey,
              stream: "sessionUser",
              data: { text: visibleUserText },
            });
          }
          const visibleAssistantText = this.extractVisibleAssistantText(msg);
          if (visibleAssistantText) {
            if (!this.agentEvents.has(rawKey)) this.agentEvents.set(rawKey, []);
            this.agentEvents.get(rawKey)!.push({
              runId: frame.payload.runId,
              sessionKey: rawKey,
              stream: "transcriptAssistant",
              data: { deltaText: visibleAssistantText, delta: visibleAssistantText, replace: true },
            });
          }
          this.handleProactiveSessionMessage(rawKey, msg);

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
          this.flushVerboseAssistantState(rawKey);
          this.clearVerboseAssistantState(rawKey);
        }

        // Agent item / command output events — real-time tool tracking for verbose mode.
        if (frame.event === "agent" && frame.payload?.stream === "item") {
          const data = frame.payload.data || {};
          const rawKey = frame.payload.sessionKey || "";
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const toolCb = this.toolEventCallbacks.get(rawKey) || this.toolEventCallbacks.get(shortKey);
          if (data.itemId && data.name) this.lastToolNamesByItemId.set(String(data.itemId), String(data.name));

          if (data.kind === "tool" && data.phase === "start") {
            this.flushVerboseAssistantState(rawKey);
            this.clearVerboseAssistantState(rawKey);
          }

          if (toolCb && data.kind === "tool" && data.name && (data.phase === "start" || data.phase === "end" || data.phase === "error")) {
            const phase = data.phase || "event";
            const meta = data.meta || data.input || data.args || "";
            const output = data.output || data.result || data.error || "";
            toolCb(`${data.name} ${phase}`.trim(), String(meta || ""), String(output || ""));
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
        else console.error("[OpenClaw] WS error:", err.message);
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.connectPromise = null;
        console.log("[OpenClaw] WS disconnected");
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

  private extractVisibleAssistantText(msg: any, options: { allowMixedToolText?: boolean } = {}): string {
    if (msg?.role !== "assistant") return "";
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

  private clearVerboseAssistantState(sessionKey: string): void {
    for (const key of [sessionKey, `agent:main:${sessionKey}`]) {
      const timer = this.verboseAssistantTimers.get(key);
      if (timer) clearTimeout(timer);
      this.verboseAssistantTimers.delete(key);
      this.verboseAssistantLatest.delete(key);
      this.verboseAssistantSent.delete(key);
      this.verboseAssistantLastTouched.delete(key);
    }
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
  }

  private flushVerboseAssistantState(rawKey: string): boolean {
    if (!this.isVerboseTranscriptEnabled(rawKey)) return false;
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
    if (!cb) return false;
    const key = rawKey;
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
    cb(toSend, { sourceType: "verbose_transcript" });
    return true;
  }

  private handleVerboseAssistantStream(payload: any): void {
    const rawKey = payload?.sessionKey || "";
    if (!rawKey || !this.isVerboseTranscriptEnabled(rawKey)) return;
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
    if (!cb) return;
    const data = payload.data || {};
    const fullText = typeof data.text === "string" ? data.text : typeof data.deltaText === "string" && data.replace ? data.deltaText : "";
    const deltaText = !fullText && typeof data.delta === "string" ? data.delta : !fullText && typeof data.deltaText === "string" ? data.deltaText : "";
    const key = rawKey;
    const previous = this.verboseAssistantLatest.get(key) || "";
    const text = (fullText || (previous + deltaText)).trim();
    if (!text) return;
    const now = Date.now();
    this.verboseAssistantLatest.set(key, text);
    this.verboseAssistantLastTouched.set(key, now);
    this.pruneVerboseCaches(now);
    if (text.length >= 3000) {
      this.flushVerboseAssistantState(rawKey);
    }
  }

  private handleProactiveSessionMessage(rawKey: string, msg: any): boolean {
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");

    // Proactive assistant text messages. Cron/session-targeted runs often emit
    // structured content arrays rather than a plain string. Extract only visible
    // text parts and ignore thinking/tool blocks so the bridge can deliver final
    // cron results via the bot.
    const allowVerboseTranscript = this.isVerboseTranscriptEnabled(rawKey);
    const proactiveText = this.extractVisibleAssistantText(msg, { allowMixedToolText: allowVerboseTranscript });
    if (!proactiveText) return false;
    if (this.mutedProactiveSessions.has(rawKey) || this.mutedProactiveSessions.has(shortKey)) {
      console.log(`[OpenClaw] Dropping proactive msg for ${shortKey}; delivery is owned by the caller`);
      return false;
    }
    if (this.suppressedSessions.has(rawKey) || this.suppressedSessions.has(shortKey)) {
      console.log(`[OpenClaw] Dropping proactive transcript msg for ${shortKey}; waiting for final delivery path`);
      return false;
    }
    const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
    if (cb) cb(proactiveText);
    return Boolean(cb);
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
        console.error("[OpenClaw] Reconnect failed:", (err as Error).message);
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
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /**
   * Collect agent reply by polling accumulated events.
   * Matches by initial runId OR sessionKey to handle multi-turn tool calling
   * where OpenClaw creates new runIds for each tool-call round.
   * No aggressive timeout — waits for lifecycle end as the source of truth.
   * 30-minute safety net only for catastrophic WS disconnection.
   */
private collectReply(runId: string, timeoutMs = 1800000, targetSessionKey?: string, options?: { emptyFinalAsNoReply?: boolean; expectedUserText?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = "";
      let chatDeltaText = "";
      let chatFinalText = "";
      let transcriptAssistantText = "";
      let sessionKey = targetSessionKey ? `agent:main:${targetSessionKey.replace(/^agent:[^:]+:/, "")}` : "";
      let shortSessionKey = targetSessionKey ? targetSessionKey.replace(/^agent:[^:]+:/, "") : "";
      let chatFinalTimer: ReturnType<typeof setTimeout> | null = null;
      let lifecycleEndTimer: ReturnType<typeof setTimeout> | null = null;
      let replayInvalidTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingRuntimeFailureText = "";
      let lastActivitySummary = "";
      let lastActivityAt = 0;
      const collectStartedAt = Date.now();
      let lifecycleStartedLogged = false;
      const expectedUserText = options?.expectedUserText?.trim() || "";
      let anchorSeen = !expectedUserText;
      const activeRunIds = new Set<string>([runId]);
      let preAnchorEvents: any[] = [];
      const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
      const isExpectedUserText = (value: string) => {
        const actual = normalizeText(value);
        const expected = normalizeText(expectedUserText);
        if (!actual || !expected) return false;
        return actual === expected || actual.includes(expected) || expected.includes(actual);
      };

      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearInterval(poller);
          if (chatFinalTimer) clearTimeout(chatFinalTimer);
          if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
          if (replayInvalidTimer) clearTimeout(replayInvalidTimer);
          console.warn(`[OpenClaw] collectReply idle timeout for runId=${runId} sessionKey=${sessionKey}`);
          this.abortChat(targetSessionKey || sessionKey, runId).catch((err) => {
            console.warn(`[OpenClaw] abort after collectReply idle timeout failed:`, (err as Error).message);
          });
          const visibleText = this.pickBestCollectedText(chatFinalText, text, chatDeltaText, transcriptAssistantText);
          if (visibleText) {
            resolve(visibleText);
          } else if (pendingRuntimeFailureText) {
            resolve(`${pendingRuntimeFailureText}\n\nLMA 已连续 ${Math.round(timeoutMs / 60000)} 分钟没有收到新的工具输出或最终回复，已停止等待。`);
          } else if (lastActivitySummary) {
            resolve(`⚠️ Agent 长时间没有产生最终回复\n最后活动: ${lastActivitySummary}\n时间: ${new Date(lastActivityAt).toLocaleString()}\n\nLMA 已连续 ${Math.round(timeoutMs / 60000)} 分钟没有收到新的工具输出或最终回复，已停止等待。`);
          } else {
            resolve("(timeout: no reply received)");
          }
        }, timeoutMs);
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
      const buildFailureText = (ev: any): string => {
        const state = ev.data?.livenessState || ev.data?.status || "unknown";
        const reason = ev.data?.stopReason || "";
        const replayInvalid = ev.data?.replayInvalid ? ", replayInvalid" : "";
        const lines = [`⚠️ Agent 未正常完成`, `状态: ${state}${replayInvalid}${reason ? "\n原因: " + reason : ""}`];
        if (lastActivitySummary) {
          lines.push(`最后活动: ${lastActivitySummary}`);
          lines.push(`最后活动时间: ${new Date(lastActivityAt).toLocaleString()}`);
        }
        lines.push("请重试，或用 /reset 重置会话");
        return lines.join("\n");
      };
      resetIdleTimer();

      const finish = (finalText: string) => {
        clearTimeout(idleTimer);
        clearInterval(poller);
        if (chatFinalTimer) clearTimeout(chatFinalTimer);
        if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
        if (replayInvalidTimer) clearTimeout(replayInvalidTimer);
        resolve(finalText);
      };

      const poller = setInterval(() => {
        // /stop force-abort: finish immediately instead of waiting for the
        // cancelled lifecycle to be treated as a transient state (idle timeout).
        if (sessionKey && (this.forceAbortedSessions.has(sessionKey) || this.forceAbortedSessions.has(shortSessionKey))) {
          this.forceAbortedSessions.delete(sessionKey);
          this.forceAbortedSessions.delete(shortSessionKey);
          finish(text || chatDeltaText || chatFinalText || transcriptAssistantText || "NO_REPLY");
          return;
        }
        const bucketsToScan = sessionKey
          ? Array.from(new Set([sessionKey, shortSessionKey].filter(Boolean)))
          : Array.from(this.agentEvents.keys());

        for (const bucketKey of bucketsToScan) {
          const bucket = this.agentEvents.get(bucketKey);
          if (!bucket) continue;

          let i = 0;
          while (i < bucket.length) {
            const ev = bucket[i];

            const evRunId = typeof ev.runId === "string" ? ev.runId : "";
            const eventSessionMatches = Boolean(sessionKey && (ev.sessionKey === sessionKey || ev.sessionKey === targetSessionKey || ev.sessionKey === shortSessionKey));
            const matchesRun = evRunId ? activeRunIds.has(evRunId) : false;

            if (!sessionKey && ev.sessionKey) {
              shortSessionKey = String(ev.sessionKey).replace(/^agent:[^:]+:/, "");
              sessionKey = `agent:main:${shortSessionKey}`;
            }

            if (eventSessionMatches && ev.stream === "sessionUser") {
              bucket.splice(i, 1);
              if (!anchorSeen && isExpectedUserText(ev.data?.text || "")) {
                anchorSeen = true;
                resetIdleTimer();
                for (const pendingEv of preAnchorEvents) {
                  const pendingRunId = typeof pendingEv.runId === "string" ? pendingEv.runId : "";
                  if (pendingRunId && pendingEv.stream === "lifecycle" && pendingEv.data?.phase === "start") {
                    activeRunIds.add(pendingRunId);
                  }
                }
                const replay = preAnchorEvents.filter((pendingEv) => {
                  const pendingRunId = typeof pendingEv.runId === "string" ? pendingEv.runId : "";
                  return !pendingRunId || activeRunIds.has(pendingRunId);
                });
                preAnchorEvents = [];
                if (replay.length) bucket.splice(i, 0, ...replay);
              } else if (!anchorSeen) {
                // A different user/runtime continuation belongs to stale queued work;
                // anything before it should not be attributed to the next real user turn.
                preAnchorEvents = [];
              }
              continue;
            }

            if (eventSessionMatches && expectedUserText && !anchorSeen && !matchesRun) {
              bucket.splice(i, 1);
              preAnchorEvents.push(ev);
              if (preAnchorEvents.length > 200) preAnchorEvents.shift();
              continue;
            }

            let matchesSession = false;
            if (eventSessionMatches && anchorSeen) {
              if (!expectedUserText) {
                // Backward-compatible mode for tests/internal callers that do not
                // provide an anchor: allow session-key matching as before.
                matchesSession = true;
              } else if (!evRunId) {
                matchesSession = true;
              } else if (activeRunIds.has(evRunId)) {
                matchesSession = true;
              } else if (ev.stream === "lifecycle" && ev.data?.phase === "start") {
                activeRunIds.add(evRunId);
                matchesSession = true;
              }
            }

            if (!(matchesRun || matchesSession)) {
              // When collectReply is anchored to a specific user message, discard stale
              // session events that arrive before that anchor (or from unrelated runIds)
              // so replayInvalid/aborted events from older runtime continuations cannot
              // be misattributed to the current user turn.
              if (eventSessionMatches && expectedUserText) {
                bucket.splice(i, 1);
              } else {
                i++;
              }
              continue;
            }

            bucket.splice(i, 1);
            // Any matching event — including toolCall/toolResult/item/lifecycle —
            // means the agent is still alive. Use an idle timeout, not an absolute
            // wall-clock timeout, so long tool-heavy tasks are not killed while active.
            resetIdleTimer();
            rememberActivity(ev);
            // If more events arrive after a replay-invalid lifecycle end, that lifecycle
            // was not terminal for the user-visible run. Keep waiting for the real final.
            if (replayInvalidTimer) {
              clearTimeout(replayInvalidTimer);
              replayInvalidTimer = null;
            }
            if (ev.stream !== "lifecycle") {
              pendingRuntimeFailureText = "";
            }

            if (ev.stream === "lifecycle" && ev.data?.phase === "start" && !lifecycleStartedLogged) {
              lifecycleStartedLogged = true;
              console.log(`[OpenClaw] lifecycle start for runId=${runId} after ${Date.now() - collectStartedAt}ms`);
            }
            if ((ev.stream === "assistant" || ev.stream === "chatDelta" || ev.stream === "transcriptAssistant") && (ev.data?.deltaText || ev.data?.delta)) {
              const chunk = ev.data.deltaText || ev.data.delta;
              if (ev.stream === "assistant") {
                if (ev.data?.replace) {
                  text = chunk;
                } else {
                  text += chunk;
                }
              } else if (ev.stream === "chatDelta") {
                if (ev.data?.replace) {
                  chatDeltaText = chunk;
                } else {
                  chatDeltaText += chunk;
                }
              } else {
                if (ev.data?.replace) {
                  transcriptAssistantText = chunk;
                } else {
                  transcriptAssistantText += chunk;
                }
              }
            }
            if (ev.stream === "chatFinal") {
              chatFinalText = ev.data?.text || "";
              // Fallback: if lifecycle end doesn't arrive within 5s, resolve
              if (!chatFinalTimer) {
                chatFinalTimer = setTimeout(() => {
                  console.warn(`[OpenClaw] collectReply: lifecycle end missing, using chatFinal fallback`);
                  this.abortChat(targetSessionKey || sessionKey, runId).catch((err) => {
                    console.warn(`[OpenClaw] abort after chatFinal fallback failed:`, (err as Error).message);
                  });
                  // Prefer final chat message over accumulated deltas: some providers may
                  // emit only partial deltas (e.g. "N") while final contains "NO_REPLY".
                  const latestFinalText = this.pickBestCollectedText(chatFinalText, text, chatDeltaText, transcriptAssistantText);
                  if (latestFinalText) {
                    finish(latestFinalText);
                  } else if (options?.emptyFinalAsNoReply) {
                    finish("NO_REPLY");
                  } else {
                    console.warn(`[OpenClaw] collectReply: empty chatFinal fallback ignored; waiting for real text or idle timeout`);
                    chatFinalTimer = null;
                  }
                }, 5000);
              }
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "end") {
              // Prefer final chat message over accumulated deltas: some providers may
              // emit only partial deltas (e.g. "N") while final contains "NO_REPLY".
              const finalText = this.pickBestCollectedText(chatFinalText, text, chatDeltaText, transcriptAssistantText);
              const finishFromLifecycle = () => {
                const latestFinalText = this.pickBestCollectedText(chatFinalText, text, chatDeltaText, transcriptAssistantText);
                if (!chatFinalText && latestFinalText.trim() === "N") {
                  // Some providers stream the first character of NO_REPLY ("N") but
                  // never deliver a final chat message in time. Never surface a lone
                  // "N" to the user; treat it as a suppressed reply.
                  finish("NO_REPLY");
                  return;
                }
                if (!latestFinalText && options?.emptyFinalAsNoReply) {
                  finish("NO_REPLY");
                  return;
                }
                if (!latestFinalText) {
                  const failureText = buildFailureText(ev);
                  const state = ev.data?.livenessState || "";
                  const reason = ev.data?.stopReason || "";
                  // replayInvalid, cancelled/rpc, and abandoned are often
                  // transient runtime states — the real reply may still arrive
                  // shortly after via session.message or a subsequent run.
                  // Defer the failure instead of finishing immediately.
                  const isTransient = ev.data?.replayInvalid
                    || state === "cancelled"
                    || state === "abandoned"
                    || reason === "rpc";
                  if (isTransient) {
                    pendingRuntimeFailureText = failureText;
                    console.warn(`[OpenClaw] transient lifecycle end (${state}, reason=${reason}) for runId=${evRunId || runId}; waiting for real text or idle timeout`);
                    return;
                  }
                  if (state !== "working") {
                    finish(failureText);
                    return;
                  }
                  console.warn(`[OpenClaw] empty lifecycle end ignored for runId=${evRunId || runId}; waiting for real text or idle timeout`);
                  return;
                }
                finish(latestFinalText);
              };

              // If lifecycle end beats chat final, a short delta like "N" can be a truncated
              // final reply. Wait for chatFinal before resolving; otherwise suppress lone "N".
              if (!options?.emptyFinalAsNoReply && ev.data?.livenessState === "working" && !chatFinalText && text.length <= 1) {
                lifecycleEndTimer = setTimeout(finishFromLifecycle, 5000);
              } else {
                finishFromLifecycle();
              }
              return;
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "error") {
              clearTimeout(idleTimer);
              clearInterval(poller);
              if (chatFinalTimer) clearTimeout(chatFinalTimer);
              if (lifecycleEndTimer) clearTimeout(lifecycleEndTimer);
              reject(new Error(`Agent error: ${ev.data?.error || "unknown"}`));
              return;
            }
          }
        }
      }, 50);
    });
  }

  private pickBestCollectedText(chatFinalText: string, assistantText: string, chatDeltaText: string, transcriptAssistantText: string): string {
    if (chatFinalText) return chatFinalText;
    const candidates = [assistantText, chatDeltaText, transcriptAssistantText].filter((value) => value && value.trim());
    if (candidates.length === 0) return "";
    // transcriptAssistant is a full transcript mirror. Keep it separate from
    // streaming deltas to avoid concatenating the same response twice; choose
    // the richest available non-final text as fallback.
    return candidates.sort((a, b) => b.length - a.length)[0];
  }



  // --- Session management ---

  async createSession(params: { key: string; model: string; label?: string }): Promise<any> {
    return this.rpc("sessions.create", params);
  }

  async patchSession(params: { key: string; model?: string; label?: string }): Promise<any> {
    return this.rpc("sessions.patch", params, 10000);
  }

  async getSessionStatus(key: string): Promise<any> {
    return this.rpc("sessions.describe", { key });
  }


  async injectAssistantMessage(params: { sessionKey: string; message: string; label?: string }): Promise<any> {
    return this.rpc("chat.inject", params, 10000);
  }

  /**
   * Get session info (model, tokens, etc.) for status display.
   */
  async getSessionInfo(sessionKey: string): Promise<any> {
    return this.rpc("sessions.describe", { key: sessionKey });
  }

  /**
   * Ensure session is using the expected model. If not, patch it back.
   * Returns true if a correction was made.
   */
  async ensureModel(sessionKey: string, expectedModel: string): Promise<boolean> {
    try {
      // Always patch to ensure model is correct — describe may return internal model names
      // Use short timeout as sessions.patch may not return a response
      await this.patchSession({ key: sessionKey, model: expectedModel }).catch(() => {});
      // Also try with full key prefix
      await this.patchSession({ key: `agent:main:${sessionKey}`, model: expectedModel }).catch(() => {});
      console.log(`[OpenClaw] Model ensured: ${sessionKey} → ${expectedModel}`);
    } catch (err) {
      console.warn(`[OpenClaw] ensureModel patch failed:`, (err as Error).message);
    }
    return false;
  }

  async deleteSession(key: string, deleteTranscript = true): Promise<any> {
    return this.rpc("sessions.delete", { key, deleteTranscript });
  }

  async resetSession(key: string): Promise<any> {
    // sessions.reset may not return a response; use short timeout
    return this.rpc("sessions.reset", { key }, 5000).catch(() => {});
  }

  async compactSession(key: string): Promise<any> {
    const release = await this.acquireMaintenanceSlot("sessions.compact");
    const startedAt = Date.now();
    try {
      return await this.rpc("sessions.compact", { key }, 10 * 60 * 1000);
    } finally {
      console.log(`[OpenClaw] sessions.compact finished for ${key} in ${Date.now() - startedAt}ms`);
      release();
    }
  }

  // --- Chat ---

  /**
   * Send a message to a session and get the agent reply.
   * deliver=false prevents OpenClaw from auto-posting to channels.
   */
  async abortChat(sessionKey: string, runId?: string): Promise<any> {
    const key = sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
    // chat.abort supports { sessionKey } with no runId to abort ALL active runs
    // for that session. Used by /stop to force-clear a stuck run.
    if (!runId) {
      // Mark the session so any in-flight collectReply finishes immediately
      // instead of treating the cancelled lifecycle as a transient state.
      this.forceAbortedSessions.add(key);
      this.forceAbortedSessions.add(`agent:main:${key}`);
    }
    const params: any = runId ? { sessionKey: key, runId } : { sessionKey: key };
    return this.rpc("chat.abort", params, 5000).catch(() => {});
  }

  private sessionKeyVariants(key: string): string[] {
    const shortKey = key.startsWith("agent:main:") ? key.slice("agent:main:".length) : key;
    return [shortKey, `agent:main:${shortKey}`];
  }

  private trackChatEventSession(sessionKey: string, state: string | undefined, payload: any): void {
    if (!sessionKey || sessionKey === "__default__") return;
    const keys = this.sessionKeyVariants(sessionKey);
    if (this.isOwnedDeliverySession(sessionKey)) {
      // This chat event belongs to a bridge-owned chat.send run. The final answer
      // is delivered by collectReply/processQueue, so transcript session.message
      // mirrors must stay suppressed briefly.
      this.suppressSessionKeys(keys);
      if (state === "final" || state === "error" || state === "aborted") this.releaseSuppressedSessionKeysAfter(keys, 30000);
      return;
    }
    // External WebChat/Control UI chat against an LMA session: do not forward
    // streaming transcript updates, but allow the final chat message to be
    // delivered through the proactive callback after it is committed.
    if (state === "delta") {
      this.suppressSessionKeys(keys);
    } else if (state === "final") {
      const text = this.extractTextFromChatMessage(payload?.message);
      if (text) this.emitProactiveForSession(sessionKey, text);
      // Keep transcript mirrors suppressed briefly; chat final already emitted
      // the user-visible result for external WebChat/Control UI turns.
      this.releaseSuppressedSessionKeysAfter(keys, 30000);
    } else if (state === "error" || state === "aborted") {
      this.releaseSuppressedSessionKeysAfter(keys, 0);
    }
  }

  private extractTextFromChatMessage(message: any): string {
    const parts = Array.isArray(message?.content) ? message.content : [];
    return parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim();
  }

  private emitProactiveForSession(sessionKey: string, text: string): boolean {
    const [shortKey, fullKey] = this.sessionKeyVariants(sessionKey);
    const cb = this.sessionMessageCallbacks.get(fullKey) || this.sessionMessageCallbacks.get(shortKey);
    if (!cb) return false;
    cb(text);
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

  private ownDeliverySessionKeys(keys: string[]): void {
    for (const key of keys) {
      const timer = this.ownedDeliverySessionTimers.get(key);
      if (timer) clearTimeout(timer);
      this.ownedDeliverySessionTimers.delete(key);
      this.ownedDeliverySessions.add(key);
    }
  }

  private releaseOwnedDeliverySessionKeysAfter(keys: string[], delayMs: number): void {
    for (const key of keys) {
      const oldTimer = this.ownedDeliverySessionTimers.get(key);
      if (oldTimer) clearTimeout(oldTimer);
      const timer = setTimeout(() => {
        this.ownedDeliverySessions.delete(key);
        this.ownedDeliverySessionTimers.delete(key);
      }, delayMs);
      this.ownedDeliverySessionTimers.set(key, timer);
    }
  }

  private isOwnedDeliverySession(sessionKey: string): boolean {
    const [shortKey, fullKey] = this.sessionKeyVariants(sessionKey);
    return this.ownedDeliverySessions.has(shortKey) || this.ownedDeliverySessions.has(fullKey);
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

  async chatSend(params: {
    sessionKey: string;
    message: string;
    attachments?: ChatAttachment[];
    deliver?: boolean;
    timeoutMs?: number;
    emptyFinalAsNoReply?: boolean;
    /** Called immediately before issuing chat.send RPC; use for at-most-once bookkeeping. */
    onSendAttempt?: () => void | Promise<void>;
    /** Called after chat.send RPC succeeds and OpenClaw has accepted the user message. */
    onSubmitted?: (runId: string) => void | Promise<void>;
  }): Promise<string> {
    const sk = params.sessionKey;
    const fullSessionKey = `agent:main:${sk}`;
    const suppressedKeys = [sk, fullSessionKey];
    this.suppressSessionKeys(suppressedKeys);
    this.ownDeliverySessionKeys(suppressedKeys);
    this.clearVerboseAssistantState(sk);
    try {
      // Drop stale buffered events for this session before starting a new run.
      // This prevents an old final text (e.g. previous "ok") from being consumed by
      // the next message while still allowing sessionKey matching for internal runIds.
      this.agentEvents.set(fullSessionKey, []);
      this.agentEvents.set(sk, []);
      const releaseChatSendSlot = await this.acquireChatSendSlot();
      let result: any;
      const sendStartedAt = Date.now();
      try {
        await params.onSendAttempt?.();
        result = await this.rpc("chat.send", {
          sessionKey: sk,
          message: params.message,
          attachments: params.attachments,
          deliver: params.deliver ?? false,
          idempotencyKey: randomUUID(),
        });
      } finally {
        releaseChatSendSlot();
      }
      console.log(`[OpenClaw] chat.send runId: ${result.runId} (rpc=${Date.now() - sendStartedAt}ms, attachments=${params.attachments?.length || 0})`);
      await params.onSubmitted?.(result.runId);
      return await this.collectReply(result.runId, params.timeoutMs || 1800000, sk, { emptyFinalAsNoReply: params.emptyFinalAsNoReply, expectedUserText: params.message });
    } finally {
      // OpenClaw can emit the final assistant session.message a moment after
      // collectReply returns. Keep a short grace window so normal chat replies
      // are not delivered twice via the proactive-message path. Cron/LMA runs
      // are unaffected because they do not go through chatSend.
      this.releaseSuppressedSessionKeysAfter(suppressedKeys, 30000);
      this.releaseOwnedDeliverySessionKeysAfter(suppressedKeys, 30000);
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
    timeoutMs?: number;
    emptyFinalAsNoReply?: boolean;
    /** Native escaped commands (//status -> /status) should not receive catch-up context. */
    includeContext?: boolean;
    /** Disable bridge attachment hints for native commands and other exact pass-through messages. */
    includeBridgeAttachmentHint?: boolean;
    /** Called immediately before issuing chat.send RPC; use for at-most-once bookkeeping. */
    onSendAttempt?: () => void | Promise<void>;
    /** Called after chat.send RPC succeeds and OpenClaw has accepted the combined message. */
    onSubmitted?: (runId: string) => void | Promise<void>;
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
        onSendAttempt: params.onSendAttempt,
        onSubmitted: params.onSubmitted,
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
      onSendAttempt: params.onSendAttempt,
      onSubmitted: params.onSubmitted,
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
          attachments.push({
            type: "file",
            mimeType: "text/markdown",
            fileName: basename(docPath),
            content: readFileSync(docPath, "utf8"),
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
    for (const timer of this.suppressedSessionTimers.values()) clearTimeout(timer);
    this.suppressedSessionTimers.clear();
    this.suppressedSessions.clear();
    this.mutedProactiveSessions.clear();
    this.mutedProactiveSessionCounts.clear();
    for (const timer of this.ownedDeliverySessionTimers.values()) clearTimeout(timer);
    this.ownedDeliverySessionTimers.clear();
    for (const timer of this.verboseAssistantTimers.values()) clearTimeout(timer);
    this.verboseAssistantTimers.clear();
    this.verboseAssistantLatest.clear();
    this.verboseAssistantSent.clear();
    this.verboseAssistantLastTouched.clear();
    this.lastToolNamesByItemId.clear();
    this.ownedDeliverySessions.clear();
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
    onMessage: (text: string, meta?: { sourceType?: string }) => void
  ): Promise<void> {
    // Register under both the short key and the full key with agent:main: prefix
    this.sessionMessageCallbacks.set(sessionKey, onMessage);
    this.sessionMessageCallbacks.set(`agent:main:${sessionKey}`, onMessage);
    this.subscribedKeys.add(sessionKey);
    try {
      // Try subscribing with short key first, then full key
      await this.rpc("sessions.messages.subscribe", { key: sessionKey }).catch(() => {});
      await this.rpc("sessions.messages.subscribe", { key: `agent:main:${sessionKey}` }).catch(() => {});
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
    this.sessionMessageCallbacks.delete(sessionKey);
    this.sessionMessageCallbacks.delete(`agent:main:${sessionKey}`);
    this.toolEventCallbacks.delete(sessionKey);
    this.toolEventCallbacks.delete(`agent:main:${sessionKey}`);
    this.setVerboseTranscriptDelivery(sessionKey, false);
    this.subscribedKeys.delete(sessionKey);
    try {
      await this.rpc("sessions.messages.unsubscribe", { key: sessionKey });
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
