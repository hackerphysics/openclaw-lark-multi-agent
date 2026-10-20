# Private-chat owner identity repair

## Contract and scope

A p2p cache used `owner_bot` (a mutable display label) as its durable owner.
The actual `handleMessage` path marks the event processed, refreshes chat metadata,
then rejects an owner-label mismatch **before inserting any business message**.
The hourly metadata refresh preserved the old nonempty label, so a bot rename
could cause permanent silence. Group routing is not part of this repair.

`chat_info.owner_app_id TEXT NOT NULL DEFAULT ''` is an additive identity pin.
`owner_bot` remains its readable label. The app ID comes from the receiving
bot's boot-authorized SDK configuration, never from mentions or display names.

- A new private chat records both identity and label atomically.
- An unpinned legacy chat backfills only when the existing label exactly matches.
- A matching nonempty app pin allows a rename and refreshes only the owner label.
- A different app is rejected even with the same name or an unregistered old owner.
- Existing unowned, unmatched, or malformed legacy/cache identities fail closed.
- Private ownership checks are independent of metadata-cache age; the startup
  drain uses the same identity contract. Metadata upserts cannot replace an
  existing private owner's label or pin.

Store claims and operator migration use `BEGIN IMMEDIATE` transactions; an
ownership race cannot create two owners or overwrite a committed foreign pin.
No configuration key, permission, dependency, routing mode, or model is added.

## Rename-safe private ingress dedup

The initial owner-pin candidate (`3aeaa6d`) made a previously rejected rename
path reachable but retained name-only intake dedup. A redelivered old `/reset`
ID marked under `OldBot` could therefore execute under `RenamedBot`, even with
the same app pin. Two actual `handleMessage` regressions were run against that
frozen source: both failed by calling `resetSession` again (one legacy marker
without a business row, one reset actually executed before restart/rename).

The correction is private-ingress-only; business/session namespaces are not
renamed:

- `p2p_processed_events(app_id, chat_id, message_id)` is a monotonic ingress
  tombstone. It is written before the first await, including owner-rejected
  private inputs. A changed label, restart, later verified repair, or repeated
  future rename cannot revive one of these IDs.
- `p2p_owner_aliases(app_id, chat_id, bot_name, proof)` retains only authoritative
  pinned owner labels, or an explicit independently verified operator scope.
  Runtime rename/startup records the proven previous label **before replacing
  it**. A mismatched unpinned label, mention, history sender name, registry
  absence, or group name never supplies alias proof.
- For an incoming ID, the stable app/chat marker, existing current-name marker,
  and proven legacy-name markers are checked/claimed atomically. Legacy markers
  can only **deny replay**, never grant ownership. A matching legacy duplicate
  promotes only that received ID to the stable fence; no historical name ledger
  is bulk copied or renamed. Rejected legacy inputs need no `messages` row.
- Stable tombstones and alias proof rows are never deleted by this repair.
  Conflicting app ownership is still rejected by the independent owner gate.
  Groups retain their existing current-name dedup; name-scoped session keys,
  message history, sync, pending triggers, and outbox identities are unchanged.

## Legacy remediation (operator only; not executed by this change)

A retired label with no app pin contains insufficient proof for automatic
migration. Do not globally adopt unknown owners and do not clear owner checks.

1. Independently verify the exact private chat belongs to the original Feishu
   application now present in configuration (original-account evidence, not name
   similarity, mentions, recent `bot_chat_seen`, or registry absence).
2. Identify the actual runtime database, preserve an appropriate consistent
   backup, inspect the exact row/type/old label, and coordinate with the live
   process before an authorized change. Review business-state snapshots too.
3. With the additive schema present, invoke only:
   `store.migrateLegacyP2pOwner(exactChatId, exactExpectedCachedLabel, currentLabel, verifiedAppId)`.
   This narrow API has no automatic runtime caller. It updates only a p2p row
   with the exact expected cached label and an empty pin, preserving that old
   proven label as a private dedup alias. It is idempotent for the exact
   destination and refuses any already-pinned conflicting row, changed legacy
   owner, missing row, or group. Lock contention is an error, not consent.

   **If a prior operator already repaired the cache label and lost its old
   scope**, the new label cannot prove which legacy processed namespace to
   honor. Independently verify the original app + exact chat + previous owner
   scope (including original processed-input/account evidence). With that
   explicit proof, supply the optional fifth argument
   `verifiedPreviousOwnerBot` in the **same** pin transaction. For example,
   `migrateLegacyP2pOwner(chat, expectedCachedLabel, currentLabel, verifiedAppId, verifiedPreviousOwnerLabel)`.
   This also supports an already matching pinned destination. The optional
   scope is durable `verified_migration` dedup metadata, not an ownership grant;
   it must never be inferred from display names, user history, or automatically
   parsed backup JSON. An idempotent call does not silently adopt its unproven
   `expectedCachedLabel` as a new historical alias.
4. Coordinate the proof/pin/optional alias before allowing renamed private
   ingress; otherwise a lost pre-upgrade scope cannot be reconstructed safely.
   Read back the label/pin and exact app/chat alias rows. Verify all other chat
   fields plus every legacy business table are unchanged; only the explicit
   private dedup metadata is additive. A false result requires reinspection,
   never a broader UPDATE.
5. Validate a **fresh** incoming private event via the normal platform path once
   separately authorized; old rejected events were already deduplicated. Do not
   reset processed markers, enqueue old messages, or replay historical business.

Historical `sender_name`, bot-specific sync ledgers, processed markers, old
outbox bot labels/statuses, and session keys are intentionally not renamed or
replayed by this migration. New events continue through the existing normal
context-sync and session-key rules. This is not a general bot/session rename
migration or an automatic transfer of old pending work.

## Verification

`tests/private-chat-owner.test.ts` exercises the actual intake/cache order, not
an extracted owner predicate. Its initial three-test version was run against the
unchanged source: the retired-label rejection passed; both same-app rename
acceptance cases failed with zero inserted messages (fresh and stale caches).
The completed suite also covers lazy backfill, new pins, foreign active/retired
apps, misleading mentions, malformed pins/config IDs, group behavior, operator
CAS/idempotence/lock races, metadata preservation, untouched history/sync/outbox,
additive legacy upgrade, and restart persistence. The rename-dedup cases include
actual resets, startup-before-redelivery, multiple future renames, old rejected
input tombstones (including no business row), explicit lost-alias proof, failed
operator CAS, alias app/chat scope, group namespace preservation, concurrent
same-app resets under different names, and transaction rollback before effects.
The original 32 cases remain; their business snapshots still compare every
legacy table, excluding only the two new private dedup-metadata tables.

Use `npm test`, `npm run build` (all three bundled plugins), and
`npm run test:sdk-contract`. The configured offline test guard forbids real TCP
connections including localhost and forbids real fetch. Dependency/lock files
are unchanged. Local tests use the pre-provided exact-lock dependency-tree
symlink with SDK 1.73.3; this is not an independent fresh-install proof.

Initial owner-pin acceptance at `3aeaa6d` (2026-10-20, Node v26.10.0), in build-before-test order:

- `npm run build`: pass, all bridge/plugin TypeScript outputs, 4.92 s.
- `npm run test:sdk-contract`: pass, 1.00 s.
- `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/private-chat-owner.test.ts`: pass, 1.61 s.
- `npm test`: **68 files / 1921 tests passed**, 38.18 s wall time (1889 existing
  tests plus 32 new cases).
- `git diff --check`: pass.

An earlier full-suite attempt was started concurrently with the worktree's
first plugin build and had three CLI-test failures because `lma-core/dist` did
not exist yet. Building first and rerunning the complete suite resolved those
setup failures; no CLI/plugin source was changed.

Rename-dedup acceptance (current correction, same environment):

- RED on frozen `3aeaa6d`: `npm test -- tests/private-chat-owner.test.ts -t 'same-app private rename must not replay'` failed both actual-reset cases, each calling `resetSession` once under the renamed bot; 0.96 s wall time.
- Focused completed owner/dedup suite: **47 cases passed**, including the original
  32; 1.91 s wall time.
- `npm run build`: pass, bridge plus all three plugins, 5.36 s.
- `npm run test:sdk-contract`: pass, 1.05 s.
- Strict typecheck of `tests/private-chat-owner.test.ts` using the full command
  above: pass, 1.67 s.
- `npm test` after build prerequisites: **68 files / 1936 tests passed**, 38.50 s
  wall time (1889 original baseline + 32 original owner cases + 15 replay cases).
- `git diff --check`: pass.
