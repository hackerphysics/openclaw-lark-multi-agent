import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";

const MAX_BOT_STREAK = 10;
const MAX_CONTEXT_MESSAGES = 50;

/**
 * Manages a single Feishu bot instance.
 *
 * All messages (human + bot) are stored locally in SQLite.
 * When responding, full conversation context is assembled from local store
 * and sent to OpenClaw HTTP API.
 */
export class FeishuBot {
  readonly config: BotConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private openclawClient: OpenClawClient;
  private store: MessageStore;
  private botOpenId: string | null = null;

  // All active bots, shared reference for @-mention routing
  private static allBots: Map<string, FeishuBot> = new Map();

  constructor(
    config: BotConfig,
    openclawClient: OpenClawClient,
    store: MessageStore
  ) {
    this.config = config;
    this.openclawClient = openclawClient;
    this.store = store;

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

  async start() {
    this.register();
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(
      `[${this.config.name}] Bot started (appId: ${this.config.appId}, model: ${this.config.model})`
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

  /**
   * Handle incoming message from Feishu.
   */
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

      // Only handle text messages for now
      if (messageType !== "text") return;

      const content = JSON.parse(message.content);
      const rawText: string = content.text || "";
      const cleanText = this.cleanMentions(rawText);
      if (!cleanText.trim()) return;

      // --- Record ALL messages to local store ---
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

      // --- Determine if this bot should respond ---
      if (!this.shouldRespond(chatType, message, isBot)) return;

      // Anti-loop check
      const streak = this.store.getBotStreak(chatId);
      if (streak >= MAX_BOT_STREAK) {
        console.log(
          `[${this.config.name}] Anti-loop: ${streak} consecutive bot msgs in ${chatId}`
        );
        return;
      }

      console.log(
        `[${this.config.name}] Responding to: "${cleanText.substring(0, 80)}..."`
      );

      // --- Build context from local store and call OpenClaw ---
      const history = this.store.getRecent(chatId, MAX_CONTEXT_MESSAGES);

      const reply = await this.openclawClient.chat({
        botName: this.config.name,
        model: this.config.model,
        history,
        systemPrompt: this.config.systemPrompt,
      });

      // Record bot's own reply to local store
      this.store.insert({
        chatId,
        messageId: `self-${this.config.name}-${Date.now()}`,
        senderType: "bot",
        senderName: this.config.name,
        content: reply,
        timestamp: Date.now(),
      });

      // Send reply to Feishu
      await this.replyMessage(messageId, reply);
      console.log(`[${this.config.name}] Replied (${reply.length} chars)`);
    } catch (err) {
      console.error(`[${this.config.name}] Error handling message:`, err);
    }
  }

  /**
   * Determine if this bot should respond.
   */
  private shouldRespond(
    chatType: string,
    message: any,
    isBot: boolean
  ): boolean {
    // In p2p, always respond (unless from a bot)
    if (chatType === "p2p") return !isBot;

    // Group chat rules
    const mentions: any[] = message.mentions || [];

    if (isBot) {
      // Bot message: only respond if this bot is explicitly @-mentioned
      return this.isMentioned(mentions);
    }

    // Human message
    if (mentions.length === 0) {
      // No mentions → all bots respond
      return true;
    }

    // Check if any mention targets a known bot
    const anyBotMentioned = mentions.some((m: any) => {
      for (const bot of FeishuBot.allBots.values()) {
        if (m.id?.app_id === bot.config.appId) return true;
        if (bot.botOpenId && m.id?.open_id === bot.botOpenId) return true;
      }
      return false;
    });

    if (!anyBotMentioned) {
      // Mentions exist but none target a known bot → all bots respond
      return true;
    }

    // Some bot is mentioned → only respond if THIS bot is mentioned
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
