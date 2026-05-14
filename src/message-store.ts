import Database from "better-sqlite3";
import { resolve } from "path";
import { mkdirSync } from "fs";

export type BotChatMode = "normal" | "free" | "mute";

export interface ChatInfo {
  chatId: string;
  chatType: "p2p" | "group";
  chatName: string;
  /** Comma-separated member open_ids */
  members: string;
  /** Comma-separated member names */
  memberNames: string;
  /** Which bot owns this chat (for p2p isolation) */
  ownerBot: string;
  /** Legacy chat-level free discussion flag; per-bot mode is authoritative. */
  freeDiscussion: boolean;
  verbose: boolean;
  discuss: boolean;
  discussMaxRounds: number;
  updatedAt: number;
}

export interface ChatMessage {
  id?: number;
  chatId: string;
  messageId: string; // Feishu message_id for dedup
  senderType: "human" | "bot";
  senderName: string; // human name or bot name (e.g. "Claude", "GPT")
  content: string;
  timestamp: number; // unix ms
}

export interface DeliveryOutboxItem {
  id?: number;
  sessionKey: string;
  chatId: string;
  botName: string;
  sourceType: string;
  sourceId: string;
  deliveryKey: string;
  contentHash: string;
  content: string;
  attachmentsJson: string;
  replyToMessageId: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
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

      CREATE TABLE IF NOT EXISTS chat_info (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL DEFAULT 'group',
        chat_name TEXT NOT NULL DEFAULT '',
        members TEXT NOT NULL DEFAULT '',
        member_names TEXT NOT NULL DEFAULT '',
        verbose INTEGER NOT NULL DEFAULT 0,
        discuss INTEGER NOT NULL DEFAULT 0,
        discuss_max_rounds INTEGER NOT NULL DEFAULT 3,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- Tracks which messages have been synced to each bot's OpenClaw session.
      CREATE TABLE IF NOT EXISTS sync_state (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        last_synced_msg_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Tracks which messages have been processed by each bot (multi-bot dedup).
      CREATE TABLE IF NOT EXISTS processed_events (
        bot_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (bot_name, message_id)
      );

      -- Tracks messages that should actively trigger a bot reply.
      -- Other unsynced messages remain local context and are sent only when a trigger arrives.
      CREATE TABLE IF NOT EXISTS pending_triggers (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_row_id INTEGER NOT NULL,
        PRIMARY KEY (bot_name, chat_id, message_row_id)
      );

      -- Tracks replies already delivered for a trigger message.
      -- Prevents duplicate user-visible replies after restarts/race conditions.
      CREATE TABLE IF NOT EXISTS delivered_replies (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        trigger_message_row_id INTEGER NOT NULL,
        delivered_at INTEGER NOT NULL,
        reply_message_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (bot_name, chat_id, trigger_message_row_id)
      );

      -- Per-bot, per-chat settings. A group can contain multiple bots, so settings
      -- like verbose/free discussion must not be shared globally at chat level.
      CREATE TABLE IF NOT EXISTS bot_chat_settings (
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        verbose INTEGER NOT NULL DEFAULT 0,
        free_discussion INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'normal',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_name, chat_id)
      );

      -- Durable delivery ledger for user-visible assistant outputs. All final
      -- text/attachment outputs should be inserted here first and dispatched
      -- once, regardless of whether they came from chat final, proactive
      -- session.message, subagent announce, or delayed error handling.
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        reply_to_message_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(bot_name, chat_id, delivery_key),
        UNIQUE(session_key, source_type, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_pending ON delivery_outbox(status, created_at);
    `);

    // Migration: add delivery_outbox delivery key columns if missing
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN delivery_key TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN reply_to_message_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    // Backfill stable keys for rows created by earlier outbox experiments before
    // creating indexes that reference the new columns.
    this.db.exec(`
      UPDATE delivery_outbox
      SET delivery_key = source_id
      WHERE delivery_key IS NULL OR delivery_key = '';
    `);
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_key ON delivery_outbox(bot_name, chat_id, delivery_key)`);
    } catch {
      // Existing duplicate experimental rows can prevent index creation in dev DB.
      // Fresh DBs still get the table-level UNIQUE constraint; dirty DBs still use
      // source unique + short-window content hash until cleaned.
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_outbox_content ON delivery_outbox(bot_name, chat_id, content_hash, created_at)`);

    // Migration: add delivery_outbox reply target if missing
    try {
      this.db.exec(`ALTER TABLE delivery_outbox ADD COLUMN reply_to_message_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add verbose column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN verbose INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: add discuss columns if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN discuss INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN discuss_max_rounds INTEGER NOT NULL DEFAULT 3`);
    } catch {
      // Column already exists
    }

    // Migration: add owner_bot column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN owner_bot TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Migration: add free_discussion column if missing
    try {
      this.db.exec(`ALTER TABLE chat_info ADD COLUMN free_discussion INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: make free discussion per-bot per-chat.
    try {
      this.db.exec(`ALTER TABLE bot_chat_settings ADD COLUMN free_discussion INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: replace independent free/mute booleans with one mutually exclusive mode.
    try {
      this.db.exec(`ALTER TABLE bot_chat_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'`);
    } catch {
      // Column already exists
    }
    this.db.exec(`
      UPDATE bot_chat_settings
      SET mode = 'free'
      WHERE free_discussion = 1 AND (mode IS NULL OR mode = '' OR mode = 'normal')
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

  getMessageId(messageId: string): number | null {
    const row = this.db.prepare(`SELECT id FROM messages WHERE message_id = ?`).get(messageId) as any;
    return row?.id || null;
  }

  markPendingTrigger(botName: string, chatId: string, messageRowId: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO pending_triggers (bot_name, chat_id, message_row_id)
      VALUES (?, ?, ?)
    `).run(botName, chatId, messageRowId);
  }

  getPendingTriggerIds(botName: string, chatId: string): Set<number> {
    const rows = this.db.prepare(`
      SELECT message_row_id FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ?
      ORDER BY message_row_id ASC
    `).all(botName, chatId) as any[];
    return new Set(rows.map((r) => Number(r.message_row_id)));
  }

  clearPendingTriggers(botName: string, chatId: string, upToId: number): void {
    this.db.prepare(`
      DELETE FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ? AND message_row_id <= ?
    `).run(botName, chatId, upToId);
  }

  clearPendingTrigger(botName: string, chatId: string, messageRowId: number): void {
    this.db.prepare(`
      DELETE FROM pending_triggers
      WHERE bot_name = ? AND chat_id = ? AND message_row_id = ?
    `).run(botName, chatId, messageRowId);
  }

  hasDeliveredReply(botName: string, chatId: string, triggerMessageRowId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM delivered_replies
      WHERE bot_name = ? AND chat_id = ? AND trigger_message_row_id = ?
    `).get(botName, chatId, triggerMessageRowId);
    return !!row;
  }

  markDeliveredReply(botName: string, chatId: string, triggerMessageRowId: number, replyMessageId: string = ''): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO delivered_replies (bot_name, chat_id, trigger_message_row_id, delivered_at, reply_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(botName, chatId, triggerMessageRowId, Date.now(), replyMessageId);
  }

  enqueueDelivery(item: Omit<DeliveryOutboxItem, "id" | "status" | "attempts" | "createdAt" | "updatedAt">): number | null {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO delivery_outbox
        (session_key, chat_id, bot_name, source_type, source_id, delivery_key, content_hash, content, attachments_json, reply_to_message_id, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(item.sessionKey, item.chatId, item.botName, item.sourceType, item.sourceId, item.deliveryKey, item.contentHash, item.content, item.attachmentsJson, item.replyToMessageId || '', now, now);
    return result.changes ? Number(result.lastInsertRowid) : null;
  }

  getDeliveryBySource(sessionKey: string, sourceType: string, sourceId: string): DeliveryOutboxItem | null {
    const row = this.db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE session_key = ? AND source_type = ? AND source_id = ?
    `).get(sessionKey, sourceType, sourceId) as any;
    return row ? this.mapDelivery(row) : null;
  }

  getPendingDeliveries(chatId?: string, botName?: string, maxCount: number = 20): DeliveryOutboxItem[] {
    if (chatId && botName) {
      const rows = this.db.prepare(`
        SELECT * FROM delivery_outbox
        WHERE status = 'pending' AND chat_id = ? AND bot_name = ?
        ORDER BY created_at ASC LIMIT ?
      `).all(chatId, botName, maxCount) as any[];
      return rows.map((r) => this.mapDelivery(r));
    }
    const rows = this.db.prepare(`
      SELECT * FROM delivery_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).all(maxCount) as any[];
    return rows.map((r) => this.mapDelivery(r));
  }

  hasRecentSimilarDelivery(botName: string, chatId: string, contentHash: string, windowMs: number): boolean {
    if (!contentHash) return false;
    const row = this.db.prepare(`
      SELECT 1 FROM delivery_outbox
      WHERE bot_name = ? AND chat_id = ? AND content_hash = ? AND created_at >= ? AND status IN ('pending', 'delivering', 'delivered')
      LIMIT 1
    `).get(botName, chatId, contentHash, Date.now() - windowMs);
    return !!row;
  }

  claimDelivery(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE delivery_outbox SET status = 'delivering', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(Date.now(), id);
    return result.changes === 1;
  }

  markDeliveryDelivered(id: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET status = 'delivered', updated_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  markDeliveryFailed(id: number): void {
    this.db.prepare(`
      UPDATE delivery_outbox SET status = 'failed', updated_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  private mapDelivery(row: any): DeliveryOutboxItem {
    return {
      id: row.id,
      sessionKey: row.session_key,
      chatId: row.chat_id,
      botName: row.bot_name,
      sourceType: row.source_type,
      sourceId: row.source_id,
      deliveryKey: row.delivery_key || row.source_id,
      contentHash: row.content_hash || '',
      content: row.content || '',
      attachmentsJson: row.attachments_json || '[]',
      replyToMessageId: row.reply_to_message_id || '',
      status: row.status,
      attempts: row.attempts || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET last_synced_msg_id = MAX(sync_state.last_synced_msg_id, excluded.last_synced_msg_id)
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
   * Count consecutive messages from one bot at the tail of a chat.
   *
   * Other bots do not consume this bot's anti-loop budget. Human messages reset
   * the streak. This lets multiple bots free-discuss without a global bot-streak
   * guard shutting everyone down after N total bot messages.
   */
  getBotStreak(chatId: string, botName: string): number {
    const rows = this.db.prepare(`
      SELECT sender_type, sender_name FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `).all(chatId) as any[];

    let count = 0;
    for (const r of rows) {
      if ((r as any).sender_type === "human") break;
      if ((r as any).sender_type === "bot" && (r as any).sender_name === botName) count++;
    }
    return count;
  }

  // --- Chat info ---

  upsertChatInfo(info: ChatInfo): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, members, member_names, verbose, free_discussion, owner_bot, discuss, discuss_max_rounds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        chat_name = excluded.chat_name,
        members = excluded.members,
        member_names = excluded.member_names,
        verbose = excluded.verbose,
        free_discussion = excluded.free_discussion,
        owner_bot = CASE WHEN excluded.owner_bot != '' THEN excluded.owner_bot ELSE chat_info.owner_bot END,
        discuss = CASE WHEN excluded.discuss != 0 THEN excluded.discuss ELSE chat_info.discuss END,
        discuss_max_rounds = CASE WHEN excluded.discuss_max_rounds != 3 THEN excluded.discuss_max_rounds ELSE chat_info.discuss_max_rounds END,
        updated_at = excluded.updated_at
    `).run(info.chatId, info.chatType, info.chatName, info.members, info.memberNames, info.verbose ? 1 : 0, info.freeDiscussion ? 1 : 0, info.ownerBot || '', info.discuss ? 1 : 0, info.discussMaxRounds || 3, info.updatedAt);
  }

  setFreeDiscussion(chatId: string, on: boolean): void {
    this.db.prepare(`UPDATE chat_info SET free_discussion = ? WHERE chat_id = ?`).run(on ? 1 : 0, chatId);
  }

  setVerbose(chatId: string, verbose: boolean): void {
    this.db.prepare(`
      UPDATE chat_info SET verbose = ? WHERE chat_id = ?
    `).run(verbose ? 1 : 0, chatId);
  }

  setDiscussMode(chatId: string, on: boolean): void {
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, discuss, discuss_max_rounds, updated_at)
      VALUES (?, 'group', '', ?, 3, ?)
      ON CONFLICT (chat_id) DO UPDATE SET discuss = excluded.discuss, updated_at = excluded.updated_at
    `).run(chatId, on ? 1 : 0, Date.now());
  }

  setDiscussMaxRounds(chatId: string, rounds: number): void {
    const normalized = Math.max(1, Math.min(10, Math.round(rounds)));
    this.db.prepare(`
      INSERT INTO chat_info (chat_id, chat_type, chat_name, discuss, discuss_max_rounds, updated_at)
      VALUES (?, 'group', '', 0, ?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET discuss_max_rounds = excluded.discuss_max_rounds, updated_at = excluded.updated_at
    `).run(chatId, normalized, Date.now());
  }

  setBotVerbose(botName: string, chatId: string, verbose: boolean): void {
    this.db.prepare(`
      INSERT INTO bot_chat_settings (bot_name, chat_id, verbose, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET
        verbose = excluded.verbose,
        updated_at = excluded.updated_at
    `).run(botName, chatId, verbose ? 1 : 0, Date.now());
  }

  getBotVerbose(botName: string, chatId: string): boolean {
    const row = this.db.prepare(`
      SELECT verbose FROM bot_chat_settings
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;
    return !!row?.verbose;
  }

  setBotMode(botName: string, chatId: string, mode: BotChatMode): void {
    const freeDiscussion = mode === "free" ? 1 : 0;
    this.db.prepare(`
      INSERT INTO bot_chat_settings (bot_name, chat_id, mode, free_discussion, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (bot_name, chat_id) DO UPDATE SET
        mode = excluded.mode,
        free_discussion = excluded.free_discussion,
        updated_at = excluded.updated_at
    `).run(botName, chatId, mode, freeDiscussion, Date.now());
  }

  getBotMode(botName: string, chatId: string): BotChatMode {
    const row = this.db.prepare(`
      SELECT mode, free_discussion FROM bot_chat_settings
      WHERE bot_name = ? AND chat_id = ?
    `).get(botName, chatId) as any;
    if (row?.mode === "free" || row?.mode === "mute" || row?.mode === "normal") return row.mode;
    return row?.free_discussion ? "free" : "normal";
  }

  setBotFreeDiscussion(botName: string, chatId: string, on: boolean): void {
    this.setBotMode(botName, chatId, on ? "free" : "normal");
  }

  getBotFreeDiscussion(botName: string, chatId: string): boolean {
    return this.getBotMode(botName, chatId) === "free";
  }

  getChatInfo(chatId: string): ChatInfo | null {
    const row = this.db.prepare(`SELECT * FROM chat_info WHERE chat_id = ?`).get(chatId) as any;
    if (!row) return null;
    return {
      chatId: row.chat_id,
      chatType: row.chat_type,
      chatName: row.chat_name,
      members: row.members,
      memberNames: row.member_names,
      ownerBot: row.owner_bot || '',
      freeDiscussion: !!row.free_discussion,
      verbose: !!row.verbose,
      discuss: !!row.discuss,
      discussMaxRounds: row.discuss_max_rounds || 3,
      updatedAt: row.updated_at,
    };
  }

  getAllChatInfo(): ChatInfo[] {
    const rows = this.db.prepare(`SELECT * FROM chat_info ORDER BY updated_at DESC`).all() as any[];
    return rows.map((r: any) => ({
      chatId: r.chat_id,
      chatType: r.chat_type,
      chatName: r.chat_name,
      members: r.members,
      memberNames: r.member_names,
      ownerBot: r.owner_bot || '',
      freeDiscussion: !!r.free_discussion,
      verbose: !!r.verbose,
      discuss: !!r.discuss,
      discussMaxRounds: r.discuss_max_rounds || 3,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Check if a message already exists in the store.
   */
  hasMessage(messageId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM messages WHERE message_id = ?`).get(messageId);
    return !!row;
  }

  /**
   * Get total message count for a chat.
   */
  getMessageCount(chatId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?`).get(chatId) as any;
    return row?.cnt || 0;
  }

  /**
   * Check if a specific bot has already processed a message.
   */
  hasBotProcessed(botName: string, messageId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM processed_events WHERE bot_name = ? AND message_id = ?`).get(botName, messageId);
    return !!row;
  }

  /**
   * Mark a message as processed by a specific bot.
   */
  markBotProcessed(botName: string, messageId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO processed_events (bot_name, message_id) VALUES (?, ?)`).run(botName, messageId);
  }

  close() {
    this.db.close();
  }
}
