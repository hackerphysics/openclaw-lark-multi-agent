# Per-input live-card delivery status

Base: frozen `8f4082f7bcfbc2858880ebdce13fe963a4f27321`.
Source lane: `~/lma-live-input-status-1020`, branch
`fix/lma-live-input-status-20261020`. Earlier review worktrees stay untouched.
All activation/publication remains held for parent fresh review and the user's
requested combined deployment/restart; this is source-only acceptance.

## Display contract and ownership

Every live input-delivery hint has a short localized `【emoji state】` followed by
the original input body/excerpt; necessary known/unknown qualifications follow
on a secondary line. Tool/assistant activity stays a separate activity window,
not a claim that each appended input was consumed.

The existing presentation owner keeps UI-only per-row phase, original message
ID and bounded visible preview fields in its existing JSON journal. No schema,
new queue, permission, config, routing/admission/retry/epoch/physical authority,
reaction or business-completion rule is added. Display fields never select a
run, authorize submission, flip Get/DONE or cause business replay.

A/B/C keep separate phases even on a shared card: ordinary A may be processing,
B enqueue-only and C locally received. Merged ordinary members are listed
individually. A repeated local receipt cannot downgrade a known receipt/activity
phase. Sealed independent cohorts retain their own known card/input identities.

Original display text is captured only from the current human ingress's visible
text/caption/name/type allowlist, before generated routing prompts or media/doc
hydration. Short text is not summarized or sent to a model. Old presentations
without new display fields resolve their own existing input row/message IDs;
there is no mutable chat-latest/history/tool/body backfill.

At the actual SDK card boundary, each reference is checked against the same
Bot/app/chat/stop epoch and exact human row/message identity, and recall is
rechecked. Missing, conflicting, recalled or unavailable source never falls back
to another message or cached private preview. The explicit unavailable marker is
`[消息正文暂不可用]` / `[Message body unavailable]`.

Media uses original visible caption/filename/type markers, not server download
paths, file/image keys, fetched document text or generated hydration instructions.
The existing markdown component is reused as inert text: platform tags/entity
introducers are neutralized, markdown syntax escaped, and card-shaped JSON
remains text. No actions, active mention/media components, fetched images,
permalinks or recipient probes are introduced. Trusted approval cards and the
ordinary business Markdown renderer are unchanged.

## Complete producer inventory

- `QueuedPresentations.receive`: **📥 received**, exact new row only.
- `claim` / `resumeQueued`: **⏳ local queue**, actual ordinary cohort only.
- `attempted` / `submitting`: **📨 submission pending**, not Gateway acceptance.
- `insertionAccepted`: **⏳ append queued**, exact appended row only; actual
  receiver/commitment/result remain explicitly unconfirmed.
- `admit` / `advance` / `admitted`: **✅ accepted**, exact ordinary cohort ACK.
- Root `progress`: **⚙️ processing** for ordinary members only; appended members
  retain their independent receipt phases. Tool/progress text is not relabelled
  as another input's delivery receipt.
- `showWaitingForResult` / ordinary input waiting: **⏳ waiting**, observation
  continues without automatic input replay.
- `pauseForUnconfirmedResult`: **❔ result unconfirmed**; typed wait pauses use
  **⏸️ wait paused**, setup/admission refusal **⛔ not submitted**, unconfirmed
  admission **📨 submission pending**, and platform receipt gaps **📨 delivery
  pending**. These are display-only kind arguments at existing call sites.
- `unconfirmedInputs` after root outcome: **⚠️ partial** cohort note lists its
  member previews while preserving B/C's different receipt phases; root outcome
  does not upgrade appended commitment.
- `prepareTerminalDelivery`: ordinary **📨 delivery pending** / **💤 no content**
  display snapshot only; no platform receipt is inferred.
- `complete`, `noReply`, `fail`: **✅ round ended**, **💤 no content**, **⚠️
  interrupted** respectively, retaining source association and no user-stop
  attribution. Ordinary completion is not appended-input commitment.
- `linkedReplyDelivered` / `reconcileDeliveredReply`: **💬 linked reply**, with
  the existing qualification that input commitment is separate. Existing
  same-card business-answer payload preservation remains untouched.
- Legacy terminal cleanup carries optional exact UI references. Without them it
  shows the explicit unavailable marker, never a neighboring/latest input.
- `retire` / explicit stop/reset: existing disposal/epoch suppression stays in
  force; no new stopped-card SDK operation is issued. Old pending effects remain
  fenced. The old generic English "stopped" failure title is accompanied by the
  neutral interrupted input label, not invented human-cancellation evidence.

Native commands have no queued live-card path and remain suppressed. Unbound
background discussion controllers cannot safely identify an original human
input, so delivery-status hints explicitly show source unavailable; protected
scheduler prompts are never substituted. `/compact` progress, auth/approval
cards and non-delivery tool/agent progress are outside this input-hint format.
No existing message-jump helper was found, so no permalink/API lookup is invented.

## Budget and serialization

Long inputs use code-point-safe readable excerpts with ellipses. Large cohorts
show bounded first/newest member previews plus an explicit omission count; the
current newest input is always retained, including when the budget tightens.
The complete serialized SDK request is measured, including nested card JSON,
reply/patch path or receive target and params. Adaptive member/preview/activity
limits reserve 512 bytes below a conservative 30,000-byte outer limit. An
oversized address/envelope is rejected locally without SDK call or fallback.
Unknown UI create/edit effects keep the existing no-blind-retry custody.

## Proof and boundaries

Three initial tests were RED against unchanged 8f source at the actual Card2 SDK
request boundary: local receipt, append queue, and A-processing/B-enqueued/C-local
all lacked their per-input body association (0.77 s).

The new 47-case suite covers every input-hint kind above, merged and parallel
cohorts, restart/legacy fields, repeated receipt, missing/foreign/bot sources,
recalled/stopped inputs, app/chat/epoch mismatches, English, long CJK/emoji/escape
content, injection, all supported ingress media/document kinds, unknown create
restart, original mention-only text, terminal cleanup, and local byte rejection.
It also runs the real SDK with an all-method synthetic HTTP transport and
captures the serialized Card2 request (no auth headers/real credentials).
All real sockets/fetch remain blocked. Earlier incomplete HTTP-mock setup was
caught by that guard; final fixtures use only the explicit synthetic transport.

SDK/mock receipt acceptance is **not** real Feishu client visual acceptance.
Parent still owns fresh review, dual-runtime gates, combined activation and an
authorized human/client visual check. No real model/platform calls, UI probes,
remote/service/config/dependency/version/Core/schema/publication/live changes
were performed. Local tests use Node v26.10.0 and the supplied exact-lock SDK
1.73.3 dependency symlink, not independent fresh-install proof.

Final-source gates (build prerequisites first):

- `npm run build`: bridge and all three plugins passed, **4.96 s**.
- `npm run test:sdk-contract`: passed, **1.02 s**.
- `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/live-input-status.test.ts`:
  passed, **1.71 s**.
- `npm test`: **70 files / 2028 tests passed**, **39.05 s**, preserving all
  1981 baseline cases plus 47 new cases. No existing baseline/privacy assertion
  was removed or weakened.
- `git diff --check`: passed.

Evidence: `/tmp/lma-live-input-red-1020.log`,
`/tmp/lma-live-input-focused-green-1020.log`,
`/tmp/lma-live-input-http-1020.log`, and
`/tmp/lma-live-input-final-{build,sdk,types,full}-1020.log`.
