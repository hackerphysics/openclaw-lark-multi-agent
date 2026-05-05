import WebSocket from "ws";
import { randomUUID } from "crypto";
import { OpenClawConfig } from "./config.js";
import { ChatMessage } from "./message-store.js";

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
  /** Session keys with active chatSend — suppress proactive message delivery */
  private suppressedSessions: Set<string> = new Set();

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
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: {
                    id: "gateway-client",
                    version: "1.0.0",
                    platform: "linux",
                    mode: "backend",
                  },
                  role: "operator",
                  scopes: ["operator.read", "operator.write", "operator.admin"],
                  auth: { token: this.config.token },
                  userAgent: "lark-multi-agent/1.0.0",
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
            if (state === "final" && msg?.content) {
              // Extract text from final chat message content array
              const textParts: string[] = [];
              for (const part of (Array.isArray(msg.content) ? msg.content : [])) {
                if (part.type === "text" && part.text) textParts.push(part.text);
              }
              if (textParts.length > 0) {
                this.agentEvents.get(sk)!.push({
                  ...frame.payload,
                  stream: "assistant",
                  data: { delta: textParts.join("\n"), text: textParts.join("\n") },
                });
              }
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
          const role = msg.role;
          const content = msg.content;

          // Proactive assistant text messages (suppress during active chatSend)
          if (role === "assistant" && typeof content === "string") {
            if (this.suppressedSessions.has(rawKey) || this.suppressedSessions.has(shortKey)) {
              console.log(`[OpenClaw] Suppressing proactive msg for ${shortKey} (active chatSend)`);
            } else {
              const cb = this.sessionMessageCallbacks.get(rawKey) || this.sessionMessageCallbacks.get(shortKey);
              if (cb) cb(content);
            }
          }

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
      // Use provided sessionKey for matching; fall back to runId-based discovery
      let sessionKey = targetSessionKey ? `agent:main:${targetSessionKey}` : "";
      const timer = setTimeout(() => {
        clearInterval(poller);
        console.warn(`[OpenClaw] collectReply timeout for runId=${runId} sessionKey=${sessionKey}`);
        // Return whatever text we collected so far instead of rejecting
        resolve(text || "(timeout: no reply received)");
      }, timeoutMs);

      const poller = setInterval(() => {
        // Scan buckets by sessionKey first, fall back to scanning all
        const bucketsToScan = sessionKey
          ? [sessionKey]
          : Array.from(this.agentEvents.keys());

        for (const bucketKey of bucketsToScan) {
          const bucket = this.agentEvents.get(bucketKey);
          if (!bucket) continue;

          let i = 0;
          while (i < bucket.length) {
            const ev = bucket[i];

            // Match by sessionKey (primary) or runId (fallback)
            const matchesSession = sessionKey && (ev.sessionKey === sessionKey || ev.sessionKey === targetSessionKey);
            const matchesRun = ev.runId === runId;
            if (matchesSession || matchesRun) {
              if (!sessionKey && ev.sessionKey) sessionKey = ev.sessionKey;
            } else {
              i++;
              continue;
            }

            // Consume this event
            bucket.splice(i, 1);

            if (ev.stream === "assistant" && ev.data?.delta) {
              text += ev.data.delta;
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "end") {
              clearTimeout(timer);
              clearInterval(poller);
              if (!text && ev.data?.livenessState !== "working") {
                const state = ev.data?.livenessState || "unknown";
                const reason = ev.data?.stopReason || "";
                const replayInvalid = ev.data?.replayInvalid ? ", replayInvalid" : "";
                resolve(`⚠️ Agent 未正常完成\n状态: ${state}${replayInvalid}${reason ? `\n原因: ${reason}` : ""}\n请重试，或用 /reset 重置会话`);
              } else {
                resolve(text);
              }
              return;
            }
            if (ev.stream === "lifecycle" && ev.data?.phase === "error") {
              clearTimeout(timer);
              clearInterval(poller);
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
  async chatSend(params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    const sk = params.sessionKey;
    this.suppressedSessions.add(sk);
    this.suppressedSessions.add(`agent:main:${sk}`);
    try {
      const result = await this.rpc("chat.send", {
        sessionKey: sk,
        message: params.message,
        deliver: params.deliver ?? false,
        idempotencyKey: randomUUID(),
      });
      console.log(`[OpenClaw] chat.send runId: ${result.runId}`);
      return await this.collectReply(result.runId, params.timeoutMs || 1800000, sk);
    } finally {
      this.suppressedSessions.delete(sk);
      this.suppressedSessions.delete(`agent:main:${sk}`);
    }
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
    if (params.unsyncedMessages.length === 0) {
      // No context to catch up, send directly
      return this.chatSend({
        sessionKey: params.sessionKey,
        message: params.currentMessage,
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
      message: combined,
      deliver: params.deliver,
      timeoutMs: params.timeoutMs,
    });
  }

  async disconnect() {
    this.shouldReconnect = false;
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
