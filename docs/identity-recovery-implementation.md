# Trusted identity recovery — corrected review candidate (2026-10-20)

Base: `842076ff5a65f20d5451b81e974df78e39d29b61` / official 1.8.18.
This revision supersedes the incomplete first candidate `d6f4cef` and includes
both parent reproductions plus the independent review's three safety findings.
No version/dependency/configuration/live database/publication/deployment changes.

## Discovery and local recovery ownership

- Original-account `GET /open-apis/bot/v3/info/`, root `bot` or compatible
  `data.bot`; reject nonzero API codes, malformed IDs and supplied wrong app IDs.
  Names and user mention metadata never establish this bot's identity.
- SDK auth and info HTTP share AbortSignal + 2s timeout. A separate 2s observer
  bounds startup/ingress even for a transport ignoring cancellation. Single
  logical flight; failed discovery retries at 5/10/20/40/80/160s, capped at 300s.
- One recovery timer also owns local journal faults. All timer SQL executes
  inside an owned promise chain. Prune/list/claim/preflight/capture-write failures
  get paced, capped repair without another incoming message. Once identity is
  known, local repair does NOT re-probe Feishu identity.
- Store close retires the timer, probe, bounded metadata waiters and proof repair
  handles. Late HTTP/metadata responses cannot publish identity or target proof.

## Narrow durable pre-routing custody

- `identity_ingress` is one additive table, bot+app scoped, ordered by received
  sequence, original envelope immutable, with stop epoch, expiry and target JSON.
  Bounds: 100 records / bot+app, 64KiB original envelope, 15min eligibility.
  Overflow warns without admission; it is not a pending trigger/Get/DONE/busy.
- At first receipt only, a bounded supported `getSessionInfo` observation pins
  the original physical session ID/key, not merely the local stop epoch. Missing,
  archived, failed or hung initial metadata becomes **unbound**, never rebound to
  whatever session happens to exist later. Interrupted captures and old candidate
  rows without a target also remain ineligible after restart.
- A transient target-write failure repairs the SAME already-captured proof from
  bounded memory; it never rediscovers a replacement binding. Losing an unpersisted
  proof in a crash results in safe refusal, not automatic migration.
- Before claim, compare the persisted target with current physical identity and
  archive state. Definitive mismatch is dedup-tombstoned without business effects;
  unavailable validation retains the original proof for paced local recovery.
- Atomic processed-event claim prevents duplicate business attempts. Claimed rows
  are excluded from identity drain selection, but retain target-only custody
  through durable pending handoff. Thus restart before ordinary send still carries
  the original generation. Command sync or ordinary send-attempt retires this
  target record. Expiry/recall/stop retirement also clears only its pending trigger.
- No historical scan creates holds or replays incident rows 841/842. Already
  processed events are never recreated from a repair promise.

## Existing business ownership and command effects

- Recovery awaits routing/preparation and ordered command dispatch, NOT the whole
  ordinary model run. At the existing pending-trigger/queue-owner boundary its
  owned promise continues independently. A never-finishing model cannot block
  retained /help, retained /stop, or another chat's ordinary owned run.
- Stop/recall/close guards follow the held input through later command awaits,
  including ensureSession, model validation/persistence, delayed reset cleanup,
  queued UI sends and compact maintenance slots. A command's own authorized
  stop/reset epoch bump updates only its own continuation fence.
- Original target survives ordinary queue setup, busy insertion custody and
  restart. Setup/model patches use the original generation CAS. Ordinary
  `chat.send` receives the original `sessionId`, including after the shared send
  slot; it cannot unarchive/retry/retarget a held input. Conflicting followup proof
  is refused. Result custody keeps the pin even if a legacy ACK omits sessionId.
- `/go` status remains readable. A **held mutating /go** is explicitly refused
  with an explanatory reply: the supervisor bootstrap entry point cannot carry
  this input's original executor guard across all of its separate initialization
  effects. A fresh post-recovery /go keeps the existing path. This avoids a Go
  protocol redesign or silently starting supervision against a successor session.
- Malformed concrete open-ID values (number/object/array/null/boolean/empty) are
  refused before app-only fallthrough; legitimate app-only mentions, p2p isolation,
  @all, known-identity routing, bridge/native commands retain established paths.

## Limits and evidence boundary

- No arbitrary-crash exactly-once claim: processed claim followed by a crash before
  handoff may lose an input instead of replaying an ambiguous operation.
- Unbound original targets are not automatically repaired by binding to a later
  session. Extended outages can exceed the explicit age/capacity bounds. Physical
  cleanup occurs during recovery/intake/drain, not an independent janitor.
- Ordering applies to retained routing/preparation and handoff, not model completion
  or global traffic. Existing preparatory RPC/command waits retain their semantics;
  this is not a general queue or arbitrary-command timeout redesign.
- Describe + legacy reset/compact are separate public RPCs: late pre-effect checks
  detect observed replacement/archive/cancellation, but cannot manufacture an atomic
  backend CAS absent from those command schemas. Ordinary chat/model changes do
  carry supported sessionId/expectedSessionId guards. No distributed atomic-reset
  guarantee against an external operation racing between RPCs is asserted.
- A transport ignoring both abort and timeout retains its one raw probe slot until
  settlement. Callers/WS/private input remain bounded and no request pile-up occurs.
- The local tree uses the existing linked `node_modules` (SDK package reports
  **1.62.1**), not independent exact-lock SDK 1.73.3 proof. Parent owns that separate
  locked review. Offline guards forbid sockets/fetch. No live acceptance claimed.

## Verification

All commands completed in this isolated worktree, on the final source:

- `npm run build`: bridge + all three plugins passed, **4.838s wall**.
- `npm run test:sdk-contract`: passed, **1.011s wall**.
- `npm test -- --reporter=dot`: **67 files / 1883 passed**, **38.113s wall**
  (Vitest 37.86s). Original 1795 baseline + 88 identity cases; none removed.
- `npm test -- --reporter=dot tests/identity-recovery.test.ts`: **88 passed**,
  **1.744s wall** (Vitest 1.51s).
- `git diff --check`: passed.

The original 39 identity cases remain, plus 49 permanent parent/reviewer schedules.
They include both exact fault schedules (normalizing only Vitest's timer-helper
return value), known-identity SQL repair/backoff/close, proof-write races and
transaction rollback, never-ending-model + help/stop/other-chat handoff, late
ensureSession cancellation, malformed ID types, archive/replacement across restart,
unbound/hung metadata, old-schema migration, pending-handoff restart, and real
client sessionId/maintenance guard assertions. Logs: `/tmp/lma-identity-corrected-`
`{build,sdk,full,focused}.log`. These are offline candidate results, not live or
fresh exact-lock acceptance evidence.

## Parent release integration

The public tree uses synthetic same-shape app/open/chat/message IDs instead of
private incident identifiers. A parent regression additionally checks durable
physical-session custody *before* terminal output when a legacy admission ACK
omits sessionId; the identified-run observation now preserves resultSessionId.
This adds one identity case: final release gate is 94 identity cases / 1889 total,
with exact-lock Node 24 and Node 26 validation recorded separately by the parent.
The intermediate 1883 count above is retained as historical author evidence.

The final independent review additionally reproduced ingress AsyncLocalStorage
leaking into a shared queue owner's later ordinary batch. The parent now exits
input-specific ALS at processQueue entry while retaining explicit per-batch
durable target, recall and epoch guards. Real-queue known/recovered controls
recall only input A and require independent queued B to submit exactly once;
the recovered variant failed before the fix and both controls pass afterward.

The same isolation applies to shared insertion/reaction, error-notice and outbox
recovery roots/timers. These components keep their own durable per-record fences,
not the recalled ingress that originally woke a service timer. Three real-Node-
timer controls failed before this extension and pass afterward. Fake timers alone
would have falsely passed because their driver invokes callbacks outside the
original Node async resource; they are not used for these three ALS assertions.
