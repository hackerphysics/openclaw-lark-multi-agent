import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";

const MAX_BOT_STREAK = 10;

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
  /** Per-chat pending reply message IDs (to ack with DONE when reply arrives) */
  private pendingAckMessages: Map<string, { messageId: string; emoji: string }[]> = new Map();
  /** Per-chat pending tool message sends (to await before final reply) */
  private pendingToolSends: Map<string, Promise<void>[]> = new Map();
  /** Per-chat serial send queue to guarantee message order */
  private sendQueue: Map<string, Promise<void>> = new Map();
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
    });
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
        await this.sendMessage(chatId, text);
      } catch (err) {
        console.error(`[${this.config.name}] Failed to deliver proactive msg:`, (err as Error).message);
      }
    });

    // Subscribe to tool events for verbose mode
    this.openclawClient.onToolEvent(sessionKey, async (toolName, toolInput, toolOutput) => {
      const chatInfo = this.store.getChatInfo(chatId);
      if (!chatInfo?.verbose) return;
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
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(
      `[${this.config.name}] Bot started (model: ${this.config.model})`
    );

    // Drain any unsynced messages left from previous run
    this.drainOnStartup();
  }

  /**
   * On startup, check all known chats for unsynced messages and process them.
   * Also re-subscribe to known sessions for tool events.
   */
  private async drainOnStartup(): Promise<void> {
    try {
      const chats = this.store.getAllChatInfo();
      for (const chat of chats) {
        // Skip p2p chats that belong to other bots
        if (chat.chatType === "p2p" && chat.ownerBot && chat.ownerBot !== this.config.name) {
          continue;
        }

        // Re-subscribe to existing sessions
        const sessionKey = this.getSessionKey(chat.chatId);
        await this.ensureSession(chat.chatId);

        // Drain unsynced messages
        const unsynced = this.store.getUnsyncedMessages(this.config.name, chat.chatId);
        const humanUnsynced = unsynced.filter((m) => m.senderType === "human");
        if (humanUnsynced.length > 0) {
          console.log(
            `[${this.config.name}] Startup drain: ${humanUnsynced.length} unsynced message(s) in ${chat.chatName || chat.chatId.slice(-8)}`
          );
          await this.processQueue(chat.chatId);
        }
      }
    } catch (err) {
      console.warn(`[${this.config.name}] Startup drain failed:`, (err as Error).message);
    }
  }

  static getAllBots(): Map<string, FeishuBot> {
    return FeishuBot.allBots;
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

      // --- Record to local store (ALL messages, before command/response checks) ---
      const senderName = isBot
        ? this.resolveBotName(sender) || "Bot"
        : this.resolveHumanName(sender) || "User";

      this.store.insert({
        chatId,
        messageId,
        senderType: isBot ? "bot" : "human",
        senderName,
        content: cleanText,
        timestamp: Date.now(),
      });

      // Mark as processed only after successful parse + insert
      this.store.markBotProcessed(this.config.name, messageId);

      // --- Commands: in p2p always respond; in group, check shouldRespond first ---
      const isCommand = /^\/(help|status|compact|reset|verbose|free)/.test(cleanText.trim());
      if (isCommand) {
        // In group chats, commands also require mention/shouldRespond
        if (chatType !== "p2p" && !this.shouldRespond(chatType, message, isBot, chatId, message.content)) return;

        if (cleanText.trim().startsWith("/help")) {
          const helpText = [
            `📚 ${this.config.name} Bot 命令列表`,
            `━━━━━━━━━━━━━━━━━━`,
            `📊 /status  — 查看当前模型、Token 用量、Session 状态`,
            `🧹 /compact — 压缩上下文（保留摘要，释放 token）`,
            `🔄 /reset   — 重置会话（清空历史，从头开始）`,
            `🔊 /verbose — 开关 Tool Call 显示（查看 AI 调用了哪些工具）`,
            `🔓 /free    — 开关 Free Discussion（群聊中无需 @ 即可回复）`,
            `❓ /help    — 显示此帮助信息`,
          ].join("\n");
          await this.replyMessage(messageId, helpText);
          return;
        }
        if (cleanText.trim().startsWith("/status")) {
          await this.ensureSession(chatId);
          await this.handleStatusCommand(chatId, chatType, messageId);
          return;
        }
        if (cleanText.trim().startsWith("/compact")) {
          await this.ensureSession(chatId);
          await this.handleCompactCommand(chatId, messageId);
          return;
        }
        if (cleanText.trim().startsWith("/reset")) {
          await this.ensureSession(chatId);
          await this.handleResetCommand(chatId, messageId);
          return;
        }
        if (cleanText.trim().startsWith("/verbose")) {
          const chatInfo = this.store.getChatInfo(chatId);
          const isOn = chatInfo?.verbose || false;
          this.store.setVerbose(chatId, !isOn);
          if (isOn) {
            await this.replyMessage(messageId, "🔇 Verbose 已关闭\nTool call 详情不再显示");
          } else {
            await this.replyMessage(messageId, "🔊 Verbose 已开启\nTool call 执行过程将实时显示");
          }
          return;
        }
        if (cleanText.trim().startsWith("/free")) {
          if (chatType === "p2p") {
            await this.replyMessage(messageId, "❌ Free Discussion 只在群聊中可用");
            return;
          }
          const chatInfo = this.store.getChatInfo(chatId);
          const isOn = chatInfo?.freeDiscussion || false;
          this.store.setFreeDiscussion(chatId, !isOn);
          if (isOn) {
            await this.replyMessage(messageId, "🔒 Free Discussion 已关闭\n群聊中需要 @ 指定 Bot 才会回复");
          } else {
            await this.replyMessage(messageId, "🔓 Free Discussion 已开启\n所有 Bot 可以自由参与讨论（连续 Bot 回复超过 " + MAX_BOT_STREAK + " 轮将暂停，等待人类发言）");
          }
          return;
        }
      }

      // --- Should this bot respond? ---
      if (!this.shouldRespond(chatType, message, isBot, chatId, message.content)) return;

      // Track this message for reaction status updates
      const pending = this.pendingAckMessages.get(chatId) || [];

      // Anti-loop
      const streak = this.store.getBotStreak(chatId);
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
        pending.push({ messageId, emoji: "Typing" });
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
      pending.push({ messageId, emoji: "Get" });
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
    while (true) {
      const allUnsynced = this.store.getUnsyncedMessages(this.config.name, chatId);
      // Only proceed if there are unsynced human messages
      const humanUnsynced = allUnsynced.filter((m) => m.senderType === "human");
      if (humanUnsynced.length === 0) {
        // No human messages in this batch — mark all as synced and continue
        if (allUnsynced.length > 0) {
          const maxId = Math.max(...allUnsynced.map((m) => m.id || 0));
          this.store.markSynced(this.config.name, chatId, maxId);
          continue;
        }
        break;
      }

      this.busyChats.set(chatId, Date.now());

      // The last human message is the "current" one, everything else is context
      const lastHuman = humanUnsynced[humanUnsynced.length - 1];
      const contextMsgs = allUnsynced.filter((m) => m.id !== lastHuman.id);

      const sessionKey = await this.ensureSession(chatId);

      console.log(
        `[${this.config.name}] Sending ${humanUnsynced.length} message(s) to OpenClaw for ${chatId.slice(-8)}`
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
        });

        // Mark everything up to now as synced
        const maxId = Math.max(...allUnsynced.map((m) => m.id || 0));
        this.store.markSynced(this.config.name, chatId, maxId);

        // Record bot reply
        const replyId = this.store.insert({
          chatId,
          messageId: `self-${this.config.name}-${Date.now()}`,
          senderType: "bot",
          senderName: this.config.name,
          content: reply,
          timestamp: Date.now(),
        });
        this.store.markSynced(this.config.name, chatId, replyId);

        // Wait for all pending tool event messages to be delivered first
        const toolSends = this.pendingToolSends.get(chatId) || [];
        if (toolSends.length > 0) {
          await Promise.allSettled(toolSends);
          this.pendingToolSends.set(chatId, []);
        }

        // Reply to the last human message on Feishu (ordered after tool msgs)
        // Skip empty replies and NO_REPLY responses
        const trimmedReply = reply.trim();
        const shouldReply = trimmedReply.length > 0 && trimmedReply !== "NO_REPLY";
        if (shouldReply && lastHuman.messageId) {
          await this.sendOrdered(chatId, async () => {
            await this.replyMessage(lastHuman.messageId, reply);
          });
        }
        console.log(`[${this.config.name}] [${new Date().toISOString()}] ${shouldReply ? 'Replied' : 'Skipped (empty/NO_REPLY)'} (${reply.length} chars)`);

        // Replace ack reactions with DONE for all pending messages in this chat
        const pendingAcks = this.pendingAckMessages.get(chatId) || [];
        for (const ack of pendingAcks) {
          await this.removeReaction(ack.messageId, ack.emoji).catch(() => {});
          await this.addReaction(ack.messageId, "DONE").catch(() => {});
        }
        this.pendingAckMessages.set(chatId, []);
      } catch (err) {
        console.error(`[${this.config.name}] processQueue error:`, err);
        break;
      } finally {
        this.busyChats.set(chatId, 0);
      }

      // Check if more messages arrived while we were busy
      // Small delay to let any in-flight messages settle
      await new Promise((r) => setTimeout(r, 200));
    }
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
    if (rawText && rawText.includes("@_all")) return true;

    // Check if this bot is explicitly mentioned
    if (this.isMentioned(mentions)) return true;

    // Check if any other bot is mentioned (not us) — don't respond
    const anyBotMentioned = mentions.some((m: any) => {
      for (const bot of FeishuBot.allBots.values()) {
        if (m.id?.app_id === bot.config.appId) return true;
        if (bot.botOpenId && m.id?.open_id === bot.botOpenId) return true;
      }
      return false;
    });
    if (anyBotMentioned) return false;

    // No bot mentioned: check free discussion mode
    if (chatId) {
      const chatInfo = this.store.getChatInfo(chatId);
      if (chatInfo?.freeDiscussion) return true;
    }

    // Default: don't respond without @
    return false;
  }

  private isMentioned(mentions: any[]): boolean {
    return mentions.some((m: any) => {
      // @ this specific bot
      if (m.id?.app_id === this.config.appId) return true;
      if (this.botOpenId && m.id?.open_id === this.botOpenId) return true;
      // @all / @ 所有人
      if (m.key === "all" || m.id?.user_id === "all" || m.id?.open_id === "all" || m.name === "所有人") return true;
      return false;
    });
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

  private async replyMessage(messageId: string, text: string) {
    // Use interactive card for markdown rendering
    const card = {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    };
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

  /**
   * Send a proactive message to a chat (not a reply).
   */
  private async sendMessage(chatId: string, text: string) {
    const card = {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    };
    try {
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
    } catch {
      // Fallback to plain text
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
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

    const verboseStatus = chatInfo?.verbose ? "🔊 开启" : "🔇 关闭";
    const freeStatus = chatInfo?.freeDiscussion ? "🔓 开启" : "🔒 关闭";

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
      `💬 Free Discussion: ${freeStatus}`,
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
