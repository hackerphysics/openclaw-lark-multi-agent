import WebSocket from "ws";
import { randomUUID } from "crypto";
import { OpenClawConfig } from "./config.js";

type PendingReq = {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * OpenClaw Gateway WebSocket client.
 *
 * Uses the full Gateway WS protocol to get complete agent pipeline support
 * (tools, memory, skills, system prompt, etc.) — same as native channels.
 */
export class OpenClawClient {
  private config: OpenClawConfig;
  private ws: WebSocket | null = null;
  private pending: Map<string, PendingReq> = new Map();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private eventHandlers: Map<string, Set<(payload: any) => void>> = new Map();

  constructor(config: OpenClawConfig) {
    this.config = config;
  }

  /**
   * Connect to the Gateway WS and perform handshake.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doConnect();
    await this.connectPromise;
    this.connectPromise = null;
  }

  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.baseUrl.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl);

      let handshakeDone = false;

      this.ws.on("open", () => {
        // Wait for connect.challenge from server
      });

      this.ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());

        if (!handshakeDone) {
          if (frame.type === "event" && frame.event === "connect.challenge") {
            // Send connect request
            const connectId = randomUUID();
            this.ws!.send(
              JSON.stringify({
                type: "req",
                id: connectId,
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
                  scopes: [
                    "operator.read",
                    "operator.write",
                    "operator.admin",
                  ],
                  auth: { token: this.config.token },
                  userAgent: "lark-multi-agent/1.0.0",
                },
              })
            );
          } else if (frame.type === "res" && frame.ok && frame.payload?.type === "hello-ok") {
            handshakeDone = true;
            this.connected = true;
            console.log("[OpenClaw] Connected to Gateway WS");
            resolve();
          } else if (frame.type === "res" && !frame.ok) {
            reject(new Error(`Gateway handshake failed: ${JSON.stringify(frame.error)}`));
          }
          return;
        }

        // Handle responses to pending requests
        if (frame.type === "res" && frame.id) {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            clearTimeout(p.timer);
            if (frame.ok) {
              p.resolve(frame.payload);
            } else {
              p.reject(new Error(`RPC error: ${JSON.stringify(frame.error)}`));
            }
          }
        }

        // Handle events (chat deltas, etc.)
        if (frame.type === "event" && frame.event) {
          const handlers = this.eventHandlers.get(frame.event);
          if (handlers) {
            for (const h of handlers) h(frame.payload);
          }
        }
      });

      this.ws.on("error", (err) => {
        if (!handshakeDone) reject(err);
        else console.error("[OpenClaw] WS error:", err.message);
      });

      this.ws.on("close", () => {
        this.connected = false;
        console.log("[OpenClaw] WS disconnected");
        // TODO: reconnect logic
      });
    });
  }

  /**
   * Send an RPC request and wait for response.
   */
  private rpc(method: string, params: any, timeoutMs = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.ws.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params,
        })
      );
    });
  }

  /**
   * Subscribe to a WS event type.
   */
  on(event: string, handler: (payload: any) => void) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: (payload: any) => void) {
    this.eventHandlers.get(event)?.delete(handler);
  }

  // --- Session management ---

  async createSession(params: {
    key: string;
    model: string;
    label?: string;
  }): Promise<any> {
    return this.rpc("sessions.create", params);
  }

  async patchSession(params: {
    key: string;
    model?: string;
    label?: string;
  }): Promise<any> {
    return this.rpc("sessions.patch", params);
  }

  async getSession(key: string): Promise<any> {
    return this.rpc("sessions.get", { key });
  }

  async listSessions(): Promise<any> {
    return this.rpc("sessions.list", {});
  }

  async resetSession(key: string): Promise<any> {
    return this.rpc("sessions.reset", { key });
  }

  async deleteSession(
    key: string,
    deleteTranscript = true
  ): Promise<any> {
    return this.rpc("sessions.delete", { key, deleteTranscript });
  }

  // --- Chat ---

  /**
   * Send a message to a session. Runs the full agent pipeline.
   * Set deliver=false to prevent auto-delivery to channels.
   * Returns the final agent response.
   */
  async chatSend(params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    // Collect streamed response via events
    const runId = await this._startChat(params);
    return this._waitForCompletion(params.sessionKey, runId, params.timeoutMs || 120000);
  }

  private async _startChat(params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    const result = await this.rpc("chat.send", {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: params.deliver ?? false,
      idempotencyKey: randomUUID(),
      timeoutMs: params.timeoutMs,
    });
    return result.runId;
  }

  private _waitForCompletion(
    sessionKey: string,
    runId: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullMessage = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Chat timeout for session ${sessionKey}`));
      }, timeoutMs);

      const handler = (payload: any) => {
        if (payload.runId !== runId) return;

        if (payload.state === "delta" && payload.message) {
          // Accumulate streaming deltas
          if (typeof payload.message === "string") {
            fullMessage += payload.message;
          } else if (payload.message.content) {
            fullMessage += payload.message.content;
          }
        } else if (payload.state === "final") {
          cleanup();
          // Final message may contain the complete text
          if (payload.message) {
            const finalText =
              typeof payload.message === "string"
                ? payload.message
                : payload.message.content || payload.message.text || "";
            resolve(finalText || fullMessage);
          } else {
            resolve(fullMessage);
          }
        } else if (payload.state === "error" || payload.state === "aborted") {
          cleanup();
          reject(
            new Error(
              `Chat ${payload.state}: ${payload.errorMessage || "unknown"}`
            )
          );
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off("agent", handler);
      };

      this.on("agent", handler);
    });
  }

  /**
   * Inject a message into a session's history without triggering an agent run.
   * Useful for adding context from other bots' messages.
   */
  async chatInject(params: {
    sessionKey: string;
    message: string;
    label?: string;
  }): Promise<any> {
    return this.rpc("chat.inject", params);
  }

  /**
   * Get chat history for a session.
   */
  async chatHistory(sessionKey: string, limit?: number): Promise<any> {
    return this.rpc("chat.history", { sessionKey, limit });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }
}
