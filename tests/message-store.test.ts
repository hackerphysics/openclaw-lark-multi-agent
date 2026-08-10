import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/message-store.js";

function withStore(fn: (store: MessageStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "olma-store-"));
  const store = new MessageStore(join(dir, "messages.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MessageStore", () => {
  it("deduplicates messages and returns the existing id", () => withStore((store) => {
    const id = store.insert({ chatId: "c1", messageId: "m1", senderType: "human", senderName: "u", content: "hello", timestamp: 1 });
    expect(id).toBeGreaterThan(0);
    expect(store.insert({ chatId: "c1", messageId: "m1", senderType: "human", senderName: "u", content: "hello", timestamp: 2 })).toBe(-1);
    expect(store.getMessageId("m1")).toBe(id);
  }));

  it("excludes recalled messages from future unsynced context", () => withStore((store) => {
    const keepId = store.insert({ chatId: "c1", messageId: "keep", senderType: "human", senderName: "u", content: "keep", timestamp: 1 });
    const recalledId = store.insert({ chatId: "c1", messageId: "recall", senderType: "human", senderName: "u", content: "recall", timestamp: 2 });
    store.markMessageRecalled("recall", "c1", 123, "message_owner");
    expect(store.isMessageRecalled("recall")).toBe(true);
    expect(store.getUnsyncedMessages("GPT", "c1").map((m) => m.id)).toEqual([keepId]);
    expect(recalledId).toBeGreaterThan(0);
  }));

  it("returns pending trigger messages even when sync cursor moved past them", () => withStore((store) => {
    const oldId = store.insert({ chatId: "c1", messageId: "old", senderType: "human", senderName: "u", content: "old", timestamp: 1 });
    const laterId = store.insert({ chatId: "c1", messageId: "later", senderType: "human", senderName: "u", content: "later", timestamp: 2 });
    store.markPendingTrigger("GPT", "c1", oldId);
    store.markSynced("GPT", "c1", laterId);
    expect(store.getUnsyncedMessages("GPT", "c1")).toEqual([]);
    expect(store.getPendingTriggerMessages("GPT", "c1").map((m) => m.id)).toEqual([oldId]);
  }));

  it("tracks per-message sync independently of the legacy high-water mark", () => withStore((store) => {
    const a = store.insert({ chatId: "c1", messageId: "a", senderType: "human", senderName: "u", content: "a", timestamp: 1 });
    const b = store.insert({ chatId: "c1", messageId: "b", senderType: "bot", senderName: "GPT", content: "b", timestamp: 2 });
    const c = store.insert({ chatId: "c1", messageId: "c", senderType: "human", senderName: "u", content: "c", timestamp: 3 });

    store.markSynced("Claude", "c1", c);
    expect(store.getUnsyncedMessagesForBot("Claude", "c1", c).map((m) => m.id)).toEqual([a, b, c]);

    store.markMessagesSynced("Claude", "c1", [a, c], "batch-1");
    expect(store.getUnsyncedMessagesForBot("Claude", "c1", c).map((m) => m.id)).toEqual([b]);
    expect(store.getUnsyncedMessagesForBot("GPT", "c1", c).map((m) => m.id)).toEqual([a, b, c]);
  }));

  it("keeps pending triggers separate from context messages", () => withStore((store) => {
    const contextId = store.insert({ chatId: "c1", messageId: "ctx", senderType: "human", senderName: "u", content: "context", timestamp: 1 });
    const triggerId = store.insert({ chatId: "c1", messageId: "trg", senderType: "human", senderName: "u", content: "trigger", timestamp: 2 });
    store.markPendingTrigger("GPT", "c1", triggerId);

    expect(store.getUnsyncedMessages("GPT", "c1").map((m) => m.id)).toEqual([contextId, triggerId]);
    expect([...store.getPendingTriggerIds("GPT", "c1")]).toEqual([triggerId]);

    store.clearPendingTrigger("GPT", "c1", triggerId);
    expect([...store.getPendingTriggerIds("GPT", "c1")]).toEqual([]);

    store.markPendingTrigger("GPT", "c1", contextId);
    store.markPendingTrigger("GPT", "c1", triggerId);
    store.clearPendingTriggers("GPT", "c1", contextId);
    expect([...store.getPendingTriggerIds("GPT", "c1")]).toEqual([triggerId]);
  }));

  it("tracks per-bot chat seen/unavailability and recovers when a bot is re-added", () => withStore((store) => {
    expect(store.hasBotSeenInChat("Ghost", "chat1")).toBe(false);
    expect(store.isBotUnavailableInChat("Ghost", "chat1")).toBe(false);
    store.markBotUnavailableInChat("Ghost", "chat1", "code=230002 Bot/User can NOT be out of the chat");
    expect(store.isBotUnavailableInChat("Ghost", "chat1")).toBe(true);
    store.markBotSeenInChat("Ghost", "chat1");
    expect(store.hasBotSeenInChat("Ghost", "chat1")).toBe(true);
    expect(store.isBotUnavailableInChat("Ghost", "chat1")).toBe(false);
  }));

  it("deduplicates and claims delivery outbox items", () => withStore((store) => {
    const base = {
      sessionKey: "lma-gpt-chat1",
      chatId: "chat1",
      botName: "GPT",
      sourceType: "assistant_visible",
      sourceId: "s1",
      deliveryKey: "trigger:1",
      contentHash: "hash1",
      content: "hello",
      attachmentsJson: "[]",
      replyToMessageId: "m1",
      deliveryMode: "patch_live_status" as const,
      targetMessageId: "live-1",
      deliveryMetaJson: JSON.stringify({ toolCalls: 4, elapsed: "0:42", model: "model-GPT", locale: "zh" }),
    };
    const id1 = store.enqueueDelivery(base)!;
    const id2 = store.enqueueDelivery({ ...base, sourceId: "s2" });
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeNull();
    const pending = store.getPendingDeliveries("chat1", "GPT");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      deliveryMode: "patch_live_status",
      targetMessageId: "live-1",
    });
    expect(JSON.parse(pending[0].deliveryMetaJson || "{}")).toMatchObject({ toolCalls: 4, model: "model-GPT" });
    expect(store.claimDelivery(id1)).toBe(true);
    expect(store.claimDelivery(id1)).toBe(false);
    store.markDeliveryDelivered(id1);
    expect(store.getPendingDeliveries("chat1", "GPT")).toHaveLength(0);
    expect(store.hasRecentSimilarDelivery("GPT", "chat1", "hash1", 60_000)).toBe(true);
  }));

  it("persists delivery stage checkpoints and retries failed in-flight rows", () => withStore((store) => {
    const id = store.enqueueDelivery({
      sessionKey: "s", chatId: "c", botName: "GPT", sourceType: "assistant_visible",
      sourceId: "stage", deliveryKey: "stage", contentHash: "h", content: "answer",
      attachmentsJson: JSON.stringify([{ path: "/a" }, { path: "/b" }]), replyToMessageId: "m",
    })!;
    expect(store.claimDelivery(id)).toBe(true);
    store.markDeliveryTextDelivered(id);
    store.markDeliveryAttachmentCursor(id, 1);
    expect(store.retryDelivery(id, 5)).toBe(true);
    const pending = store.getPendingDeliveries("c", "GPT")[0];
    expect(pending).toMatchObject({ textDelivered: true, attachmentCursor: 1, status: "pending" });
  }));

  it("atomically checkpoints fallback text together with pending card cleanup", () => withStore((store) => {
    const id = store.enqueueDelivery({
      sessionKey: "s", chatId: "c", botName: "GPT", sourceType: "assistant_visible",
      sourceId: "fallback", deliveryKey: "fallback", contentHash: "h", content: "answer",
      attachmentsJson: "[]", replyToMessageId: "m", deliveryMode: "patch_live_status",
      targetMessageId: "live-1", deliveryMetaJson: "{}",
    })!;
    expect(store.claimDelivery(id)).toBe(true);
    store.markDeliveryTextDeliveredWithCleanup(id);
    expect(store.getDeliveryByKey("GPT", "c", "fallback")).toMatchObject({
      textDelivered: true,
      cleanupPending: true,
      status: "delivering",
    });
  }));

  it("reconciles legacy duplicate delivery keys and restores uniqueness", () => withStore((store) => {
    const db = (store as any).db;
    db.exec("DROP INDEX IF EXISTS idx_delivery_outbox_key");
    db.exec("PRAGMA foreign_keys=OFF");
    // Simulate a dirty legacy DB that predates the stable unique index.
    const now = Date.now();
    db.prepare(`INSERT INTO delivery_outbox
      (session_key,chat_id,bot_name,source_type,source_id,delivery_key,content_hash,content,attachments_json,reply_to_message_id,status,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'delivered',0,?,?)`).run("s2","c","GPT","assistant_visible","legacy-dup","stage","h2","dup","[]","m",now,now);
    db.exec(`DELETE FROM delivery_outbox WHERE id NOT IN (SELECT MIN(id) FROM delivery_outbox GROUP BY bot_name,chat_id,delivery_key)`);
    db.exec(`CREATE UNIQUE INDEX idx_delivery_outbox_key ON delivery_outbox(bot_name, chat_id, delivery_key)`);
    const id = store.enqueueDelivery({
      sessionKey: "s3", chatId: "c", botName: "GPT", sourceType: "assistant_visible",
      sourceId: "third", deliveryKey: "stage", contentHash: "h3", content: "third",
      attachmentsJson: "[]", replyToMessageId: "m",
    });
    expect(id).toBeNull();
    expect(store.getDeliveryByKey("GPT", "c", "stage")).toBeTruthy();
  }));

  it("detects recent overlapping deliveries with matching attachments", () => withStore((store) => {
    const base = {
      sessionKey: "lma-gpt-chat1",
      chatId: "chat1",
      botName: "GPT",
      sourceType: "assistant_visible",
      sourceId: "s1",
      deliveryKey: "trigger:1",
      contentHash: "hash1",
      content: "我先说明一下。最终结果是 ABC。",
      attachmentsJson: "[]",
      replyToMessageId: "m1",
    };
    store.enqueueDelivery(base);
    expect(store.hasRecentOverlappingDelivery("GPT", "chat1", "最终结果是 ABC。", "[]", 60_000, 8)).toBe(true);
    expect(store.hasRecentOverlappingDelivery("GPT", "chat1", "OK", "[]", 60_000, 8)).toBe(false);
    expect(store.hasRecentOverlappingDelivery("GPT", "chat1", "最终结果是 ABC。", JSON.stringify([{ type: "file", path: "/x" }]), 60_000, 8)).toBe(false);
  }));

  it("tracks delivered replies idempotently", () => withStore((store) => {
    expect(store.hasDeliveredReply("GPT", "c1", 42)).toBe(false);
    store.markDeliveredReply("GPT", "c1", 42, "reply-1");
    store.markDeliveredReply("GPT", "c1", 42, "reply-2");
    expect(store.hasDeliveredReply("GPT", "c1", 42)).toBe(true);
  }));

  it("stores verbose per bot per chat", () => withStore((store) => {
    store.setBotVerbose("GPT", "group", true);
    expect(store.getBotVerbose("GPT", "group")).toBe(true);
    expect(store.getBotVerbose("Gemini", "group")).toBe(false);
    store.setBotVerbose("GPT", "group", false);
    expect(store.getBotVerbose("GPT", "group")).toBe(false);
  }));

  it("stores mutually exclusive modes per bot per chat", () => withStore((store) => {
    expect(store.getBotMode("GPT", "group")).toBe("normal");
    store.setBotMode("GPT", "group", "free");
    expect(store.getBotMode("GPT", "group")).toBe("free");
    expect(store.getBotFreeDiscussion("GPT", "group")).toBe(true);
    expect(store.getBotMode("Gemini", "group")).toBe("normal");
    store.setBotMode("GPT", "group", "mute");
    expect(store.getBotMode("GPT", "group")).toBe("mute");
    expect(store.getBotFreeDiscussion("GPT", "group")).toBe(false);
    store.setBotFreeDiscussion("GPT", "group", false);
    expect(store.getBotMode("GPT", "group")).toBe("normal");
  }));

  it("counts bot streak per bot and resets on human messages", () => withStore((store) => {
    store.insert({ chatId: "c1", messageId: "h1", senderType: "human", senderName: "u", content: "start", timestamp: 1 });
    store.insert({ chatId: "c1", messageId: "g1", senderType: "bot", senderName: "GPT", content: "g1", timestamp: 2 });
    store.insert({ chatId: "c1", messageId: "c1", senderType: "bot", senderName: "Claude", content: "c1", timestamp: 3 });
    store.insert({ chatId: "c1", messageId: "g2", senderType: "bot", senderName: "GPT", content: "g2", timestamp: 4 });
    store.insert({ chatId: "c1", messageId: "d1", senderType: "bot", senderName: "DeepSeek", content: "d1", timestamp: 5 });
    expect(store.getBotStreak("c1", "GPT")).toBe(2);
    expect(store.getBotStreak("c1", "Claude")).toBe(1);
    expect(store.getBotStreak("c1", "DeepSeek")).toBe(1);
    store.insert({ chatId: "c1", messageId: "h2", senderType: "human", senderName: "u", content: "reset", timestamp: 6 });
    expect(store.getBotStreak("c1", "GPT")).toBe(0);
  }));

  it("preserves p2p owner when upserting chat info without owner", () => withStore((store) => {
    store.upsertChatInfo({ chatId: "p2p", chatType: "p2p", chatName: "dm", members: "", memberNames: "", ownerBot: "GPT", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: 1 });
    store.upsertChatInfo({ chatId: "p2p", chatType: "p2p", chatName: "dm2", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 10, updatedAt: 2 });
    expect(store.getChatInfo("p2p")?.ownerBot).toBe("GPT");
  }));
});
