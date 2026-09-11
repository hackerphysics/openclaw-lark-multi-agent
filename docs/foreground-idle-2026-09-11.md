# Foreground pause: consecutive effective-activity silence (unreleased)

Correction to 1.4.10 (`ce3fd98`), not a release or deployment. The earlier
fixed ten-minute foreground/card budget was the wrong interpretation of the
requested behavior. **Ten minutes means time since the last effective task
activity, never total task runtime.**

## Clock and parameters

- Reuse `collectReply`'s existing idle timer. Remove `foregroundWaitTimer` and
  `LiveStatusController`'s independent `refreshBudgetTimer`/`refreshBudgetMs`.
  There is no replacement absolute foreground/card deadline.
- `FOREGROUND_WAIT_MS` remains `600000`. `chatSend` and `chatSendWithContext`
  retain `timeoutMs`; it now consistently means consecutive effective-activity
  silence for local foreground waiting, not an execution limit. Ordinary bridge,
  discussion and existing retry-probe callers use the same default. No new env
  variable, config setting or model request is introduced.
- The initial window starts with `collectReply`, after chat.send acceptance and
  `onSubmitted` completion. Card creation, send-slot waiting, attachment/context
  preparation, RPC admission delay and pre-collection bookkeeping are not charged
  as task silence. The existing RPC/caller failure and cleanup paths still apply;
  a standalone card has no knowledge of admission or independent silence clock.
- New effective activity restarts a full window. Already-received events are
  drained before an expiry decision, including when the 50ms poll has not run.
  An idle generation check prevents an in-flight status query from freezing the
  foreground after newer activity. Final/error/stop cleanup invalidates the
  pending decision and clears observation timers.
- `LiveStatusOptions.tickMs` / `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_TICK_MS`
  (default 1000ms) only refresh elapsed presentation. Neither a successful card
  patch, a retry nor a tick feeds the idle clock. `delayMs` and the existing card
  creation-delay environment variable still only control card presentation.
  Elapsed includes time since card start; it is not the remaining silence time.

## What counts as activity

This filter is local to the collector's idle clock. It does **not** replace or
broaden the existing event matching, transcript/answer assembly or delivery rules.
An event must first pass existing matching, and its nonempty runId must belong
to the collector's existing `activeRunIds` (including a continuation admitted by
the existing user-anchor/lifecycle rules).

| Evidence | Silence reset |
| --- | --- |
| New assistant/chatDelta/transcriptAssistant text | Yes: incremental delta/deltaText, replacement snapshots, canonical assistant data.text |
| Tool start/end/error; canonical tool result | Yes, once per owned run + call identity + normalized phase |
| Canonical tool / legacy item mirror | Once, sharing toolCallId/itemId/id and phase |
| First lifecycle start for an owned run | Once; a repeated start is not new progress |
| Repeated frame, repeated replacement text, identical accumulated text mirrored across text streams | No |
| Usage-only updates (even changing token counts), empty/whitespace text, ticks/heartbeat | No |
| Card elapsed tick/edit, local poll, status/agent.wait response without a real terminal outcome | No |
| User/steer admission receipt or repeated recoverable-error notification | No; subsequent real execution progress counts |
| Unrelated run or run-less session fallback | No; existing reply matching/assembly is nevertheless preserved |
| Unknown streams / raw command-output updates | No; known tool completion is the supported progress boundary |

Tool fingerprints do not include arguments or output; usage changes do not make
an old event new. Canonical `result` is normalized to end/error. Text frame
fingerprints ignore usage and use stream, sequence (when present), replacement
mode and actual text; repeated replacement text cannot renew silence merely by
changing sequence. Identical incremental fragments with distinct sequence IDs
can be genuinely new output and count. Content fingerprints also suppress known
accumulated-text mirrors. Fingerprints are local SHA-256 digests retained only
for this collector's lifetime; no public text or routing fields are changed.

When metadata is insufficient, err toward not renewing an unverifiable wait:
repeated identical no-seq fragments are treated as replays; tools without call IDs
are recognized only once per run/name/phase. Missing run IDs cannot establish
ownership for silence renewal. These conservative cases may pause a genuinely
active older runtime's presentation, but never stop execution or replay a request.

## Pause, freeze, yield and eventual results

After a full silent window, the foreground callback receives one normal pause
notice. Its actual session status may be running, idle or unknown; an unknown
state is not relabeled running or failed. Without a callback, preserve the
published running-only `SessionWaitPaused` outcome and low-frequency observation
for other local-silence states. Real Gateway-reported timeout/error classification
remains a separate, unchanged path; this change is not a ten-minute grace period
for actual terminal errors.

Gateway **chat-final `yielded: true`** remains an immediate handoff: no silence
wait or status lookup is needed to confirm it. Tool names, tool outputs, spawn
receipts and unverified acknowledgments do not confirm yield. Private
sessions_yield context stays protected. Same-batch actual final/error still wins.

**No automatic thaw**, for both ordinary silence and yield, is the already
published policy retained here. Later real tools/text do not restart a frozen
card's ticker or progress edits. Local tool counting may continue for the one-time
terminal summary. This is explicitly not a new resume-on-activity policy.

The pause does not abort or resend the task, resolve it as NO_REPLY, release its
queue owner, or consume its real final-delivery key. The existing observer,
background delivery route, low-frequency reconciliation, notice dedupe and final
or error cleanup remain. Explicit stop and ordinary collector final-delivery
behavior are unchanged. The existing 24-hour local-observation resource horizon
is unchanged and is **not** a ten-minute foreground limit. It does not issue an
abort. Model selection, attachments, routing, queue/steering, run identity,
plugin/config and package versions are unchanged.

## Regression acceptance

Fake timers exercise minutes/hours without a real ten-minute wait:

- At 9:35 a real canonical write completion arrives. At 9:59 and 10:00 the card
  still updates elapsed and no notice is sent. At 19:34.999 there is no pause;
  at 19:35 uninterrupted silence produces exactly one notice/freeze. Subsequent
  real tool activity does not thaw it; the original final still arrives.
- Activity every four minutes continues for more than twenty minutes without
  pausing. Only ten minutes after the final activity does the notice occur once.
- Full-text/delta/transcript, legacy/canonical tools, cross-stream mirrors,
  duplicates/usage/noise, foreign/run-less events and existing matching modes.
- Progress just before the 50ms collector poll/deadline and during either status
  RPC invalidates stale pause decisions; final/error/stop clear pending waits.
- Card creation can precede slot admission, chat.send acceptance or submitted
  bookkeeping by more than ten minutes without freezing. Admission failure and
  delayed card creation followed by freeze/final/failure/noReply/dispose do not
  resurrect tickers.
- All existing confirmed-yield, private-context, no-abort/no-resend, background
  ownership/continuation and ordinary regressions remain. The two old fixed-budget
  tests were rewritten to assert these corrected semantics, not deleted.

**Verified:** build passed; **431/431 tests in 13 files** passed (369 existing
cases retained with the two corrected semantics tests, plus 62 new cases).

Validation uses `npm run build` and `npm test` (the existing offline Vitest config
forbids real sockets/fetch). Additional process-level Linux seccomp validation
blocks socket/connect for the build/test process tree, including child CLI tests;
its IPv4/IPv6 TCP/UDP denial self-check must pass before running either command.
No dependency installation, Gateway/Feishu connection, push, tag, publish,
deployment or service restart is part of this correction.

Limitations: no live Feishu delivery/reconnect or real Gateway wire capture is
claimed. Existing 50ms polling, bounded metadata lookup and card delivery latency
may make visible notification later than the silence threshold, never authorize
a fixed total-runtime cutoff. Alternative/missing event identities and raw
streaming command output follow the conservative rules above. A single tool that
runs silently for ten minutes can pause presentation while continuing in the
background. The activity fingerprint cache grows with distinct events until
collector cleanup (within the unchanged observation horizon).
