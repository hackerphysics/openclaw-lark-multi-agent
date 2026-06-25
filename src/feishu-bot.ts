import * as lark from "@larksuiteoapi/node-sdk";
import { createRequire } from "module";
import { BotConfig, persistBotModel } from "./config.js";
import { getI18n, normalizeLocale, type Locale } from "./i18n.js";
import { OpenClawClient } from "./openclaw-client.js";
import { LiveStatusController, type LiveStatusView } from "./live-status.js";
import { CompactProgressController, type CompactProgressView } from "./compact-progress.js";
import { MessageStore } from "./message-store.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { getBridgeAttachmentsDir, getDataDir } from "./paths.js";
import { buildFeishuCardElements } from "./markdown.js";
import { discussionManager, type DiscussionParticipant, type ReplyResult } from "./discussion-manager.js";
import { resolveSessionFilePath, toolTrimCompactFile } from "./session-file-compactor.js";

const require = createRequire(import.meta.url);
const LMA_VERSION = require("../package.json").version as string;

const MAX_BOT_STREAK = 10;
const MAX_MERGED_TRIGGER_MESSAGES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_MERGED_TRIGGER_MESSAGES || 100);
const MAX_MERGED_TRIGGER_BYTES = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_MAX_MERGED_TRIGGER_BYTES || 128 * 1024);
const BRIDGE_ATTACHMENTS_DIR = getBridgeAttachmentsDir();
const FEISHU_DOCS_DIR = join(getDataDir(), "feishu-docs");
const SESSION_HEALTH_POLL_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_SESSION_HEALTH_POLL_MS || 5_000);
const SESSION_HEALTH_CONFIRM_MS = Number(process.env.OPENCLAW_LARK_MULTI_AGENT_SESSION_HEALTH_CONFIRM_MS || 2_000);
// Auto-retry: when a reply looks truncated/incomplete, ask the same session
// whether it finished. If it did not, let it continue; loop until it confirms
// completion or the retry budget is spent. Off by setting AUTO_RETRY=0.
// Read at call time (not module load) so tests can toggle it per-case.
function autoRetryEnabled(): boolean { return process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY !== "0"; }
function autoRetryMax(): number { return Number(process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_MAX || 5); }
// The exact phrase the agent must reply to confirm completion. The probe asks
// for the locale-appropriate phrase; detection accepts BOTH so either works.
const AUTO_RETRY_DONE_PHRASE = process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_DONE_PHRASE || "\u7ed3\u675f\u4e86";
const AUTO_RETRY_DONE_PHRASE_EN = process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_DONE_PHRASE_EN || "DONE";
// When an auto-retry probe errors AND context usage is at/above this percent,
// auto-compact the session once and keep retrying (instead of giving up). This
// rescues the “session too heavy → run times out / lock contention” failure mode.
function autoRetryCompactPct(): number { return Number(process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY_COMPACT_PCT || 50); }
// How many of the most-recent tool calls (and their results) tool-trim keeps
// intact — recent tool calls may still be relevant to the agent's next step.
function toolTrimKeepRecent(): number { return Number(process.env.OPENCLAW_LARK_MULTI_AGENT_TOOLTRIM_KEEP_RECENT || 3); }
// After a reply is delivered, if context usage reaches this percent, send the
// user a one-time alert to compact. 0 disables the alert.
function contextAlertPct(): number { return Number(process.env.OPENCLAW_LARK_MULTI_AGENT_CONTEXT_ALERT_PCT || 80); }

class UnhealthySessionError extends Error {
  constructor(readonly status: string) {
    super(`unhealthy session: ${status}`);
    this.name = "UnhealthySessionError";
  }
}


type BridgeAttachment = {
  type?: "image" | "file" | "document";
  path: string;
  caption?: string;
};

type FeishuDocRef = {
  type: "docx" | "doc" | "wiki";
  token: string;
  title?: string;
  url?: string;
};

type HydratedFeishuDoc = FeishuDocRef & {
  markdownPath: string;
};

type RoutingIntent = {
  isAllMention: boolean;
  targetedBotNames: string[];
  hasTargetedMention: boolean;
  hasHumanMention: boolean;
  isCurrentBotMentioned: boolean;
};

/**
 * Manages a single Feishu bot instance.
 *
 * Each bot owns an OpenClaw session (full agent pipeline).
 * All messages are recorded locally in SQLite.
 * When this bot needs to respond, unsynced messages are batched into
 * a single context catch-up + the actual message → one agent run.
 */
export class FeishuBot {
  readonly config: BotConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private openclawClient: OpenClawClient;
  private store: MessageStore;
  private botOpenId: string | null = null;
  /** Tracks which chatId sessions have been initialized */
  private initializedSessions: Set<string> = new Set();
  /** Per-chat busy lock: timestamp when became busy (0 = not busy) */
  private busyChats: Map<string, number> = new Map();
  /** Per-chat "stop" generation counter. Bumped by /stop so any in-flight
   *  auto-retry loop can detect it was cancelled and stop retrying immediately. */
  private stopEpoch: Map<string, number> = new Map();
  /** Per-chat pending reply message IDs (to ack with DONE when their trigger is processed) */
  private pendingAckMessages: Map<string, { messageId: string; emoji: string; rowId: number }[]> = new Map();
  /** Per-chat pending tool message sends (to await before final reply) */
  private pendingToolSends: Map<string, Promise<void>[]> = new Map();
  private recentVerboseToolMessages: Map<string, number> = new Map();
  /** Per-chat processQueue lock to avoid duplicate concurrent chat.send runs */
  private queueRuns: Map<string, Promise<void>> = new Map();
  /** Per-chat serial send queue to guarantee message order */
  private sendQueue: Map<string, Promise<void>> = new Map();
  /** Per-chat delayed runtime failure notifications, canceled if a real reply arrives. */
  private delayedFailureTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Last time a real assistant-visible reply was successfully handed to the delivery pipeline. */
  private lastRealDeliveryAt: Map<string, number> = new Map();
  /** Per-chat: whether we've already sent the high-context alert this cycle. */
  private contextAlerted: Map<string, boolean> = new Map();
  /** Active chatSend trigger target so final replies and proactive session.message share one delivery key. */
  private activeDeliveryTargets: Map<string, { triggerId: number; messageId: string; token: symbol; timer?: ReturnType<typeof setTimeout>; liveStatus?: LiveStatusController }> = new Map();
  private adminOpenId: string | null;
  private locale: Locale;
  private configPath?: string;

  private static allBots: Map<string, FeishuBot> = new Map();
  /** Chats where this bot app has actually received an event in this process. */
  private static seenBotChats: Map<string, Set<string>> = new Map();

  constructor(
    config: BotConfig,
    openclawClient: OpenClawClient,
    store: MessageStore,
    adminOpenId?: string,
    configPath?: string
  ) {
    this.config = config;
    this.openclawClient = openclawClient;
    this.store = store;
    this.adminOpenId = adminOpenId || null;
    this.locale = normalizeLocale(config.locale);
    this.configPath = configPath;
    // Session keys are now per-chat: lma-<botname>-<chatId>

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
    });

    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": this.handleMessage.bind(this),
      "im.message.recalled_v1": this.handleMessageRecalled.bind(this),
    });
  }

  private async handleMessageRecalled(data: any) {
    console.log(`[${this.config.name}] Message recalled event:`, JSON.stringify(data));
    const messageId = data?.message_id;
    const chatId = data?.chat_id;
    if (!messageId || !chatId) return;
    const rowId = this.store.getMessageId(messageId);
    this.store.markMessageRecalled(messageId, chatId, Number(data?.recall_time) || Date.now(), data?.recall_type || '');
    if (!rowId) return;

    this.store.clearPendingTrigger(this.config.name, chatId, rowId);
    const pendingAcks = this.pendingAckMessages.get(chatId) || [];
    const remainingAcks: typeof pendingAcks = [];
    for (const ack of pendingAcks) {
      if (ack.rowId === rowId) {
        await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
      } else {
        remainingAcks.push(ack);
      }
    }
    this.pendingAckMessages.set(chatId, remainingAcks);
    console.log(`[${this.config.name}] Recalled message ${messageId} row=${rowId}; pending trigger canceled if present`);
  }

  register() {
    FeishuBot.allBots.set(this.config.appId, this);
  }

  /**
   * Get the session key for a specific chat.
   * Format: lma-<botname>-<chatId>
   */
  getSessionKey(chatId: string): string {
    return `lma-${this.config.name.toLowerCase()}-${chatId}`;
  }



  private chatLocale(chatId?: string): Locale {
    return normalizeLocale(chatId ? this.store.getChatLocale(chatId) || this.locale : this.locale);
  }

  private isEn(chatId?: string): boolean {
    return this.chatLocale(chatId) === "en";
  }

  private lmaBridgePolicy(): string {
    return getI18n(this.locale).bridgePolicy;
  }

  private async injectBridgePolicy(sessionKey: string): Promise<void> {
    await this.openclawClient.injectAssistantMessage({
      sessionKey,
      message: this.lmaBridgePolicy(),
      label: "LMA bridge policy",
    }).catch((err) => {
      console.warn(`[${this.config.name}] bridge policy inject failed:`, (err as Error).message);
    });
  }

  /**
   * Ensure the session for a given chatId exists with the correct model.
   * Lazy: only creates on first message in that chat.
   */
  private async ensureSession(chatId: string): Promise<string> {
    const sessionKey = this.getSessionKey(chatId);
    if (this.initializedSessions.has(sessionKey)) {
      // Already initialized this process lifetime, just ensure model
      const corrected = await this.openclawClient.ensureModel(sessionKey, this.config.model);
      if (corrected) {
        console.log(`[${this.config.name}] Model auto-corrected to ${this.config.model}`);
        await this.notifyModelDrift(chatId, sessionKey);
      }
      return sessionKey;
    }

    try {
      // Check if session already exists in OpenClaw
      const existing = await this.openclawClient.getSessionInfo(sessionKey).catch(() => null);

      if (existing?.session) {
        // Session exists — preserve it, only ensure model is correct
        console.log(`[${this.config.name}] Session exists: ${sessionKey} (tokens: ${existing.session.totalTokens || 0})`);
        const corrected = await this.openclawClient.ensureModel(sessionKey, this.config.model);
        if (corrected) {
          console.log(`[${this.config.name}] Model auto-corrected to ${this.config.model}`);
          await this.notifyModelDrift(chatId, sessionKey);
        }
      } else {
        // Session doesn't exist — create new
        await this.openclawClient.createSession({
          key: sessionKey,
          model: this.config.model,
          label: `LMA: ${this.config.name} [${chatId.slice(-8)}]`,
        });
        // Always patch model after create to ensure it takes effect
        await this.openclawClient.patchSession({ key: sessionKey, model: this.config.model });
        await this.injectBridgePolicy(sessionKey);
        console.log(`[${this.config.name}] Session created: ${sessionKey} (model: ${this.config.model})`);
      }
    } catch (err) {
      console.warn(`[${this.config.name}] ensureSession error:`, (err as Error).message);
    }

    this.initializedSessions.add(sessionKey);

    // Subscribe to session events (proactive messages + tool calls)
    this.openclawClient.setVerboseTranscriptDelivery(sessionKey, this.store.getBotVerbose(this.config.name, chatId));
    await this.openclawClient.subscribeSession(sessionKey, async (text, meta) => {
      try {
        const sourceType = meta?.sourceType === "verbose_transcript" ? "verbose_transcript" : "assistant_visible";
        console.log(`[${this.config.name}] ${sourceType === "verbose_transcript" ? "Verbose transcript" : "Proactive message"} for ${chatId.slice(-8)}`);
        const parsed = this.extractBridgeAttachments(text);
        if (sourceType !== "verbose_transcript" && (parsed.text.trim() || parsed.attachments.length > 0)) this.cancelDelayedFailure(chatId);
        const activeTarget = this.activeDeliveryTargets.get(chatId);
        try {
          await this.enqueueAndDispatchDelivery(
            chatId,
            sourceType,
            this.deliverySourceId(sourceType === "verbose_transcript" ? "verbose" : "proactive", `${Date.now()}:${Math.random()}:${parsed.text.trim()}|${JSON.stringify(parsed.attachments)}`),
            parsed.text.trim(),
            parsed.attachments,
            activeTarget?.messageId,
            undefined
          );
          if (sourceType !== "verbose_transcript" && (parsed.text.trim() || parsed.attachments.length > 0)) {
            await activeTarget?.liveStatus?.complete().catch(() => {});
          }
        } catch (err) {
          if (sourceType !== "verbose_transcript") await activeTarget?.liveStatus?.fail().catch(() => {});
          throw err;
        }
      } catch (err) {
        console.error(`[${this.config.name}] Failed to deliver proactive msg:`, (err as Error).message);
      }
    });

    // Subscribe to tool events for verbose mode
    this.openclawClient.onToolEvent(sessionKey, async (toolName, toolInput, toolOutput) => {
      if (!this.store.getBotVerbose(this.config.name, chatId)) return;
      console.log(`[${this.config.name}] [${new Date().toISOString()}] Tool event received: ${toolName}`);
      const sendPromise = this.sendOrdered(chatId, async () => {
        try {
          const inputPreview = toolInput.length > 200 ? toolInput.substring(0, 200) + "..." : toolInput;
          const outputPreview = toolOutput.length > 300 ? toolOutput.substring(0, 300) + "..." : toolOutput;
          const msg = `🔧 Tool: ${toolName}\n📥 ${inputPreview}${toolOutput ? `\n📤 ${outputPreview}` : ""}`;
          const dedupeKey = `${chatId}:${msg}`;
          const now = Date.now();
          const lastSentAt = this.recentVerboseToolMessages.get(dedupeKey) || 0;
          if (now - lastSentAt < 5_000) return;
          this.recentVerboseToolMessages.set(dedupeKey, now);
          for (const [key, ts] of this.recentVerboseToolMessages) {
            if (now - ts > 60_000) this.recentVerboseToolMessages.delete(key);
          }
          console.log(`[${this.config.name}] [${new Date().toISOString()}] Sending tool msg to Feishu...`);
          await this.sendMessage(chatId, msg);
          console.log(`[${this.config.name}] [${new Date().toISOString()}] Tool msg sent OK`);
        } catch (err) {
          console.warn(`[${this.config.name}] Failed to send tool event:`, (err as Error).message);
        }
      });
      // Track the send promise so processQueue can await it before final reply
      const pending = this.pendingToolSends.get(chatId) || [];
      pending.push(sendPromise);
      this.pendingToolSends.set(chatId, pending);
    });

    return sessionKey;
  }

  /**
   * Start the Feishu WS connection. Sessions are created lazily per chat.
   */
  async start() {
    await this.probeBotIdentity();
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(
      `[${this.config.name}] Bot started (model: ${this.config.model}, open_id: ${this.botOpenId || "unknown"})`
    );

    // Drain any unsynced messages left from previous run
    this.drainOnStartup();
  }

  /** Resolve this bot's open_id at startup so direct @bot mentions work even
   * when Feishu mention payloads omit app_id and only contain open_id/name. */
  private async probeBotIdentity(): Promise<void> {
    try {
      const res: any = await this.client.request({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
      } as any);
      const botInfo = res?.data?.pingBotInfo;
      if (botInfo?.botID) {
        this.botOpenId = botInfo.botID;
        console.log(`[${this.config.name}] Bot identity resolved: ${botInfo.botName || this.config.name} (${this.botOpenId})`);
      } else {
        console.warn(`[${this.config.name}] Bot identity probe returned no botID`);
      }
    } catch (err) {
      console.warn(`[${this.config.name}] Bot identity probe failed:`, (err as Error).message);
    }
  }

  /**
   * On startup, check all known chats for unsynced messages and process them.
   * Also re-subscribe to known sessions for tool events.
   */
  private async drainOnStartup(): Promise<void> {
    try {
      const restoredDeliveries = this.store.resetStaleDeliveries(this.config.name, 5 * 60_000, 5);
      if (restoredDeliveries.restored > 0 || restoredDeliveries.failed > 0) {
        console.warn(`[${this.config.name}] Startup delivery recovery: restored=${restoredDeliveries.restored}, failed=${restoredDeliveries.failed}`);
      }
      const chats = this.store.getAllChatInfo();
      const drainTasks: Promise<void>[] = [];
      for (const chat of chats) {
        // Skip p2p chats that belong to other bots
        if (chat.chatType === "p2p" && chat.ownerBot && chat.ownerBot !== this.config.name) {
          continue;
        }

        // Re-subscribe to existing sessions
        await this.ensureSession(chat.chatId);

        // Drain only messages that were explicitly marked as reply triggers.
        // Context-only messages should not start an OpenClaw run after restart.
        const pendingTriggerIds = this.store.getPendingTriggerIds(this.config.name, chat.chatId);
        const pendingDeliveries = this.store.getPendingDeliveries(chat.chatId, this.config.name, 1);
        if (pendingDeliveries.length > 0) {
          drainTasks.push(this.dispatchPendingDeliveries(chat.chatId).catch((err) => {
            console.warn(`[${this.config.name}] Startup delivery drain failed for ${chat.chatId.slice(-8)}:`, (err as Error).message);
          }));
        }
        if (pendingTriggerIds.size > 0) {
          console.log(
            `[${this.config.name}] Startup drain: ${pendingTriggerIds.size} pending trigger(s) in ${chat.chatName || chat.chatId.slice(-8)}`
          );
          // Do not let one slow/stuck chat block startup drain for all other chats.
          drainTasks.push(this.processQueue(chat.chatId).catch((err) => {
            console.warn(`[${this.config.name}] Startup drain failed for ${chat.chatId.slice(-8)}:`, (err as Error).message);
          }));
        }
      }
      await Promise.allSettled(drainTasks);
    } catch (err) {
      console.warn(`[${this.config.name}] Startup drain failed:`, (err as Error).message);
    }
  }

  static getAllBots(): Map<string, FeishuBot> {
    return FeishuBot.allBots;
  }

  static getByName(name: string): FeishuBot | undefined {
    for (const bot of FeishuBot.allBots.values()) {
      if (bot.config.name === name) return bot;
    }
    return undefined;
  }

  static findByOpenId(openId: string): FeishuBot | undefined {
    for (const bot of FeishuBot.allBots.values()) {
      if (bot.botOpenId === openId) return bot;
    }
    return undefined;
  }

  private async handleMessage(data: any) {
    try {
      const event = data as any;
      const message = event.message;
      const sender = event.sender;

      const chatId: string = message.chat_id;
      this.markCurrentBotSeenInChat(chatId);
      const chatType: string = message.chat_type;
      const messageType: string = message.message_type;
      const messageId: string = message.message_id;
      const isBot = sender?.sender_type === "app";

      // Extract bot open_id from mentions
      if (message.mentions) {
        for (const m of message.mentions) {
          const bot = FeishuBot.allBots.get(m.id?.app_id || "");
          if (bot && m.id?.open_id) {
            bot.botOpenId = m.id.open_id;
          }
        }
      }

      if (messageType !== "text" && messageType !== "image" && messageType !== "file" && messageType !== "audio" && messageType !== "sticker" && messageType !== "post" && messageType !== "share_doc") return;

      // --- Dedup: atomically claim this message for this bot before any await.
      // Feishu/WebSocket can deliver the same event more than once; a separate
      // has-then-mark sequence races and can send the same user message into
      // OpenClaw twice.
      if (!this.store.tryMarkBotProcessed(this.config.name, messageId)) return;

      // --- Cache chat info (lazy, at most once per hour) ---
      await this.fetchAndCacheChatInfo(chatId, chatType);

      // --- P2P isolation: only the owning bot processes p2p messages ---
      if (chatType === "p2p") {
        const chatInfo = this.store.getChatInfo(chatId);
        if (chatInfo?.ownerBot && chatInfo.ownerBot !== this.config.name) {
          return; // This p2p chat belongs to another bot
        }
      }

      let content: any;
      try {
        content = JSON.parse(message.content);
      } catch {
        console.warn(`[${this.config.name}] Failed to parse message content, skipping`);
        return;
      }

      // --- Extract text content based on message type ---
      let cleanText = "";
      let rawText = "";
      if (messageType === "text") {
        rawText = content.text || "";
        cleanText = this.cleanMentions(rawText);
        // A mention-only text message is still a valid routing trigger. Feishu may
        // expose mentions as display text like "@万万（Claude）" rather than @_user_xxx,
        // so decide emptiness after stripping leading routing mentions.
        if ((this.isMentioned(message.mentions || []) || this.isAllMention(rawText, message.mentions || [])) && !this.stripLeadingCommandMentions(cleanText).trim()) {
          cleanText = "请回复上面最近一条用户消息。";
        }
      } else if (messageType === "image") {
        // Download image and pass local path
        const imageKey = content.image_key;
        if (imageKey) {
          try {
            const imgPath = await this.downloadResource(messageId, imageKey, "image");
            cleanText = `[Image: ${imgPath}]`;
          } catch (err) {
            cleanText = `[Image: download failed - ${(err as Error).message}]`;
          }
        }
      } else if (messageType === "file") {
        const fileKey = content.file_key;
        const fileName = content.file_name || "unknown";
        if (fileKey) {
          try {
            const filePath = await this.downloadResource(messageId, fileKey, "file");
            cleanText = `[File: ${fileName} -> ${filePath}]`;
          } catch (err) {
            cleanText = `[File: ${fileName} - download failed]`;
          }
        }
      } else if (messageType === "audio") {
        const fileKey = content.file_key;
        if (fileKey) {
          try {
            const audioPath = await this.downloadResource(messageId, fileKey, "file");
            cleanText = `[Audio: ${audioPath}]`;
          } catch (err) {
            cleanText = `[Audio: download failed]`;
          }
        }
      } else if (messageType === "post") {
        // Rich text post - extract all text content
        cleanText = await this.hydrateInlineImageKeys(this.extractPostText(content), messageId);
      } else if (messageType === "share_doc") {
        cleanText = content.title || content.name || content.text || content.url || "[Feishu document]";
      } else if (messageType === "sticker") {
        cleanText = `[Sticker: ${content.file_key || "unknown"}]`;
      }

      cleanText = await this.hydrateFeishuDocsInMessage(cleanText, content, messageId);

      if (!cleanText.trim()) return;

      const routing = this.getRoutingIntent(chatType, message, messageType === "text" ? (content.text || "") : "");

      // Commands may be prefixed by @all / @bot in group chats. Strip those
      // leading routing mentions before deciding whether this is a bridge command
      // or an escaped OpenClaw command.
      const trimmedCleanText = cleanText.trim();
      const commandText = this.stripLeadingCommandMentions(trimmedCleanText);
      // Escape hatch: //command means send /command through to OpenClaw,
      // while /command remains a bridge-level openclaw-lark-multi-agent command.
      const isNativeOpenClawCommand = commandText.startsWith("//");
      if (isNativeOpenClawCommand) {
        cleanText = "/" + commandText.slice(2).trimStart();
      } else if (commandText.startsWith("/")) {
        cleanText = commandText;
      }

      const preliminaryCommandName = cleanText.trim().split(/\s+/)[0]?.toLowerCase() || "";
      const preliminaryBridgeCommands = new Set(["/help", "/status", "/compact", "/reset", "/stop", "/verbose", "/livestatus", "/free", "/mute", "/mode", "/model", "/models", "/discuss", "/chairman", "/locale"]);
      const isPreliminaryBridgeCommand = !isNativeOpenClawCommand && preliminaryBridgeCommands.has(preliminaryCommandName);

      // --- Record to local store (ALL messages, before command/response checks) ---
      const senderName = isBot
        ? this.resolveBotName(sender) || "Bot"
        : this.resolveHumanName(sender) || "User";

      let insertedId = this.store.insert({
        chatId,
        messageId,
        senderType: isBot ? "bot" : "human",
        senderName,
        content: cleanText,
        timestamp: Date.now(),
        triggerKind: isNativeOpenClawCommand
          ? "native_command"
          : isPreliminaryBridgeCommand
            ? "bridge_command"
            : isBot && this.isBridgeControlReply(cleanText)
              ? "bridge_control_reply"
              : "normal",
      });
      if (insertedId < 0) insertedId = this.store.getMessageId(messageId) || -1;

      // --- Commands: in p2p always respond; in group, check shouldRespond first ---
      // Single slash commands are handled by the bridge. Double slash commands were
      // already unescaped above and should pass through to OpenClaw instead.
      const isBridgeCommand = !commandText.startsWith("//");
      const commandName = preliminaryCommandName;
      const bridgeCommands = preliminaryBridgeCommands;
      const isCommand = isBridgeCommand && bridgeCommands.has(commandName);
      if (isCommand) {
        // In group chats, most bridge commands must be explicitly routed to this
        // bot or @all. /discuss is a group-level command, so an unmentioned
        // /discuss command is handled by one coordinator bot to avoid N replies.
        const isDiscussCommand = commandName === "/discuss";
        const isChairmanCommand = commandName === "/chairman";
        const isLocaleCommand = commandName === "/locale";
        const isModelCommand = commandName === "/model";
        const isHelpCommand = commandName === "/help";
        const rejectModelAll = chatType !== "p2p" && isModelCommand && routing.isAllMention;
        if (chatType !== "p2p") {
          const groupBotCount = Array.from(FeishuBot.allBots.values()).filter((bot) => bot.store === this.store).length;
          const singleBotGroup = groupBotCount === 1;
          if (isModelCommand) {
            // Model switching is per-bot. @all is rejected by one coordinator;
            // otherwise group /model must explicitly target this bot. A single-bot
            // group treats the sole bot as the implicit target.
            if (routing.isAllMention) {
              if (!this.isDiscussionCoordinator()) return;
            } else if (routing.hasTargetedMention) {
              if (!routing.isCurrentBotMentioned) return;
            } else if (!singleBotGroup) {
              if (!this.isDiscussionCoordinator()) return;
            }
          } else if (isChairmanCommand) {
            // /chairman @Bot is owned by the mentioned bot itself. This avoids
            // requiring a coordinator to parse another bot's mention metadata,
            // which can vary across Feishu clients/bridges. Untargeted/status,
            // @all, and clear/off remain coordinator-owned group commands.
            //
            // Target resolution uses both Feishu mention metadata AND a text
            // fallback (parsing "@Bot" / "Bot" from the raw message), so a
            // /chairman that arrives without mention metadata still routes to
            // the intended bot instead of silently failing.
            const chairmanArg = this.stripLeadingCommandMentions(this.cleanMentions(rawText)).replace(/^\s*\/chairman\b/i, "").trim().toLowerCase();
            const isClearArg = ["off", "clear", "none"].includes(chairmanArg.split(/\s+/)[0] || "");
            const hasMentionMeta = (message.mentions || []).some((m: any) => !this.isAllMentionItem(m));
            const targets = this.resolveChairmanTargets(message.mentions || [], cleanText, rawText);
            // A pure status query: no clear keyword, no mention metadata, and no
            // textual argument at all. Anything else is a set/route attempt.
            const isStatusArg = !isClearArg && !hasMentionMeta && chairmanArg.length === 0;
            if (isClearArg || isStatusArg) {
              // Group-level status/clear: one coordinator handles it.
              if (!this.isDiscussionCoordinator()) return;
            } else if (targets.length >= 1) {
              // Targets resolved: only the (single) targeted bot acts. If
              // multiple distinct targets resolved, the coordinator handles
              // the "only one chairman" error once.
              const uniqueTargets = Array.from(new Set(targets));
              const targetedSelf = uniqueTargets.includes(this.config.name);
              if (uniqueTargets.length > 1) {
                if (!this.isDiscussionCoordinator()) return;
              } else if (!targetedSelf) {
                return;
              }
            } else {
              // A set attempt whose target could not be resolved at all (missing
              // metadata AND no readable name in text): coordinator handles the
              // fallback so the user still gets an actionable reply.
              if (!this.isDiscussionCoordinator()) return;
            }
          } else if (isLocaleCommand && !routing.hasTargetedMention) {
            // Untargeted or @all locale is a group-level setting; one coordinator handles it.
            // If the user explicitly @s a bot, the targeted bot should execute and answer.
            if (!this.isDiscussionCoordinator()) return;
          } else if (isHelpCommand && !routing.hasTargetedMention) {
            // Bare or @all /help in a multi-bot group should never be silent or
            // spammy. Let the coordinator answer once instead of requiring users
            // to know they must @ a bot before they can discover the command list.
            if (!this.isDiscussionCoordinator()) return;
          } else if (isDiscussCommand && !routing.hasTargetedMention) {
            // Untargeted or @all /discuss is group-level; one coordinator handles it.
            if (!this.isDiscussionCoordinator()) return;
          } else if (routing.hasTargetedMention) {
            // Explicitly targeted commands belong only to the mentioned bot.
            if (!routing.isCurrentBotMentioned) return;
          } else if (!routing.isAllMention && !singleBotGroup) {
            // Other bridge commands in a multi-bot group need an explicit target or @all.
            // A single-bot group treats the sole bot as the implicit target.
            return;
          }
        }

        const markCommandSynced = () => {
          if (insertedId > 0) {
            this.store.markSynced(this.config.name, chatId, insertedId);
            // Bridge commands should only clear their own pending row. They
            // must not clear earlier human triggers that are waiting after a
            // failed/empty run; /status must be safe to use for debugging.
            this.store.clearPendingTrigger(this.config.name, chatId, insertedId);
          }
        };

        if (commandName === "/help") {
          const helpText = [
            `📚 ${this.config.name} Bot 命令列表`,
            `━━━━━━━━━━━━━━━━━━`,
            `桥接层命令（单斜杠，由 openclaw-lark-multi-agent 本地处理）`,
            `📊 /status  — 查看当前模型、Token 用量、Session 状态`,
            `🧹 /compact — 压缩当前 bot 的 OpenClaw session`,
            `🔄 /reset   — 重置当前 bot 的 OpenClaw session`,
            `⏹️ /stop    — 强制停止当前 bot 在本聊天的卡死 run，解锁队列`,
            `🔊 /verbose — 开关当前聊天里的 Tool Call 显示`,
            `📡 /livestatus [on|off] — 开关非 verbose 下的单条覆盖式运行状态消息（默认开启；/livestatus off 可关闭）`,
            `🔓 /free [on|off] — 开关当前 bot 的 free 模式（仅非 Discuss 模式下影响普通消息主动回复）`,
            `🤐 /mute   — 切换当前 bot 的 mute 模式（禁言，不转发 OpenClaw）`,
            `🎛️ /mode   — 查看当前 bot 在当前群聊的模式`,
            `🤖 /model [id] — 查看/切换当前 bot 绑定模型（持久化）`,
            `💬 /discuss on|off|status|stop|rounds N — 群级多 bot 连续讨论（所有非 mute bot + Chairman 参与，忽略 free）`,
            `👑 /chairman @Bot|off — 设置/清除本群唯一 Chairman（状态见 /status）`,
            `🌐 /locale zh|en — 设置/查看当前群语言`,
            `❓ /help    — 显示此帮助信息`,
            ``,
            `OpenClaw 原生命令（双斜杠，会转成单斜杠发给 OpenClaw）`,
            `🆕 //new — 新建/切换会话`,
            `🔄 //reset — 让 OpenClaw 自己执行 reset`,
            `🧹 //compact [instructions] — 让 OpenClaw 压缩上下文`,
            `⏹️ //stopOptions — 查看/停止当前运行选项`,
            `🧠 //think <level> — 设置思考等级`,
            `🤖 //model <id> — 切换/查看模型`,
            `⚡ //fast status|on|off — OpenAI fast mode`,
            `🔊 //verbose on|off|full — OpenClaw verbose`,
            `🧵 //trace on|off|rawStatus — OpenClaw trace`,
            `📊 //status — OpenClaw 原生状态`,
            `📋 //tasks — 查看任务`,
            `👤 //whoami — 查看当前身份/会话`,
            `🧩 //contextSkills — 查看当前上下文技能`,
            `🛠️ //skill <name> [input] — 调用技能`,
            `🧰 //tools — 查看可用工具`,
            `📖 //commands — 查看完整 OpenClaw 命令`, 
            ``,
            `示例：群里发 @${this.config.name} //status，可把 /status 直接交给 OpenClaw。`,
          ].join("\n");
          await this.replyMessage(messageId, helpText);
          markCommandSynced();
          return;
        }
        if (commandName === "/status") {
          await this.ensureSession(chatId);
          await this.handleStatusCommand(chatId, chatType, messageId);
          markCommandSynced();
          return;
        }
        if (commandName === "/compact") {
          await this.ensureSession(chatId);
          await this.handleCompactCommand(chatId, messageId);
          markCommandSynced();
          return;
        }
        if (commandName === "/reset") {
          await this.ensureSession(chatId);
          await this.handleResetCommand(chatId, messageId);
          markCommandSynced();
          return;
        }
        if (commandName === "/stop") {
          await this.handleStopCommand(chatId, messageId);
          markCommandSynced();
          return;
        }
        if (rejectModelAll) {
          await this.replyMessage(messageId, "❌ /model 是单 bot 设置，不能 @所有人。请明确 @ 一个 bot，例如：@Claude /model provider/model-id");
          markCommandSynced();
          return;
        }
        if (commandName === "/model") {
          if (chatType !== "p2p" && !routing.isAllMention && !routing.hasTargetedMention) {
            const groupBotCount = Array.from(FeishuBot.allBots.values()).filter((bot) => bot.store === this.store).length;
            if (groupBotCount > 1) {
              await this.replyMessage(messageId, "❌ /model 是单 bot 设置，请明确 @ 一个 bot，例如：@Claude /model provider/model-id");
              markCommandSynced();
              return;
            }
          }
          await this.handleModelCommand(chatId, messageId, cleanText.trim());
          markCommandSynced();
          return;
        }
        if (commandName === "/verbose") {
          const isOn = this.store.getBotVerbose(this.config.name, chatId);
          const nextVerbose = !isOn;
          this.store.setBotVerbose(this.config.name, chatId, nextVerbose);
          this.openclawClient.setVerboseTranscriptDelivery(this.getSessionKey(chatId), nextVerbose);
          if (isOn) {
            await this.replyMessage(messageId, `🔇 ${this.config.name} Verbose 已关闭\n只影响当前 Bot 在当前会话的 Tool call 和中间文本显示`);
          } else {
            await this.replyMessage(messageId, `🔊 ${this.config.name} Verbose 已开启\n只影响当前 Bot 在当前会话的 Tool call 和中间文本显示`);
          }
          markCommandSynced();
          return;
        }
        if (commandName === "/livestatus") {
          const current = this.store.getBotLiveStatus(this.config.name, chatId);
          const parts = cleanText.trim().split(/\s+/);
          const arg = (parts[1] || "toggle").toLowerCase();
          const next = arg === "on" ? true : arg === "off" ? false : !current;
          this.store.setBotLiveStatus(this.config.name, chatId, next);
          await this.replyMessage(messageId, next
            ? `📡 ${this.config.name} Live Status 已开启\n非 verbose 模式下会用一条可覆盖消息显示运行状态，并在最终回复时覆盖成答案。`
            : `📡 ${this.config.name} Live Status 已关闭\n非 verbose 模式下只发送最终回复。`);
          markCommandSynced();
          return;
        }
        if (commandName === "/free") {
          if (chatType === "p2p") {
            await this.replyMessage(messageId, "❌ Free 模式只在群聊中可用");
            markCommandSynced();
            return;
          }
          const parts = cleanText.trim().split(/\s+/).filter(Boolean);
          const arg = (parts[1] || "toggle").toLowerCase();
          if (!["toggle", "on", "off"].includes(arg)) {
            await this.replyMessage(messageId, "❌ 用法：/free [on|off]");
            markCommandSynced();
            return;
          }
          const current = this.store.getBotMode(this.config.name, chatId);
          const next = arg === "on" ? "free" : arg === "off" ? "normal" : current === "free" ? "normal" : "free";
          this.store.setBotMode(this.config.name, chatId, next);
          if (next === "free") {
            await this.replyMessage(messageId, `🔓 ${this.config.name} 已切换到 free 模式
不需要 @ 也可以回复普通人类消息；如果消息明确 @ 了其他 bot 或普通人，我不会抢答。
如需多轮自动讨论，请使用群级命令 /discuss on。`);
          } else {
            await this.replyMessage(messageId, `🔒 ${this.config.name} 已切换到 normal 模式
只有明确 @ 我才会回复`);
          }
          markCommandSynced();
          return;
        }
        if (commandName === "/mute") {
          if (chatType === "p2p") {
            await this.replyMessage(messageId, "❌ Mute 模式只在群聊中可用");
            markCommandSynced();
            return;
          }
          const current = this.store.getBotMode(this.config.name, chatId);
          const next = current === "mute" ? "normal" : "mute";
          this.store.setBotMode(this.config.name, chatId, next);
          if (next === "mute") {
            await this.replyMessage(messageId, `🤐 ${this.config.name} 已切换到 mute 模式\n普通消息、@所有人 都不会回复；明确 @ 我时只提示禁言中`);
          } else {
            await this.replyMessage(messageId, `🔒 ${this.config.name} 已解除 mute，回到 normal 模式\n只有明确 @ 我才会回复`);
          }
          markCommandSynced();
          return;
        }
        if (commandName === "/mode") {
          if (chatType === "p2p") {
            await this.replyMessage(messageId, `🎛️ ${this.config.name} 当前模式：normal（私聊总是响应）`);
          } else {
            const mode = this.store.getBotMode(this.config.name, chatId);
            const desc = mode === "free" ? "不需要 @ 也可以参与回复" : mode === "mute" ? "禁言中；明确 @ 我时只提示禁言中" : "只有明确 @ 我才会回复";
            await this.replyMessage(messageId, `🎛️ ${this.config.name} 当前模式：${mode}\n${desc}`);
          }
          markCommandSynced();
          return;
        }
        if (commandName === "/discuss") {
          await this.handleDiscussCommand(chatId, chatType, messageId, cleanText.trim());
          markCommandSynced();
          return;
        }
        if (commandName === "/chairman") {
          await this.handleChairmanCommand(chatId, chatType, messageId, message.mentions || [], cleanText.trim(), rawText);
          markCommandSynced();
          return;
        }
        if (commandName === "/locale") {
          await this.handleLocaleCommand(chatId, chatType, messageId, cleanText.trim());
          markCommandSynced();
          return;
        }
      }

      // --- Discuss mode: group-level multi-bot round scheduler. It takes over
      // plain human messages so normal Free mode does not duplicate Round 1.
      // Targeted mentions must fall through to normal routing so @GPT still
      // works while discuss mode is enabled.
      if (chatType !== "p2p" && !isBot && this.store.getChatInfo(chatId)?.discuss) {
        // Discuss mode owns ordinary and @all human messages. Explicit @bot/@human
        // falls through to normal targeted routing.
        if (!routing.hasTargetedMention) {
          const discussionLocale = this.chatLocale(chatId);
          const chairman = this.getChairmanParticipant(chatId);
          const participants = this.getDiscussionParticipants(chatId);
          if (participants.length > 0 || chairman) {
            const preempted = discussionManager.status(chatId);
            const started = discussionManager.startIfAbsent({
              chatId,
              rootMessageId: messageId,
              topic: cleanText,
              maxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 10,
              participants,
              chairman,
              sendSystemMessage: async (text) => { await this.sendSystemDelivery(chatId, text); },
              locale: discussionLocale,
              onComplete: async (event) => {
                if (event.reason === "chairman_final") {
                  this.store.setDiscussMode(event.chatId, false);
                  await this.sendSystemDelivery(event.chatId, this.isEn(event.chatId)
                    ? `💬 Discuss ended: Chairman ${event.chairmanName || ""} completed the final summary. Discuss mode has been turned off automatically.`
                    : `💬 Discuss 已结束：Chairman ${event.chairmanName || ""} 已完成总结，已自动关闭 Discuss 模式。`);
                }
              },
            });
            if (started && preempted) {
              await this.sendSystemDelivery(chatId, this.isEn(chatId)
                ? `💬 New topic received; stopped the previous Discuss session and started a new one. Previous topic: ${preempted.topic.slice(0, 80)}`
                : `💬 收到新话题，已停止上一轮 Discuss 并开启新讨论。上一话题：${preempted.topic.slice(0, 80)}`);
            }
          } else if (this.isDiscussionCoordinator()) {
            await this.sendSystemDelivery(chatId, this.isEn(chatId)
              ? "💬 Discuss is on, but there is no available participant. Unmute at least one bot or set a Chairman."
              : "💬 Discuss 已开启，但当前没有可参与者。请至少解除一个 bot 的禁言，或设置 Chairman。");
          }
          if (insertedId > 0) this.store.markSynced(this.config.name, chatId, insertedId);
          return;
        }
      }

      // --- Mute mode: do not forward ordinary muted bots to OpenClaw. Chairman
      // intentionally outranks mute, so a muted Chairman can still answer/facilitate
      // in Chairman paths.
      if (chatType !== "p2p" && !isBot && this.store.getBotMode(this.config.name, chatId) === "mute" && this.store.getChairmanBot(chatId) !== this.config.name) {
        if (routing.isCurrentBotMentioned) {
          await this.replyMessage(messageId, `🤐 ${this.config.name} 当前处于 mute 模式，发送 /mute 可解除`);
          if (insertedId > 0) {
            this.store.markSynced(this.config.name, chatId, insertedId);
            this.store.clearPendingTrigger(this.config.name, chatId, insertedId);
          }
        }
        return;
      }

      // --- Should this bot respond? ---
      if (!this.shouldRespond(chatType, message, isBot, chatId, routing)) return;
      if (!isBot && insertedId > 0) {
        this.store.markPendingTrigger(this.config.name, chatId, insertedId);
      }

      // Track this message for reaction status updates
      const pending = this.pendingAckMessages.get(chatId) || [];

      const unhealthy = await this.getUnhealthySessionStatus(chatId);
      if (unhealthy) {
        await this.warnUnhealthySessionAndContinue(chatId, messageId, unhealthy);
      }

      // Anti-loop
      const streak = this.store.getBotStreak(chatId, this.config.name);
      if (streak >= MAX_BOT_STREAK) {
        console.log(
          `[${this.config.name}] Anti-loop: ${streak} consecutive bot msgs`
        );
        return;
      }

      // --- Queue-based sending: if agent is busy, just accumulate ---
      const busySince = this.busyChats.get(chatId) || 0;
      const BUSY_TIMEOUT_MS = 1_800_000; // 30 minutes, matches collectReply safety timeout
      const isBusy = busySince > 0 && (Date.now() - busySince) < BUSY_TIMEOUT_MS;

      if (isBusy) {
        // Queued: show waiting reaction
        await this.addReaction(messageId, "Typing").catch(() => {});
        pending.push({ messageId, emoji: "Typing", rowId: insertedId });
        this.pendingAckMessages.set(chatId, pending);
        console.log(
          `[${this.config.name}] Agent busy for ${chatId.slice(-8)}, queuing: "${cleanText.substring(0, 50)}..."`
        );
        return; // Message is in DB, will be picked up when agent finishes
      }

      if (busySince > 0) {
        // Busy timeout expired — unlock but don't processQueue here;
        // let the next new message trigger it naturally to avoid concurrent runs
        console.warn(
          `[${this.config.name}] Busy timeout expired for ${chatId.slice(-8)} (${Math.round((Date.now() - busySince) / 1000)}s), unlocking (will process on next message)`
        );
        this.busyChats.set(chatId, 0);
        return;
      }

      // --- Not busy, send now (with any accumulated messages) ---
      // Acknowledge receipt: sent to OpenClaw (GET/了解)
      await this.addReaction(messageId, "Get").catch(() => {});
      pending.push({ messageId, emoji: "Get", rowId: insertedId });
      this.pendingAckMessages.set(chatId, pending);
      await this.processQueue(chatId);
    } catch (err) {
      console.error(`[${this.config.name}] Error:`, err);
    }
  }

  private shouldUseLiveStatus(chatId: string, isNativeCommandTrigger = false): boolean {
    if (isNativeCommandTrigger) return false;
    if (this.store.getBotVerbose(this.config.name, chatId)) return false;
    if (!this.store.getBotLiveStatus(this.config.name, chatId)) return false;
    return process.env.OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS !== "0";
  }

  private async getUnhealthySessionStatus(chatId: string): Promise<string | null> {
    const sessionKey = this.getSessionKey(chatId);
    try {
      const resp = await this.openclawClient.getSessionInfo(sessionKey);
      const status = String(resp?.session?.status || "").toLowerCase();
      if (!status) return null;
      if (this.isSessionDeadStatus(status)) return status;
    } catch {
      // Absence/transient describe failures should not block a new run; chat.send
      // will create/report the session as usual.
    }
    return null;
  }

  /**
   * Distinguish SESSION death from RUN failure. `sessions.describe` reports the
   * status of the most recent run, not whether the session is usable. A run can
   * end as `aborted`/`error`/`failed`/`timeout` (e.g. an LLM idle timeout) while
   * the session itself stays perfectly usable for the next message — confirmed in
   * the wild: LMA reported "killed" but `/status` immediately showed running.
   *
   * Only treat the session as dead for statuses that mean the session itself is
   * gone and a new run cannot start without /reset. Use word-boundary matching so
   * a run-level "error" substring never trips this. Run-level failures are NOT
   * surfaced here: the work promise will either return the (possibly empty) reply
   * or throw, and that is handled by the normal delivery/error path.
   */
  private isSessionDeadStatus(status: string): boolean {
    const s = status.toLowerCase();
    // Session-level death tokens only. Notably excludes aborted/error/errored/
    // failed/failure/timeout, which are run-level outcomes on a live session.
    const deadTokens = ["killed", "dead", "crashed", "destroyed", "terminated", "gone"];
    return deadTokens.some((tok) => new RegExp(`(^|[^a-z])${tok}([^a-z]|$)`).test(s));
  }

  private async warnUnhealthySessionAndContinue(chatId: string, messageId: string, status: string): Promise<void> {
    await this.replyMessage(messageId, this.isEn(chatId)
      ? `⚠️ ${this.config.name} session is currently unhealthy (${status}). I will still try this message. If it keeps failing, send /reset and retry.`
      : `⚠️ ${this.config.name} 的 session 当前状态异常（${status}）。我会继续尝试处理这条消息；如果连续失败，再发送 /reset 后重试。`);
    console.warn(`[${this.config.name}] unhealthy session ${this.getSessionKey(chatId)} status=${status}; warning user but allowing retry for ${chatId.slice(-8)}`);
  }

  private async stopForUnhealthySession(chatId: string, messageId: string, status: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    await this.openclawClient.abortChat(sessionKey).catch(() => {});
    this.busyChats.set(chatId, 0);
    const acks = this.pendingAckMessages.get(chatId) || [];
    const remainingAcks: typeof acks = [];
    for (const ack of acks) {
      await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
      await this.addReaction(ack.messageId, "DONE").catch(() => {});
    }
    this.pendingAckMessages.set(chatId, remainingAcks);
    await this.addReaction(messageId, "DONE").catch(() => {});
    await this.replyMessage(messageId, this.isEn(chatId)
      ? `⚠️ ${this.config.name} session became unhealthy while waiting (${status}). I stopped this attempt. You can send another message to try again; if it keeps failing, send /reset.`
      : `⚠️ ${this.config.name} 的 session 在等待过程中变成异常状态（${status}）。我已停止这次等待。你可以直接再发一条继续尝试；如果连续失败，再发送 /reset。`);
    console.warn(`[${this.config.name}] unhealthy session ${sessionKey} status=${status}; stopped current attempt for ${chatId.slice(-8)}`);
  }

  private async withSessionHealthMonitor<T>(chatId: string, messageId: string, insertedId: number, work: Promise<T>): Promise<T> {
    let done = false;
    const monitoredWork = work.finally(() => { done = true; });
    const monitor = (async () => {
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_HEALTH_POLL_MS));
        if (done) break;
        const unhealthy = await this.getUnhealthySessionStatus(chatId);
        if (unhealthy) {
          // Session status can briefly report killed/aborted while the final
          // response is still racing back to the bridge. Confirm once before
          // surfacing a user-visible failure, otherwise users can see both a
          // successful reply and a misleading "session became unhealthy" notice.
          await new Promise((resolve) => setTimeout(resolve, SESSION_HEALTH_CONFIRM_MS));
          if (done) break;
          const confirmedUnhealthy = await this.getUnhealthySessionStatus(chatId);
          if (confirmedUnhealthy) {
            await this.stopForUnhealthySession(chatId, messageId, confirmedUnhealthy);
            throw new UnhealthySessionError(confirmedUnhealthy);
          }
        }
      }
      return undefined as never;
    })();
    try {
      return await Promise.race([monitoredWork, monitor]);
    } finally {
      done = true;
    }
  }

  /**
   * Process queued messages for a chat: batch all unsynced messages and send to OpenClaw.
   * Loops until no more unsynced human messages remain.
   */
  private async processQueue(chatId: string): Promise<void> {
    const existing = this.queueRuns.get(chatId);
    if (existing) {
      console.log(`[${this.config.name}] processQueue already running for ${chatId.slice(-8)}, joining existing run`);
      return existing;
    }
    const run = this.processQueueInner(chatId).finally(() => {
      this.queueRuns.delete(chatId);
    });
    this.queueRuns.set(chatId, run);
    return run;
  }

  private async processQueueInner(chatId: string): Promise<void> {
    while (true) {
      const pendingMessages = this.store.getPendingTriggerMessages(this.config.name, chatId);
      const pendingTriggerIds = this.store.getPendingTriggerIds(this.config.name, chatId);
      // Only proceed if there are pending human messages that should actively trigger this bot.
      const pendingHumanTriggers = pendingMessages
        .filter((m) => m.senderType === "human" && m.id && pendingTriggerIds.has(m.id))
        .sort((a, b) => a.timestamp - b.timestamp);
      if (pendingHumanTriggers.length === 0) {
        break;
      }

      // Do not preflight-block a retry just because the previous session status
      // is still marked unhealthy. handleMessage already warns the user; the
      // current chat.send attempt should be allowed so users can choose to try
      // again without being forced through /reset. The in-flight health monitor
      // below still stops a run that becomes unhealthy while waiting.

      this.busyChats.set(chatId, Date.now());

      // Pick the batch to process this loop. Consecutive plain human messages are
      // merged into a single run; native escaped commands (//x) are processed on
      // their own and never merged with ordinary messages, because they are exact
      // pass-through requests that must not receive catch-up context.
      const firstPending = pendingHumanTriggers[0];
      const firstIsNative = firstPending.triggerKind === "native_command";
      let mergedTriggers: typeof pendingHumanTriggers;
      if (firstIsNative) {
        // One native command at a time.
        mergedTriggers = [firstPending];
      } else {
        // Take the leading run of consecutive non-native messages.
        mergedTriggers = [];
        for (const m of pendingHumanTriggers) {
          if (m.triggerKind === "native_command") break;
          mergedTriggers.push(m);
        }
      }
      // Bound the merged current message payload. When a bot is stuck, many
      // human triggers can accumulate; sending all of them can exceed OpenClaw's
      // single-message/payload limit. Keep the most recent messages and drop the
      // older ones from this batch (marking them synced/cleared below so they do
      // not clog the queue forever).
      const originalMergedTriggers = mergedTriggers;
      const droppedMergedTriggers: typeof pendingHumanTriggers = [];
      if (!firstIsNative) {
        const selected: typeof pendingHumanTriggers = [];
        let bytes = 0;
        for (let i = originalMergedTriggers.length - 1; i >= 0; i--) {
          const m = originalMergedTriggers[i];
          const addBytes = Buffer.byteLength((selected.length ? "\n" : "") + m.content, "utf8");
          if (selected.length > 0 && (selected.length >= MAX_MERGED_TRIGGER_MESSAGES || bytes + addBytes > MAX_MERGED_TRIGGER_BYTES)) {
            droppedMergedTriggers.unshift(m);
            continue;
          }
          // Always keep at least the newest trigger, even if it is individually
          // too large; OpenClaw will return a real payload error instead of us
          // silently dropping the current user request.
          selected.unshift(m);
          bytes += addBytes;
        }
        mergedTriggers = selected;
        if (droppedMergedTriggers.length > 0) {
          const summaries = droppedMergedTriggers
            .map((m) => `#${m.id || "?"}:${m.content.replace(/\s+/g, " ").trim().slice(0, 120)}`)
            .join(" | ");
          console.warn(`[${this.config.name}] Dropped ${droppedMergedTriggers.length} older pending trigger(s) for ${chatId.slice(-8)} due to merge limits (kept=${mergedTriggers.length}, bytes=${bytes}): ${summaries}`);
        }
      }
      const deliveredTriggerIds = mergedTriggers
        .map((m) => m.id || 0)
        .filter((id) => id > 0 && this.store.hasDeliveredReply(this.config.name, chatId, id));
      if (deliveredTriggerIds.length > 0) {
        console.warn(`[${this.config.name}] Clearing ${deliveredTriggerIds.length} stale delivered pending trigger(s) for ${chatId.slice(-8)}: ${deliveredTriggerIds.join(",")}`);
        for (const id of deliveredTriggerIds) this.store.clearPendingTrigger(this.config.name, chatId, id);
        mergedTriggers = mergedTriggers.filter((m) => !m.id || !deliveredTriggerIds.includes(m.id));
        if (mergedTriggers.length === 0) continue;
      }

      const isNativeCommandTrigger = firstIsNative;
      const lastHuman = mergedTriggers[mergedTriggers.length - 1];
      const triggerId = lastHuman.id || 0;
      const mergedContent = mergedTriggers.map((m) => m.content).join("\n");
      const mergedTriggerIds = mergedTriggers.map((m) => m.id || 0).filter(Boolean);
      const droppedTriggerIds = droppedMergedTriggers.map((m) => m.id || 0).filter(Boolean);
      const mergedTriggerIdSet = new Set(mergedTriggerIds);
      const completedTriggerIdSet = new Set([...droppedTriggerIds, ...mergedTriggerIds]);

      // Catch-up is only injected in group chats. p2p must never get it.
      // Use "not p2p" rather than "=== group": chatInfo is always cached before
      // a message reaches the queue, but if chat_type were ever missing we'd
      // rather treat it as a group (catch-up helps in groups, harms in p2p).
      const chatType = this.store.getChatInfo(chatId)?.chatType || "";
      const isGroup = chatType !== "p2p";
      if (triggerId && this.store.hasDeliveredReply(this.config.name, chatId, triggerId)) {
        console.warn(`[${this.config.name}] Duplicate trigger skipped for ${chatId.slice(-8)} msgId=${triggerId}`);
        for (const id of [...droppedTriggerIds, ...mergedTriggerIds]) this.store.clearPendingTrigger(this.config.name, chatId, id);
        continue;
      }
      if (droppedTriggerIds.length > 0) {
        const dropBatchId = `${this.config.name}:${chatId}:dropped:${Date.now()}`;
        this.store.markMessagesSynced(this.config.name, chatId, droppedTriggerIds, dropBatchId);
        for (const id of droppedTriggerIds) this.store.clearPendingTrigger(this.config.name, chatId, id);
      }

      // Catch-up context: messages this bot has not seen yet in this GROUP chat.
      // Includes both human and other-bot messages (so mention-only replies can
      // see the human message they refer to). Excludes:
      //   - the merged trigger messages themselves (they are the current input)
      //   - other pending triggers (each is current for its own run)
      //   - this bot's own messages
      //   - native escaped commands
      // p2p never injects catch-up; native command runs never inject catch-up.
      let contextMsgs: typeof pendingMessages = [];
      if (isGroup && !isNativeCommandTrigger) {
        // Use a processing-time snapshot upper bound rather than the current
        // trigger id. In multi-bot groups, another bot's visible reply may be
        // stored locally after the human trigger row even though it is already
        // relevant context for this run. The snapshot captures all messages the
        // bridge knows about at dispatch time, while the filters below still
        // exclude current/pending triggers and this bot's own messages.
        const contextUpperBoundId = Math.max(triggerId, this.store.getLatestMessageId(chatId));
        const catchupMessages = this.store.getUnsyncedMessagesForBot(this.config.name, chatId, contextUpperBoundId);
        contextMsgs = catchupMessages.filter((m) =>
          m.senderName !== this.config.name
          && !(m.senderType === "human" && m.id && m.id > triggerId)
          && !(m.id && mergedTriggerIdSet.has(m.id))
          && !(m.id && pendingTriggerIds.has(m.id))
          && (m.triggerKind === "normal" || !m.triggerKind)
          && !this.isLegacyBridgeControlMessage(m.content)
        );
      }
      const processedMessages = [...contextMsgs, ...mergedTriggers].filter((m) => m.id);

      const queueStartedAt = Date.now();
      const sessionKey = await this.ensureSession(chatId);

      console.log(
        `[${this.config.name}] Sending ${mergedTriggers.length} trigger(s) as 1 run to OpenClaw for ${chatId.slice(-8)} (context=${contextMsgs.length}, dropped=${droppedTriggerIds.length})`
      );

      // Update reactions: queued messages → sent (GET/了解)
      const pendingAcks = this.pendingAckMessages.get(chatId) || [];
      for (const ack of pendingAcks) {
        if (ack.emoji !== "Get") {
          await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
          await this.addReaction(ack.messageId, "Get").catch(() => {});
          ack.emoji = "Get";
        }
      }

      let runAcceptedByOpenClaw = false;
      let liveStatus: LiveStatusController | undefined;
      try {
        const releaseActiveDeliveryTarget = lastHuman.messageId ? this.setActiveDeliveryTarget(chatId, triggerId, lastHuman.messageId) : () => {};
        let reply: string;
        let contextMarkedSubmitted = false;
        let currentMarkedSubmitted = false;
        const markSubmittedBatch = (suffix: string) => {
          const contextIds = contextMsgs.map((m) => m.id || 0).filter(Boolean);
          if (!contextMarkedSubmitted && contextIds.length > 0) {
            this.store.markMessagesSynced(this.config.name, chatId, contextIds, `${this.config.name}:${chatId}:${triggerId}:context-${suffix}`);
            contextMarkedSubmitted = true;
          }
          if (!currentMarkedSubmitted && mergedTriggerIds.length > 0) {
            this.store.markMessagesSynced(this.config.name, chatId, mergedTriggerIds, `${this.config.name}:${chatId}:${triggerId}:current-${suffix}`);
            for (const id of mergedTriggerIds) this.store.clearPendingTrigger(this.config.name, chatId, id);
            currentMarkedSubmitted = true;
          }
        };
        liveStatus = this.shouldUseLiveStatus(chatId, isNativeCommandTrigger)
          ? new LiveStatusController({
              create: (view) => this.sendOrdered(chatId, () => this.replyLiveStatusCard(lastHuman.messageId || "", view, chatId)),
              edit: (messageId, view) => this.sendOrdered(chatId, () => this.patchLiveStatusCard(messageId, view, chatId)),
              warn: (message, err) => console.warn(`[${this.config.name}] ${message}:`, this.errorSummary(err)),
            }, {
              botName: this.config.name,
              model: this.config.model,
              locale: this.isEn(chatId) ? "en" : "zh",
            })
          : undefined;
        liveStatus?.start(this.isEn(chatId) ? "waiting for OpenClaw" : "等待 OpenClaw 回复");
        const activeTargetForStatus = this.activeDeliveryTargets.get(chatId);
        if (activeTargetForStatus?.triggerId === triggerId && liveStatus) activeTargetForStatus.liveStatus = liveStatus;
        try {
          reply = await this.withSessionHealthMonitor(chatId, lastHuman.messageId || "", triggerId, this.openclawClient.chatSendWithContext({
            sessionKey,
            unsyncedMessages: contextMsgs,
            currentMessage: mergedContent,
            currentSenderName: lastHuman.senderName,
            deliver: false,
            // Keep bridge UX responsive; long agent/tool loops should surface a clear failure
            // instead of leaving reactions stuck forever.
            timeoutMs: 1_800_000,
            includeContext: !isNativeCommandTrigger,
            includeBridgeAttachmentHint: !isNativeCommandTrigger,
            onSendAttempt: () => {
              // At-most-once: as soon as we begin issuing chat.send, do not let
              // this batch auto-replay. If the RPC response is lost after
              // OpenClaw accepts it, retrying would duplicate the same message.
              markSubmittedBatch("send-attempt");
            },
            onSubmitted: (runId: string) => {
              runAcceptedByOpenClaw = true;
              // Refine state for logs/idempotent sync rows when OpenClaw returns
              // a runId. markSubmittedBatch is idempotent due to local flags and
              // INSERT OR IGNORE in message_sync.
              markSubmittedBatch(`submitted:${runId}`);
            },
            onProgress: (event) => liveStatus?.progress(event),
          }));
        } catch (mainErr) {
          // The main run failed before returning a reply. If it is a retryable
          // error (e.g. a request timeout) and not a session-health failure,
          // reuse the SAME auto-retry mechanism to let the session resume from
          // where it was interrupted, instead of giving up immediately.
          if (mainErr instanceof UnhealthySessionError) throw mainErr;
          const errText = (mainErr as Error)?.message || String(mainErr);
          if (autoRetryEnabled() && !isNativeCommandTrigger && this.isRetryableAgentError(errText)) {
            console.warn(`[${this.config.name}] main run failed (${errText.slice(0, 80)}) for ${chatId.slice(-8)}; entering auto-retry`);
            reply = await this.autoRetryUntilComplete({
              chatId,
              sessionKey,
              senderName: lastHuman.senderName,
              triggerId,
              lastHumanMessageId: lastHuman.messageId || "",
              isNativeCommandTrigger,
              initialError: errText,
              liveStatus,
            });
          } else {
            throw mainErr;
          }
        } finally {
          // OpenClaw may emit the final assistant session.message just after
          // collectReply returns. Keep the trigger mapping briefly so proactive
          // and chat-final paths share the same delivery key.
          releaseActiveDeliveryTarget();
        }
        console.log(`[${this.config.name}] OpenClaw reply collected for ${chatId.slice(-8)} in ${Date.now() - queueStartedAt}ms`);

        // Auto-retry: if the reply looks truncated/incomplete, confirm with the
        // session and loop until it reports done (or the budget is spent). This
        // replaces `reply` with the final, confirmed result before delivery.
        reply = await this.autoRetryUntilComplete({
          chatId,
          sessionKey,
          senderName: lastHuman.senderName,
          triggerId,
          lastHumanMessageId: lastHuman.messageId || "",
          isNativeCommandTrigger,
          initialReply: reply,
          liveStatus,
        });

        const parsedReply = this.extractBridgeAttachments(reply);
        const visibleReply = parsedReply.text;
        const trimmedReply = visibleReply.trim();
        const hasAttachments = parsedReply.attachments.length > 0;
        const explicitNoReply = trimmedReply.toUpperCase() === "NO_REPLY";
        const trulyEmptyReply = trimmedReply.length === 0 && !hasAttachments;
        if (trulyEmptyReply) {
          // Empty final text is not the same as an explicit NO_REPLY. It often
          // means the upstream session/run was interrupted, raced, or collected
          // incorrectly. But if chatSendWithContext returned, the content was
          // submitted far enough that auto-replaying risks duplicate delivery.
          // The user can resend a new message if they want to retry.
          markSubmittedBatch("empty-returned");
          await liveStatus?.noReply().catch(() => {});
          console.warn(`[${this.config.name}] Empty reply for ${chatId.slice(-8)} trigger=${triggerId}; not replaying submitted message(s)`);
          const pendingAcks = this.pendingAckMessages.get(chatId) || [];
          const remainingAcks: typeof pendingAcks = [];
          for (const ack of pendingAcks) {
            if (completedTriggerIdSet.has(ack.rowId)) {
              await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
              await this.addReaction(ack.messageId, "DONE").catch(() => {});
            } else {
              remainingAcks.push(ack);
            }
          }
          this.pendingAckMessages.set(chatId, remainingAcks);
          break;
        }

        // Mark current triggers only after the run produced a non-empty result.
        // Catch-up context is marked as soon as chat.send is accepted (above),
        // because it has already been delivered even if the run later times out
        // or is stopped. Messages that arrive while the agent is busy must remain
        // pending for the next loop.
        const maxId = Math.max(...processedMessages.map((m) => m.id || 0));
        const syncBatchId = `${this.config.name}:${chatId}:${triggerId}:${Date.now()}`;
        if (!currentMarkedSubmitted) this.store.markMessagesSynced(this.config.name, chatId, mergedTriggerIds, syncBatchId);
        if (!contextMarkedSubmitted && contextMsgs.length > 0) {
          // Defensive fallback for mocked clients or older implementations that
          // do not call onSubmitted: avoid duplicate context on successful runs.
          this.store.markMessagesSynced(this.config.name, chatId, contextMsgs.map((m) => m.id || 0), `${syncBatchId}:context-success`);
        }
        this.store.markSynced(this.config.name, chatId, maxId);
        for (const id of mergedTriggerIds) this.store.clearPendingTrigger(this.config.name, chatId, id);
        const shouldReply = trimmedReply.length > 0 && !explicitNoReply;
        const isRuntimeFailure = shouldReply && this.isRuntimeFailureText(trimmedReply);

        // Record bot reply only if it is user-visible/context-worthy.
        if (shouldReply || hasAttachments) {
          const storedContent = [visibleReply, ...parsedReply.attachments.map((a: BridgeAttachment) => `[Attachment: ${a.type || "file"} ${a.path}]`)]
            .filter(Boolean)
            .join("\n");
          const replyId = this.store.insert({
            chatId,
            messageId: `self-${this.config.name}-${Date.now()}`,
            senderType: "bot",
            senderName: this.config.name,
            content: storedContent,
            timestamp: Date.now(),
          });
          if (replyId > 0) {
            const remainingPending = this.store.getPendingTriggerIds(this.config.name, chatId);
            const hasEarlierPending = Array.from(remainingPending).some((id) => id <= replyId);
            // Do not advance sync past a human message that arrived while this
            // run was busy. Otherwise the pending trigger remains in the table
            // but getUnsyncedMessages() can no longer see it.
            if (!hasEarlierPending) {
              this.store.markMessagesSynced(this.config.name, chatId, [replyId], `${this.config.name}:${chatId}:reply:${replyId}`);
              this.store.markSynced(this.config.name, chatId, replyId);
            }
          }
        }

        // Wait for all pending tool event messages to be delivered first
        const toolSends = this.pendingToolSends.get(chatId) || [];
        if (toolSends.length > 0) {
          await Promise.allSettled(toolSends);
          this.pendingToolSends.set(chatId, []);
        }

        // Reply to the last human message on Feishu (ordered after tool msgs)
        // Skip empty replies and explicit NO_REPLY responses
        if ((shouldReply || hasAttachments) && lastHuman.messageId && !isRuntimeFailure) {
          if (triggerId && this.store.hasDeliveredReply(this.config.name, chatId, triggerId)) {
            console.warn(`[${this.config.name}] Reply already delivered, skip duplicate for ${chatId.slice(-8)} msgId=${triggerId}`);
            await liveStatus?.complete().catch(() => {});
          } else {
            try {
              // Final answer always goes through the normal interactive-card
              // delivery path so Markdown renders correctly. The live status is a
              // SEPARATE message: once the final reply is enqueued, mark the
              // status message done.
              await this.enqueueAndDispatchDelivery(
                chatId,
                "assistant_visible",
                this.deliverySourceId("visible", `${(shouldReply ? visibleReply : "").trim()}|${JSON.stringify(parsedReply.attachments)}`),
                shouldReply ? visibleReply : "",
                parsedReply.attachments,
                lastHuman.messageId,
                `trigger:${triggerId}`
              );
              await liveStatus?.complete();
              // Mark every merged trigger as delivered so retries/restarts do
              // not re-process any of them.
              for (const id of mergedTriggerIds) this.store.markDeliveredReply(this.config.name, chatId, id, lastHuman.messageId);
              // After a successful reply, warn the user once if context is high.
              void this.maybeAlertHighContext(chatId);
            } catch (err) {
              // enqueueAndDispatchDelivery already sent a user-visible delivery
              // failure. Do not fall through to the generic provider-error path;
              // that creates a second misleading "bot did not complete" message.
              await liveStatus?.fail().catch(() => {});
              console.warn(`[${this.config.name}] assistant delivery failed after notification:`, this.errorSummary(err));
            }
          }
        }
        if (isRuntimeFailure && lastHuman.messageId) {
          await liveStatus?.fail().catch(() => {});
          this.scheduleDelayedFailure(chatId, lastHuman.messageId, visibleReply, triggerId);
        } else if (!shouldReply && !hasAttachments) {
          // Explicit NO_REPLY (or empty visible text): the model finished without
          // producing a user-visible reply. Mark the status card done with a
          // "no content" summary instead of leaving it stuck on "正在执行".
          await liveStatus?.noReply().catch(() => {});
        }
        console.log(`[${this.config.name}] [${new Date().toISOString()}] ${shouldReply || hasAttachments ? 'Replied' : 'Skipped (empty/NO_REPLY)'} (${reply.length} chars, attachments=${parsedReply.attachments.length})`);

        // Replace ack reactions with DONE only for trigger messages actually
        // processed in this run. Queued messages that arrived mid-run keep their
        // Typing/Get reaction and will be acknowledged by the next loop.
        const pendingAcks = this.pendingAckMessages.get(chatId) || [];
        const remainingAcks: typeof pendingAcks = [];
        for (const ack of pendingAcks) {
          if (completedTriggerIdSet.has(ack.rowId)) {
            await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
            await this.addReaction(ack.messageId, "DONE").catch(() => {});
          } else {
            remainingAcks.push(ack);
          }
        }
        this.pendingAckMessages.set(chatId, remainingAcks);
      } catch (err) {
        if (err instanceof UnhealthySessionError) {
          // stopForUnhealthySession already warned the user; mark the live
          // status as interrupted. The user can send another message to retry
          // without being forced through /reset.
          await liveStatus?.fail().catch(() => {});
          console.warn(`[${this.config.name}] processQueue stopped because session became unhealthy: ${err.status}`);
          break;
        }
        console.error(`[${this.config.name}] processQueue error:`, err);
        const errorText = this.formatUserVisibleError(err);
        if (lastHuman.messageId) {
          // Error message goes through the normal delivery path; the live status
          // is a separate message that we mark interrupted afterwards.
          await this.enqueueAndDispatchDelivery(chatId, "provider_error", `trigger:${triggerId}:provider-error`, errorText, [], lastHuman.messageId, `trigger:${triggerId}:provider-error`)
            .then(() => {
              if (triggerId) this.store.markDeliveredReply(this.config.name, chatId, triggerId, lastHuman.messageId);
            })
            .catch(() => {});
          await liveStatus?.fail().catch(() => {});
        } else {
          await liveStatus?.fail().catch(() => {});
        }
        if (triggerId) {
          // At-most-once: if anything after send attempt failed, this batch has
          // already been marked/cleared by onSendAttempt. If failure happened
          // before the callback (e.g. before acquiring the slot), clear only this
          // processing batch to avoid startup/drain loops; the user can resend.
          for (const id of mergedTriggerIds) this.store.clearPendingTrigger(this.config.name, chatId, id);
          this.store.markMessagesSynced(this.config.name, chatId, mergedTriggerIds, `${this.config.name}:${chatId}:${triggerId}:${runAcceptedByOpenClaw ? "failed-submitted" : "failed-attempt"}`);
          this.store.markSynced(this.config.name, chatId, Math.max(...mergedTriggerIds));
        }
        const pendingAcks = this.pendingAckMessages.get(chatId) || [];
        const remainingAcks: typeof pendingAcks = [];
        for (const ack of pendingAcks) {
          if (completedTriggerIdSet.has(ack.rowId)) {
            await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
            await this.addReaction(ack.messageId, "DONE").catch(() => {});
          } else {
            remainingAcks.push(ack);
          }
        }
        this.pendingAckMessages.set(chatId, remainingAcks);
        break;
      } finally {
        this.busyChats.set(chatId, 0);
      }

      // Check if more messages arrived while we were busy
      // Small delay to let any in-flight messages settle
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private shouldHandleBridgeCommand(
    chatType: string,
    message: any,
    isBot: boolean,
    rawText?: string
  ): boolean {
    if (chatType === "p2p") return !isBot;
    if (isBot) return false;
    const mentions: any[] = message.mentions || [];
    if (this.isAllMention(rawText, mentions)) return true;
    return this.isMentioned(mentions);
  }

  private shouldRespond(
    chatType: string,
    _message: any,
    isBot: boolean,
    chatId: string | undefined,
    routing: RoutingIntent
  ): boolean {
    if (chatType === "p2p") return !isBot;

    // Bot messages: only respond if this bot is explicitly mentioned.
    if (isBot) return routing.isCurrentBotMentioned;

    // @all is an explicit broadcast to all non-muted bots.
    if (routing.isAllMention) return true;

    // Explicit targeted mentions are exclusive. If this bot is not one of the
    // mentioned bots, free/chairman must not steal the turn.
    if (routing.hasTargetedMention) return routing.isCurrentBotMentioned;

    // Human-only mentions are also exclusive; free/chairman should not jump in.
    if (routing.hasHumanMention) return false;

    if (chatId) {
      if (this.store.getBotMode(this.config.name, chatId) === "free") return true;

      // Chairman fallback: if nobody is in free mode, the unique chairman
      // answers ordinary unmentioned messages for the group.
      const chairman = this.store.getChairmanBot(chatId);
      if (chairman === this.config.name && !this.hasFreeModeBot(chatId)) return true;
    }

    return false;
  }

  private getRoutingIntent(chatType: string, message: any, rawText?: string): RoutingIntent {
    const mentions: any[] = message.mentions || [];
    const isAllMention = chatType !== "p2p" && this.isAllMention(rawText, mentions);
    const targetedBotNames = this.mentionedBotNames(mentions);
    const hasHumanMention = mentions.some((m: any) => !this.isAllMentionItem(m) && !this.mentionedBotName(m));
    const hasTargetedMention = targetedBotNames.length > 0 || hasHumanMention;
    return {
      isAllMention,
      targetedBotNames,
      hasTargetedMention,
      hasHumanMention,
      isCurrentBotMentioned: targetedBotNames.includes(this.config.name),
    };
  }

  private isMentioned(mentions: any[]): boolean {
    return mentions.some((m: any) => this.mentionedBotName(m) === this.config.name);
  }

  private isAllMention(rawText?: string, mentions: any[] = []): boolean {
    if (rawText && /(^|\s)@(?:_all|all|所有人)(?=\s|$)/i.test(rawText)) return true;
    return mentions.some((m: any) => this.isAllMentionItem(m));
  }

  private isAllMentionItem(mention: any): boolean {
    return mention.key === "all" || mention.key === "@_all" || mention.id?.user_id === "all" || mention.id?.open_id === "all" || mention.name === "所有人";
  }

  private mentionedBotName(mention: any): string | null {
    if (this.isAllMentionItem(mention)) return null;
    const candidates = [this, ...Array.from(FeishuBot.allBots.values()).filter((bot) => bot !== this)];
    for (const bot of candidates) {
      if (mention.id?.app_id && mention.id.app_id === bot.config.appId) return bot.config.name;
      if (bot.botOpenId && mention.id?.open_id && mention.id.open_id === bot.botOpenId) return bot.config.name;
    }

    // Name is only a fallback because Feishu should normally provide app_id/open_id.
    // Keep it exact to avoid shared-prefix bots like 万万（GPT） / 万万（Claude）
    // stealing each other's mentions.
    if (typeof mention.name === "string") {
      const raw = mention.name.trim().replace(/^@+/, "").replace(/\s+/g, "").toLowerCase();
      for (const bot of candidates) {
        const botName = bot.config.name.trim().replace(/\s+/g, "").toLowerCase();
        const exactNames = [
          botName,
          `万万（${botName}）`,
          `万万(${botName})`,
        ];
        if (exactNames.includes(raw)) return bot.config.name;
        // Generic display-name fallback: many deployments name bots like
        // "光子 (Claude)" or "万万（GPT）". Match only when the parenthesized
        // suffix is exactly the configured bot name, avoiding loose substring
        // matches that caused shared-prefix bots to steal each other's mentions.
        if (new RegExp(`^[^()（）]+[（(]${this.escapeRegExp(botName)}[）)]$`, "i").test(raw)) return bot.config.name;
      }
    }
    return null;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  }

  private resolveBotName(sender: any): string | null {
    const openId = sender?.sender_id?.open_id;
    if (openId) {
      const bot = FeishuBot.findByOpenId(openId);
      if (bot) return bot.config.name;
    }
    return null;
  }

  private resolveHumanName(sender: any): string | null {
    return sender?.sender_id?.open_id || null;
  }

  private cleanMentions(text: string): string {
    return text.replace(/@_user_\d+/g, "").trim();
  }

  private stripLeadingCommandMentions(text: string): string {
    let s = text.trim();
    let prev = "";
    while (s !== prev) {
      prev = s;
      s = s
        .replace(/^(@_all|@all|@所有人|所有人)\s*/i, "")
        .replace(/^@\S+\s*/u, "")
        .trimStart();
    }
    return s;
  }

  private buildMarkdownCard(text: string) {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: {
        elements: buildFeishuCardElements(text),
      },
    };
  }

  private formatUserVisibleError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    let reason = raw.replace(/\s+/g, " ").trim();
    if (/quota/i.test(reason) || /exceeded/i.test(reason)) {
      const reset = reason.match(/reset at ([^.;]+)/i)?.[1];
      reason = reset ? `模型/供应商额度已用尽，重置时间：${reset}` : "模型/供应商额度已用尽，请稍后重试或切换模型";
    } else if (/timeout/i.test(reason)) {
      reason = "模型响应超时，请稍后重试";
    } else if (/schema|tool payload|rejected/i.test(reason)) {
      reason = "模型供应商拒绝了请求格式或工具参数，需要调整模型/工具调用";
    } else if (reason.length > 220) {
      reason = reason.slice(0, 220) + "...";
    }
    return `⚠️ ${this.config.name} 这次没有完成回复。\n原因：${reason}`;
  }

  private isBridgeControlReply(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return /^✅ Session reset\.?$/i.test(t)
      || /^✅ Session 已重置/m.test(t)
      || /^✅ Session 已压缩/m.test(t)
      || /^❌ (重置|压缩|stop|模型切换|无法持久化|用法|Free 模式|Mute 模式|一个群只能设置一个 Chairman)/m.test(t)
      || /^⏹️ .*已停止/m.test(t)
      || /^📊 /m.test(t)
      || /^🤖 .*当前模型：/m.test(t)
      || /^Models \(/m.test(t)
      || /^(Switch|More|All): \/models?/m.test(t)
      || /^🎛️ .*当前模式：/m.test(t)
      || /^🌐 (当前语言|Current locale|Locale set|语言已设置)/m.test(t)
      || /^👑 /m.test(t)
      || /^💬 Discuss /m.test(t);
  }

  // Backward-compatibility for rows stored before trigger_kind distinguished
  // bridge_command / bridge_control_reply. Keep this intentionally narrow to
  // avoid hiding ordinary AI replies that happen to start with ✅/❌/🤖.
  private isLegacyBridgeControlMessage(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return /^\/(help|status|compact|reset|stop|verbose|livestatus|free|mute|mode|model|models|discuss|chairman|locale)(\s|$)/i.test(t)
      || this.isBridgeControlReply(t);
  }

  private isRuntimeFailureText(text: string): boolean {
    return text.startsWith("⚠️ Agent 未正常完成") || /\n原因:\s*rpc\b/.test(text);
  }

  /**
   * Is this main-run error worth auto-retrying (by resuming the session via the
   * probe loop)? Mainly transient failures — request/response timeouts and
   * aborted/incomplete runs. We do NOT auto-retry clearly terminal errors
   * (auth/permission/quota/billing/model-not-supported), which would just fail
   * again. The error text comes from collectReply's `Agent error: <msg>`.
   */
  private isRetryableAgentError(errText: string): boolean {
    const t = (errText || "").toLowerCase();
    // Terminal errors: never auto-retry.
    if (/(unauthorized|permission|forbidden|invalid api key|quota|billing|insufficient|model_not_supported|not supported|invalid_request)/.test(t)) return false;
    // Retryable: timeouts and transient interruptions.
    return /(timed out|timeout|aborted|operation was aborted|no response|request failed|temporarily|connection|econnreset|socket hang|stream)/.test(t);
  }

  /**
   * Heuristic: does this reply look truncated / mid-task? Bias toward false
   * positives (“宁可错杀不放过”) — a false positive only costs one invisible
   * confirmation round, and the session self-check is the real arbiter. We gate
   * only on cheap text shape here, never on stopReason (the upstream rarely
   * provides one for normal-looking-but-truncated finals).
   */
  /**
   * Heuristic: does this reply look genuinely truncated / cut off mid-task?
   *
   * IMPORTANT (per Stephen): only retry when there is CLEAR evidence the agent
   * did not finish — do NOT retry just because a reply lacks a trailing period.
   * Many complete replies legitimately end without sentence punctuation (a terse
   * “好的”, a bullet list, a path, a number, a closing word). Treating those as
   * truncated caused needless extra probe rounds, which hurts UX. So we gate on
   * strong structural signals only:
   *   1. Unbalanced code fence — almost certainly cut off mid code block.
   *   2. Ends with a dangling connector / lead-in (“然后”, “接下来”, “let me”…)
   *      or a trailing clause-joining punctuation (comma/colon/semicolon),
   *      which means a sentence was left hanging.
   *   3. Ends mid-word inside a Latin word right after a connector-less clause
   *      (very rare; only when the last “word” is unusually long), kept minimal.
   * A plain “no sentence-ending punctuation” is deliberately NOT sufficient.
   */
  private looksTruncated(text: string): boolean {
    const t = (text || "").trim();
    if (!t) return false; // empty/NO_REPLY handled elsewhere
    // (1) Unbalanced code fence => almost certainly cut off mid-block.
    const fences = (t.match(/```/g) || []).length;
    if (fences % 2 === 1) return true;
    // (2a) Trailing clause-joining punctuation: a sentence was left hanging.
    if (/[，,：:、;；]\s*$/u.test(t)) return true;
    // (2b) Ends on an explicit continuation cue / lead-in.
    if (/(接下来|然后|首先|现在我|让我|下一步|我先|我来|我接着|接着|稍等|let me|now i|next|first|\b(?:and|then|so|to|the|a)\b)\s*$/iu.test(t)) return true;
    return false;
  }

  /** Current context usage percent for a session (totalTokens / contextTokens),
   *  or 0 if it cannot be determined. Same basis as /status. */
  private async getContextUsagePercent(sessionKey: string): Promise<number> {
    try {
      const resp = await this.openclawClient.getSessionInfo(sessionKey);
      const s = resp?.session;
      const total = s?.totalTokens || 0;
      const ctx = s?.contextTokens || 0;
      return ctx > 0 ? Math.round((total / ctx) * 100) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * After a reply is delivered, alert the user once if context usage crossed the
   * threshold (default 80%), so they can compact before a session bloats into the
   * timeout/lock/overflow failure modes. We only alert on a fresh crossing: once
   * alerted we stay quiet until usage drops back below the threshold (e.g. after
   * a compact), then re-arm.
   */
  private async maybeAlertHighContext(chatId: string): Promise<void> {
    const threshold = contextAlertPct();
    if (threshold <= 0) return;
    try {
      const sessionKey = this.getSessionKey(chatId);
      const pct = await this.getContextUsagePercent(sessionKey);
      if (pct <= 0) return;
      const alerted = this.contextAlerted.get(chatId) || false;
      if (pct >= threshold) {
        if (alerted) return; // already warned this cycle
        this.contextAlerted.set(chatId, true);
        const en = this.isEn(chatId);
        const text = en
          ? `\u26a0\ufe0f Context is at ${pct}% (\u2265${threshold}%). Consider /compact soon to avoid timeouts/overflow.`
          : `\u26a0\ufe0f \u4e0a\u4e0b\u6587\u5df2\u8fbe ${pct}%\uff08\u2265${threshold}%\uff09\uff0c\u5efa\u8bae\u5c3d\u5feb /compact \u538b\u7f29\uff0c\u907f\u514d\u8d85\u65f6/\u7206\u4e0a\u4e0b\u6587\u3002`;
        await this.sendMessage(chatId, text).catch(() => {});
      } else if (pct < threshold - 5) {
        // Re-arm once usage clearly dropped (hysteresis to avoid flapping).
        this.contextAlerted.set(chatId, false);
      }
    } catch {
      // best-effort; never block delivery
    }
  }

  /** True when the agent's reply is exactly a completion phrase (zh or en,
   *  tolerant of trailing punctuation/whitespace and case). */
  /**
   * True when the agent's reply means “done”. We accept the exact phrase as well
   * as common wrappers (“已经结束了” / “好的，结束了” / “yes, DONE”), but reject it
   * when a negation/not-finished cue is present (“还没结束” / “not done”), so a
   * “still working” answer never counts as completion.
   */
  private isDonePhrase(text: string): boolean {
    const raw = (text || "").trim();
    if (!raw) return false;
    // Short replies only — a long continuation is the model working, not confirming.
    if (raw.length > 24) return false;
    const stripped = raw.replace(/[。.!！~～\s“”"'，,]+/gu, "");
    const zh = AUTO_RETRY_DONE_PHRASE; // e.g. 结束了
    const en = AUTO_RETRY_DONE_PHRASE_EN.toUpperCase(); // e.g. DONE
    const hasDone = stripped.includes(zh) || stripped.toUpperCase().includes(en);
    if (!hasDone) return false;
    // Reject if a not-finished / negation cue is present.
    if (/(没|未|不|还在|继续|not|isn'?t|aren'?t|no[t\s])/iu.test(raw)) return false;
    return true;
  }

  /**
   * Auto-retry loop: if `reply` looks truncated, ask the same session whether it
   * finished. The session is the arbiter: if it replies exactly the done phrase,
   * the ORIGINAL reply was the real result and we deliver that. Otherwise the
   * session kept working and its new output becomes the latest reply, which we
   * re-check. Loops until the session confirms completion, a reply no longer
   * looks truncated, the budget is spent, or the session cannot answer.
   */
  private async autoRetryUntilComplete(params: {
    chatId: string;
    sessionKey: string;
    senderName: string;
    triggerId: number;
    lastHumanMessageId: string;
    isNativeCommandTrigger: boolean;
    initialReply?: string;
    /** When set, the main run failed with this (recoverable) error instead of
     *  returning a reply; start the probe loop immediately to let the session
     *  resume from where it was interrupted (e.g. a request timeout). */
    initialError?: string;
    liveStatus?: LiveStatusController;
  }): Promise<string> {
    const { chatId, sessionKey, senderName, triggerId, lastHumanMessageId, isNativeCommandTrigger, liveStatus } = params;
    let reply = params.initialReply ?? "";
    // Whether we still owe at least one probe regardless of how `reply` looks.
    // The timeout path starts in this state (no reply to inspect yet).
    let forceProbe = params.initialError !== undefined && !params.initialReply;
    if (!autoRetryEnabled() || isNativeCommandTrigger) {
      if (forceProbe) throw new Error(`Agent error: ${params.initialError}`);
      return reply;
    }

    const maxRetry = autoRetryMax();
    let compacted = false; // auto-compact at most once per auto-retry round
    let probedAtLeastOnce = false;
    // Snapshot the stop generation at entry. If the user runs /stop while this
    // loop is in flight, handleStopCommand bumps the epoch; we detect the change
    // and stop retrying immediately instead of issuing more probes.
    const startStopEpoch = this.stopEpoch.get(chatId) || 0;
    const wasStopped = () => (this.stopEpoch.get(chatId) || 0) !== startStopEpoch;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      // /stop while we were looping: abandon retries and deliver what we have.
      if (wasStopped()) {
        console.log(`[${this.config.name}] auto-retry: aborted by /stop for ${chatId.slice(-8)}`);
        if (!reply) throw new Error(`Agent error: ${params.initialError || "stopped by user"}`);
        return reply;
      }
      if (!forceProbe) {
        const parsed = this.extractBridgeAttachments(reply);
        const trimmed = parsed.text.trim();
        // Hard rule: a reply that produced attachments (image/file/doc) is a
        // finished product — never auto-retry it (and never risk dropping the
        // bridge attachment marker by replacing `reply` with a probe answer).
        if (parsed.attachments.length > 0) return reply;
        // Only engage for plausibly-successful-but-truncated text. Empty/NO_REPLY
        // and runtime failures have their own handling upstream.
        if (!trimmed || trimmed.toUpperCase() === "NO_REPLY" || this.isRuntimeFailureText(trimmed)) return reply;
        if (!this.looksTruncated(trimmed)) return reply;
      }
      forceProbe = false; // consumed; subsequent rounds inspect the probe reply

      const en = this.isEn(chatId);
      await liveStatus?.progress(en
        ? `⚠️ Reply looks incomplete — auto-checking (${attempt}/${maxRetry})…`
        : `⚠️ 疑似任务未完成，正在自动重试（${attempt}/${maxRetry}）…`).catch(() => {});

      // One short line, in the user's own voice (we intentionally do not change
      // senderName). Each locale uses its own done-phrase so the English probe
      // stays fully English; detection accepts both phrases.
      const probe = en
        ? `Is that done? If so just reply "${AUTO_RETRY_DONE_PHRASE_EN}", otherwise keep going.`
        : `刚才那个任务结束了吗？结束了就回我“${AUTO_RETRY_DONE_PHRASE}”，没结束就接着做。`;

      let probeReply: string;
      try {
        probeReply = await this.withSessionHealthMonitor(chatId, lastHumanMessageId, triggerId, this.openclawClient.chatSendWithContext({
          sessionKey,
          unsyncedMessages: [],
          currentMessage: probe,
          currentSenderName: senderName,
          deliver: false,
          timeoutMs: 1_800_000,
          includeContext: false,
          includeBridgeAttachmentHint: false,
          onProgress: (event) => liveStatus?.progress(event),
        }));
        probedAtLeastOnce = true;
      } catch (err) {
        // Confirmation round failed (timeout/unhealthy). If the session is heavy
        // (≥ threshold) and we have not compacted yet this round, auto-compact and
        // keep retrying — a bloated session is the usual cause of these timeouts.
        // Otherwise stop looping.
        console.warn(`[${this.config.name}] auto-retry probe failed for ${chatId.slice(-8)}:`, this.errorSummary(err));
        if (!compacted) {
          const pct = await this.getContextUsagePercent(sessionKey);
          if (pct >= autoRetryCompactPct()) {
            const en = this.isEn(chatId);
            await liveStatus?.progress(en
              ? `🧹 Context is large (${pct}%) and the retry failed — auto-compacting…`
              : `🧹 上下文过大（${pct}%）且重试出错，正在自动压缩…`).catch(() => {});
            try {
              const r = await this.compactWithFallback(sessionKey);
              compacted = true; // mark as attempted regardless, to avoid re-compacting in a loop
              if (r.compacted) {
                console.log(`[${this.config.name}] auto-retry: compacted session (${r.method}${r.detail ? " " + r.detail : ""}) at ${pct}% for ${chatId.slice(-8)}; continuing`);
                forceProbe = !reply; // if we still have no reply (timeout path), keep probing
                continue; // retry the probe on the now-lighter session
              }
              // Compact was a no-op; do not spin.
              console.warn(`[${this.config.name}] auto-retry: compact was a no-op for ${chatId.slice(-8)} (${r.reason || "no reason"})`);
            } catch (compactErr) {
              console.warn(`[${this.config.name}] auto-retry compact failed for ${chatId.slice(-8)}:`, this.errorSummary(compactErr));
            }
          }
        }
        // No reply to fall back to (timeout path) and retries exhausted/failed:
        // re-throw so the caller surfaces the original failure.
        if (!reply) throw (err instanceof Error ? err : new Error(`Agent error: ${params.initialError || "retry failed"}`));
        return reply;
      }

      const probeText = this.extractBridgeAttachments(probeReply).text.trim();
      // /stop landed while the probe was in flight: stop here rather than loop
      // again. Deliver the latest meaningful output we have.
      if (wasStopped()) {
        console.log(`[${this.config.name}] auto-retry: aborted by /stop mid-probe for ${chatId.slice(-8)}`);
        const latest = probeText && probeText.toUpperCase() !== "NO_REPLY" ? probeReply : reply;
        if (!latest) throw new Error(`Agent error: ${params.initialError || "stopped by user"}`);
        return latest;
      }
      if (!probeText || probeText.toUpperCase() === "NO_REPLY") {
        if (!reply) throw new Error(`Agent error: ${params.initialError || "no reply after retry"}`);
        return reply; // session could not answer; deliver existing result
      }
      if (this.isDonePhrase(probeText)) {
        console.log(`[${this.config.name}] auto-retry: session confirmed done after ${attempt} check(s) for ${chatId.slice(-8)}`);
        // On the timeout path we have no original reply; the done confirmation
        // means the interrupted work actually finished — but we have nothing
        // user-visible to deliver, so treat it as NO_REPLY rather than fabricate.
        return reply || "NO_REPLY";
      }
      // Not done: the session kept working. Its output is the new latest reply.
      console.log(`[${this.config.name}] auto-retry: session continued (attempt ${attempt}) for ${chatId.slice(-8)}`);
      reply = probeReply;
    }
    console.warn(`[${this.config.name}] auto-retry budget (${maxRetry}) spent for ${chatId.slice(-8)}; delivering latest result`);
    void probedAtLeastOnce;
    if (!reply) throw new Error(`Agent error: ${params.initialError || "retry budget exhausted"}`);
    return reply;
  }

  private cancelDelayedFailure(chatId: string): void {
    const timer = this.delayedFailureTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.delayedFailureTimers.delete(chatId);
  }

  private setActiveDeliveryTarget(chatId: string, triggerId: number, messageId: string): () => void {
    const existing = this.activeDeliveryTargets.get(chatId);
    if (existing?.timer) clearTimeout(existing.timer);
    const token = Symbol(`${chatId}:${triggerId}`);
    this.activeDeliveryTargets.set(chatId, { triggerId, messageId, token });
    return () => {
      const timer = setTimeout(() => {
        const current = this.activeDeliveryTargets.get(chatId);
        if (current?.token === token) this.activeDeliveryTargets.delete(chatId);
      }, 60_000);
      const current = this.activeDeliveryTargets.get(chatId);
      if (current?.token === token) current.timer = timer;
    };
  }

  private scheduleDelayedFailure(chatId: string, replyToMessageId: string, text: string, triggerId: number): void {
    const lastRealDelivery = this.lastRealDeliveryAt.get(chatId) || 0;
    if (Date.now() - lastRealDelivery < 90_000) {
      console.log(`[${this.config.name}] Suppressed delayed runtime failure for ${chatId.slice(-8)} because a real reply was delivered recently`);
      return;
    }
    this.cancelDelayedFailure(chatId);
    const timer = setTimeout(() => {
      this.delayedFailureTimers.delete(chatId);
      void this.enqueueAndDispatchDelivery(chatId, "delayed_error", `trigger:${triggerId}:delayed-error`, text, [], replyToMessageId, `trigger:${triggerId}:delayed-error`)
        .then(() => {
          if (triggerId) this.store.markDeliveredReply(this.config.name, chatId, triggerId, replyToMessageId);
        })
        .catch((err) => {
          console.warn(`[${this.config.name}] delayed failure delivery failed:`, (err as Error).message);
        });
    }, 60_000);
    this.delayedFailureTimers.set(chatId, timer);
  }

  private deliverySessionKey(chatId: string): string {
    return this.getSessionKey(chatId);
  }

  private stableHash(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  private deliverySourceId(kind: string, text: string): string {
    return `${kind}:${this.stableHash(text)}`;
  }

  private async sendSystemDelivery(chatId: string, text: string): Promise<void> {
    const sourceId = `discussion-system:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await this.enqueueAndDispatchDelivery(chatId, "discussion_system", sourceId, text);
  }

  private async enqueueAndDispatchDelivery(chatId: string, sourceType: string, sourceId: string, text: string, attachments: BridgeAttachment[] = [], replyToMessageId?: string, deliveryKey?: string): Promise<void> {
    if (!text.trim() && attachments.length === 0) return;
    const attachmentsJson = JSON.stringify(attachments);
    const normalizedPayload = `${text.trim()}|${attachmentsJson}`;
    const contentHash = this.stableHash(normalizedPayload);
    const finalDeliveryKey = deliveryKey || sourceId;
    if (sourceType === "verbose_transcript") {
      if (this.store.hasRecentSimilarDelivery(this.config.name, chatId, contentHash, 60_000, ["verbose_transcript"])) return;
      if (this.store.hasRecentOverlappingDelivery(this.config.name, chatId, text, attachmentsJson, 60_000, 8, ["verbose_transcript"])) return;
    } else if (!deliveryKey) {
      if (this.store.hasRecentSimilarDelivery(this.config.name, chatId, contentHash, 60_000, [sourceType])) return;
      if (this.store.hasRecentOverlappingDelivery(this.config.name, chatId, text, attachmentsJson, 60_000, 8, [sourceType])) return;
    }
    const deliveryId = this.store.enqueueDelivery({
      sessionKey: this.deliverySessionKey(chatId),
      chatId,
      botName: this.config.name,
      sourceType,
      sourceId,
      deliveryKey: finalDeliveryKey,
      contentHash,
      content: text,
      attachmentsJson,
      replyToMessageId: replyToMessageId || "",
    });
    if (deliveryId === null) return;
    await this.dispatchPendingDeliveries(chatId, replyToMessageId);
    if (sourceType === "assistant_visible" && (text.trim() || attachments.length > 0) && text.trim().toUpperCase() !== "NO_REPLY" && !this.isRuntimeFailureText(text.trim())) {
      this.lastRealDeliveryAt.set(chatId, Date.now());
    }
  }

  private async dispatchPendingDeliveries(chatId: string, replyToMessageId?: string): Promise<void> {
    const pending = this.store.getPendingDeliveries(chatId, this.config.name, 50);
    for (const item of pending) {
      await this.sendOrdered(chatId, async () => {
        try {
          if (!item.id || !this.store.claimDelivery(item.id)) return;
          const attachments = JSON.parse(item.attachmentsJson || "[]") as BridgeAttachment[];
          if (item.content.trim()) {
            const replyTarget = item.replyToMessageId || replyToMessageId;
            const shouldReplyToSource = replyTarget && (item.sourceType === "assistant_visible" || item.sourceType === "verbose_transcript" || item.sourceType === "provider_error" || item.sourceType === "delayed_error");
            if (shouldReplyToSource) {
              try {
                await this.replyMessage(replyTarget, item.content);
              } catch (err) {
                console.warn(`[${this.config.name}] replyMessage failed, fallback to sendMessage:`, (err as Error).message);
                await this.sendMessage(chatId, item.content);
              }
            } else {
              await this.sendMessage(chatId, item.content);
            }
          }
          for (const attachment of attachments) await this.sendBridgeAttachment(chatId, attachment);
          if (item.id) this.store.markDeliveryDelivered(item.id);
        } catch (err) {
          if (this.isOutOfChatError(err)) this.markCurrentBotUnavailable(chatId, err);
          if (item.id) this.store.markDeliveryFailed(item.id);
          const errorText = `⚠️ 附件发送失败：${this.errorSummary(err)}`;
          const replyTarget = item.replyToMessageId || replyToMessageId;
          try {
            if (replyTarget) await this.replyMessage(replyTarget, errorText);
            else await this.sendMessage(chatId, errorText);
          } catch (notifyErr) {
            console.warn(`[${this.config.name}] Failed to notify attachment delivery error:`, this.errorSummary(notifyErr));
          }
          throw err;
        }
      });
    }
  }


  private hasFreeModeBot(chatId: string): boolean {
    return Array.from(FeishuBot.allBots.values())
      .some((bot) => bot.store === this.store && bot.store.getBotMode(bot.config.name, chatId) === "free");
  }

  private mentionedBotNames(mentions: any[]): string[] {
    const names = mentions
      .map((mention: any) => this.mentionedBotName(mention))
      .filter((name: string | null): name is string => Boolean(name));
    return Array.from(new Set(names));
  }

  private mentionedBotNamesFromChairmanText(...texts: string[]): string[] {
    const normalizedTexts = texts
      .filter(Boolean)
      .map((text) => text.replace(/^\s*\/chairman\b/i, "").trim())
      .filter(Boolean)
      .map((text) => text.replace(/^@+/, "").replace(/\s+/g, "").toLowerCase());
    if (normalizedTexts.length === 0) return [];
    const names: string[] = [];
    const candidates = [this, ...Array.from(FeishuBot.allBots.values()).filter((bot) => bot !== this && bot.store === this.store)];
    for (const raw of normalizedTexts) {
      for (const bot of candidates) {
        const botName = bot.config.name.trim().replace(/\s+/g, "").toLowerCase();
        const displayNames = [
          botName,
          `@${botName}`,
          `万万（${botName}）`,
          `@万万（${botName}）`,
          `万万(${botName})`,
          `@万万(${botName})`,
        ];
        if (displayNames.includes(raw) || new RegExp(`^@?[^()（）]+[（(]${this.escapeRegExp(botName)}[）)]$`, "i").test(raw)) {
          names.push(bot.config.name);
        }
      }
    }
    return Array.from(new Set(names));
  }

  /**
   * Resolve the target bot name(s) for a /chairman command using every signal
   * available, in priority order:
   *   1. Feishu mention metadata (app_id / open_id / name).
   *   2. Text fallback: "@Bot" or "Bot" written in the message body.
   *
   * This keeps /chairman working even when a Feishu client or bridge omits
   * mention metadata. Returns a de-duplicated, order-preserving list.
   */
  private resolveChairmanTargets(mentions: any[], text: string, rawText = ""): string[] {
    const fromMeta = this.mentionedBotNames(mentions);
    if (fromMeta.length > 0) return fromMeta;
    return this.mentionedBotNamesFromChairmanText(text, rawText);
  }

  private isDiscussionCoordinator(): boolean {
    const bots = Array.from(FeishuBot.allBots.values()).filter((bot) => bot.store === this.store);
    if (bots.length === 0) return true;
    return bots[0] === this;
  }


  private static markBotSeenInChat(botName: string, chatId: string): void {
    let set = FeishuBot.seenBotChats.get(botName);
    if (!set) {
      set = new Set<string>();
      FeishuBot.seenBotChats.set(botName, set);
    }
    set.add(chatId);
  }

  private markCurrentBotSeenInChat(chatId: string): void {
    FeishuBot.markBotSeenInChat(this.config.name, chatId);
    this.store.markBotSeenInChat(this.config.name, chatId);
  }

  private isBotAvailableInChat(bot: FeishuBot, chatId: string): boolean {
    // A bot can be globally configured but not actually installed in this Feishu
    // group. Discuss participants must be restricted to bots that either have
    // received an event in this chat during this process, or have previously
    // delivered a message successfully in this chat. Otherwise LMA may generate
    // "ghost" participants and Feishu will reject delivery with 230002
    // (Bot/User can NOT be out of the chat).
    if (this.store.isBotUnavailableInChat(bot.config.name, chatId)) return false;
    return FeishuBot.seenBotChats.get(bot.config.name)?.has(chatId)
      || this.store.hasBotSeenInChat(bot.config.name, chatId)
      || this.store.hasAnyDeliveredToChat(bot.config.name, chatId);
  }

  private getDiscussionParticipants(chatId: string): DiscussionParticipant[] {
    const chairman = this.store.getChairmanBot(chatId);
    return Array.from(FeishuBot.allBots.values())
      .filter((bot) => bot.store === this.store && bot.config.name !== chairman && bot.store.getBotMode(bot.config.name, chatId) !== "mute" && this.isBotAvailableInChat(bot, chatId))
      .map((bot) => this.asDiscussionParticipant(bot, chatId));
  }

  private getChairmanParticipant(chatId: string): DiscussionParticipant | undefined {
    const chairman = this.store.getChairmanBot(chatId);
    if (!chairman) return undefined;
    const bot = Array.from(FeishuBot.allBots.values()).find((candidate) => candidate.store === this.store && candidate.config.name === chairman && this.isBotAvailableInChat(candidate, chatId));
    return bot ? this.asDiscussionParticipant(bot, chatId) : undefined;
  }

  private asDiscussionParticipant(bot: FeishuBot, chatId: string): DiscussionParticipant {
    return {
      name: bot.config.name,
      runDiscussionTurn: async (_chatId: string, prompt: string, meta?: { round: number; maxRounds: number }) => bot.runDiscussionTurn(chatId, prompt, meta),
    };
  }

  private async runDiscussionTurn(chatId: string, prompt: string, meta?: { round: number; maxRounds: number }): Promise<ReplyResult> {
    const sessionKey = await this.ensureSession(chatId);
    const releaseProactiveMute = this.openclawClient.muteProactiveDelivery(sessionKey);
    const liveStatusEnabled = this.store.getBotLiveStatus(this.config.name, chatId) && !this.store.getBotVerbose(this.config.name, chatId);
    const liveStatus = liveStatusEnabled
      ? new LiveStatusController({
          create: (view) => this.sendOrdered(chatId, () => this.sendLiveStatusCard(chatId, view)),
          edit: (messageId, view) => this.sendOrdered(chatId, () => this.patchLiveStatusCard(messageId, view, chatId)),
          warn: (message, err) => console.warn(`[${this.config.name}] ${message}:`, err instanceof Error ? err.message : err),
        }, {
          botName: this.config.name,
          model: this.config.model,
          locale: this.isEn(chatId) ? "en" : "zh",
        })
      : undefined;
    liveStatus?.start(meta ? `第 ${meta.round}/${meta.maxRounds} 轮讨论` : "讨论中");
    let reply: string;
    try {
      reply = await this.openclawClient.chatSendWithContext({
        sessionKey,
        unsyncedMessages: [],
        currentMessage: prompt,
        currentSenderName: "Discussion Scheduler",
        deliver: false,
        timeoutMs: 1_800_000,
        emptyFinalAsNoReply: true,
        onProgress: (event) => { void liveStatus?.progress(event).catch((err) => console.warn(`[${this.config.name}] live status progress failed:`, err instanceof Error ? err.message : err)); },
      });
    } catch (err) {
      await liveStatus?.fail().catch(() => {});
      throw err;
    } finally {
      // OpenClaw can emit the final assistant session.message shortly after
      // chatSend/collectReply returns. Keep discussion proactive muted briefly;
      // the discussion coordinator already owns user-visible delivery.
      releaseProactiveMute(120_000);
    }
    const parsedReply = this.extractBridgeAttachments(reply);
    const rawVisibleReply = parsedReply.text.trim();
    const discussionMarkerPattern = /\n*—— 第 \d+\/\d+ 轮 · .+$/;
    const cleanVisibleReply = rawVisibleReply.replace(discussionMarkerPattern, "").trim();
    const userVisibleReply = cleanVisibleReply
      .replace(/(^|\n)\s*(FINAL_SUMMARY|CHAIRMAN_NOTE)\s*[:：]\s*/gi, "$1")
      .replace(/(^|\n)\s*最终总结\s*[:：]\s*/g, "$1")
      .trim();
    let displayReply = userVisibleReply;
    const isVisible = userVisibleReply.length > 0 && userVisibleReply.toUpperCase() !== "NO_REPLY";
    if (isVisible && meta) {
      const roundMarker = `—— 第 ${meta.round}/${meta.maxRounds} 轮 · ${this.config.name}`;
      displayReply = `${displayReply}\n\n${roundMarker}`;
    }
    if (isVisible || parsedReply.attachments.length > 0) {
      const storedContent = [displayReply, ...parsedReply.attachments.map((a: BridgeAttachment) => `[Attachment: ${a.type || "file"} ${a.path}]`)]
        .filter(Boolean)
        .join("\n");
      this.store.insert({
        chatId,
        messageId: `self-${this.config.name}-discuss-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        senderType: "bot",
        senderName: this.config.name,
        content: storedContent,
        timestamp: Date.now(),
      });
      try {
        await this.enqueueAndDispatchDelivery(chatId, "discussion", `discussion:${Date.now()}:${Math.random().toString(36).slice(2)}`, isVisible ? displayReply : "", parsedReply.attachments);
      } catch (err) {
        await liveStatus?.fail().catch(() => {});
        throw err;
      }
    }
    // Mirror the normal path: a NO_REPLY/empty discussion turn should finish the
    // status card with a "no content" summary, not a plain done summary.
    if (!isVisible && parsedReply.attachments.length === 0) {
      await liveStatus?.noReply().catch(() => {});
    } else {
      await liveStatus?.complete().catch(() => {});
    }
    return { botName: this.config.name, text: cleanVisibleReply, visible: isVisible };
  }

  private buildLiveStatusCard(view: LiveStatusView, chatId?: string): any {
    const en = this.isEn(chatId);
    // Clean finish (done / NO_REPLY): keep it minimal — no header, no footer, just
    // one compact grey line (status emoji + tool-call count + total elapsed) so
    // the finished card does not take up much screen space.
    if (view.state === "done") {
      const statusEmoji = view.noReply ? "💤" : "✅";
      const summary = en
        ? `${statusEmoji} ${view.toolCalls} tool call${view.toolCalls === 1 ? "" : "s"} · ⏱ ${view.elapsed}`
        : `${statusEmoji} 累计${view.toolCalls} 次工具调用 · ⏱ 耗时${view.elapsed}`;
      return {
        schema: "2.0",
        config: { update_multi: true, width_mode: "fill" },
        body: { elements: [{ tag: "markdown", content: `<font color='grey'>${summary}</font>` }] },
      };
    }
    const elements: any[] = [];
    // Running OR failed: show the recent activity window (each line prefixed with
    // the relative time mm:ss). On failure we deliberately KEEP the last lines so
    // the steps leading up to the error/kill/timeout are visible for debugging.
    if (view.lines.length > 0) {
      const iconFor = (kind: string): string =>
        kind === "tool_start" ? "▸"
        : kind === "tool_end" ? "✓"
        : kind === "lifecycle" ? "⋯"
        : kind === "summary" ? "📊"
        : "•";
      const fmtAt = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      const content = view.lines
        .map((l) => {
          const stamp = l.kind === "summary" ? "" : `\`${fmtAt(l.at)}\` `;
          return `${stamp}${iconFor(l.kind)} ${this.escapeCardText(l.text)}`;
        })
        .join("\n");
      elements.push({ tag: "markdown", content });
    } else {
      elements.push({ tag: "markdown", content: en ? "_working…_" : "_正在启动…_" });
    }
    elements.push({ tag: "hr" });
    // Footer: elapsed time + model name.
    const footerBits: string[] = [];
    footerBits.push(en ? `⏱ ${view.elapsed}` : `⏱ 已用 ${view.elapsed}`);
    if (view.model) footerBits.push(`🧠 ${this.escapeCardText(view.model)}`);
    elements.push({ tag: "markdown", content: `<font color='grey'>${footerBits.join("  ·  ")}</font>` });
    const template = view.state === "failed" ? "orange" : "blue";
    return {
      schema: "2.0",
      // update_multi is REQUIRED for im.message.patch to update the card; Feishu
      // rejects patches on cards that did not declare it before and after.
      config: { update_multi: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: view.title },
        template,
      },
      body: { elements },
    };
  }

  /** Minimal escaping so activity text does not break card markdown. */
  private escapeCardText(text: string): string {
    return String(text || "").replace(/</g, "\uff1c").replace(/>/g, "\uff1e");
  }

  private async sendLiveStatusCard(chatId: string, view: LiveStatusView): Promise<string | undefined> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(this.buildLiveStatusCard(view, chatId)),
          msg_type: "interactive",
        },
      });
      this.store.clearBotUnavailableInChat(this.config.name, chatId);
      return (res as any)?.data?.message_id || (res as any)?.message_id;
    } catch (err) {
      if (this.isOutOfChatError(err)) this.markCurrentBotUnavailable(chatId, err);
      throw err;
    }
  }

  private async replyLiveStatusCard(messageId: string, view: LiveStatusView, chatId?: string): Promise<string | undefined> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(this.buildLiveStatusCard(view, chatId)),
        msg_type: "interactive",
      },
    } as any);
    return (res as any)?.data?.message_id || (res as any)?.message_id;
  }

  private async patchLiveStatusCard(messageId: string, view: LiveStatusView, chatId?: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(this.buildLiveStatusCard(view, chatId)) },
    } as any);
  }

  /**
   * Render the /compact progress card. While running it shows a phase line plus a
   * ticking elapsed footer so the user can see compaction is in progress; when
   * terminal it collapses to a single compact line (success/skip/fail).
   */
  private buildCompactProgressCard(view: CompactProgressView, chatId?: string): any {
    const en = this.isEn(chatId);
    if (view.state !== "running") {
      let line: string;
      if (view.state === "done") {
        line = en
          ? `✅ Session compacted${view.detail ? ` (${view.detail})` : ""} · ⏱ ${view.elapsed}`
          : `✅ Session 已压缩${view.detail ? `（${view.detail}）` : ""} · ⏱ 耗时 ${view.elapsed}`;
      } else if (view.state === "noop") {
        line = en
          ? `ℹ️ Session not compacted${view.detail ? ` (${view.detail})` : ""}`
          : `ℹ️ Session 未压缩${view.detail ? `（${view.detail}）` : ""}`;
      } else {
        line = en
          ? `❌ Compact failed${view.detail ? `: ${view.detail}` : ""}`
          : `❌ 压缩失败${view.detail ? `：${view.detail}` : ""}`;
      }
      return {
        schema: "2.0",
        config: { update_multi: true, width_mode: "fill" },
        body: { elements: [{ tag: "markdown", content: `<font color='grey'>${this.escapeCardText(line)}</font>` }] },
      };
    }
    // Running: phase line + ticking elapsed footer.
    const phaseLine = view.phase === "tool-trim"
      ? (en ? "🧹 Native compaction is slow — switching to fast trim…" : "🧹 原生压缩较慢，已切换快速压缩…")
      : (en ? "🧹 Compacting session…" : "🧹 正在压缩 session…");
    const footer = en ? `⏱ ${view.elapsed}` : `⏱ 已用 ${view.elapsed}`;
    return {
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: {
        title: { tag: "plain_text", content: en ? "Compacting" : "正在压缩" },
        template: "blue",
      },
      body: {
        elements: [
          { tag: "markdown", content: this.escapeCardText(phaseLine) },
          { tag: "hr" },
          { tag: "markdown", content: `<font color='grey'>${footer}</font>` },
        ],
      },
    };
  }

  private async replyCompactCard(messageId: string, view: CompactProgressView, chatId?: string): Promise<string | undefined> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(this.buildCompactProgressCard(view, chatId)),
        msg_type: "interactive",
      },
    } as any);
    return (res as any)?.data?.message_id || (res as any)?.message_id;
  }

  private async patchCompactCard(messageId: string, view: CompactProgressView, chatId?: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(this.buildCompactProgressCard(view, chatId)) },
    } as any);
  }

  private async sendTextMessage(chatId: string, text: string): Promise<string | undefined> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      this.store.clearBotUnavailableInChat(this.config.name, chatId);
      return (res as any)?.data?.message_id || (res as any)?.message_id;
    } catch (err) {
      if (this.isOutOfChatError(err)) this.markCurrentBotUnavailable(chatId, err);
      throw err;
    }
  }

  private async replyTextMessage(messageId: string, text: string): Promise<string | undefined> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
    return (res as any)?.data?.message_id || (res as any)?.message_id;
  }

  private async editTextMessage(messageId: string, text: string): Promise<void> {
    await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  private async deleteMessageById(messageId: string): Promise<void> {
    await this.client.im.v1.message.delete({ path: { message_id: messageId } });
  }

  private async replyMessage(messageId: string, text: string): Promise<string | undefined> {
    // Use Feishu CardKit v2 markdown component for full Markdown rendering.
    const card = this.buildMarkdownCard(text);
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      return (res as any)?.data?.message_id || (res as any)?.message_id;
    } catch {
      // Fallback to plain text if card fails
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return (res as any)?.data?.message_id || (res as any)?.message_id;
    }
  }

  private extractBridgeAttachments(reply: string): { text: string; attachments: BridgeAttachment[] } {
    const attachments: BridgeAttachment[] = [];
    // Models occasionally corrupt the attachment marker. The opening tag is the
    // least reliable part: we have seen it lose the "<LMA" prefix ("_BRIDGE_…"),
    // lose even more ("RIDGE_ATTACHMENTS>"), or drop entirely. The closing tag is
    // far more reliably emitted. So instead of enumerating opening-tag shapes,
    // anchor on the closer and recover the JSON payload by brace-balancing
    // backwards from it — robust no matter how many leading chars are dropped.
    let text = reply;
    let guard = 0;
    for (;;) {
      if (guard++ > 50) break; // safety: never loop unbounded on pathological input
      const found = this.findBridgeAttachmentMarker(text);
      if (!found) break;
      const { start, end, json } = found;
      let consumed = false;
      try {
        const parsed = JSON.parse(json);
        const rawAttachments = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.attachments) ? parsed.attachments : [parsed];
        const before = attachments.length;
        for (const item of rawAttachments) this.pushBridgeAttachment(attachments, item);
        // Only strip the span if it actually yielded at least one attachment;
        // otherwise leave the text alone rather than eat unrelated content.
        consumed = attachments.length > before;
      } catch (err) {
        console.warn(`[${this.config.name}] Failed to parse bridge attachment marker:`, (err as Error).message);
      }
      if (consumed) {
        text = (text.slice(0, start) + text.slice(end)).replace(/[^\S\n]+\n/g, "\n");
      } else {
        // Could not use this span; blank it out so we do not re-find it forever,
        // but keep scanning in case another valid marker exists earlier.
        text = text.slice(0, start) + text.slice(end);
      }
    }
    text = text.trim();

    // Compatibility fallback for agents that use OpenClaw's channel directive
    // syntax instead of the LMA marker. In Feishu/LMA, leaving MEDIA:<path> in
    // plain text only shows the path, so parse it into bridge attachments.
    const mediaDirectivePattern = /^\s*MEDIA:(.+)$/gm;
    text = text.replace(mediaDirectivePattern, (_match, rawPath) => {
      const mediaPath = String(rawPath).trim();
      if (!mediaPath) return "";
      const cleanPath = mediaPath.replace(/^['\"]|['\"]$/g, "");
      attachments.push({ type: this.isImagePath(cleanPath) ? "image" : "file", path: cleanPath });
      return "";
    }).trim();
    return { text, attachments };
  }

  /**
   * Locate one bridge-attachment marker in `text` and recover its JSON payload,
   * tolerating arbitrary corruption of the OPENING tag (lost prefix, or no
   * opening tag at all). Strategy:
   *   1. Find a closing tag — the full `</LMA_BRIDGE_ATTACHMENTS>`, or a partial
   *      suffix of it (e.g. `_BRIDGE_ATTACHMENTS>`, `RIDGE_ATTACHMENTS>`), or the
   *      `</parameter>` the marker sometimes degrades into.
   *   2. From just before that closer, brace-match BACKWARDS to the start of the
   *      JSON value (`{...}` or `[...]`), so the opening marker is irrelevant.
   *   3. Return the span to strip [start,end) plus the extracted JSON string.
   * `start` extends left to swallow any leftover opening-marker remnant (so no
   * `RIDGE_ATTACHMENTS>` text leaks into the visible reply).
   */
  private findBridgeAttachmentMarker(text: string): { start: number; end: number; json: string } | null {
    // Closing-tag candidates, longest/most-specific first. We accept partial
    // suffixes of the real closing tag because the opening corruption pattern
    // (dropped leading chars) also happens to the closer.
    const closeRe = /<\/LMA_BRIDGE_ATTACHMENTS>|[A-Z_]*BRIDGE_ATTACHMENTS>\s*<\/LMA_BRIDGE_ATTACHMENTS>|<\/parameter>/g;
    // The JSON sits between an (often corrupted) opener and the closer. Find the
    // closer first, then walk back to the JSON. Prefer the canonical closer.
    const closers: Array<{ idx: number; len: number }> = [];
    const canonical = /<\/LMA_BRIDGE_ATTACHMENTS>/g;
    let m: RegExpExecArray | null;
    while ((m = canonical.exec(text))) closers.push({ idx: m.index, len: m[0].length });
    if (closers.length === 0) {
      // Degraded closer: `</parameter>` immediately after the JSON payload.
      const param = /<\/parameter>/g;
      while ((m = param.exec(text))) closers.push({ idx: m.index, len: m[0].length });
    }
    void closeRe; // (kept for documentation of accepted shapes)
    for (const c of closers) {
      const json = this.extractJsonBeforeIndex(text, c.idx);
      if (!json) continue;
      // Extend `start` left over any opening-marker remnant + surrounding space,
      // so the visible text does not keep a dangling `RIDGE_ATTACHMENTS>` etc.
      // The remnant is always some trailing SUFFIX of `<LMA_BRIDGE_ATTACHMENTS>`
      // (corruption drops leading chars), so match any such suffix.
      let start = json.start;
      const lead = text.slice(Math.max(0, start - 48), start);
      const leadMarker = this.openMarkerRemnant().exec(lead);
      if (leadMarker) start = Math.max(0, start - (lead.length - leadMarker.index));
      return { start, end: c.idx + c.len, json: json.text };
    }
    return null;
  }

  /**
   * Regex matching a trailing remnant of the opening marker `<LMA_BRIDGE_ATTACHMENTS>`
   * at the END of a string. Built from every suffix of the full marker so that
   * however many leading characters the model dropped (`_BRIDGE_ATTACHMENTS>`,
   * `RIDGE_ATTACHMENTS>`, `>` …), the leftover is fully stripped from the visible
   * text. Trailing `>` and surrounding whitespace are also consumed.
   */
  private openMarkerRemnant(): RegExp {
    const full = "<LMA_BRIDGE_ATTACHMENTS>";
    const suffixes: string[] = [];
    for (let i = 0; i < full.length; i++) suffixes.push(full.slice(i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Longest suffixes first so the regex prefers the most complete remnant.
    return new RegExp(`(?:${suffixes.join("|")})\\s*$`);
  }

  /**
   * Given the index of a closing tag, walk backwards to extract the balanced
   * JSON value (`{...}` or `[...]`) that ends just before it. Returns the JSON
   * string and its start offset, or null if no balanced value is found.
   */
  private extractJsonBeforeIndex(text: string, closeIdx: number): { text: string; start: number } | null {
    // Skip whitespace immediately before the closer.
    let end = closeIdx;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    if (end === 0) return null;
    const lastChar = text[end - 1];
    const open = lastChar === "}" ? "{" : lastChar === "]" ? "[" : null;
    if (!open) return null;
    const close = lastChar;
    // Brace-balance backwards, ignoring braces inside strings.
    let depth = 0;
    let inStr = false;
    for (let i = end - 1; i >= 0; i--) {
      const ch = text[i];
      if (inStr) {
        if (ch === '"' && text[i - 1] !== "\\") inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === close) depth++;
      else if (ch === open) {
        depth--;
        if (depth === 0) return { text: text.slice(i, end), start: i };
      }
    }
    return null;
  }

  private pushBridgeAttachment(attachments: BridgeAttachment[], item: any): void {
    if (!item || typeof item.path !== "string") return;
    attachments.push({
      type: item.type === "image" || item.type === "document" || item.type === "file" ? item.type : undefined,
      path: item.path,
      caption: typeof item.caption === "string" ? item.caption : undefined,
    });
  }

  private validateBridgeAttachmentPath(filePath: string): string {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) throw new Error(`Attachment file not found: ${resolvedPath}`);
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) throw new Error(`Attachment path is not a file: ${resolvedPath}`);
    if (stats.size <= 0) throw new Error(`Attachment file is empty: ${resolvedPath}`);
    if (stats.size > 30 * 1024 * 1024) throw new Error(`Attachment file too large (>30MB): ${resolvedPath}`);
    return resolvedPath;
  }

  private inferFeishuFileType(filePath: string): "pdf" | "doc" | "xls" | "ppt" | "stream" {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".pdf") return "pdf";
    if ([".doc", ".docx"].includes(ext)) return "doc";
    if ([".xls", ".xlsx", ".csv"].includes(ext)) return "xls";
    if ([".ppt", ".pptx"].includes(ext)) return "ppt";
    return "stream";
  }

  private isImagePath(filePath: string): boolean {
    return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extname(filePath).toLowerCase());
  }

  private errorSummary(err: any): string {
    const data = err?.response?.data || err?.data;
    const code = data?.code ? `code=${data.code} ` : "";
    const msg = data?.msg || data?.message || err?.message || String(err);
    return `${code}${msg}`.slice(0, 800);
  }

  private isOutOfChatError(err: any): boolean {
    const data = err?.response?.data || err?.data;
    const code = data?.code;
    const msg = data?.msg || data?.message || err?.message || String(err);
    return Number(code) === 230002 || /Bot\/User can NOT be out of the chat/i.test(String(msg));
  }

  private markCurrentBotUnavailable(chatId: string, err: any): void {
    this.store.markBotUnavailableInChat(this.config.name, chatId, this.errorSummary(err));
    console.warn(`[${this.config.name}] Marked unavailable in chat ${chatId.slice(-8)} after Feishu out-of-chat error`);
  }

  private stripReadOnlyDocxFields<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => this.stripReadOnlyDocxFields(item)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, any> = {};
      for (const [key, child] of Object.entries(value as Record<string, any>)) {
        if (key === "merge_info") continue;
        out[key] = this.stripReadOnlyDocxFields(child);
      }
      return out as T;
    }
    return value;
  }

  private async createFeishuDocFromMarkdown(filePath: string): Promise<{ title: string; url: string }> {
    const rawTitle = basename(filePath).replace(/\.[^.]+$/, "").trim() || "Markdown Document";
    const markdown = readFileSync(filePath, "utf8");
    const docx = (this.client as any).docx;
    const created = await docx.document.create({ data: { title: rawTitle } });
    const documentId = created?.data?.document?.document_id || created?.document?.document_id;
    const revisionId = created?.data?.document?.revision_id || created?.document?.revision_id;
    if (!documentId) throw new Error(`Feishu doc create returned no document_id for ${filePath}`);

    const converted = await docx.document.convert({ data: { content_type: "markdown", content: markdown } });
    const convertedData = converted?.data || converted;
    const blocks = this.stripReadOnlyDocxFields(convertedData?.blocks || []);
    const firstLevelBlockIds = convertedData?.first_level_block_ids || [];
    if (Array.isArray(blocks) && blocks.length > 0) {
      await docx.documentBlockDescendant.create({
        path: { document_id: documentId, block_id: documentId },
        data: {
          children_id: firstLevelBlockIds,
          descendants: blocks,
          document_revision_id: revisionId,
        },
      });
    }

    return { title: rawTitle, url: `https://www.feishu.cn/docx/${documentId}` };
  }

  private async sendBridgeAttachment(chatId: string, attachment: BridgeAttachment): Promise<void> {
    const filePath = this.validateBridgeAttachmentPath(attachment.path);
    const type = attachment.type || (this.isImagePath(filePath) ? "image" : "file");

    if (type === "document" && extname(filePath).toLowerCase() === ".md") {
      try {
        const doc = await this.createFeishuDocFromMarkdown(filePath);
        const caption = attachment.caption?.trim() || `飞书文档：${doc.title}`;
        await this.sendMessage(chatId, `${caption}\n${doc.url}`);
        return;
      } catch (err) {
        console.warn(`[${this.config.name}] Feishu doc conversion failed, falling back to file attachment:`, this.errorSummary(err));
        const caption = attachment.caption?.trim();
        await this.sendMessage(chatId, `${caption ? `${caption}\n` : ""}飞书文档创建失败，已改为 Markdown 文件附件发送。`);
        await this.sendBridgeFileAttachment(chatId, filePath);
        return;
      }
    }

    if (attachment.caption?.trim()) await this.sendMessage(chatId, attachment.caption.trim());

    if (type === "image") {
      if (statSync(filePath).size > 10 * 1024 * 1024) throw new Error(`Image too large (>10MB): ${filePath}`);
      const uploaded = await this.client.im.image.create({
        data: { image_type: "message", image: readFileSync(filePath) },
      });
      const imageKey = (uploaded as any)?.image_key || (uploaded as any)?.data?.image_key;
      if (!imageKey) throw new Error(`Feishu image upload returned no image_key for ${filePath}`);
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: "image",
        },
      });
      return;
    }

    await this.sendBridgeFileAttachment(chatId, filePath);
  }

  private async sendBridgeFileAttachment(chatId: string, filePath: string): Promise<void> {
    const uploaded = await this.client.im.file.create({
      data: {
        file_type: this.inferFeishuFileType(filePath),
        file_name: basename(filePath),
        file: readFileSync(filePath),
      },
    });
    const fileKey = (uploaded as any)?.file_key || (uploaded as any)?.data?.file_key;
    if (!fileKey) throw new Error(`Feishu file upload returned no file_key for ${filePath}`);
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: "file",
      },
    });
  }

  /**
   * Send a proactive message to a chat (not a reply).
   */
  private async sendMessage(chatId: string, text: string): Promise<string | undefined> {
    const card = this.buildMarkdownCard(text);
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      this.store.clearBotUnavailableInChat(this.config.name, chatId);
      return (res as any)?.data?.message_id || (res as any)?.message_id;
    } catch (err) {
      console.warn(`[${this.config.name}] sendMessage interactive failed:`, JSON.stringify((err as any)?.response?.data || (err as any)?.data || { message: (err as Error).message }));
      if (this.isOutOfChatError(err)) this.markCurrentBotUnavailable(chatId, err);
      // Fallback to plain text
      try {
        const res = await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: "text",
          },
        });
        this.store.clearBotUnavailableInChat(this.config.name, chatId);
        return (res as any)?.data?.message_id || (res as any)?.message_id;
      } catch (fallbackErr) {
        console.warn(`[${this.config.name}] sendMessage text failed:`, JSON.stringify((fallbackErr as any)?.response?.data || (fallbackErr as any)?.data || { message: (fallbackErr as Error).message }));
        if (this.isOutOfChatError(fallbackErr)) this.markCurrentBotUnavailable(chatId, fallbackErr);
        throw fallbackErr;
      }
    }
  }

  /**
   * Enqueue a message send to guarantee ordering per chat.
   * All sends for a chat are serialized through this.
   */
  private sendOrdered<T = void>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendQueue.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous failed
    this.sendQueue.set(chatId, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * Add a reaction (emoji) to a message.
   */
  private async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const resp = await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: emojiType },
      },
    });
    return (resp.data as any)?.reaction_id;
  }

  /**
   * Remove a reaction by emoji type from a message.
   * Finds the bot's own reaction of that type and deletes it.
   */
  private async removeReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      const resp = await this.client.im.messageReaction.list({
        path: { message_id: messageId },
        params: { reaction_type: emojiType },
      });
      const items = (resp.data as any)?.items || [];
      for (const item of items) {
        if (item.reaction_id) {
          await this.client.im.messageReaction.delete({
            path: { message_id: messageId, reaction_id: item.reaction_id },
          });
          break;
        }
      }
    } catch {
      // ignore
    }
  }


  private async handleLocaleCommand(chatId: string, chatType: string, messageId: string, text: string): Promise<void> {
    if (chatType === "p2p") {
      await this.replyMessage(messageId, "Locale is only configurable in group chats.");
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const value = (parts[1] || "").toLowerCase();
    if (!value) {
      const locale = this.chatLocale(chatId);
      await this.replyMessage(messageId, locale === "en" ? "🌐 Current locale: en" : "🌐 当前语言：zh");
      return;
    }
    if (value !== "zh" && value !== "en") {
      await this.replyMessage(messageId, "Usage: /locale zh|en");
      return;
    }
    this.store.setChatLocale(chatId, value);
    await this.replyMessage(messageId, value === "en" ? "🌐 Locale set to en" : "🌐 语言已设置为 zh");
  }

  private async handleDiscussCommand(chatId: string, chatType: string, messageId: string, text: string): Promise<void> {
    if (chatType === "p2p") {
      await this.replyMessage(messageId, "Discuss mode is only available in group chats.");
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const action = parts[1] || "status";
    if (action === "on") {
      const chairman = this.store.getChairmanBot(chatId);
      if (!chairman) {
        await this.replyMessage(messageId, this.isEn(chatId)
          ? "❌ You must set a Chairman before enabling Discuss.\nUsage: /chairman @Bot"
          : "❌ 开启 Discuss 前必须先设置 Chairman。\n用法：/chairman @某个Bot");
        return;
      }
      this.store.setDiscussMode(chatId, true);
      await this.replyMessage(messageId, this.isEn(chatId)
        ? `💬 Discuss enabled\nChairman: ${chairman}\nParticipants: all non-muted bots + Chairman; free mode is ignored in Discuss\nRounds: ${this.store.getChatInfo(chatId)?.discussMaxRounds || 10}`
        : `💬 Discuss 已开启\nChairman：${chairman}\n参与者：当前群所有非 mute bot + Chairman（Discuss 模式忽略 free 开关）\n轮数：${this.store.getChatInfo(chatId)?.discussMaxRounds || 10}`);
      return;
    }
    if (action === "off") {
      this.store.setDiscussMode(chatId, false);
      discussionManager.stop(chatId);
      await this.replyMessage(messageId, this.isEn(chatId) ? "💬 Discuss disabled" : "💬 Discuss 已关闭");
      return;
    }
    if (action === "stop") {
      const stopped = discussionManager.stop(chatId);
      await this.replyMessage(messageId, this.isEn(chatId)
        ? (stopped ? "💬 Current discuss stopped" : "💬 No active discuss")
        : (stopped ? "💬 当前 discuss 已停止" : "💬 当前没有运行中的 discuss"));
      return;
    }
    if (action === "rounds") {
      const n = Number.parseInt(parts[2] || "", 10);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        await this.replyMessage(messageId, "❌ Usage: /discuss rounds <1-10>");
        return;
      }
      this.store.setDiscussMaxRounds(chatId, n);
      await this.replyMessage(messageId, this.isEn(chatId)
        ? `💬 Discuss rounds set to ${this.store.getChatInfo(chatId)?.discussMaxRounds || n}`
        : `💬 Discuss 轮数已设置为 ${this.store.getChatInfo(chatId)?.discussMaxRounds || n}`);
      return;
    }
    const info = this.store.getChatInfo(chatId);
    const active = discussionManager.status(chatId);
    const participants = this.getDiscussionParticipants(chatId).map((p) => p.name);
    await this.replyMessage(messageId, this.isEn(chatId) ? [
      `💬 Discuss: ${info?.discuss ? "on" : "off"}`,
      `Rounds: ${info?.discussMaxRounds || 10}`,
      `Chairman: ${info?.chairmanBot || "not set"}`,
      `Participants: ${[...participants, info?.chairmanBot].filter(Boolean).length ? [...participants, info?.chairmanBot].filter(Boolean).join(", ") : "(none available)"}`,
      active ? `Active: round ${active.currentRound}/${active.maxRounds}, topic=${active.topic.slice(0, 80)}` : "Active: none",
    ].join("\n") : [
      `💬 Discuss: ${info?.discuss ? "on" : "off"}`,
      `轮数：${info?.discussMaxRounds || 10}`,
      `Chairman：${info?.chairmanBot || "未设置"}`,
      `参与者：${[...participants, info?.chairmanBot].filter(Boolean).length ? [...participants, info?.chairmanBot].filter(Boolean).join(", ") : "（无可参与者）"}`,
      active ? `运行中：第 ${active.currentRound}/${active.maxRounds} 轮，topic=${active.topic.slice(0, 80)}` : "运行中：无",
    ].join("\n"));
  }

  private async handleChairmanCommand(chatId: string, chatType: string, messageId: string, mentions: any[], text: string, rawText = ""): Promise<void> {
    if (chatType === "p2p") {
      await this.replyMessage(messageId, "❌ Chairman 只在群聊中可用");
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const action = (parts[1] || "").toLowerCase();
    if (["off", "clear", "none"].includes(action)) {
      const previous = this.store.getChairmanBot(chatId);
      this.store.clearChairmanBot(chatId);
      await this.replyMessage(messageId, previous ? `✅ 已清除当前群 Chairman（原 ${previous}）` : "✅ 当前群没有 Chairman");
      return;
    }

    const resolvedBotNames = this.resolveChairmanTargets(mentions, text, rawText);
    if (resolvedBotNames.length === 0) {
      // /chairman is intentionally not a status query. Status lives in /status;
      // this command is only for switching or clearing the Chairman. Keeping the
      // two meanings separate prevents failed mention parsing from being masked
      // as a harmless "current status" response.
      const groupBots = Array.from(FeishuBot.allBots.values())
        .filter((bot) => bot.store === this.store)
        .map((bot) => bot.config.name);
      const uniqueGroupBots = Array.from(new Set(groupBots));
      const choices = uniqueGroupBots.length > 0
        ? uniqueGroupBots.map((name) => `/chairman ${name}`).join("\n")
        : "/chairman @某个Bot";
      await this.replyMessage(messageId,
        `❌ /chairman 只用于设置/切换 Chairman，不再用于状态查询。\n` +
        `查看当前 Chairman 请用 /status。\n` +
        `切换请 @ 一个 bot，或直接发（可复制）：\n${choices}\n` +
        `清除请用：/chairman off`);
      return;
    }
    if (resolvedBotNames.length > 1) {
      await this.replyMessage(messageId, "❌ 一个群只能设置一个 Chairman。请只 @ 一个 bot。");
      return;
    }

    const next = resolvedBotNames[0];
    const previous = this.store.getChairmanBot(chatId);
    this.store.setChairmanBot(chatId, next);
    const mode = this.store.getBotMode(next, chatId);
    const lines = [previous && previous !== next ? `✅ Chairman 已从 ${previous} 切换为 ${next}` : `✅ Chairman 已设置为 ${next}`];
    lines.push("作用：");
    lines.push("- 非 Discuss 模式下：free bot 会主动回答普通消息；没有 free bot 时由 Chairman 兜底");
    lines.push("- Discuss 模式下：所有非 mute bot + Chairman 参与讨论，free 开关会被忽略");
    lines.push("- Chairman 优先级高于 mute，会参与兜底回答、主持、调停并做最终总结");
    if (mode === "mute") lines.push(`⚠️ ${next} 当前是 mute，但 Chairman 场景下仍会发言`);
    await this.replyMessage(messageId, lines.join("\n"));
  }

  /**
   * Handle /model command: show or switch this bot's bound model.
   */
  private async handleModelCommand(chatId: string, messageId: string, text: string): Promise<void> {
    const parts = text.split(/\s+/).filter(Boolean);
    const nextModel = parts[1];
    if (!nextModel) {
      await this.replyMessage(messageId, `🤖 ${this.config.name} 当前模型：${this.config.model}\n用法：/model <provider/model-id>`);
      return;
    }
    if (nextModel === this.config.model) {
      await this.replyMessage(messageId, `🤖 ${this.config.name} 已经在使用：${this.config.model}`);
      return;
    }
    if (!this.configPath) {
      await this.replyMessage(messageId, "❌ 无法持久化模型设置：运行时没有 configPath");
      return;
    }

    const previous = this.config.model;
    const sessionKey = await this.ensureSession(chatId);
    try {
      // Validate/apply to the current session first. If OpenClaw rejects the
      // model, do not persist a bad config.
      await this.openclawClient.patchSession({ key: sessionKey, model: nextModel });
      persistBotModel(this.configPath, this.config.name, nextModel);
      this.config.model = nextModel;
      await this.replyMessage(messageId, `✅ ${this.config.name} 模型已切换并持久化\n之前：${previous}\n现在：${nextModel}`);
    } catch (err) {
      await this.openclawClient.patchSession({ key: sessionKey, model: previous }).catch(() => {});
      await this.replyMessage(messageId, `❌ 模型切换失败，配置未修改\n目标：${nextModel}\n原因：${(err as Error).message}`);
    }
  }

  /**
   * Handle /status command: show current session info.
   */
  private async handleStatusCommand(chatId: string, chatType: string, messageId: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    const chatInfo = this.store.getChatInfo(chatId);
    const msgCount = this.store.getMessageCount(chatId);

    let session: any = null;
    try {
      const resp = await this.openclawClient.getSessionInfo(sessionKey);
      session = resp?.session;
    } catch {
      // session may not exist yet
    }

    // Always show the configured model — session.model may show gateway-injected internal name
    const model = this.config.model;
    const totalTokens = session?.totalTokens || 0;
    const contextTokens = session?.contextTokens || 0;
    const inputTokens = session?.inputTokens || 0;
    const outputTokens = session?.outputTokens || 0;
    const usedPct = contextTokens > 0 ? Math.round((totalTokens / contextTokens) * 100) : 0;
    const tokenNote = !session?.totalTokensFresh ? " (待首次对话后更新)" : "";

    const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;

    const chatLabel = chatInfo?.chatName || (chatType === "p2p" ? "私聊" : chatId.slice(-8));
    const sessionExists = session ? "✅ 活跃" : "⏳ 未初始化";
    const status = session?.status || "unknown";

    const verboseStatus = this.store.getBotVerbose(this.config.name, chatId) ? "🔊 开启" : "🔇 关闭";
    const liveStatus = this.store.getBotLiveStatus(this.config.name, chatId) ? "📡 开启" : "📴 关闭";
    const mode = chatType === "p2p" ? "normal" : this.store.getBotMode(this.config.name, chatId);
    const chairman = chatType === "p2p" ? "" : this.store.getChairmanBot(chatId);
    const chairmanStatus = chatType === "p2p"
      ? "不适用"
      : chairman
        ? chairman === this.config.name ? `👑 是（${chairman}）` : `否（当前：${chairman}）`
        : "未设置";
    const localeStatus = chatType === "p2p" ? this.locale : this.chatLocale(chatId);

    const statusText = [
      `📊 ${this.config.name} Bot Status`,
      `━━━━━━━━━━━━━━━━━━`,
      `🤖 Bot: ${this.config.name}`,
      `🧩 LMA: ${LMA_VERSION}`,
      `🧠 模型: ${model}`,
      `💬 会话: ${chatLabel} (${chatType === "p2p" ? "私聊" : "群聊"})`,
      `📋 Session: ${sessionExists} | ${status}`,
      `━━━━━━━━━━━━━━━━━━`,
      `📝 本地消息: ${msgCount} 条`,
      `🧮 上下文: ${fmtK(totalTokens)} / ${fmtK(contextTokens)} (${usedPct}%)${tokenNote}`,
      `📥 输入: ${fmtK(inputTokens)} | 📤 输出: ${fmtK(outputTokens)}`,
      `🔧 Verbose: ${verboseStatus}`,
      `📡 Live Status: ${liveStatus}`,
      `🎛️ Mode: ${mode}`,
      `👑 Chairman: ${chairmanStatus}`,
      `🌐 Locale: ${localeStatus}`,
    ].join("\n");

    await this.replyMessage(messageId, statusText);
  }

  /**
   * Handle /compact command: compress session context.
   */
  /**
   * Compact a session with a fallback chain:
   *   1. OpenClaw's native (LLM-summary) compaction — best semantics.
   *   2. If that did not compact (or threw), fall back to "tool-trim": rewrite
   *      the transcript file to drop tool calls/results while keeping the
   *      conversation. This needs no model, so it works no matter how large the
   *      session is (the native path itself fails to fit an oversized session
   *      into the model). A backup is always written before any file change.
   * Returns a structured result describing what happened.
   */
  private async compactWithFallback(
    sessionKey: string,
    onPhase?: (phase: "native" | "tool-trim") => void,
  ): Promise<{
    compacted: boolean;
    method: "native" | "tool-trim" | "none";
    reason?: string;
    detail?: string;
  }> {
    // 1. Native compaction first.
    let nativeReason: string | undefined;
    try {
      const res = await this.openclawClient.compactSession(sessionKey);
      if (res?.compacted === true) return { compacted: true, method: "native" };
      nativeReason = typeof res?.reason === "string" ? res.reason : undefined;
    } catch (err) {
      nativeReason = (err as Error).message;
    }

    // 2. Fall back to tool-trim on the transcript file. Tell the caller so a
    //    progress card can flip from "compacting" to "fast-trim" (this is the
    //    slow→still-working transition the user most needs to see).
    onPhase?.("tool-trim");
    let sessionId: string | undefined;
    try {
      const info = await this.openclawClient.getSessionInfo(sessionKey);
      sessionId = info?.session?.sessionId;
    } catch {
      // ignore; handled below
    }
    if (!sessionId) {
      return { compacted: false, method: "none", reason: nativeReason || "could not resolve session file" };
    }
    const filePath = resolveSessionFilePath(sessionKey, sessionId);
    if (!filePath) {
      return { compacted: false, method: "none", reason: nativeReason || "transcript file not found" };
    }
    const trim = toolTrimCompactFile(filePath, toolTrimKeepRecent());
    if (!trim.ok) {
      return { compacted: false, method: "none", reason: trim.reason || "tool-trim failed" };
    }
    const before = trim.bytesBefore || 0;
    const after = trim.bytesAfter || 0;
    if (before > 0 && after >= before) {
      // Nothing meaningful trimmed.
      return { compacted: false, method: "none", reason: trim.reason || "no tool content to trim" };
    }
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}M`;
    return {
      compacted: true,
      method: "tool-trim",
      detail: `${mb(before)}→${mb(after)} (-${pct}%)`,
    };
  }

  private async handleCompactCommand(chatId: string, messageId: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    const en = this.isEn(chatId);
    // Large sessions can take tens of seconds to compact (native compaction may
    // even time out before the tool-trim fallback kicks in). Show a ticking
    // "compacting…" card so the user can SEE it is working instead of staring at
    // nothing and assuming nothing is happening. The card is created lazily, so
    // a fast compaction that finishes quickly never flashes a card at all.
    const progress = new CompactProgressController({
      create: (view) => this.sendOrdered(chatId, () => this.replyCompactCard(messageId, view, chatId)),
      edit: (id, view) => this.sendOrdered(chatId, () => this.patchCompactCard(id, view, chatId)),
      warn: (msg, err) => console.warn(`[${this.config.name}] ${msg}`, err instanceof Error ? err.message : err),
    }, { locale: en ? "en" : "zh" });
    progress.start();
    try {
      const r = await this.compactWithFallback(sessionKey, (phase) => {
        if (phase === "tool-trim") void progress.toToolTrim().catch(() => {});
      });
      if (r.compacted) {
        // If a card was shown, patch it in place; otherwise (fast finish, no card)
        // fall back to a normal reply so the user still gets confirmation.
        const detail = r.method === "tool-trim" && r.detail
          ? (en ? `tool-trim ${r.detail}` : `删工具调用 ${r.detail}`)
          : (en ? "native" : "原生压缩");
        await progress.done(detail);
        if (!progress.id) {
          await this.replyMessage(messageId, r.method === "tool-trim"
            ? (en ? `✅ Session compacted (tool-trim${r.detail ? " " + r.detail : ""})` : `✅ Session 已压缩（删工具调用${r.detail ? " " + r.detail : ""}）`)
            : (en ? `✅ Session compacted` : `✅ Session 已压缩`));
        }
      } else {
        const reason = r.reason || (en ? "nothing to compact" : "无需压缩");
        await progress.noop(reason);
        if (!progress.id) {
          await this.replyMessage(messageId, en
            ? `ℹ️ Session not compacted (${reason})`
            : `ℹ️ Session 未压缩（${reason}）`);
        }
      }
    } catch (err) {
      const reason = (err as Error).message;
      await progress.fail(reason);
      if (!progress.id) {
        await this.replyMessage(messageId, en
          ? `❌ Compact failed: ${reason}`
          : `❌ 压缩失败: ${reason}`);
      }
    }
  }

  /**
   * Handle /reset command: fire sessions.reset and confirm.
   * sessions.reset doesn't return a WS response, so we fire-and-forget
   * then verify via describe.
   */
  private async handleResetCommand(chatId: string, messageId: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    try {
      // Fire reset (no response expected)
      this.openclawClient.resetSession(sessionKey).catch(() => {});
      // Wait a moment for it to take effect
      await new Promise((r) => setTimeout(r, 2000));
      // Re-init session
      this.initializedSessions.delete(sessionKey);
      await this.ensureSession(chatId);
      await this.replyMessage(messageId, `✅ Session 已重置\n模型: ${this.config.model}`);
    } catch (err) {
      await this.replyMessage(messageId, `❌ 重置失败: ${(err as Error).message}`);
    }
  }

  /**
   * Force-stop a stuck run for this bot in this chat. Aborts all active OpenClaw
   * runs for the session, clears the busy lock and every pending trigger, and
   * resets stuck reactions so new messages are processed normally again.
   */
  private async handleStopCommand(chatId: string, messageId: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    try {
      // Bump the stop generation FIRST so any in-flight auto-retry loop sees the
      // cancellation on its next iteration and stops retrying immediately.
      this.stopEpoch.set(chatId, (this.stopEpoch.get(chatId) || 0) + 1);
      // Abort all active runs for this session (chat.abort with no runId).
      await this.openclawClient.abortChat(sessionKey).catch(() => {});
      // Force-unlock the busy gate so queued messages can be processed.
      this.busyChats.set(chatId, 0);
      // Drop every pending trigger for this bot/chat so the stuck run is not retried.
      const cleared = this.store.clearAllPendingTriggers(this.config.name, chatId);
      // Clear stuck Typing/Get reactions on queued messages.
      const acks = this.pendingAckMessages.get(chatId) || [];
      for (const ack of acks) {
        await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
      }
      this.pendingAckMessages.set(chatId, []);
      const locale = this.chatLocale(chatId);
      await this.replyMessage(messageId, locale === "en"
        ? `⏹️ Stopped. Aborted the active run, unlocked the queue, and cleared ${cleared} pending message(s). You can send a new message now.`
        : `⏹️ 已停止。已中止当前 run、解锁队列，并清掉 ${cleared} 条待处理消息。现在可以重新发消息了。`);
      console.log(`[${this.config.name}] /stop force-cleared ${chatId.slice(-8)}: aborted run, cleared ${cleared} pending`);
    } catch (err) {
      await this.replyMessage(messageId, `❌ stop 失败: ${(err as Error).message}`);
    }
  }

  /**
   * Fetch chat info (name, type, members) via Feishu API and cache in SQLite.
   * Called once per chat on first message.
   */
  private async fetchAndCacheChatInfo(chatId: string, chatType: string): Promise<void> {
    const existing = this.store.getChatInfo(chatId);
    // Refresh at most once per hour
    if (existing && Date.now() - existing.updatedAt < 3600_000) return;

    try {
      if (chatType === "p2p") {
        // For p2p, we don't have a group name or member list from chat API
        this.store.upsertChatInfo({
          chatId,
          chatType: "p2p",
          chatName: "私聊",
          members: "",
          memberNames: "",
          ownerBot: existing?.ownerBot || this.config.name,
          freeDiscussion: this.store.getChatInfo(chatId)?.freeDiscussion || false,
          verbose: this.store.getChatInfo(chatId)?.verbose || false,
          discuss: this.store.getChatInfo(chatId)?.discuss || false,
          discussMaxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 10,
          updatedAt: Date.now(),
        });
        return;
      }

      // Fetch group info
      const chatResp = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const chatName = (chatResp.data as any)?.name || "";

      // Fetch members
      let members: string[] = [];
      let memberNames: string[] = [];
      try {
        const membersResp = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: "open_id", page_size: 100 },
        });
        const items = (membersResp.data as any)?.items || [];
        for (const item of items) {
          if (item.member_id) members.push(item.member_id);
          if (item.name) memberNames.push(item.name);
        }
      } catch {
        // Some bots may lack permission to list members
      }

      this.store.upsertChatInfo({
        chatId,
        chatType: "group",
        chatName,
        members: members.join(","),
        memberNames: memberNames.join(","),
        ownerBot: "",  // group chats are shared, no owner
        freeDiscussion: this.store.getChatInfo(chatId)?.freeDiscussion || false,
        verbose: this.store.getChatInfo(chatId)?.verbose || false,
        discuss: this.store.getChatInfo(chatId)?.discuss || false,
        discussMaxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 10,
        updatedAt: Date.now(),
      });
      console.log(`[${this.config.name}] Cached chat info: ${chatName} (${chatId.slice(-8)})`);
    } catch (err) {
      console.warn(`[${this.config.name}] Failed to fetch chat info:`, (err as Error).message);
    }
  }

  /**
   * Send a model-drift notification to the affected chat.
   */
  private async hydrateInlineImageKeys(text: string, messageId: string): Promise<string> {
    const imageKeyPattern = /\[Image: (img_[^\]\n]+)\]/g;
    const replacements: Array<{ from: string; to: string }> = [];
    for (const match of text.matchAll(imageKeyPattern)) {
      const imageKey = match[1];
      try {
        const imgPath = await this.downloadResource(messageId, imageKey, "image");
        replacements.push({ from: match[0], to: `[Image: ${imgPath}]` });
      } catch (err) {
        replacements.push({ from: match[0], to: `[Image: download failed - ${(err as Error).message}]` });
      }
    }
    let out = text;
    for (const r of replacements) out = out.replace(r.from, r.to);
    return out;
  }

  private async hydrateFeishuDocsInMessage(text: string, content: any, messageId: string): Promise<string> {
    const refs = this.extractFeishuDocRefs(text, content);
    if (refs.length === 0) return text;
    const hydrated: string[] = [];
    for (const ref of refs.slice(0, 5)) {
      try {
        const doc = await this.hydrateFeishuDoc(ref, messageId);
        hydrated.push(`[FeishuDoc: ${doc.title || doc.token} -> ${doc.markdownPath}]`);
      } catch (err) {
        hydrated.push(`[FeishuDoc: ${ref.title || ref.token} - hydration failed: ${this.errorSummary(err)}]`);
      }
    }
    return `${text.trim()}\n\n[飞书文档已由 LMA 用机器人权限读取并转换为 Markdown 附件，OpenClaw 可直接读取附件内容。]\n${hydrated.join("\n")}`.trim();
  }

  private extractFeishuDocRefs(text: string, content: any): FeishuDocRef[] {
    const refs: FeishuDocRef[] = [];
    const add = (ref: FeishuDocRef) => {
      if (!ref.token || refs.some((r) => r.type === ref.type && r.token === ref.token)) return;
      refs.push(ref);
    };
    const scanValue = (value: any, title?: string) => {
      if (!value) return;
      if (typeof value === "string") {
        for (const ref of this.extractFeishuDocRefsFromText(value, title)) add(ref);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) scanValue(item, title);
        return;
      }
      if (typeof value !== "object") return;
      const nextTitle = value.title || value.name || value.file_name || title;
      const explicitType = String(value.obj_type || value.doc_type || value.type || "").toLowerCase();
      const docxToken = value.docx_token || value.document_id || (explicitType === "docx" ? value.token : undefined);
      const docToken = value.doc_token || (explicitType === "doc" ? value.token : undefined);
      const wikiToken = value.wiki_token || value.node_token || (explicitType === "wiki" ? value.token : undefined);
      if (docxToken) add({ type: "docx", token: String(docxToken), title: nextTitle, url: value.url || value.href });
      if (docToken) add({ type: "doc", token: String(docToken), title: nextTitle, url: value.url || value.href });
      if (wikiToken) add({ type: "wiki", token: String(wikiToken), title: nextTitle, url: value.url || value.href });
      for (const v of Object.values(value)) scanValue(v, nextTitle);
    };
    scanValue(content);
    for (const ref of this.extractFeishuDocRefsFromText(text)) add(ref);
    return refs;
  }

  private extractFeishuDocRefsFromText(text: string, title?: string): FeishuDocRef[] {
    const refs: FeishuDocRef[] = [];
    const pattern = /https?:\/\/[^\s)\]>"']+\/(docx|docs|wiki)\/([A-Za-z0-9_-]+)/g;
    for (const match of text.matchAll(pattern)) {
      const kind = match[1] === "docs" ? "doc" : (match[1] as "docx" | "wiki");
      refs.push({ type: kind, token: match[2], title, url: match[0] });
    }
    return refs;
  }

  private async hydrateFeishuDoc(ref: FeishuDocRef, messageId: string): Promise<HydratedFeishuDoc> {
    let resolved = ref;
    if (ref.type === "wiki") resolved = await this.resolveWikiDocRef(ref);
    const markdown = this.cleanupFeishuMarkdown(await this.fetchFeishuDocMarkdown(resolved));
    const title = resolved.title || ref.title || `${resolved.type}-${resolved.token}`;
    mkdirSync(FEISHU_DOCS_DIR, { recursive: true });
    const fileName = `${messageId}-${this.safeFileName(title)}-${resolved.token.slice(0, 8)}.md`;
    const markdownPath = join(FEISHU_DOCS_DIR, fileName);
    const body = [
      `# ${title}`,
      ``,
      `- Source type: ${ref.type}${resolved.type !== ref.type ? ` -> ${resolved.type}` : ""}`,
      `- Token: ${ref.token}`,
      resolved.url || ref.url ? `- URL: ${resolved.url || ref.url}` : "",
      `- Hydrated at: ${new Date().toISOString()}`,
      ``,
      markdown.trim(),
      ``,
    ].filter(Boolean).join("\n");
    writeFileSync(markdownPath, body, "utf8");
    return { ...resolved, title, markdownPath };
  }

  private async resolveWikiDocRef(ref: FeishuDocRef): Promise<FeishuDocRef> {
    const resp = await (this.client as any).wiki.v2.space.getNode({ params: { token: ref.token } });
    const node = resp?.data?.node;
    if (!node?.obj_token || !node?.obj_type) throw new Error(`Wiki node not readable: ${resp?.msg || "missing obj_token"}`);
    const objType = String(node.obj_type).toLowerCase();
    if (objType !== "docx" && objType !== "doc") throw new Error(`Unsupported wiki object type: ${objType}`);
    return { type: objType as "docx" | "doc", token: node.obj_token, title: node.title || ref.title, url: ref.url };
  }

  private cleanupFeishuMarkdown(markdown: string): string {
    return markdown
      .replace(/\\&\\#/g, "&#")
      .replace(/\\&#/g, "&#")
      .replace(/\\&amp;#/g, "&#")
      .replace(/&amp;#/g, "&#")
      .replace(/&#(\d+);/g, (_, code) => {
        const n = Number(code);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
        const n = Number.parseInt(code, 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\\([+\-=(){}[\].!,，。；：！？、])/g, "$1")
      .replace(/\\\*/g, "*")
      .replace(/\\_/g, "_")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private async fetchFeishuDocMarkdown(ref: FeishuDocRef): Promise<string> {
    let contentErr: unknown;
    const docs = (this.client as any).docs;
    if ((ref.type === "docx" || ref.type === "doc") && docs?.v1?.content?.get) {
      try {
        const resp = await docs.v1.content.get({ params: { doc_token: ref.token, doc_type: ref.type, content_type: "markdown", lang: "zh" } } as any);
        const content = resp?.data?.content;
        if (content) return content;
        contentErr = new Error(`docs content empty: ${resp?.msg || "unknown"}`);
      } catch (err) {
        contentErr = err;
      }
    }
    if (ref.type === "docx") {
      const resp = await (this.client as any).docx.document.rawContent({ path: { document_id: ref.token } });
      const content = resp?.data?.content;
      if (content) return content;
      throw new Error(`docx raw content empty: ${resp?.msg || this.errorSummary(contentErr)}`);
    }
    throw new Error(`Legacy doc markdown hydration failed: ${this.errorSummary(contentErr)}`);
  }

  private safeFileName(name: string): string {
    return name.replace(/[\\/:*?\"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "feishu-doc";
  }

  /**
   * Download a resource (image/file/audio) from a Feishu message.
   * Returns the local file path.
   */
  private async downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("fs");
    const { resolve } = await import("path");
    const { getLmaMediaDir } = await import("./paths.js");
    const dir = getLmaMediaDir();
    mkdirSync(dir, { recursive: true });

    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });

    const result = resp as any;
    const ext = type === "image" ? ".png" : "";
    const filePath = resolve(dir, `${fileKey}${ext}`);

    // SDK v1.62+ returns { writeFile, getReadableStream, headers }
    if (result.writeFile) {
      await result.writeFile(filePath);
    } else if (result.data && Buffer.isBuffer(result.data)) {
      writeFileSync(filePath, result.data);
    } else {
      throw new Error("Unsupported response format");
    }

    return filePath;
  }

  /**
   * Extract text content from a rich text (post) message.
   */
  private extractPostText(content: any): string {
    const parts: string[] = [];
    const title = content.title;
    if (title) parts.push(title);

    const body = content.content || [];
    for (const paragraph of body) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (element.tag === "text" && element.text) {
          parts.push(element.text);
        } else if (element.tag === "a" && element.text) {
          parts.push(`${element.text}(${element.href || ''})`);
        } else if (element.tag === "at" && element.user_name) {
          parts.push(`@${element.user_name}`);
        } else if (element.tag === "img" && element.image_key) {
          parts.push(`[Image: ${element.image_key}]`);
        }
      }
    }
    return this.cleanMentions(parts.join(" "));
  }

  private async notifyModelDrift(chatId: string, _sessionKey: string): Promise<void> {
    try {
      const chatInfo = this.store.getChatInfo(chatId);
      const chatLabel = chatInfo?.chatName || chatId.slice(-8);

      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({
            text: `⚠️ 模型漂移已自动纠正\n期望: ${this.config.model}\n已恢复`,
          }),
          msg_type: "text",
        },
      });
      console.log(`[${this.config.name}] Drift notification sent to ${chatLabel}`);
    } catch (err) {
      console.warn(`[${this.config.name}] Failed to notify drift:`, (err as Error).message);
    }
  }
}
