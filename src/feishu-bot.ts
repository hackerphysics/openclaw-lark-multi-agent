import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";

const MAX_BOT_STREAK = 10;

/**
 * Manages a single Feishu bot instance.
 *
 * Each bot owns an OpenClaw session (full agent pipeline).
 * Non-responding messages are injected as context via chat.inject.
 * When the bot needs to respond, chat.send triggers a full agent run.
 */
export class FeishuBot {
  readonly config: BotConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private openclawClient: OpenClawClient;
  private store: MessageStore;
  private botOpenId: string | null = null;
  private sessionKey: string;

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
   * Initialize the OpenClaw session for this bot and start WS connection.
   */
  async start() {
    this.register();

    // Create or ensure session exists with the right model
    try {
      await this.openclawClient.createSession({
        key: this.sessionKey,
        model: this.config.model,
        label: `LMA: ${this.config.name}`,
      });
      console.log(
        `[${this.config.name}] Session created: ${this.sessionKey} (${this.config.model})`
      );
    } catch (err: any) {
      // Session may already exist; try patching the model
      try {
        await this.openclawClient.patchSession({
          key: this.sessionKey,
          model: this.config.model,
          label: `LMA: ${this.config.name}`,
        });
        console.log(
          `[${this.config.name}] Session patched: ${this.sessionKey} (${this.config.model})`
        );
      } catch (patchErr: any) {
        console.error(
          `[${this.config.name}] Failed to create/patch session:`,
          patchErr.message
        );
      }
    }

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

      // --- Record to local store (all messages, for anti-loop tracking) ---
      const senderName = isBot
        ? this.resolveBotName(sender) || "UnknownBot"
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
      const shouldRespond = this.shouldRespond(chatType, message, isBot);

      if (shouldRespond) {
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

        // Send to OpenClaw session → full agent pipeline
        const reply = await this.openclawClient.chatSend({
          sessionKey: this.sessionKey,
          message: this.formatIncomingMessage(senderName, cleanText, isBot),
          deliver: false, // We handle delivery ourselves
        });

        // Record bot reply
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
      } else {
        // Not responding, but inject the message as context into our session
        // so the bot knows what's happening when it does respond next time
        const label = isBot ? `[${senderName}]` : `[User: ${senderName}]`;
        await this.openclawClient.chatInject({
          sessionKey: this.sessionKey,
          message: `${label}: ${cleanText}`,
          label: `context from ${senderName}`,
        });
      }
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

  /**
   * Format the incoming message for the agent session.
   */
  private formatIncomingMessage(
    senderName: string,
    text: string,
    isBot: boolean
  ): string {
    if (isBot) {
      return `[${senderName} (AI)]: ${text}`;
    }
    return text;
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
    // TODO: resolve actual user name via Feishu API
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
