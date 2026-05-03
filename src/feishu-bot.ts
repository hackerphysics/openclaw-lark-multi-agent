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
  readonly sessionKey: string;

  private static allBots: Map<string, FeishuBot> = new Map();

  constructor(
    config: BotConfig,
    openclawClient: OpenClawClient,
    store: MessageStore
  ) {
    this.config = config;
    this.openclawClient = openclawClient;
    this.store = store;
    this.sessionKey = `lma-${config.name.toLowerCase()}`;

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
   * Create/patch the OpenClaw session and start Feishu WS.
   */
  async start() {
    this.register();

    // Ensure session exists with correct model
    try {
      await this.openclawClient.createSession({
        key: this.sessionKey,
        model: this.config.model,
        label: `LMA: ${this.config.name}`,
      });
      console.log(`[${this.config.name}] Session created: ${this.sessionKey}`);
    } catch {
      await this.openclawClient.patchSession({
        key: this.sessionKey,
        model: this.config.model,
        label: `LMA: ${this.config.name}`,
      });
      console.log(`[${this.config.name}] Session patched: ${this.sessionKey}`);
    }

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(
      `[${this.config.name}] Bot started (model: ${this.config.model})`
    );
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

      const content = JSON.parse(message.content);
      const rawText: string = content.text || "";
      const cleanText = this.cleanMentions(rawText);
      if (!cleanText.trim()) return;

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

      // Anti-loop
      const streak = this.store.getBotStreak(chatId);
      if (streak >= MAX_BOT_STREAK) {
        console.log(
          `[${this.config.name}] Anti-loop: ${streak} consecutive bot msgs`
        );
        return;
      }

      console.log(
        `[${this.config.name}] Responding to: "${cleanText.substring(0, 80)}..."`
      );

      // --- Get unsynced messages (excluding the current one) ---
      const allUnsynced = this.store.getUnsyncedMessages(
        this.config.name,
        chatId
      );
      // The current message is in allUnsynced too (just inserted).
      // Separate it: everything before current = context, current = the actual message.
      const contextMsgs = allUnsynced.filter((m) => m.id !== insertId);

      // --- Send to OpenClaw with context catch-up ---
      const reply = await this.openclawClient.chatSendWithContext({
        sessionKey: this.sessionKey,
        unsyncedMessages: contextMsgs,
        currentMessage: cleanText,
        currentSenderName: senderName,
        deliver: false,
      });

      // Mark everything up to now as synced (including the current message)
      const maxId = Math.max(insertId, ...allUnsynced.map((m) => m.id || 0));
      this.store.markSynced(this.config.name, chatId, maxId);

      // Record bot reply to local store
      const replyId = this.store.insert({
        chatId,
        messageId: `self-${this.config.name}-${Date.now()}`,
        senderType: "bot",
        senderName: this.config.name,
        content: reply,
        timestamp: Date.now(),
      });
      // The reply is already in the session (agent wrote it), so mark synced
      this.store.markSynced(this.config.name, chatId, replyId);

      // Send reply to Feishu
      await this.replyMessage(messageId, reply);
      console.log(`[${this.config.name}] Replied (${reply.length} chars)`);
    } catch (err) {
      console.error(`[${this.config.name}] Error:`, err);
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
}
