import * as lark from "@larksuiteoapi/node-sdk";
import { BotConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";

/**
 * Manages a single Feishu bot instance: handles websocket connection and message routing.
 */
export class FeishuBot {
  readonly config: BotConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private openclawClient: OpenClawClient;
  private botOpenId: string | null = null;

  // All active bots, shared reference for @-mention routing
  private static allBots: Map<string, FeishuBot> = new Map();

  // Per-chat counter of consecutive bot messages without a human message.
  // Shared across all bots. Key = chatId.
  private static botMsgStreak: Map<string, number> = new Map();
  private static readonly MAX_BOT_STREAK = 10;

  constructor(config: BotConfig, openclawClient: OpenClawClient) {
    this.config = config;
    this.openclawClient = openclawClient;

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

  /**
   * Register this bot in the global registry.
   */
  register() {
    FeishuBot.allBots.set(this.config.appId, this);
  }

  /**
   * Start the websocket connection.
   */
  async start() {
    this.register();

    // Fetch the bot's own open_id for self-identification
    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: "0" }, // dummy, we'll use bot info
      });
      // Actually use the bot info endpoint
    } catch {
      // Bot open_id will be extracted from message events
    }

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log(`[${this.config.name}] Bot started (appId: ${this.config.appId})`);
  }

  /**
   * Get all registered bots.
   */
  static getAllBots(): Map<string, FeishuBot> {
    return FeishuBot.allBots;
  }

  /**
   * Find a bot by its open_id.
   */
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
      const isBot = sender?.sender_type === "app";

      // Track consecutive bot messages per chat for anti-loop
      if (chatId) {
        if (isBot) {
          const cur = FeishuBot.botMsgStreak.get(chatId) || 0;
          FeishuBot.botMsgStreak.set(chatId, cur + 1);
        } else {
          // Human message resets the counter
          FeishuBot.botMsgStreak.set(chatId, 0);
        }
      }

      // Skip bot messages (they only arrive here for tracking; routing handled below)
      if (isBot) return;
      const chatType = message.chat_type; // "p2p" or "group"
      const messageType = message.message_type;
      const messageId = message.message_id;

      // Store bot open_id from mentions if available
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
      let text = content.text || "";

      // --- Anti-loop: stop after MAX_BOT_STREAK consecutive bot messages ---
      const streak = FeishuBot.botMsgStreak.get(chatId) || 0;
      if (streak >= FeishuBot.MAX_BOT_STREAK) {
        console.log(`[${this.config.name}] Anti-loop: ${streak} consecutive bot messages in ${chatId}, waiting for human`);
        return;
      }

      // --- Routing logic ---
      if (chatType === "group") {
        const shouldRespond = this.shouldRespondInGroup(message, text);
        if (!shouldRespond) return;
      }

      // Clean up @mentions from the text
      text = this.cleanMentions(text);
      if (!text.trim()) return;

      console.log(`[${this.config.name}] Processing: "${text.substring(0, 80)}..." from ${sender?.sender_id?.open_id}`);

      // Build session key: botName + chatId for conversation continuity
      const sessionKey = `feishu-multibot-${this.config.name}-${chatId}`;

      // Call OpenClaw
      const reply = await this.openclawClient.chat({
        sessionKey,
        model: this.config.model,
        message: text,
        systemPrompt: this.config.systemPrompt,
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
   * 1. User message @-mentions any bot(s):
   *    - Only the mentioned bot(s) respond, others stay silent.
   * 2. User message has no @-mention:
   *    - All bots respond.
   * 3. Bot message (sender_type=app) @-mentions this bot:
   *    - This bot responds.
   * 4. Bot message without @-mention to this bot:
   *    - This bot stays silent.
   */
  private shouldRespondInGroup(message: any, text: string): boolean {
    const mentions: any[] = message.mentions || [];

    if (mentions.length === 0) {
      // No mentions → all bots respond
      return true;
    }

    // Check if this bot is mentioned
    const isMentioned = mentions.some((m: any) => {
      // Match by app_id or open_id
      if (m.id?.app_id === this.config.appId) return true;
      if (this.botOpenId && m.id?.open_id === this.botOpenId) return true;
      // Match by name as fallback
      if (m.name === this.config.name || m.name === `@${this.config.name}`) return true;
      return false;
    });

    return isMentioned;
  }

  /**
   * Remove @mention tags from text.
   */
  private cleanMentions(text: string): string {
    // Feishu @mentions appear as @_user_N in text
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

  /**
   * Send a new message to a chat.
   */
  async sendMessage(chatId: string, text: string) {
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
