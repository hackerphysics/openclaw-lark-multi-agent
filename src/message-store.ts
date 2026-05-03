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
    `);
  }

  /**
   * Insert a message. Returns false if duplicate (message_id already exists).
   */
  insert(msg: ChatMessage): boolean {
    try {
      this.db.prepare(`
        INSERT INTO messages (chat_id, message_id, sender_type, sender_name, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(msg.chatId, msg.messageId, msg.senderType, msg.senderName, msg.content, msg.timestamp);
      return true;
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return false;
      throw err;
    }
  }

  /**
   * Get recent messages for a chat, ordered by timestamp ascending.
   * @param maxCount Maximum number of messages to return.
   */
  getRecent(chatId: string, maxCount: number = 50): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chatId, maxCount) as any[];

    return rows.reverse().map((r) => ({
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
   * Count consecutive bot messages at the tail of a chat (no human in between).
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
      if (r.sender_type === "bot") count++;
      else break;
    }
    return count;
  }

  close() {
    this.db.close();
  }
}
