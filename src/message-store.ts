import Database from "better-sqlite3";
import { resolve } from "path";
import { mkdirSync } from "fs";

export interface ChatMessage {
  id?: number;
  chatId: string;
  messageId: string; // Feishu message_id for dedup
  senderType: "human" | "bot";
  senderName: string; // human name or bot name (e.g. "Claude", "GPT")
  content: string;
  timestamp: number; // unix ms
}

export class MessageStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || resolve(process.cwd(), "data", "messages.db");
    const dir = resolve(path, "..");
    mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT UNIQUE NOT NULL,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);

      -- Tracks which messages have been synced to each bot's OpenClaw session.
      -- If a message id is NOT in this table for a given bot, it hasn't been seen by that session yet.
      CREATE TABLE IF NOT EXISTS sync_state (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        last_synced_msg_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_name, chat_id)
      );
    `);
  }

  /**
   * Insert a message. Returns the auto-increment id, or -1 if duplicate.
   */
  insert(msg: ChatMessage): number {
    try {
      const result = this.db.prepare(`
        INSERT INTO messages (chat_id, message_id, sender_type, sender_name, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(msg.chatId, msg.messageId, msg.senderType, msg.senderName, msg.content, msg.timestamp);
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return -1;
      throw err;
    }
  }

  /**
   * Get messages that haven't been synced to a bot's session yet.
   * Returns messages ordered by timestamp ascending.
   */
  getUnsyncedMessages(
    botName: string,
    chatId: string,
    maxCount: number = 50
  ): ChatMessage[] {
    const row = this.db.prepare(`
      SELECT last_synced_msg_id FROM sync_state
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;

    const lastId = row?.last_synced_msg_id || 0;

    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND id > ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(chatId, lastId, maxCount) as any[];

    return rows.map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  /**
   * Mark all messages up to (and including) the given id as synced for a bot.
   */
  markSynced(botName: string, chatId: string, upToId: number): void {
    this.db.prepare(`
      INSERT INTO sync_state (bot_name, chat_id, last_synced_msg_id)
      VALUES (?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET last_synced_msg_id = excluded.last_synced_msg_id
    `).run(botName, chatId, upToId);
  }

  /**
   * Get recent messages for a chat, ordered by timestamp ascending.
   */
  getRecent(chatId: string, maxCount: number = 50): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chatId, maxCount) as any[];

    return rows.reverse().map((r: any) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  /**
   * Count consecutive bot messages at the tail of a chat.
   */
  getBotStreak(chatId: string): number {
    const rows = this.db.prepare(`
      SELECT sender_type FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `).all(chatId) as any[];

    let count = 0;
    for (const r of rows) {
      if ((r as any).sender_type === "bot") count++;
      else break;
    }
    return count;
  }

  close() {
    this.db.close();
  }
}
