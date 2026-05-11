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
    store.upsertChatInfo({ chatId: "p2p", chatType: "p2p", chatName: "dm", members: "", memberNames: "", ownerBot: "GPT", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 3, updatedAt: 1 });
    store.upsertChatInfo({ chatId: "p2p", chatType: "p2p", chatName: "dm2", members: "", memberNames: "", ownerBot: "", freeDiscussion: false, verbose: false, discuss: false, discussMaxRounds: 3, updatedAt: 2 });
    expect(store.getChatInfo("p2p")?.ownerBot).toBe("GPT");
  }));
});
