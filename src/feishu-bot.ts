import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig, AppConfig } from "./config.js";
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
  /** Dedup: track recently processed message IDs */
  private processedMessages: Set<string> = new Set();
  /** Per-chat busy lock: timestamp when became busy (0 = not busy) */
  private busyChats: Map<string, number> = new Map();
  /** Per-chat pending reply message IDs (to ack with DONE when reply arrives) */
  private pendingAckMessages: Map<string, { messageId: string; emoji: string }[]> = new Map();
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
      await this.openclawClient.createSession({
        key: sessionKey,
        model: this.config.model,
        label: `LMA: ${this.config.name} [${chatId.slice(-8)}]`,
      });
      console.log(`[${this.config.name}] Session created: ${sessionKey}`);
    } catch {
      // Session already exists, patch model
      const corrected = await this.openclawClient.ensureModel(sessionKey, this.config.model);
      if (corrected) {
        console.log(`[${this.config.name}] Model auto-corrected to ${this.config.model}`);
        await this.notifyModelDrift(chatId, sessionKey);
      }
    }

    this.initializedSessions.add(sessionKey);

    // Subscribe to agent-initiated messages for this session
    await this.openclawClient.subscribeSession(sessionKey, async (text) => {
      try {
        console.log(`[${this.config.name}] Proactive message for ${chatId.slice(-8)}`);
        await this.sendMessage(chatId, text);
      } catch (err) {
        console.error(`[${this.config.name}] Failed to deliver proactive msg:`, (err as Error).message);
      }
    });

    return sessionKey;
  }

  /**
   * Start the Feishu WS connection. Sessions are created lazily per chat.
   */
  async start() {
    this.register();
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(
      `[${this.config.name}] Bot started (model: ${this.config.model})`
    );

    // Drain any unsynced messages left from previous run
    this.drainOnStartup();
  }

  /**
   * On startup, check all known chats for unsynced messages and process them.
   */
  private async drainOnStartup(): Promise<void> {
    try {
      const chats = this.store.getAllChatInfo();
      for (const chat of chats) {
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

      if (messageType !== "text") return;

      // --- Dedup: skip if already processed (memory + DB) ---
      if (this.processedMessages.has(messageId)) return;
      // Also check DB in case of process restart
      const existingMsg = this.store.hasMessage(messageId);
      if (existingMsg) {
        this.processedMessages.add(messageId);
        return;
      }
      this.processedMessages.add(messageId);
      // Keep set bounded
      if (this.processedMessages.size > 1000) {
        const first = this.processedMessages.values().next().value;
        if (first) this.processedMessages.delete(first);
      }

      // --- Cache chat info (lazy, at most once per hour) ---
      await this.fetchAndCacheChatInfo(chatId, chatType);

      const content = JSON.parse(message.content);
      const rawText: string = content.text || "";
      const cleanText = this.cleanMentions(rawText);
      if (!cleanText.trim()) return;

      // --- Handle /status command (always respond, regardless of mention rules) ---
      if (cleanText.trim().startsWith("/status")) {
        await this.ensureSession(chatId);
        await this.handleStatusCommand(chatId, chatType, messageId);
        return;
      }

      // --- Handle /compact command ---
      if (cleanText.trim().startsWith("/compact")) {
        await this.ensureSession(chatId);
        await this.handleCompactCommand(chatId, messageId);
        return;
      }

      // --- Handle /reset command ---
      if (cleanText.trim().startsWith("/reset")) {
        await this.ensureSession(chatId);
        await this.handleResetCommand(chatId, messageId);
        return;
      }

      // --- Record to local store (ALL messages) ---
      const senderName = isBot
        ? this.resolveBotName(sender) || "Bot"
        : this.resolveHumanName(sender) || "User";

      const insertId = this.store.insert({
        chatId,
        messageId,
        senderType: isBot ? "bot" : "human",
        senderName,
        content: cleanText,
        timestamp: Date.now(),
      });

      // --- Should this bot respond? ---
      if (!this.shouldRespond(chatType, message, isBot)) return;

      // --- Acknowledge receipt: random reaction to show message received ---
      const ACK_REACTIONS = ["OK", "THUMBSUP", "MUSCLE", "APPLAUSE", "JIAYI"];
      const ackEmoji = ACK_REACTIONS[Math.floor(Math.random() * ACK_REACTIONS.length)];
      await this.addReaction(messageId, ackEmoji).catch(() => {});

      // Track this message for later DONE ack
      const pending = this.pendingAckMessages.get(chatId) || [];
      pending.push({ messageId, emoji: ackEmoji });
      this.pendingAckMessages.set(chatId, pending);

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
      const BUSY_TIMEOUT_MS = 180_000; // 3 minutes max
      const isBusy = busySince > 0 && (Date.now() - busySince) < BUSY_TIMEOUT_MS;

      if (isBusy) {
        console.log(
          `[${this.config.name}] Agent busy for ${chatId.slice(-8)}, queuing: "${cleanText.substring(0, 50)}..."`
        );
        return; // Message is in DB, will be picked up when agent finishes
      }

      if (busySince > 0) {
        // Busy timeout expired — force unlock and proceed
        console.warn(
          `[${this.config.name}] Busy timeout expired for ${chatId.slice(-8)} (${Math.round((Date.now() - busySince) / 1000)}s), force unlocking`
        );
        this.busyChats.set(chatId, 0);
      }

      // --- Not busy, send now (with any accumulated messages) ---
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
      if (humanUnsynced.length === 0) break;

      this.busyChats.set(chatId, Date.now());

      // The last human message is the "current" one, everything else is context
      const lastHuman = humanUnsynced[humanUnsynced.length - 1];
      const contextMsgs = allUnsynced.filter((m) => m.id !== lastHuman.id);

      const sessionKey = await this.ensureSession(chatId);

      console.log(
        `[${this.config.name}] Sending ${humanUnsynced.length} message(s) to OpenClaw for ${chatId.slice(-8)}`
      );

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

        // Reply to the last human message on Feishu
        if (lastHuman.messageId) {
          await this.replyMessage(lastHuman.messageId, reply);
        }
        console.log(`[${this.config.name}] Replied (${reply.length} chars)`);

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
    isBot: boolean
  ): boolean {
    if (chatType === "p2p") return !isBot;

    const mentions: any[] = message.mentions || [];

    if (isBot) {
      return this.isMentioned(mentions);
    }

    if (mentions.length === 0) return true;

    const anyBotMentioned = mentions.some((m: any) => {
      for (const bot of FeishuBot.allBots.values()) {
        if (m.id?.app_id === bot.config.appId) return true;
        if (bot.botOpenId && m.id?.open_id === bot.botOpenId) return true;
      }
      return false;
    });

    if (!anyBotMentioned) return true;
    return this.isMentioned(mentions);
  }

  private isMentioned(mentions: any[]): boolean {
    return mentions.some((m: any) => {
      if (m.id?.app_id === this.config.appId) return true;
      if (this.botOpenId && m.id?.open_id === this.botOpenId) return true;
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
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  /**
   * Send a proactive message to a chat (not a reply).
   */
  private async sendMessage(chatId: string, text: string) {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
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
   * Check token usage and auto-compact if needed.
   * Returns true if compaction was triggered.
   */
  private async checkAndCompact(sessionKey: string): Promise<boolean> {
    try {
      const resp = await this.openclawClient.getSessionInfo(sessionKey);
      const session = resp?.session;
      if (!session) return false;

      const totalTokens = session.totalTokens || 0;
      const contextTokens = session.contextTokens || 0;
      if (contextTokens === 0) return false;

      const usagePct = totalTokens / contextTokens;
      // Compact when usage exceeds 70%
      if (usagePct > 0.7) {
        console.log(`[${this.config.name}] Context ${Math.round(usagePct * 100)}% full, compacting...`);
        await this.openclawClient.compactSession(sessionKey);
        console.log(`[${this.config.name}] Compaction done`);
        return true;
      }
    } catch (err) {
      console.warn(`[${this.config.name}] checkAndCompact failed:`, (err as Error).message);
    }
    return false;
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

    const model = session?.model ? `${session.modelProvider || ""}/${session.model}` : this.config.model;
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

    const statusText = [
      `📊 ${this.config.name} Bot Status`,
      `━━━━━━━━━━━━━━━━━━`,
      `🤖 Bot: ${this.config.name}`,
      `🧠 模型: ${model}`,
      `💬 会话: ${chatLabel} (${chatType === "p2p" ? "私聊" : "群聊"})`,
      `📋 Session: ${sessionExists} | ${status}`,
      `🔑 Key: ${sessionKey}`,
      `━━━━━━━━━━━━━━━━━━`,
      `📝 本地消息: ${msgCount} 条`,
      `🧮 上下文: ${fmtK(totalTokens)} / ${fmtK(contextTokens)} (${usedPct}%)${tokenNote}`,
      `📥 输入: ${fmtK(inputTokens)} | 📤 输出: ${fmtK(outputTokens)}`,
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
      await this.replyMessage(messageId, `✅ Session 已压缩\nKey: ${sessionKey}`);
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
