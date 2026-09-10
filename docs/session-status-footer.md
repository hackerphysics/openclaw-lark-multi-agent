# Session status footer and nonfatal wait notices

Base: cf5827d. This branch is separate from the unverified steer V2 work.
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
and result handling remain. The default accepted-request foreground budget is
**10 minutes**, independent of new activity. The process card also has its own
fixed 10-minute refresh lifetime from start, including time spent before admission.
It is frozen when the budget expires: elapsed ticks and later tool/assistant
progress do not edit it or restart its ticker. Local tool counting may continue
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

Verification: build; full offline normal-flow regression suite including original
305 tests; added coverage for footer placement, plain-text fallback, lookup bound,
running vs idle timeout handling, no abort/no automatic retry, notice-vs-answer
ownership, background wait continuation, final-vs-timeout races, and process-card
fixed-budget/frozen-card behavior. No live Feishu message or production restart is performed
by these tests. Production activation remains a separate step.
