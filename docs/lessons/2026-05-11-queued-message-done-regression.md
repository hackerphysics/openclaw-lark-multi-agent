---
status: active
importance: essential
category: lessons
tags: [regression, queue, pending-triggers, sync-state, reactions]
last_reviewed: 2026-05-11
---

# Queued message marked DONE before processing

## Summary

A regression caused the second of two consecutive human messages to be marked `DONE` without being processed.

The scenario:

1. A user sends message A.
2. The bot starts an OpenClaw run for A and becomes busy.
3. The user sends message B while A is still running.
4. B is queued and shows a waiting reaction.
5. A finishes.
6. B is incorrectly marked `DONE` even though no OpenClaw run processed it.

This previously existed, was fixed once, and then reappeared after later queue/discussion-mode changes. Treat this as a high-risk regression class.

## Impact

User-visible behavior:

- The second message looked completed in Feishu.
- The bot never answered the second message.
- The database could contain a stale `pending_triggers` row that was no longer visible to `getUnsyncedMessages()` because `sync_state` had advanced beyond it.

Concrete report:

- Chat: `oc_f8fff0533dc355b5dd7c9ba20d7ee7c7`
- User observed: “连续发两条消息，第一条正在处理，第二条等待。第一条处理完成之后，直接把第二条标记成了 done，没有处理。”

## Root Cause

Two invariants were violated.

### Invariant 1: pending triggers must remain visible

If `pending_triggers` contains row `X`, then `sync_state.last_synced_msg_id` must not advance past `X` before `X` has been processed or explicitly cleared.

Broken behavior:

```ts
const maxId = Math.max(...allUnsynced.map((m) => m.id || 0));
store.markSynced(botName, chatId, maxId);
store.clearPendingTriggers(botName, chatId, maxId);
```

Later, after inserting the bot reply, the code could mark the bot reply row as synced. If message B arrived during the run, the bot reply row could be after B, so `sync_state` advanced beyond B.

Result: B remained in `pending_triggers`, but `getUnsyncedMessages()` started after B and could no longer fetch it.

### Invariant 2: only processed trigger rows may be marked DONE

A reaction can be changed to `DONE` only when the corresponding message row was actually included in `humanUnsynced` for the current run.

Broken behavior:

```ts
const pendingAcks = pendingAckMessages.get(chatId) || [];
for (const ack of pendingAcks) {
  removeReaction(ack.messageId, ack.emoji);
  addReaction(ack.messageId, "DONE");
}
pendingAckMessages.set(chatId, []);
```

This changed every pending ack in the chat to `DONE`, including messages that arrived while the current OpenClaw run was already in flight.

## Fix

The fix restored row-level accounting.

### Reaction state now includes row id

```ts
pendingAckMessages: Map<string, { messageId: string; emoji: string; rowId: number }[]>
```

When a message is queued while the bot is busy, its row id is stored with the ack state.

### DONE only for processed trigger rows

At the start of a run, the bridge snapshots the trigger rows actually processed:

```ts
const processedTriggerIds = new Set(
  humanUnsynced.map((m) => m.id || 0).filter(Boolean)
);
```

At the end of the run:

```ts
for (const ack of pendingAcks) {
  if (processedTriggerIds.has(ack.rowId)) {
    removeReaction(ack.messageId, ack.emoji);
    addReaction(ack.messageId, "DONE");
  } else {
    remainingAcks.push(ack);
  }
}
```

Queued messages that arrived mid-run keep their waiting reaction and are acknowledged only after their own trigger row is processed.

### Sync no longer advances past earlier pending triggers

After inserting a bot reply, the bridge checks whether there are earlier pending triggers before advancing sync to the reply row:

```ts
const remainingPending = store.getPendingTriggerIds(botName, chatId);
const hasEarlierPending = Array.from(remainingPending).some((id) => id <= replyId);
if (!hasEarlierPending) store.markSynced(botName, chatId, replyId);
```

## Tests Added

A regression test was added:

```ts
does not mark queued mid-run messages DONE or synced before processing
```

The test simulates:

1. message A starts a run;
2. the OpenClaw call is held open;
3. message B arrives while busy;
4. A completes;
5. B must trigger a second OpenClaw call;
6. B may only receive `DONE` after that second call.

## Prevention

### Required review checklist for queue/sync changes

Any change touching these symbols is high-risk:

- `processQueueInner`
- `pendingAckMessages`
- `pending_triggers`
- `markPendingTrigger`
- `clearPendingTriggers`
- `markSynced`
- `getUnsyncedMessages`
- `delivered_replies`
- `busyChats`
- `queueRuns`

Before merging or deploying such changes, run at minimum:

```bash
npm test -- tests/feishu-bot.test.ts tests/message-store.test.ts
npm run build
```

Before release, run full tests:

```bash
npm test && npm run build
```

### Code comment invariant

Keep the invariant near `processQueueInner`:

```ts
// Invariant:
// pending_triggers are the source of truth for active human triggers.
// Never advance sync_state beyond an unprocessed pending trigger.
// Never mark an ack DONE unless its rowId was processed in this run.
```

### Future hardening

Prefer changing `pendingAckMessages` from an array to a row-keyed map:

```ts
Map<chatId, Map<rowId, AckState>>
```

This makes it structurally harder to accidentally mark every queued message `DONE`.

## Related Files

- `src/feishu-bot.ts`
- `src/message-store.ts`
- `tests/feishu-bot.test.ts`
- `tests/message-store.test.ts`
