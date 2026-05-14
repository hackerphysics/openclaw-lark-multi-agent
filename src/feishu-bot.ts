import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";
import { existsSync, readFileSync, statSync } from "fs";
import { basename, extname, resolve } from "path";
import { getBridgeAttachmentAllowedRoots, getBridgeAttachmentsDir } from "./paths.js";
import { buildFeishuCardElements } from "./markdown.js";
import { discussionManager, type DiscussionParticipant, type ReplyResult } from "./discussion-manager.js";

const MAX_BOT_STREAK = 10;
const BRIDGE_ATTACHMENTS_DIR = getBridgeAttachmentsDir();
const BRIDGE_ATTACHMENT_ALLOWED_ROOTS = getBridgeAttachmentAllowedRoots();

type BridgeAttachment = {
  type?: "image" | "file" | "document";
  path: string;
  caption?: string;
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
  /** Per-chat pending reply message IDs (to ack with DONE when their trigger is processed) */
  private pendingAckMessages: Map<string, { messageId: string; emoji: string; rowId: number }[]> = new Map();
  /** Per-chat pending tool message sends (to await before final reply) */
  private pendingToolSends: Map<string, Promise<void>[]> = new Map();
  /** Per-chat processQueue lock to avoid duplicate concurrent chat.send runs */
  private queueRuns: Map<string, Promise<void>> = new Map();
  /** Per-chat serial send queue to guarantee message order */
  private sendQueue: Map<string, Promise<void>> = new Map();
  /** Per-chat delayed runtime failure notifications, canceled if a real reply arrives. */
  private delayedFailureTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Last time a real assistant-visible reply was successfully handed to the delivery pipeline. */
  private lastRealDeliveryAt: Map<string, number> = new Map();
  private adminOpenId: string | null;

  private static allBots: Map<string, FeishuBot> = new Map();

  constructor(
    config: BotConfig,
    openclawClient: OpenClawClient,
    store: MessageStore,
    adminOpenId?: string
  ) {
    this.config = config;
    this.openclawClient = openclawClient;
    this.store = store;
    this.adminOpenId = adminOpenId || null;
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
        console.log(`[${this.config.name}] Session created: ${sessionKey} (model: ${this.config.model})`);
      }
    } catch (err) {
      console.warn(`[${this.config.name}] ensureSession error:`, (err as Error).message);
    }

    this.initializedSessions.add(sessionKey);

    // Subscribe to session events (proactive messages + tool calls)
    await this.openclawClient.subscribeSession(sessionKey, async (text) => {
      try {
        console.log(`[${this.config.name}] Proactive message for ${chatId.slice(-8)}`);
        const parsed = this.extractBridgeAttachments(text);
        if (parsed.text.trim() || parsed.attachments.length > 0) this.cancelDelayedFailure(chatId);
        await this.enqueueAndDispatchDelivery(chatId, "assistant_visible", this.deliverySourceId("proactive", `${Date.now()}:${Math.random()}:${parsed.text.trim()}|${JSON.stringify(parsed.attachments)}`), parsed.text.trim(), parsed.attachments);
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

      if (messageType !== "text" && messageType !== "image" && messageType !== "file" && messageType !== "audio" && messageType !== "sticker" && messageType !== "post") return;

      // --- Dedup: skip if this bot already processed this message ---
      if (this.store.hasBotProcessed(this.config.name, messageId)) return;

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
      if (messageType === "text") {
        const rawText: string = content.text || "";
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
        cleanText = this.extractPostText(content);
      } else if (messageType === "sticker") {
        cleanText = `[Sticker: ${content.file_key || "unknown"}]`;
      }

      if (!cleanText.trim()) return;

      // Commands may be prefixed by @all / @bot in group chats. Strip those
      // leading routing mentions before deciding whether this is a bridge command
      // or an escaped OpenClaw command.
      const trimmedCleanText = cleanText.trim();
      const commandText = this.stripLeadingCommandMentions(trimmedCleanText);
      // Escape hatch: //command means send /command through to OpenClaw,
      // while /command remains a bridge-level openclaw-lark-multi-agent command.
      if (commandText.startsWith("//")) {
        cleanText = "/" + commandText.slice(2).trimStart();
      } else if (commandText.startsWith("/")) {
        cleanText = commandText;
      }

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
      });
      if (insertedId < 0) insertedId = this.store.getMessageId(messageId) || -1;

      // Mark as processed only after successful parse + insert
      this.store.markBotProcessed(this.config.name, messageId);

      // --- Commands: in p2p always respond; in group, check shouldRespond first ---
      // Single slash commands are handled by the bridge. Double slash commands were
      // already unescaped above and should pass through to OpenClaw instead.
      const isBridgeCommand = !commandText.startsWith("//");
      const isCommand = isBridgeCommand && /^\/(help|status|compact|reset|verbose|free|mute|mode|discuss)/.test(cleanText.trim());
      if (isCommand) {
        // In group chats, most bridge commands must be explicitly routed to this
        // bot or @all. /discuss is a group-level command, so an unmentioned
        // /discuss command is handled by one coordinator bot to avoid N replies.
        const isDiscussCommand = cleanText.trim().startsWith("/discuss");
        if (chatType !== "p2p" && !this.shouldHandleBridgeCommand(chatType, message, isBot, message.content)) {
          if (!(isDiscussCommand && this.isDiscussionCoordinator())) return;
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

        if (cleanText.trim().startsWith("/help")) {
          const helpText = [
            `📚 ${this.config.name} Bot 命令列表`,
            `━━━━━━━━━━━━━━━━━━`,
            `桥接层命令（单斜杠，由 openclaw-lark-multi-agent 本地处理）`,
            `📊 /status  — 查看当前模型、Token 用量、Session 状态`,
            `🧹 /compact — 压缩当前 bot 的 OpenClaw session`,
            `🔄 /reset   — 重置当前 bot 的 OpenClaw session`,
            `🔊 /verbose — 开关当前聊天里的 Tool Call 显示`,
            `🔓 /free   — 切换当前 bot 的 free 模式（不 @ 也可回复）`,
            `🤐 /mute   — 切换当前 bot 的 mute 模式（禁言，不转发 OpenClaw）`,
            `🎛️ /mode   — 查看当前 bot 在当前群聊的模式`,
            `💬 /discuss on|off|status|stop|rounds N — 群级多 bot 连续讨论`,
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
        if (cleanText.trim().startsWith("/status")) {
          await this.ensureSession(chatId);
          await this.handleStatusCommand(chatId, chatType, messageId);
          markCommandSynced();
          return;
        }
        if (cleanText.trim().startsWith("/compact")) {
          await this.ensureSession(chatId);
          await this.handleCompactCommand(chatId, messageId);
          markCommandSynced();
          return;
        }
        if (cleanText.trim().startsWith("/reset")) {
          await this.ensureSession(chatId);
          await this.handleResetCommand(chatId, messageId);
          markCommandSynced();
          return;
        }
        if (cleanText.trim().startsWith("/verbose")) {
          const isOn = this.store.getBotVerbose(this.config.name, chatId);
          this.store.setBotVerbose(this.config.name, chatId, !isOn);
          if (isOn) {
            await this.replyMessage(messageId, `🔇 ${this.config.name} Verbose 已关闭\n只影响当前 Bot 在当前会话的 Tool call 显示`);
          } else {
            await this.replyMessage(messageId, `🔊 ${this.config.name} Verbose 已开启\n只影响当前 Bot 在当前会话的 Tool call 显示`);
          }
          markCommandSynced();
          return;
        }
        if (cleanText.trim().startsWith("/free")) {
          if (chatType === "p2p") {
            await this.replyMessage(messageId, "❌ Free 模式只在群聊中可用");
            markCommandSynced();
            return;
          }
          const current = this.store.getBotMode(this.config.name, chatId);
          const next = current === "free" ? "normal" : "free";
          this.store.setBotMode(this.config.name, chatId, next);
          if (next === "free") {
            await this.replyMessage(messageId, `🔓 ${this.config.name} 已切换到 free 模式\n不需要 @ 也可以回复普通人类消息；如果消息明确 @ 了其他 bot 或普通人，我不会抢答。\n如需多轮自动讨论，请使用群级命令 /discuss on。`);
          } else {
            await this.replyMessage(messageId, `🔒 ${this.config.name} 已切换到 normal 模式\n只有明确 @ 我才会回复`);
          }
          markCommandSynced();
          return;
        }
        if (cleanText.trim().startsWith("/mute")) {
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
        if (cleanText.trim().startsWith("/mode")) {
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
        if (cleanText.trim().startsWith("/discuss")) {
          await this.handleDiscussCommand(chatId, chatType, messageId, cleanText.trim());
          markCommandSynced();
          return;
        }
      }

      // --- Discuss mode: group-level multi-bot round scheduler. It takes over
      // plain human messages so normal Free mode does not duplicate Round 1.
      // Targeted mentions must fall through to normal routing so @GPT still
      // works while discuss mode is enabled.
      if (chatType !== "p2p" && !isBot && this.store.getChatInfo(chatId)?.discuss) {
        const mentions: any[] = message.mentions || [];
        const hasTargetedMention = mentions.some((m: any) => !this.isAllMentionItem(m));
        if (!hasTargetedMention) {
          const participants = this.getDiscussionParticipants(chatId);
          if (participants.length > 0) {
            discussionManager.startIfAbsent({
              chatId,
              rootMessageId: messageId,
              topic: cleanText,
              maxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 3,
              participants,
              sendSystemMessage: async (text) => { await this.sendMessage(chatId, text); },
            });
          }
          if (insertedId > 0) this.store.markSynced(this.config.name, chatId, insertedId);
          return;
        }
      }

      // --- Mute mode: do not forward anything to OpenClaw. Only direct mentions get a local notice. ---
      if (chatType !== "p2p" && !isBot && this.store.getBotMode(this.config.name, chatId) === "mute") {
        if (this.isMentioned(message.mentions || [])) {
          await this.replyMessage(messageId, `🤐 ${this.config.name} 当前处于 mute 模式，发送 /mute 可解除`);
          if (insertedId > 0) {
            this.store.markSynced(this.config.name, chatId, insertedId);
            this.store.clearPendingTrigger(this.config.name, chatId, insertedId);
          }
        }
        return;
      }

      // --- Should this bot respond? ---
      if (!this.shouldRespond(chatType, message, isBot, chatId, message.content)) return;
      if (!isBot && insertedId > 0) {
        this.store.markPendingTrigger(this.config.name, chatId, insertedId);
      }

      // Track this message for reaction status updates
      const pending = this.pendingAckMessages.get(chatId) || [];

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
      const unsyncedMessages = this.store.getUnsyncedMessages(this.config.name, chatId);
      const pendingMessages = this.store.getPendingTriggerMessages(this.config.name, chatId);
      const messageById = new Map<number, typeof unsyncedMessages[number]>();
      for (const msg of [...unsyncedMessages, ...pendingMessages]) {
        if (msg.id) messageById.set(msg.id, msg);
      }
      const allUnsynced = Array.from(messageById.values()).sort((a, b) => a.timestamp - b.timestamp);
      const pendingTriggerIds = this.store.getPendingTriggerIds(this.config.name, chatId);
      // Only proceed if there are pending human messages that should actively trigger this bot.
      // Pending triggers are included even if a later bridge command has advanced sync_state.
      const humanUnsynced = allUnsynced.filter((m) => m.senderType === "human" && m.id && pendingTriggerIds.has(m.id));
      if (humanUnsynced.length === 0) {
        break;
      }

      this.busyChats.set(chatId, Date.now());

      // The last trigger message is the "current" one, everything else is context
      const lastHuman = humanUnsynced[humanUnsynced.length - 1];
      const triggerId = lastHuman.id || 0;
      if (triggerId && this.store.hasDeliveredReply(this.config.name, chatId, triggerId)) {
        console.warn(`[${this.config.name}] Duplicate trigger skipped for ${chatId.slice(-8)} msgId=${triggerId}`);
        this.store.clearPendingTriggers(this.config.name, chatId, triggerId);
        continue;
      }
      const contextMsgs = allUnsynced.filter((m) => m.id !== lastHuman.id);

      const queueStartedAt = Date.now();
      const sessionKey = await this.ensureSession(chatId);

      console.log(
        `[${this.config.name}] Sending ${humanUnsynced.length} trigger(s) to OpenClaw for ${chatId.slice(-8)} (context=${contextMsgs.length})`
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

      try {
        const reply = await this.openclawClient.chatSendWithContext({
          sessionKey,
          unsyncedMessages: contextMsgs,
          currentMessage: lastHuman.content,
          currentSenderName: lastHuman.senderName,
          deliver: false,
          // Keep bridge UX responsive; long agent/tool loops should surface a clear failure
          // instead of leaving reactions stuck forever.
          timeoutMs: 1_800_000,
        });
        console.log(`[${this.config.name}] OpenClaw reply collected for ${chatId.slice(-8)} in ${Date.now() - queueStartedAt}ms`);

        const parsedReply = this.extractBridgeAttachments(reply);
        const visibleReply = parsedReply.text;
        const trimmedReply = visibleReply.trim();
        const hasAttachments = parsedReply.attachments.length > 0;
        const explicitNoReply = trimmedReply.toUpperCase() === "NO_REPLY";
        const trulyEmptyReply = trimmedReply.length === 0 && !hasAttachments;
        if (trulyEmptyReply) {
          // Empty final text is not the same as an explicit NO_REPLY. It often
          // means the upstream session/run was interrupted, raced, or collected
          // incorrectly. Do not mark sync, clear pending triggers, or mark DONE.
          // Leave the trigger pending for a later retry/new message.
          console.warn(`[${this.config.name}] Empty reply for ${chatId.slice(-8)} trigger=${triggerId}; keeping pending for retry`);
          break;
        }

        // Mark only the snapshot processed in this run as synced. Messages that
        // arrive while the agent is busy may already be in pendingAckMessages,
        // but they are not part of allUnsynced/humanUnsynced for this run and
        // must remain pending for the next loop.
        const maxId = Math.max(...allUnsynced.map((m) => m.id || 0));
        const processedTriggerIds = new Set(humanUnsynced.map((m) => m.id || 0).filter(Boolean));
        this.store.markSynced(this.config.name, chatId, maxId);
        this.store.clearPendingTriggers(this.config.name, chatId, maxId);
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
            if (!hasEarlierPending) this.store.markSynced(this.config.name, chatId, replyId);
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
          } else {
            await this.enqueueAndDispatchDelivery(chatId, "assistant_visible", this.deliverySourceId("visible", `${(shouldReply ? visibleReply : "").trim()}|${JSON.stringify(parsedReply.attachments)}`), shouldReply ? visibleReply : "", parsedReply.attachments, lastHuman.messageId, `trigger:${triggerId}`);
            if (triggerId) this.store.markDeliveredReply(this.config.name, chatId, triggerId, lastHuman.messageId);
          }
        }
        if (isRuntimeFailure && lastHuman.messageId) {
          this.scheduleDelayedFailure(chatId, lastHuman.messageId, visibleReply, triggerId);
        }
        console.log(`[${this.config.name}] [${new Date().toISOString()}] ${shouldReply || hasAttachments ? 'Replied' : 'Skipped (empty/NO_REPLY)'} (${reply.length} chars, attachments=${parsedReply.attachments.length})`);

        // Replace ack reactions with DONE only for trigger messages actually
        // processed in this run. Queued messages that arrived mid-run keep their
        // Typing/Get reaction and will be acknowledged by the next loop.
        const pendingAcks = this.pendingAckMessages.get(chatId) || [];
        const remainingAcks: typeof pendingAcks = [];
        for (const ack of pendingAcks) {
          if (processedTriggerIds.has(ack.rowId)) {
            await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
            await this.addReaction(ack.messageId, "DONE").catch(() => {});
          } else {
            remainingAcks.push(ack);
          }
        }
        this.pendingAckMessages.set(chatId, remainingAcks);
      } catch (err) {
        console.error(`[${this.config.name}] processQueue error:`, err);
        const errorText = this.formatUserVisibleError(err);
        if (lastHuman.messageId) {
          await this.enqueueAndDispatchDelivery(chatId, "provider_error", `trigger:${triggerId}:provider-error`, errorText, [], lastHuman.messageId, `trigger:${triggerId}:provider-error`)
            .then(() => {
              if (triggerId) this.store.markDeliveredReply(this.config.name, chatId, triggerId, lastHuman.messageId);
            })
            .catch(() => {});
        }
        if (triggerId) {
          // The run failed after OpenClaw/provider rejected it. Notify the user
          // and clear only this failed trigger so later messages can continue.
          this.store.clearPendingTrigger(this.config.name, chatId, triggerId);
          this.store.markSynced(this.config.name, chatId, triggerId);
        }
        const pendingAcks = this.pendingAckMessages.get(chatId) || [];
        const remainingAcks: typeof pendingAcks = [];
        for (const ack of pendingAcks) {
          if (ack.rowId === triggerId) {
            await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
            await this.addReaction(ack.messageId, "FAIL").catch(() => {});
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
    message: any,
    isBot: boolean,
    chatId?: string,
    rawText?: string
  ): boolean {
    if (chatType === "p2p") return !isBot;

    const mentions: any[] = message.mentions || [];

    // Bot messages: only respond if this bot is mentioned
    if (isBot) {
      return this.isMentioned(mentions);
    }

    // @all in text: all bots respond
    if (this.isAllMention(rawText, mentions)) return true;

    // Check if this bot is explicitly mentioned
    if (this.isMentioned(mentions)) return true;

    // Targeted mentions are exclusive. If a human mentions another person or
    // another bot, free-mode bots must not steal that message. Free mode only
    // applies to plain human messages with no targeted mentions.
    const hasTargetedMention = mentions.some((m: any) => !this.isAllMentionItem(m));
    if (hasTargetedMention) return false;

    // No bot mentioned: check current per-bot mode
    if (chatId) {
      if (this.store.getBotMode(this.config.name, chatId) === "free") return true;
    }

    // Default: don't respond without @
    return false;
  }

  private isMentioned(mentions: any[]): boolean {
    return mentions.some((m: any) => this.mentionedBotName(m) === this.config.name);
  }

  private isAllMention(rawText?: string, mentions: any[] = []): boolean {
    if (rawText && (rawText.includes("@_all") || rawText.includes("@all") || rawText.includes("@所有人"))) return true;
    return mentions.some((m: any) => this.isAllMentionItem(m));
  }

  private isAllMentionItem(mention: any): boolean {
    return mention.key === "all" || mention.key === "@_all" || mention.id?.user_id === "all" || mention.id?.open_id === "all" || mention.name === "所有人";
  }

  private mentionedBotName(mention: any): string | null {
    if (this.isAllMentionItem(mention)) return null;
    const candidates = [this, ...Array.from(FeishuBot.allBots.values()).filter((bot) => bot !== this)];
    for (const bot of candidates) {
      if (mention.id?.app_id === bot.config.appId) return bot.config.name;
      if (bot.botOpenId && mention.id?.open_id === bot.botOpenId) return bot.config.name;
      if (typeof mention.name === "string") {
        const n = mention.name.toLowerCase();
        const botName = bot.config.name.toLowerCase();
        if (n === botName || n.includes(`（${botName}）`) || n.includes(`(${botName})`)) return bot.config.name;
      }
    }
    return null;
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

  private isRuntimeFailureText(text: string): boolean {
    return text.startsWith("⚠️ Agent 未正常完成") || /\n原因:\s*rpc\b/.test(text);
  }

  private cancelDelayedFailure(chatId: string): void {
    const timer = this.delayedFailureTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.delayedFailureTimers.delete(chatId);
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

  private async enqueueAndDispatchDelivery(chatId: string, sourceType: string, sourceId: string, text: string, attachments: BridgeAttachment[] = [], replyToMessageId?: string, deliveryKey?: string): Promise<void> {
    if (!text.trim() && attachments.length === 0) return;
    const attachmentsJson = JSON.stringify(attachments);
    const normalizedPayload = `${text.trim()}|${attachmentsJson}`;
    const contentHash = this.stableHash(normalizedPayload);
    const finalDeliveryKey = deliveryKey || sourceId;
    if (!deliveryKey) {
      if (this.store.hasRecentSimilarDelivery(this.config.name, chatId, contentHash, 60_000)) return;
      if (this.store.hasRecentOverlappingDelivery(this.config.name, chatId, text, attachmentsJson, 60_000, 8)) return;
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
            const shouldReplyToSource = replyTarget && (item.sourceType === "assistant_visible" || item.sourceType === "provider_error" || item.sourceType === "delayed_error");
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

  private isDiscussionCoordinator(): boolean {
    const bots = Array.from(FeishuBot.allBots.values()).filter((bot) => bot.store === this.store);
    if (bots.length === 0) return true;
    return bots[0] === this;
  }

  private getDiscussionParticipants(chatId: string): DiscussionParticipant[] {
    return Array.from(FeishuBot.allBots.values())
      .filter((bot) => bot.store === this.store && bot.store.getBotMode(bot.config.name, chatId) === "free")
      .map((bot) => ({
        name: bot.config.name,
        runDiscussionTurn: async (_chatId: string, prompt: string, meta?: { round: number; maxRounds: number }) => bot.runDiscussionTurn(chatId, prompt, meta),
      }));
  }

  private async runDiscussionTurn(chatId: string, prompt: string, meta?: { round: number; maxRounds: number }): Promise<ReplyResult> {
    const sessionKey = await this.ensureSession(chatId);
    const releaseProactiveMute = this.openclawClient.muteProactiveDelivery(sessionKey);
    let reply: string;
    try {
      reply = await this.openclawClient.chatSendWithContext({
        sessionKey,
        unsyncedMessages: [],
        currentMessage: prompt,
        currentSenderName: "Discussion Scheduler",
        deliver: false,
        timeoutMs: 1_800_000,
      });
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
    let displayReply = cleanVisibleReply;
    const isVisible = cleanVisibleReply.length > 0 && cleanVisibleReply.toUpperCase() !== "NO_REPLY";
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
      await this.enqueueAndDispatchDelivery(chatId, "discussion", `discussion:${Date.now()}:${Math.random().toString(36).slice(2)}`, isVisible ? displayReply : "", parsedReply.attachments);
    }
    return { botName: this.config.name, text: cleanVisibleReply, visible: isVisible };
  }

  private async replyMessage(messageId: string, text: string) {
    // Use Feishu CardKit v2 markdown component for full Markdown rendering.
    const card = this.buildMarkdownCard(text);
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
    } catch {
      // Fallback to plain text if card fails
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
    }
  }

  private extractBridgeAttachments(reply: string): { text: string; attachments: BridgeAttachment[] } {
    const attachments: BridgeAttachment[] = [];
    const markerPattern = /<LMA_BRIDGE_ATTACHMENTS>([\s\S]*?)<\/LMA_BRIDGE_ATTACHMENTS>/g;
    let text = reply.replace(markerPattern, (_match, jsonText) => {
      try {
        const parsed = JSON.parse(String(jsonText).trim());
        const rawAttachments = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.attachments) ? parsed.attachments : [parsed];
        for (const item of rawAttachments) {
          if (!item || typeof item.path !== "string") continue;
          attachments.push({
            type: item.type === "image" || item.type === "document" || item.type === "file" ? item.type : undefined,
            path: item.path,
            caption: typeof item.caption === "string" ? item.caption : undefined,
          });
        }
      } catch (err) {
        console.warn(`[${this.config.name}] Failed to parse bridge attachment marker:`, (err as Error).message);
      }
      return "";
    }).trim();
    return { text, attachments };
  }

  private validateBridgeAttachmentPath(filePath: string): string {
    const resolvedPath = resolve(filePath);
    const isAllowed = BRIDGE_ATTACHMENT_ALLOWED_ROOTS.some((root) => resolvedPath === root || resolvedPath.startsWith(root + "/"));
    if (!isAllowed) {
      throw new Error(`Attachment path outside allowed directories (${BRIDGE_ATTACHMENT_ALLOWED_ROOTS.join(", ")}): ${resolvedPath}`);
    }
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
    const blocks = convertedData?.blocks || [];
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
  private async sendMessage(chatId: string, text: string) {
    const card = this.buildMarkdownCard(text);
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
    } catch (err) {
      console.warn(`[${this.config.name}] sendMessage interactive failed:`, JSON.stringify((err as any)?.response?.data || (err as any)?.data || { message: (err as Error).message }));
      // Fallback to plain text
      try {
        await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: "text",
          },
        });
      } catch (fallbackErr) {
        console.warn(`[${this.config.name}] sendMessage text failed:`, JSON.stringify((fallbackErr as any)?.response?.data || (fallbackErr as any)?.data || { message: (fallbackErr as Error).message }));
        throw fallbackErr;
      }
    }
  }

  /**
   * Enqueue a message send to guarantee ordering per chat.
   * All sends for a chat are serialized through this.
   */
  private sendOrdered(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.sendQueue.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous failed
    this.sendQueue.set(chatId, next);
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

  private async handleDiscussCommand(chatId: string, chatType: string, messageId: string, text: string): Promise<void> {
    if (chatType === "p2p") {
      await this.replyMessage(messageId, "❌ Discuss 模式只在群聊中可用");
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    const action = parts[1] || "status";
    if (action === "on") {
      this.store.setDiscussMode(chatId, true);
      await this.replyMessage(messageId, `💬 Discuss 已开启\n参与者：当前群所有 free 模式 bot\n轮数：${this.store.getChatInfo(chatId)?.discussMaxRounds || 3}`);
      return;
    }
    if (action === "off") {
      this.store.setDiscussMode(chatId, false);
      discussionManager.stop(chatId);
      await this.replyMessage(messageId, "💬 Discuss 已关闭");
      return;
    }
    if (action === "stop") {
      const stopped = discussionManager.stop(chatId);
      await this.replyMessage(messageId, stopped ? "💬 当前 discuss 已停止" : "💬 当前没有运行中的 discuss");
      return;
    }
    if (action === "rounds") {
      const n = Number.parseInt(parts[2] || "", 10);
      if (!Number.isFinite(n)) {
        await this.replyMessage(messageId, "❌ 用法：/discuss rounds <1-10>");
        return;
      }
      this.store.setDiscussMaxRounds(chatId, n);
      await this.replyMessage(messageId, `💬 Discuss 轮数已设置为 ${this.store.getChatInfo(chatId)?.discussMaxRounds || n}`);
      return;
    }
    const info = this.store.getChatInfo(chatId);
    const active = discussionManager.status(chatId);
    const participants = this.getDiscussionParticipants(chatId).map((p) => p.name);
    await this.replyMessage(messageId, [
      `💬 Discuss: ${info?.discuss ? "on" : "off"}`,
      `轮数：${info?.discussMaxRounds || 3}`,
      `参与者：${participants.length ? participants.join(", ") : "（无 free bot）"}`,
      active ? `运行中：第 ${active.currentRound}/${active.maxRounds} 轮，topic=${active.topic.slice(0, 80)}` : "运行中：无",
    ].join("\n"));
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
    const mode = chatType === "p2p" ? "normal" : this.store.getBotMode(this.config.name, chatId);

    const statusText = [
      `📊 ${this.config.name} Bot Status`,
      `━━━━━━━━━━━━━━━━━━`,
      `🤖 Bot: ${this.config.name}`,
      `🧠 模型: ${model}`,
      `💬 会话: ${chatLabel} (${chatType === "p2p" ? "私聊" : "群聊"})`,
      `📋 Session: ${sessionExists} | ${status}`,
      `━━━━━━━━━━━━━━━━━━`,
      `📝 本地消息: ${msgCount} 条`,
      `🧮 上下文: ${fmtK(totalTokens)} / ${fmtK(contextTokens)} (${usedPct}%)${tokenNote}`,
      `📥 输入: ${fmtK(inputTokens)} | 📤 输出: ${fmtK(outputTokens)}`,
      `🔧 Verbose: ${verboseStatus}`,
      `🎛️ Mode: ${mode}`,
    ].join("\n");

    await this.replyMessage(messageId, statusText);
  }

  /**
   * Handle /compact command: compress session context.
   */
  private async handleCompactCommand(chatId: string, messageId: string): Promise<void> {
    const sessionKey = this.getSessionKey(chatId);
    try {
      await this.openclawClient.compactSession(sessionKey);
      await this.replyMessage(messageId, `✅ Session 已压缩`);
    } catch (err) {
      await this.replyMessage(messageId, `❌ 压缩失败: ${(err as Error).message}`);
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
          ownerBot: this.config.name,
          freeDiscussion: this.store.getChatInfo(chatId)?.freeDiscussion || false,
          verbose: this.store.getChatInfo(chatId)?.verbose || false,
          discuss: this.store.getChatInfo(chatId)?.discuss || false,
          discussMaxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 3,
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
        discussMaxRounds: this.store.getChatInfo(chatId)?.discussMaxRounds || 3,
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
  /**
   * Download a resource (image/file/audio) from a Feishu message.
   * Returns the local file path.
   */
  private async downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("fs");
    const { resolve } = await import("path");
    const dir = resolve(process.cwd(), "data", "media");
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
