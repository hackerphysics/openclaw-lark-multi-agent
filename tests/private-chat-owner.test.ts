import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuBot } from "../src/feishu-bot.js";
import { MessageStore, type ChatInfo } from "../src/message-store.js";

process.env.OPENCLAW_LARK_MULTI_AGENT_AUTO_RETRY = "0";
const APP = "cli_1111111111111111";
const OTHER_APP = "cli_2222222222222222";
const CHAT = "oc_33333333333333333333333333333333";
const OLD = "VintageBot";
const CURRENT = "CurrentBot";
const dirs: string[] = [];
const stores = new Set<MessageStore>();
function cache(overrides: Partial<ChatInfo> = {}): ChatInfo {
  return { chatId: CHAT, chatType: "p2p", chatName: "Private fixture", members: "member", memberNames: "Human",
    ownerBot: OLD, freeDiscussion: false, verbose: true, discuss: false, discussMaxRounds: 7, locale: "en", updatedAt: Date.now(), ...overrides };
}
function fixture(path?: string, appId = APP, name = CURRENT) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), "lma-private-owner-"));
  if (dir) dirs.push(dir);
  const dbPath = path || join(dir!, "messages.db");
  const store = new MessageStore(dbPath); stores.add(store);
  const gateway: any = { getSessionInfo: vi.fn(async () => ({ session: { sessionId: "private-generation", totalTokens: 0 } })),
    ensureModel: vi.fn(async () => false), createSession: vi.fn(async () => {}), subscribeSession: vi.fn(async () => {}), onToolEvent: vi.fn(),
    chatSendWithContext: vi.fn(async (params: any) => { await params.onSendAttempt?.(); await params.onSubmitted?.("private-run"); return "Offline answer."; }),
    resetSession: vi.fn(async () => "ok"),
    injectAssistantMessage: vi.fn(async () => ({})) };
  const bot: any = new FeishuBot({ name, appId, appSecret: "offline-secret", model: "offline-model" }, gateway, store);
  bot.register();
  bot.ensureSession = vi.fn(async (chatId: string) => bot.getSessionKey(chatId));
  bot.addReaction = bot.removeReaction = vi.fn(async () => {});
  bot.sendLiveStatusCard = bot.replyLiveStatusCard = vi.fn(async () => "private-status");
  bot.patchLiveStatusCard = bot.patchLiveStatusDoneSummary = vi.fn(async () => {});
  bot.replyMessage = vi.fn(async () => "private-reply");
  bot.sendMessage = vi.fn(async () => "private-reply");
  bot.requestIdentity = vi.fn(async () => { throw new Error("offline identity probe forbidden"); });
  bot.client = { im: { chat: { get: vi.fn(async () => ({ data: { name: "Group fixture" } })) }, chatMembers: { get: vi.fn(async () => ({ data: { items: [] } })) } } };
  return { bot, store, gateway, dbPath };
}
function event(id = "om_private_event", chatType = "p2p", text = "A fresh question.") {
  return { sender: { sender_type: "user", sender_id: { open_id: "ou_44444444444444444444444444444444" } },
    message: { chat_id: CHAT, chat_type: chatType, message_id: id, message_type: "text", content: JSON.stringify({ text }), mentions: [] } };
}
function pin(store: MessageStore, value: unknown) {
  // Also permits the regression to run against the pre-fix source snapshot.
  const db = (store as any).db;
  if (!db.prepare("PRAGMA table_info(chat_info)").all().some((r: any) => r.name === "owner_app_id")) {
    db.exec("ALTER TABLE chat_info ADD COLUMN owner_app_id TEXT NOT NULL DEFAULT ''");
  }
  db.prepare("UPDATE chat_info SET owner_app_id=? WHERE chat_id=?").run(value, CHAT);
}
function close(store: MessageStore) { store.close(); stores.delete(store); }
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0;
  FeishuBot.getAllBots().clear(); (FeishuBot as any).seenBotChats.clear(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("private ownership through actual handleMessage and cache ordering", () => {
  it("reproduces the retired legacy label early return before business insertion", async () => {
    const h = fixture(); h.store.upsertChatInfo(cache());
    await h.bot.handleMessage(event());
    expect(h.store.hasBotProcessed(CURRENT, "om_private_event")).toBe(true);
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.store.getPendingTriggerIds(CURRENT, CHAT).size).toBe(0);
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it.each([0, 3_600_001])("admits a renamed owner with the same pinned app, irrespective of cache age=%s", async age => {
    const h = fixture(); h.store.upsertChatInfo(cache({ updatedAt: Date.now() - age })); pin(h.store, APP);
    await h.bot.handleMessage(event());
    expect(h.store.getRecent(CHAT).filter(row => row.senderType === "human").map(row => row.messageId)).toEqual(["om_private_event"]);
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    expect(h.store.getChatInfo(CHAT)?.ownerBot).toBe(CURRENT);
  });

  it("pins a new private chat to the receiving SDK app without any identity HTTP", async () => {
    const h = fixture();
    await h.bot.handleMessage(event());
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ chatType: "p2p", ownerBot: CURRENT, ownerAppId: APP });
    expect(h.gateway.chatSendWithContext).toHaveBeenCalledOnce();
    expect(h.bot.requestIdentity).not.toHaveBeenCalled();
    expect(h.bot.client.im.chat.get).not.toHaveBeenCalled();
  });

  it("backfills an exact matched legacy label without changing cached metadata", async () => {
    const h = fixture(); const before = cache({ ownerBot: CURRENT }); h.store.upsertChatInfo(before);
    await h.bot.handleMessage(event("matched", "p2p", "/help"));
    expect(h.store.getChatInfo(CHAT)).toEqual({ ...before, ownerAppId: APP, chairmanBot: "" });
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it.each([OLD, CURRENT, "OtherBot"])("refuses a different app pin even when owner label is %s and no such bot is registered", async ownerBot => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerBot, ownerAppId: OTHER_APP }));
    await h.bot.handleMessage(event());
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ ownerBot, ownerAppId: OTHER_APP });
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("keeps another active app's private isolation with the same display label", async () => {
    const h = fixture(); const other = fixture(h.dbPath, OTHER_APP, CURRENT);
    expect(FeishuBot.getAllBots().size).toBe(2);
    await h.bot.handleMessage(event("owner", "p2p", "/help"));
    await other.bot.handleMessage(event("foreign", "p2p", "/help"));
    expect(other.store.getMessageByMessageId("foreign")).toBeNull();
    expect(other.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.getChatInfo(CHAT)?.ownerAppId).toBe(APP);
  });

  it.each(["", "OtherBot", OLD])("does not claim an unpinned unmatched legacy label=%j from mentions or registry absence", async ownerBot => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerBot }));
    const input = event("untrusted-mentions", "p2p", "/help");
    input.message.mentions = [{ key: "@_user_1", name: CURRENT, id: { app_id: APP } }] as any;
    await h.bot.handleMessage(input);
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ ownerBot, ownerAppId: "" });
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it.each([" ", `${APP} `, "not an app", `{"appId":"${APP}"}`, Buffer.from(APP)])("refuses malformed pin %j instead of treating it as legacy", async value => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerBot: CURRENT })); pin(h.store, value);
    await h.bot.handleMessage(event());
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.store.getChatInfo(CHAT)?.ownerAppId).toEqual(value);
  });

  it.each(["", " ", `${APP} `])("never admits or creates a private owner with missing/malformed runtime app=%j", async appId => {
    const h = fixture(undefined, appId);
    await h.bot.handleMessage(event());
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.store.getChatInfo(CHAT)).toBeNull();
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it("does not normalize a missing/null pin in a malformed old schema into the empty legacy sentinel", async () => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerBot: CURRENT }));
    (h.store as any).db.exec("ALTER TABLE chat_info DROP COLUMN owner_app_id; ALTER TABLE chat_info ADD COLUMN owner_app_id TEXT");
    await h.bot.handleMessage(event());
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    expect(h.store.getChatInfo(CHAT)?.ownerAppId).toBeNull();
    expect(h.store.migrateLegacyP2pOwner(CHAT, CURRENT, CURRENT, APP)).toBe(false);
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
  });

  it("leaves group routing and cache refresh unowned and unchanged", async () => {
    const h = fixture();
    const input = event("group-event", "group", "@_user_1 /help");
    input.message.mentions = [{ key: "@_user_1", id: { app_id: APP } }] as any;
    await h.bot.handleMessage(input);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.bot.client.im.chat.get).toHaveBeenCalledOnce();
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ chatType: "group", chatName: "Group fixture", ownerBot: "", ownerAppId: "" });
    expect(h.store.claimP2pOwner(CHAT, CURRENT, APP)).toBe(false);
  });
});

describe("same-app private rename must not replay business effects", () => {
  it("does not execute an old name's processed reset ID through actual handleMessage; a fresh ID still works once", async () => {
    vi.useFakeTimers();
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerAppId: APP }));
    h.store.markBotProcessed(OLD, "om_old_reset");
    // No messages row: rejected commands also had durable name tombstones.
    const replay = h.bot.handleMessage(event("om_old_reset", "p2p", "/reset"));
    await vi.advanceTimersByTimeAsync(2_001); await replay;
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    await Promise.all([h.bot.handleMessage(event("om_fresh_help", "p2p", "/help")), h.bot.handleMessage(event("om_fresh_help", "p2p", "/help"))]);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
  });

  it("does not execute an actually handled reset again after renaming the same SDK app", async () => {
    vi.useFakeTimers(); const old = fixture(undefined, APP, OLD);
    const input = event("om_handled_reset", "p2p", "/reset");
    const first = old.bot.handleMessage(input);
    await vi.advanceTimersByTimeAsync(2_001); await first;
    expect(old.gateway.resetSession).toHaveBeenCalledOnce();
    expect(old.bot.replyMessage).toHaveBeenCalledOnce();
    close(old.store);
    const renamed = fixture(old.dbPath);
    const replay = renamed.bot.handleMessage(input);
    await vi.advanceTimersByTimeAsync(2_001); await replay;
    expect(renamed.gateway.resetSession).not.toHaveBeenCalled();
    expect(renamed.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(renamed.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("retains the pinned old-name proof when startup updates the label before any redelivery, across further renames", async () => {
    vi.useFakeTimers(); const h = fixture(); h.store.upsertChatInfo(cache({ ownerAppId: APP }));
    h.store.markBotProcessed(OLD, "om_legacy_tombstone");
    await h.bot.drainOnStartup();
    expect(h.store.getChatInfo(CHAT)?.ownerBot).toBe(CURRENT);
    close(h.store);
    for (const name of ["NextBot", "FinalBot"]) {
      const renamed = fixture(h.dbPath, APP, name); await renamed.bot.drainOnStartup();
      const replay = renamed.bot.handleMessage(event("om_legacy_tombstone", "p2p", "/reset"));
      await vi.advanceTimersByTimeAsync(2_001); await replay;
      expect(renamed.gateway.resetSession).not.toHaveBeenCalled();
      expect(renamed.gateway.chatSendWithContext).not.toHaveBeenCalled();
      expect(renamed.bot.replyMessage).not.toHaveBeenCalled();
      await renamed.bot.handleMessage(event(`om_fresh_${name}`, "p2p", "/help"));
      expect(renamed.bot.replyMessage).toHaveBeenCalledOnce();
      close(renamed.store);
    }
  });

  it.each([false, true])("keeps an owner-rejected input tombstoned after proof-based repair and rename (legacy marker=%s)", async legacyMarker => {
    vi.useFakeTimers(); const h = fixture(undefined, APP, OLD);
    h.store.upsertChatInfo(cache({ ownerBot: "UnresolvedOwner" }));
    if (legacyMarker) h.store.markBotProcessed(OLD, "om_rejected_reset");
    await h.bot.handleMessage(event("om_rejected_reset", "p2p", "/reset"));
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(h.store.getMessageCount(CHAT)).toBe(0);
    // The rejected receiver was NOT adopted as an owner alias. Its own stable
    // app tombstone, not name inference, must survive the later verified repair.
    expect((h.store as any).db.prepare("SELECT * FROM p2p_owner_aliases").all()).toEqual([]);
    close(h.store);
    const renamed = fixture(h.dbPath);
    expect(renamed.store.migrateLegacyP2pOwner(CHAT, "UnresolvedOwner", CURRENT, APP)).toBe(true);
    const replay = renamed.bot.handleMessage(event("om_rejected_reset", "p2p", "/reset"));
    await vi.advanceTimersByTimeAsync(2_001); await replay;
    expect(renamed.gateway.resetSession).not.toHaveBeenCalled();
    expect(renamed.bot.replyMessage).not.toHaveBeenCalled();
    await renamed.bot.handleMessage(event("om_fresh_after_rejection", "p2p", "/help"));
    expect(renamed.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it.each([false, true])("accepts an explicitly verified lost legacy alias in the operator pin transaction (already pinned=%s)", async alreadyPinned => {
    vi.useFakeTimers(); const h = fixture();
    h.store.upsertChatInfo(cache({ ownerBot: CURRENT, ownerAppId: alreadyPinned ? APP : "" }));
    h.store.markBotProcessed(OLD, "om_before_label_repair");
    const before = businessSnapshot(h.store);
    // The cache label was already repaired by an earlier operator. The fifth
    // argument represents separate original-account + old-scope proof, NOT a
    // guessed alias or an automatically parsed backup/history record.
    expect(h.store.migrateLegacyP2pOwner(CHAT, CURRENT, CURRENT, APP, OLD)).toBe(true);
    expect(h.store.migrateLegacyP2pOwner(CHAT, CURRENT, CURRENT, APP, OLD)).toBe(true);
    expect(businessSnapshot(h.store)).toEqual(before);
    expect((h.store as any).db.prepare("SELECT proof FROM p2p_owner_aliases WHERE app_id=? AND chat_id=? AND bot_name=?").get(APP, CHAT, OLD))
      .toEqual({ proof: "verified_migration" });
    const replay = h.bot.handleMessage(event("om_before_label_repair", "p2p", "/reset"));
    await vi.advanceTimersByTimeAsync(2_001); await replay;
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    await h.bot.handleMessage(event("om_fresh_operator_pin", "p2p", "/help"));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it("does not turn an idempotent operator call's unproven expected label into a historical alias", async () => {
    const h = fixture(); h.store.claimP2pOwner(CHAT, CURRENT, APP);
    h.store.markBotProcessed("UnprovenBot", "om_not_a_private_duplicate");
    expect(h.store.migrateLegacyP2pOwner(CHAT, "UnprovenBot", CURRENT, APP)).toBe(true);
    expect((h.store as any).db.prepare("SELECT 1 FROM p2p_owner_aliases WHERE bot_name='UnprovenBot'").get()).toBeUndefined();
    await h.bot.handleMessage(event("om_not_a_private_duplicate", "p2p", "/help"));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
  });

  it.each(["foreign-pin", "stale-owner"])("does not record a supplied alias when operator authorization fails: %s", mode => {
    const h = fixture();
    h.store.upsertChatInfo(cache({ ownerBot: CURRENT, ownerAppId: mode === "foreign-pin" ? OTHER_APP : "" }));
    const before = h.store.getChatInfo(CHAT);
    expect(h.store.migrateLegacyP2pOwner(CHAT, mode === "stale-owner" ? OLD : CURRENT, CURRENT, APP, OLD)).toBe(false);
    expect(h.store.getChatInfo(CHAT)).toEqual(before);
    expect((h.store as any).db.prepare("SELECT * FROM p2p_owner_aliases").all()).toEqual([]);
  });

  it("does not adopt history/mentions as aliases even when those names have processed markers", async () => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerBot: CURRENT, ownerAppId: APP }));
    h.store.insert({ chatId: CHAT, messageId: "om_unrelated_history", senderType: "bot", senderName: OLD, content: "Old display text", timestamp: 1 });
    h.store.markBotProcessed(OLD, "om_not_proven_by_history");
    const input = event("om_not_proven_by_history", "p2p", "/help");
    input.message.mentions = [{ name: OLD, id: { app_id: APP }, key: "@_user_1" }] as any;
    await h.bot.handleMessage(input);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect((h.store as any).db.prepare("SELECT 1 FROM p2p_owner_aliases WHERE bot_name=?").get(OLD)).toBeUndefined();
  });

  it("keeps verified alias scopes bound to their exact app and chat, not the global old-name ledger", async () => {
    vi.useFakeTimers(); const h = fixture(); h.store.upsertChatInfo(cache());
    h.store.markBotProcessed(OLD, "om_scoped_tombstone");
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(true);
    const otherChat = "oc_55555555555555555555555555555555";
    const other = fixture(h.dbPath, OTHER_APP, "DifferentBot");
    other.store.claimP2pOwner(otherChat, "DifferentBot", OTHER_APP);
    const foreign = event("om_scoped_tombstone", "p2p", "/help"); foreign.message.chat_id = otherChat;
    await other.bot.handleMessage(foreign);
    expect(other.bot.replyMessage).toHaveBeenCalledOnce();
    expect(other.store.getChatInfo(otherChat)?.ownerAppId).toBe(OTHER_APP);
    const ownReplay = h.bot.handleMessage(event("om_scoped_tombstone", "p2p", "/reset"));
    await vi.advanceTimersByTimeAsync(2_001); await ownReplay;
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
  });

  it("does not apply private aliases or app markers to the existing group name namespace", async () => {
    const h = fixture(); h.store.upsertChatInfo(cache());
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(true);
    h.store.markBotProcessed(OLD, "om_group_namespace");
    const group = event("om_group_namespace", "group", "@_user_1 /help");
    group.message.chat_id = "oc_66666666666666666666666666666666";
    group.message.mentions = [{ key: "@_user_1", id: { app_id: APP } }] as any;
    await h.bot.handleMessage(group); await h.bot.handleMessage(group);
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.store.hasBotProcessed(CURRENT, "om_group_namespace")).toBe(true);
    expect((h.store as any).db.prepare("SELECT * FROM p2p_processed_events WHERE message_id='om_group_namespace'").all()).toEqual([]);
  });

  it("atomically fences concurrent actual reset deliveries under different names of the same app", async () => {
    vi.useFakeTimers(); const first = fixture(); first.store.upsertChatInfo(cache({ ownerAppId: APP }));
    const second = fixture(first.dbPath, APP, "NextBot");
    const input = event("om_concurrent_reset", "p2p", "/reset");
    const work = Promise.all([first.bot.handleMessage(input), second.bot.handleMessage(input)]);
    await vi.advanceTimersByTimeAsync(2_001); await work;
    expect(first.gateway.resetSession.mock.calls.length + second.gateway.resetSession.mock.calls.length).toBe(1);
    expect(first.bot.replyMessage.mock.calls.length + second.bot.replyMessage.mock.calls.length).toBe(1);
    expect((first.store as any).db.prepare("SELECT COUNT(*) AS n FROM p2p_processed_events WHERE message_id=?").get(input.message.message_id)).toEqual({ n: 1 });
  });

  it("rolls back both private fences and aliases when legacy marker persistence fails before business effects", async () => {
    vi.useFakeTimers(); const h = fixture(); h.store.upsertChatInfo(cache({ ownerAppId: APP }));
    vi.spyOn(h.store, "tryMarkBotProcessed").mockImplementationOnce(() => { throw Object.assign(new Error("fixture busy"), { code: "SQLITE_BUSY" }); });
    const input = event("om_atomic_retry", "p2p", "/reset");
    await h.bot.handleMessage(input);
    expect(h.gateway.resetSession).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect((h.store as any).db.prepare("SELECT * FROM p2p_processed_events").all()).toEqual([]);
    expect((h.store as any).db.prepare("SELECT * FROM p2p_owner_aliases").all()).toEqual([]);
    const retry = h.bot.handleMessage(input); await vi.advanceTimersByTimeAsync(2_001); await retry;
    expect(h.gateway.resetSession).toHaveBeenCalledOnce();
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
  });
});

function businessSnapshot(store: MessageStore) {
  const db = (store as any).db;
  // The two new private ingress/alias tables are dedup metadata, not business
  // history. Keep comparing EVERY legacy table (including processed_events).
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('chat_info','p2p_processed_events','p2p_owner_aliases') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }: any) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function historicalState(h: ReturnType<typeof fixture>) {
  h.store.upsertChatInfo(cache({ updatedAt: 1234 }));
  const id = h.store.insert({ chatId: CHAT, messageId: "om_historical", senderType: "human", senderName: "Human", content: "Old already answered question", timestamp: 100 });
  const reply = h.store.insert({ chatId: CHAT, messageId: "om_historical_reply", senderType: "bot", senderName: OLD, content: "Old delivered answer", timestamp: 101 });
  h.store.markBotProcessed(OLD, "om_historical");
  h.store.markSynced(OLD, CHAT, reply);
  const db = (h.store as any).db;
  db.prepare("INSERT INTO message_sync(bot_name,chat_id,message_row_id,synced_at) VALUES(?,?,?,?)").run(OLD, CHAT, id, 100);
  db.prepare(`INSERT INTO delivery_outbox(session_key,chat_id,bot_name,source_type,source_id,delivery_key,content_hash,content,status,created_at,updated_at)
    VALUES(?,?,?,'fixture','old','old','old','Old delivered answer','delivered',100,101)`).run("lma-vintagebot-private-fixture", CHAT, OLD);
}

describe("operator CAS and additive database upgrade", () => {
  it("migrates only the exact verified legacy owner, idempotently and without business replay", async () => {
    const h = fixture(); historicalState(h);
    const before = h.store.getChatInfo(CHAT); const business = businessSnapshot(h.store);
    expect(h.store.migrateLegacyP2pOwner(CHAT, "WrongBot", CURRENT, APP)).toBe(false);
    expect(h.store.getChatInfo(CHAT)).toEqual(before);
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(true);
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(true);
    expect(h.store.getChatInfo(CHAT)).toEqual({ ...before, ownerBot: CURRENT, ownerAppId: APP });
    expect(businessSnapshot(h.store)).toEqual(business);
    await h.bot.drainOnStartup();
    expect(h.bot.ensureSession).toHaveBeenCalledWith(CHAT);
    expect(h.gateway.chatSendWithContext).not.toHaveBeenCalled();
    expect(h.bot.replyMessage).not.toHaveBeenCalled();
    expect(businessSnapshot(h.store)).toEqual(business);
    await h.bot.handleMessage(event("fresh-after-migration", "p2p", "/help"));
    expect(h.bot.replyMessage).toHaveBeenCalledOnce();
    expect(h.store.getMessageByMessageId("om_historical_reply")?.senderName).toBe(OLD);
  });

  it.each([OTHER_APP, APP, " "])("will not operator-rebind an already nonempty app pin=%j", appId => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerAppId: appId }));
    const before = h.store.getChatInfo(CHAT);
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(false);
    expect(h.store.getChatInfo(CHAT)).toEqual(before);
  });

  it("does not create missing rows, migrate groups, or accept empty source/destination identities", () => {
    const h = fixture();
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(false);
    h.store.upsertChatInfo(cache({ chatType: "group" }));
    expect(h.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(false);
    for (const args of [[CHAT, "", CURRENT, APP], [CHAT, OLD, "", APP], [CHAT, OLD, CURRENT, ""]]) {
      expect(h.store.migrateLegacyP2pOwner(...args as [string, string, string, string])).toBe(false);
    }
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ chatType: "group", ownerBot: OLD, ownerAppId: "" });
  });

  it("serializes competing app pins and refuses a stale migration after the winner commits", () => {
    const first = fixture(); first.store.upsertChatInfo(cache()); const second = fixture(first.dbPath, OTHER_APP, "OtherBot");
    const db = (first.store as any).db, otherDb = (second.store as any).db;
    otherDb.pragma("busy_timeout=0");
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => second.store.migrateLegacyP2pOwner(CHAT, OLD, "OtherBot", OTHER_APP)).toThrow(/locked/);
      db.prepare("UPDATE chat_info SET owner_bot=?,owner_app_id=? WHERE chat_id=? AND owner_app_id=''").run(CURRENT, APP, CHAT);
      db.exec("COMMIT");
    } catch (err) { if (db.inTransaction) db.exec("ROLLBACK"); throw err; }
    expect(second.store.migrateLegacyP2pOwner(CHAT, OLD, "OtherBot", OTHER_APP)).toBe(false);
    expect(second.store.claimP2pOwner(CHAT, "OtherBot", OTHER_APP)).toBe(false);
    expect(first.store.getChatInfo(CHAT)).toMatchObject({ ownerBot: CURRENT, ownerAppId: APP });
  });

  it("a fresh chat's first app pin also fences another connection with the same name", () => {
    const first = fixture(); const second = fixture(first.dbPath, OTHER_APP);
    expect(first.store.claimP2pOwner(CHAT, CURRENT, APP)).toBe(true);
    expect(second.store.claimP2pOwner(CHAT, CURRENT, OTHER_APP)).toBe(false);
    expect(second.store.getChatInfo(CHAT)?.ownerAppId).toBe(APP);
  });

  it("metadata upserts cannot overwrite the private identity or label", () => {
    const h = fixture(); h.store.claimP2pOwner(CHAT, CURRENT, APP);
    h.store.upsertChatInfo(cache({ ownerBot: "OtherBot", ownerAppId: OTHER_APP, chatName: "Refreshed metadata" }));
    expect(h.store.getChatInfo(CHAT)).toMatchObject({ ownerBot: CURRENT, ownerAppId: APP, chatName: "Refreshed metadata" });
  });

  it("adds the pin to a legacy database without guessing a retired label; upgrades repeat safely", () => {
    const h = fixture(); historicalState(h); const business = businessSnapshot(h.store);
    (h.store as any).db.exec("ALTER TABLE chat_info DROP COLUMN owner_app_id");
    close(h.store);
    const upgraded = fixture(h.dbPath);
    expect(upgraded.store.getChatInfo(CHAT)).toMatchObject({ ownerBot: OLD, ownerAppId: "", updatedAt: 1234 });
    expect(upgraded.store.claimP2pOwner(CHAT, CURRENT, APP)).toBe(false);
    expect(businessSnapshot(upgraded.store)).toEqual(business);
    expect(upgraded.store.migrateLegacyP2pOwner(CHAT, OLD, CURRENT, APP)).toBe(true);
    close(upgraded.store);
    const again = fixture(h.dbPath);
    expect(again.store.getChatInfo(CHAT)).toMatchObject({ ownerBot: CURRENT, ownerAppId: APP });
    expect(businessSnapshot(again.store)).toEqual(business);
  });

  it("persists owner pins across restart; startup authorizes the same app rename but refuses changed app", async () => {
    const h = fixture(); h.store.upsertChatInfo(cache({ ownerAppId: APP })); close(h.store);
    const renamed = fixture(h.dbPath);
    await renamed.bot.drainOnStartup();
    expect(renamed.bot.ensureSession).toHaveBeenCalledWith(CHAT);
    expect(renamed.store.getChatInfo(CHAT)).toMatchObject({ ownerBot: CURRENT, ownerAppId: APP });
    expect(renamed.store.getAllChatInfo()[0]?.ownerAppId).toBe(APP);
    close(renamed.store);
    const foreign = fixture(h.dbPath, OTHER_APP, CURRENT);
    await foreign.bot.drainOnStartup();
    expect(foreign.bot.ensureSession).not.toHaveBeenCalled();
    await foreign.bot.handleMessage(event("after-restart", "p2p", "/help"));
    expect(foreign.bot.replyMessage).not.toHaveBeenCalled();
    expect(foreign.store.getMessageCount(CHAT)).toBe(0);
  });
});
