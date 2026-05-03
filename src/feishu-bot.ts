import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore, ChatMessage } from "./message-store.js";

const MAX_BOT_STREAK = 10;
const MAX_CONTEXT_MESSAGES = 50;

/**
 * Manages a single Feishu bot instance: handles websocket connection and message routing.
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
      `[${this.config.name}] Bot started (appId: ${this.config.appId})`
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
      const chatType: string = message.chat_type; // "p2p" or "group"
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
      let text: string = content.text || "";
      const cleanText = this.cleanMentions(text);

      // --- Record ALL messages to store (regardless of whether we respond) ---
      const senderName = isBot
        ? this.resolveBotName(sender) || "UnknownBot"
        : sender?.sender_id?.open_id || "Unknown";
      
      this.store.insert({
        chatId,
        messageId,
        senderType: isBot ? "bot" : "human",
        senderName: isBot ? senderName : (this.resolveHumanName(sender) || senderName),
        content: cleanText,
        timestamp: Date.now(),
      });

      // Skip bot messages for response logic (already recorded above)
      if (isBot) return;

      // --- Determine if this bot should respond ---
      if (chatType === "group") {
        if (!this.shouldRespondInGroup(message)) return;
      }

      if (!cleanText.trim()) return;

      // --- Anti-loop check ---
      const streak = this.store.getBotStreak(chatId);
      if (streak >= MAX_BOT_STREAK) {
        console.log(
          `[${this.config.name}] Anti-loop: ${streak} consecutive bot messages in ${chatId}, waiting for human`
        );
        return;
      }

      console.log(
        `[${this.config.name}] Processing: "${cleanText.substring(0, 80)}..."`
      );

      // --- Build context from store and call OpenClaw ---
      const history = this.store.getRecent(chatId, MAX_CONTEXT_MESSAGES);
      const sessionKey = `lma-${this.config.name}-${chatId}`;

      const reply = await this.openclawClient.chat({
        botName: this.config.name,
        sessionKey,
        model: this.config.model,
        history,
        systemPrompt: this.config.systemPrompt,
      });

      // Record bot's own reply
      // (messageId will be filled after sending; use a synthetic one for now)
      const replyMsgId = `self-${this.config.name}-${Date.now()}`;
      this.store.insert({
        chatId,
        messageId: replyMsgId,
        senderType: "bot",
        senderName: this.config.name,
        content: reply,
        timestamp: Date.now(),
      });

      // Send reply
      await this.replyMessage(messageId, reply);
      console.log(`[${this.config.name}] Replied (${reply.length} chars)`);
    } catch (err) {
      console.error(`[${this.config.name}] Error handling message:`, err);
    }
  }

  /**
   * Determine if this bot should respond in a group chat.
   *
   * Rules:
   * 1. User message @-mentions any bot(s) → only mentioned bot(s) respond
   * 2. User message has no @-mention → all bots respond
   */
  private shouldRespondInGroup(message: any): boolean {
    const mentions: any[] = message.mentions || [];

    if (mentions.length === 0) {
      // No mentions → all bots respond
      return true;
    }

    // Check if ANY mention targets a known bot
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
    return mentions.some((m: any) => {
      if (m.id?.app_id === this.config.appId) return true;
      if (this.botOpenId && m.id?.open_id === this.botOpenId) return true;
      return false;
    });
  }

  /**
   * Try to resolve bot name from sender info by matching against known bots.
   */
  private resolveBotName(sender: any): string | null {
    const openId = sender?.sender_id?.open_id;
    if (openId) {
      const bot = FeishuBot.findByOpenId(openId);
      if (bot) return bot.config.name;
    }
    return null;
  }

  /**
   * Resolve human display name from sender.
   */
  private resolveHumanName(sender: any): string | null {
    return sender?.sender_id?.open_id || null;
  }

  /**
   * Remove @mention tags from text.
   */
  private cleanMentions(text: string): string {
    return text.replace(/@_user_\d+/g, "").trim();
  }

  /**
   * Reply to a message in Feishu.
   */
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
