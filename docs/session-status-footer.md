# Session status footer and nonfatal wait notices

Originally based on cf5827d; consecutive-silence correction based on 1.4.10 /
ce3fd98. This work is separate from the unverified steer V2 work.
It does not include a plugin or Gateway configuration change.

Final text replies show `🧠 <model> · <session state> · 85K/200K`.
No `status:` prefix or snapshot wording is printed in the footer.
Context uses the existing /status counters (`totalTokens` / `contextTokens`),
from the same metadata query. K means 1000 tokens, rounded to integers.
The numbers are not clamped at the limit. Missing/explicitly stale used counts
show `?K`; a missing limit shows `?K`. If neither count is available, omit the
fraction rather than inventing zero usage.
The state is fetched from the same sessions.describe source used by /status,
bounded to 1.5 seconds. Unknown/unavailable state is shown as unknown, not guessed.
The footer is a send-time snapshot, not a continuously updating status widget.
It describes the session, not a guarantee that the model is actively generating.

Status remains separate from the configured model, stored answer text and content
hash/dedupe keys. Both interactive-card and plain-text fallback preserve it.
Commands and textless attachment replies do not gain fabricated answer text.

When a wait reports a timeout and a fresh status is running, LMA sends a normal
wait-paused notice, not an execution-failed warning. For normal in-flight requests,
foreground waiting is paused but the original background observer, queue ownership
and result handling remain. The default foreground threshold is **10 consecutive
minutes without effective task activity**, NOT ten minutes of total runtime.
The existing collector idle timer is the only silence clock; no independent
card lifetime remains. It starts when accepted-request collection begins, after
chat.send acceptance and the onSubmitted callback. Card creation, waiting for a
send slot and pre-collection bookkeeping are not charged as task silence.
New owned assistant text, distinct tool start/completion and a first owned run
start reset this clock; see [activity rules and parameters](foreground-idle-2026-09-11.md).
Card elapsed ticks, status/agent.wait polling, usage-only and duplicate events do
not reset it. For example, write completion at 9:35 prevents a 10:00 freeze;
silence can expire no earlier than 19:35. Continuous activity can run past ten
minutes without a foreground pause.

On local silence expiry the foreground callback receives a normal pause even if
status is idle/unknown (the actual state is shown, never invented). A confirmed
Gateway chat-final yielded:true still pauses immediately, without waiting for
silence or a status lookup. Once either pause freezes the card, elapsed ticks and
later tool/assistant progress do not edit it or restart its ticker. This retains
the published no-auto-thaw policy for ordinary silence as well as yield.
Local tool counting may continue
for one final summary. A real final result is sent separately, and the old card
may receive one necessary terminal cleanup; this is not recurring refresh.
No abort or new model request is issued for the wait notice. The notice has its own outbox key and does not mark the
original input DONE or claim the real answer's final-delivery key.

A true final received during timeout classification wins. Late real results can
still use the original delivery key. API clients without a wait-notice callback
receive a typed SessionWaitPaused outcome; that fallback releases only exact-run
local delivery ownership so later proactive output is not suppressed by a grace
window. Discussion fallback pause handling releases its local proactive mute.

Non-timeout failures (including actionable validation/auth/quota errors) remain
errors. Timeout with idle/unknown status is not blindly relabeled running.
Delayed timeout notices also recheck status and recent real output before sending.
The Gateway's own execution budgets and explicit /stop behavior are unchanged.
Background event reception and low-frequency Gateway state reconciliation remain;
freezing the card removes recurring Feishu card-edit calls, not all network traffic.

Verification of this correction: build and **431 offline tests in 13 files**
passed. The existing 369 tests are retained (the two fixed-budget tests now assert
consecutive-silence semantics), with 62 additional cases. Coverage includes footer
placement/fallback, lookup bounds, timeout classification, no abort/replay,
notice/answer ownership, background continuation, progress/timeout races and card
freeze/cleanup. See [correction details](foreground-idle-2026-09-11.md). No live
Feishu message, production restart or publication is performed by these tests.
