# Yield foreground handoff — isolated code review

## Scope and contract

Base: `main` at `def24569ab2812b143e41236cb43cba55bf1e844` (package 1.4.9).
No deployment, restart, tag, push, release or version/dependency change.
The supplied `artifacts/lma-release-1.4.9/yield-diagnosis.md` was read before implementation.

Contract checked against the locally installed OpenClaw **2026.9.2** docs and public Gateway protocol entry (`dist/gateway/protocol/index.js`); the repository build dependency remains **2026.8.2**:

- `docs/tools/subagents.md`, “Tool: sessions_yield”: yield ends the parent turn; announced completion can arrive later. It does not collect collectors. `message` is private resumed context; `acknowledgment` is optional public waiting text, and is not necessarily delivered.
- Exported `ChatEventSchema` / its `ChatFinalEventSchema` branch: `runId`, `sessionKey`, `seq`, `state: "final"`, optional `message`, optional `yielded: true`. `message` is optional even for final. There is **no dedicated acknowledgment field** in this event schema.
- Installed emitter source (`server-chat-DhlqkrkS.js`, `emitChatTerminal`) confirms the yielded bit comes from host lifecycle classification. Its message can be buffered assistant text, not necessarily an acknowledgment or a completed answer. This inspection is provenance only: product code imports **no hashed/private SDK bundles**.

## Behavior

1. Normalize only a Gateway **chat-final envelope** with boolean `yielded === true` into an internal `gatewayYielded` flag. Tool names, arguments, results, lifecycle-only paused states, string `"true"`, spawn admission, errors and aborted envelopes are not confirmation.
2. On confirmation, emit at most one `SessionWaitPaused` callback with structured `reason: "yield"`, using the existing waiting-notice outbox key, not the final-answer key. Generic copy:

   > ⏳ 本轮已转入后台等待；若有后续结果，将继续在此回复。未发送停止请求，也未自动重发请求。

   It does not assert child execution or promise a completion source exists. No extra status RPC is needed before this notice; normal delivery still obtains the current status/model/context footer. Timeout copy and the fixed ten-minute budget remain unchanged.
3. Reuse `LiveStatusController.showWaitingForResult`: stop recurring/ticker/tool card edits, retain one-time final/error updates. Keep the original collector, queue owner, progress registration and final-delivery ownership. Do not resolve yield as success, failure or `NO_REPLY`.
4. Cancel pending chat/lifecycle fallback timers on yield. Drop pre-yield accumulated prose as a terminal candidate. A yielded or subsequent blank final cannot enter the abort fallback, and a later actual final cannot abort the yielded original. Ordinary truly empty non-yield fallback no longer aborts before checking text.
5. A `paused/end_turn` lifecycle without a real chat final is nonterminal but is **not itself a notice trigger**. Lifecycle-only empty discussion completion gets the existing bounded 5-second reconciliation window. A confirming yield cancels it; ordinary silent discussion still completes after that window.
6. Real final/error settlement closes the observation synchronously, so same-batch final/error wins over the deferred notice. Later real finals retain ordinary delivery, including a matched resumed lifecycle start followed by assistant/transcript text and lifecycle completion without chat final. Recent unrelated output cannot suppress this turn's yield notice; a delivered answer for this trigger can.
7. After normal-chat yield, do not adopt unowned new-run events merely from the session or a lifecycle start. They keep the existing proactive path, independent of the original final key. Already-established run correlation is retained. Discussion keeps its existing scheduler-owned anchored collection path (identified by its transcript mute), not a new cross-run correlator.
8. Redact `sessions_yield` argument/result summaries (objects and strings) from tool progress/verbose presentation. This exact-name redaction is not a completion or yield detector. No tool acknowledgment or raw child/tool output is copied into the notice.

## Offline validation

Run from the isolated worktree, reusing the existing dependency tree without installing packages:

```sh
npm run build
npm test
```

The suite uses `tests/normal-flow-offline.config.ts` and its existing guard, which rejects real TCP sockets (localhost included) and real fetch. New tests mock WebSocket with an in-memory EventEmitter and exercise the **actual wire normalization and collector**, not just hand-built collector events. Feishu tests use the existing mocked delivery harness and temporary SQLite stores. No live Gateway chat, model inference or Feishu delivery is used.

- Clean baseline: **335/335**, 11 files, build passed.
- Child suite: **366 tests**, 12 files. Parent independent build/regression: **369/369 tests**, 12 files after adding timeout→yield, failed-notice callback and persisted trigger reentry coverage.
- New coverage: immediate empty yield/no interim text; notice at most once; no abort/no resend; lifecycle-first paused and working 5-second races; duplicate yield/blank final; actual-final priority in both orders; same-batch error priority; late final without lifecycle; tools-only resume/re-yield; unconfirmed/fake tool evidence; private argument/result redaction; explicit stop; ten-minute timeout; retained run ownership; new-run proactive route with/without anchored lifecycle; discussion notice/continuation; card ticker/progress freeze and final update.
- Existing suite remains enabled for collector, queue/steer, stop, attachments, routing, model selection, discussions, status footer integer K formatting and dedupe.

Fresh worktrees need build before the existing CLI tests (`dist/cli.js` is not tracked). The first baseline test attempt before build had four missing-dist CLI failures; after building the unchanged baseline, all 335 passed. No baseline test was disabled or rewritten to hide that setup requirement.

## Deliberate limits / parent review

- **No acknowledgment extraction/reuse**: neither raw tool output nor arbitrary buffered chat text proves that an acknowledgment was publicly delivered. This patch uses only the generic notice. Exact deduplication against acknowledgments delivered by some other channel/path is not implemented; ordinary final-answer ownership checks remain.
- Missing `chat.yielded` confirmation keeps existing timeout behavior; this patch does not add lifecycle/agent.wait-only early notices. A working lifecycle-only silent discussion can still finish after 5 seconds if the confirming chat event is delayed beyond that boundary.
- Discussion retains the pre-existing distinction: transcript mute suppresses `session.message` mirrors, but does not suppress independent external `chat final` callbacks. The offline test verifies both the scheduler collector result and that unchanged callback path. It does **not** prove duplicate-free end-to-end Feishu delivery for a different-run discussion completion; changing that policy would be a separate routing change.
- Normal different-run completion is deliberately not consumed as the old collector's final. The old observation/queue owner remains until its existing settlement, stop, no-active-run reconciliation or local 24-hour horizon. No new replay, cancellation or correlation heuristic is introduced.
- Outbox dedupe and existing retries are reused. Real Feishu delivery latency/failure recovery, process restart persistence and Gateway reconnection across yield have not been live-validated. Offline results do not claim deployed behavior or user-visible delivery receipts.

## Parent review: notification identity

Notice dedupe is deliberately once per original trigger (and once per collector),
not once per continuation run. A timeout notice already tells the user that
foreground waiting has stopped; a later yield keeps it rather than posting
another waiting notice. Reentered callbacks with the same trigger reuse the
persisted waiting-notice key, leaving the real final key untouched. The parent
regression verifies these paths and failed-notice callback observation retention.
It does not claim live reconnect/restart delivery or per-run discussion dedupe.
