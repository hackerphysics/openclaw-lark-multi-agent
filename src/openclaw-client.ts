import WebSocket from "ws";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { basename, extname } from "path";
import { OpenClawConfig } from "./config.js";
import { ChatMessage } from "./message-store.js";
import { getBridgeAttachmentsDir } from "./paths.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

const BRIDGE_ATTACHMENTS_DIR = getBridgeAttachmentsDir();

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
  private sessionMessageCallbacks: Map<string, (text: string) => void> = new Map();
  /** Session keys that should be re-subscribed on reconnect */
  private subscribedKeys: Set<string> = new Set();
  /** Session keys with active/recent chatSend — proactive is forwarded and deduped by outbox. */
  private suppressedSessions: Set<string> = new Set();
  private suppressedSessionTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Session keys whose proactive messages must be dropped by the bridge (e.g. discussion scheduler owns delivery). */
  private mutedProactiveSessions: Set<string> = new Set();
  private mutedProactiveSessionCounts: Map<string, number> = new Map();

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
                  minProtocol: 4,
                  maxProtocol: 99,
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
            const msg = frame.payload?.message;
            if (state === "final") {
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
          this.handleProactiveSessionMessage(rawKey, msg);

          // Tool calls in assistant messages — skip, using agent item events instead
          // (session.message toolCall events are batched, not real-time)
        }

        // Agent item events — real-time tool call tracking for verbose mode
        if (frame.event === "agent" && frame.payload?.stream === "item") {
          const data = frame.payload.data || {};
          const rawKey = frame.payload.sessionKey || "";
          const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
          const toolCb = this.toolEventCallbacks.get(rawKey) || this.toolEventCallbacks.get(shortKey);

          if (toolCb && data.kind === "tool" && data.phase === "start" && data.name) {
            const meta = data.meta || "";
            toolCb(data.name, meta, "");
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

  private handleProactiveSessionMessage(rawKey: string, msg: any): boolean {
    const shortKey = rawKey.replace(/^agent:[^:]+:/, "");
    const role = msg.role;
    const content = msg.content;

    // Proactive assistant text messages. Cron/session-targeted runs often emit
    // structured content arrays rather than a plain string. Extract only visible
    // text parts and ignore thinking/tool blocks so the bridge can deliver final
    // cron results via the bot.
    let proactiveText = "";
    if (role === "assistant") {
      if (typeof content === "string") {
        proactiveText = content;
      } else if (Array.isArray(content)) {
        const hasToolBlock = content.some((part: any) => {
          const type = String(part?.type || "").toLowerCase();
          return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use" || type === "toolresult" || type === "tool_result";
        });
        // Do not deliver mixed text+toolCall assistant messages through
        // the proactive final-text path; those are usually intermediate
        // reasoning/status during a tool loop. Tool calls are still
        // delivered via the verbose channel from agent item events when
        // /verbose is enabled. Cron final messages arrive as text-only
        // (optionally with thinking).
        if (!hasToolBlock) {
          proactiveText = content
            .filter((part: any) => part?.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text)
            .join("\n")
            .trim();
        }
      }
    }
    if (!proactiveText) return false;
    if (this.mutedProactiveSessions.has(rawKey) || this.mutedProactiveSessions.has(shortKey)) {
      console.log(`[OpenClaw] Dropping proactive msg for ${shortKey}; delivery is owned by the caller`);
      return false;
    }
    if (this.suppressedSessions.has(rawKey) || this.suppressedSessions.has(shortKey)) {
      console.log(`[OpenClaw] Forwarding proactive msg for ${shortKey} during active chatSend; delivery outbox will dedupe`);
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
private collectReply(runId: string, timeoutMs = 1800000, targetSessionKey?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = "";
      let chatFinalText = "";
      let sessionKey = targetSessionKey ? `agent:main:${targetSessionKey}` : "";
      let chatFinalTimer: ReturnType<typeof setTimeout> | null = null;
      let lifecycleEndTimer: ReturnType<typeof setTimeout> | null = null;
      let replayInvalidTimer: ReturnType<typeof setTimeout> | null = null;
      const collectStartedAt = Date.now();
      let lifecycleStartedLogged = false;

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
          resolve(text || chatFinalText || "(timeout: no reply received)");
        }, timeoutMs);
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
        const bucketsToScan = sessionKey
          ? [sessionKey]
          : Array.from(this.agentEvents.keys());

        for (const bucketKey of bucketsToScan) {
          const bucket = this.agentEvents.get(bucketKey);
          if (!bucket) continue;

          let i = 0;
          while (i < bucket.length) {
            const ev = bucket[i];

            const evRunId = typeof ev.runId === "string" ? ev.runId : "";
            const matchesRun = evRunId ? evRunId === runId : false;
            // OpenClaw chat.send may emit the user-facing chat runId while the actual
            // agent lifecycle uses an internal runId. We clear this session's event buffer
            // immediately before chat.send, so matching by sessionKey here is safe and
            // necessary to collect the real agent output.
            const matchesSession = sessionKey && (ev.sessionKey === sessionKey || ev.sessionKey === targetSessionKey);
            if (matchesRun || matchesSession) {
              if (!sessionKey && ev.sessionKey) sessionKey = ev.sessionKey;
            } else {
              i++;
              continue;
            }

            bucket.splice(i, 1);
            // Any matching event — including toolCall/toolResult/item/lifecycle —
            // means the agent is still alive. Use an idle timeout, not an absolute
            // wall-clock timeout, so long tool-heavy tasks are not killed while active.
            resetIdleTimer();
            // If more events arrive after a replay-invalid lifecycle end, that lifecycle
            // was not terminal for the user-visible run. Keep waiting for the real final.
            if (replayInvalidTimer) {
              clearTimeout(replayInvalidTimer);
              replayInvalidTimer = null;
            }

            if (ev.stream === "lifecycle" && ev.data?.phase === "start" && !lifecycleStartedLogged) {
              lifecycleStartedLogged = true;
              console.log(`[OpenClaw] lifecycle start for runId=${runId} after ${Date.now() - collectStartedAt}ms`);
            }
            if (ev.stream === "assistant" && (ev.data?.deltaText || ev.data?.delta)) {
              const chunk = ev.data.deltaText || ev.data.delta;
              if (ev.data?.replace) {
                // v4: non-prefix replacement — deltaText is the full replacement
                text = chunk;
              } else {
                text += chunk;
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
                  const latestFinalText = chatFinalText || text;
                  if (latestFinalText) {
                    finish(latestFinalText);
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
              const finalText = chatFinalText || text;
              const finishFromLifecycle = () => {
                const latestFinalText = chatFinalText || text;
                if (!chatFinalText && latestFinalText.trim() === "N") {
                  // Some providers stream the first character of NO_REPLY ("N") but
                  // never deliver a final chat message in time. Never surface a lone
                  // "N" to the user; treat it as a suppressed reply.
                  finish("NO_REPLY");
                  return;
                }
                if (!latestFinalText) {
                  const state = ev.data?.livenessState || "unknown";
                  const reason = ev.data?.stopReason || "";
                  const replayInvalid = ev.data?.replayInvalid ? ", replayInvalid" : "";
                  const failureText = `⚠️ Agent 未正常完成\n状态: ${state}${replayInvalid}${reason ? "\n原因: " + reason : ""}\n请重试，或用 /reset 重置会话`;
                  if (ev.data?.replayInvalid) {
                    console.warn(`[OpenClaw] replayInvalid lifecycle observed for runId=${evRunId || runId}; waiting for subsequent events before surfacing failure`);
                    replayInvalidTimer = setTimeout(() => finish(failureText), 120000);
                    return;
                  }
                  if (ev.data?.livenessState !== "working") {
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
              if (!chatFinalText && text.length <= 1) {
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
    return this.rpc("sessions.compact", { key });
  }

  // --- Chat ---

  /**
   * Send a message to a session and get the agent reply.
   * deliver=false prevents OpenClaw from auto-posting to channels.
   */
  async abortChat(sessionKey: string, runId: string): Promise<any> {
    const key = sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
    return this.rpc("chat.abort", { sessionKey: key, runId }, 5000).catch(() => {});
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

  async chatSend(params: {
    sessionKey: string;
    message: string;
    attachments?: ChatAttachment[];
    deliver?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    const sk = params.sessionKey;
    const fullSessionKey = `agent:main:${sk}`;
    const suppressedKeys = [sk, fullSessionKey];
    this.suppressSessionKeys(suppressedKeys);
    try {
      // Drop stale buffered events for this session before starting a new run.
      // This prevents an old final text (e.g. previous "ok") from being consumed by
      // the next message while still allowing sessionKey matching for internal runIds.
      this.agentEvents.set(fullSessionKey, []);
      this.agentEvents.set(sk, []);
      const sendStartedAt = Date.now();
      const result = await this.rpc("chat.send", {
        sessionKey: sk,
        message: params.message,
        attachments: params.attachments,
        deliver: params.deliver ?? false,
        idempotencyKey: randomUUID(),
      });
      console.log(`[OpenClaw] chat.send runId: ${result.runId} (rpc=${Date.now() - sendStartedAt}ms, attachments=${params.attachments?.length || 0})`);
      return await this.collectReply(result.runId, params.timeoutMs || 1800000, sk);
    } finally {
      // OpenClaw can emit the final assistant session.message a moment after
      // collectReply returns. Keep a short grace window so normal chat replies
      // are not delivered twice via the proactive-message path. Cron/LMA runs
      // are unaffected because they do not go through chatSend.
      this.releaseSuppressedSessionKeysAfter(suppressedKeys, 30000);
    }
  }

  private shouldInjectBridgeAttachmentHint(text: string): boolean {
    return /发送|发到|发给|传|上传|附件|文件|文档|图片|图像|照片|生成图|做张图|画张图|导出|保存|pdf|docx?|xlsx?|pptx?|markdown|\bmd\b/i.test(text);
  }

  private bridgeAttachmentHint(text: string): string {
    if (!this.shouldInjectBridgeAttachmentHint(text)) return "";
    return `

[Bridge attachment capability hint: This is an OpenClaw Lark Multi-Agent bridge session. You cannot send Feishu files/images directly from inside OpenClaw. Do NOT call message, sessions_send, Feishu tools, or proactive send tools for this request. If the user asks you to send an image/file/document to Feishu, prefer creating new files under ${BRIDGE_ATTACHMENTS_DIR}/; existing files under the OpenClaw workspace are also allowed. Include this exact marker at the very end of your final reply (do not explain or expose the marker as normal text): <LMA_BRIDGE_ATTACHMENTS>{"attachments":[{"type":"image|file|document","path":"/absolute/path","caption":"optional"}]}</LMA_BRIDGE_ATTACHMENTS>. The bridge layer will parse this marker and send the attachment. Use type=image for images; use type=document for Markdown documents (.md) so the bridge creates a Feishu cloud document and sends its link; use type=file for other ordinary files.]`;
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
  }): Promise<string> {
    const attachments = this.extractImageAttachments([
      ...params.unsyncedMessages.map((m) => m.content),
      params.currentMessage,
    ]);
    const mediaInstruction = attachments.length > 0
      ? "\n\n[Media note: Image attachments are included with this message. If your model can inspect images directly, use the attached image input. If it cannot, use the image tool on the provided media/attachment path; do not try unrelated network or model-provider workarounds.]"
      : "";
    const bridgeAttachmentHint = this.bridgeAttachmentHint(params.currentMessage);
    if (params.unsyncedMessages.length === 0) {
      // No context to catch up, send directly
      return this.chatSend({
        sessionKey: params.sessionKey,
        message: params.currentMessage + mediaInstruction + bridgeAttachmentHint,
        attachments,
        deliver: params.deliver,
        timeoutMs: params.timeoutMs,
      });
    }

    // Build context block + actual message in one chat.send
    const contextLines = params.unsyncedMessages.map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const tag = m.senderType === "bot" ? `${m.senderName} (AI)` : m.senderName;
      return `[${tag} ${time}]: ${m.content}`;
    });

    const combined =
      `[以下是你不在线期间群里的对话，请了解上下文]\n` +
      contextLines.join("\n") +
      `\n---\n` +
      `[${params.currentSenderName}]: ${params.currentMessage}`;

    return this.chatSend({
      sessionKey: params.sessionKey,
      message: combined + mediaInstruction + bridgeAttachmentHint,
      attachments,
      deliver: params.deliver,
      timeoutMs: params.timeoutMs,
    });
  }

  private extractImageAttachments(contents: string[]): ChatAttachment[] {
    const attachments: ChatAttachment[] = [];
    const seen = new Set<string>();
    const imagePattern = /\[Image: ([^\]\n]+)\]/g;
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
    onMessage: (text: string) => void
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

  async unsubscribeSession(sessionKey: string): Promise<void> {
    this.sessionMessageCallbacks.delete(sessionKey);
    this.sessionMessageCallbacks.delete(`agent:main:${sessionKey}`);
    this.toolEventCallbacks.delete(sessionKey);
    this.toolEventCallbacks.delete(`agent:main:${sessionKey}`);
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
