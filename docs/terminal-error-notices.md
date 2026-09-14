# Terminal error notices (local repair, 2026-09-14)

## Scope and public-protocol boundary

This repairs **unowned gateway chat / committed assistant errors presented by the LMA bridge**. It does not fix the gateway's announce execution, rewrite `collectReply`, auto-resubmit business/model requests, reinterpret session status, change models, or replay historical results.

Preflight: reuse LMA's MessageStore, ordered dispatcher, durable delivery keys, platform retry mechanism, startup drain, and existing foreground inactivity/yield handling. No new dependency, worker, model poll or gateway plugin is needed.

Protocol inspected locally:

- `docs/gateway/protocol.md`, Task ledger RPCs: read-only `tasks.list` and `tasks.get`; optional requester/owner, child session, run, source, task and parent-task identity.
- Public export `dist/gateway/protocol/index.js`: `TaskSummarySchema`, `ChatEventSchema`, `AgentEventSchema`, `TasksListParamsSchema`, `SessionsDescribeParamsSchema`.
- `docs/concepts/agent-loop.md`: terminal chat envelopes, gateway retry grace, execution settlement, and the fact that a short `agent.wait` timeout is **wait-only**, not execution failure.
- The installed source for announce identity construction, requester-settle wake and subagent completion projection was read to check the missing documentation. Production code does **not** import any private/hashed runtime, or access OpenClaw's SQLite/JSONL state.

The public task schema exposes `deliveryStatus` and `terminalOutcome`, but **not** the requester-settle wake's retry counter, pending next attempt or full batch/generation identity. Neither an `announce:` prefix, a `retry-2` suffix, nor an ended parent attempt establishes final failure of the original user request.

Therefore:

1. Recognize only direct `announce:v1:<childSession>:<childRun>` and single-child `announce:requester-settle:<agent>:<requesterSession>:<childRun>[:yield-N][:retry-N]` as **candidate locators**.
2. Match exactly one public subagent task with the candidate run ID, requester `sessionKey`, `ownerKey`, and (for direct announce) child session. Require a nonempty child session. Read at most two 100-row pages; missing, ambiguous or truncated discovery stays unknown. Revalidate every identity through a fresh `tasks.get`.
3. Do not join by shared session, similar text, timestamps, source-ID resemblance, parent-task ID alone, or another child's success. Unsupported/batched/generation forms stay unknown. Session `running` / `killed` is not queried for this decision: it would add no exact task evidence.

## Classification

| Evidence | Bridge presentation |
| --- | --- |
| Exact task queued/running; or delivery pending/session_queued | No error; keep pending diagnostic |
| Exact task completed + delivered, without blocked outcome | Suppress this attempt's error; do not synthesize or replay an answer |
| Exact child failed/timed_out, delivery delivered/failed/not_applicable | One notice identifying **that child**, never claiming the whole session or original request failed |
| Exact completed child, delivery failed **and** terminalOutcome blocked | One notice that execution completed but result handoff is blocked/terminated and needs human handling |
| Bare delivery failed, cancellation, incomplete metadata, unsupported form/RPC, lookup failure | Unknown; no final failure/success claim |
| Ordinary gateway chat.error (or chat.final with error stopReason) | Preserve an accurate run-error notice, deduped by exact run |
| Ordinary transcript error or bare abort | Require exact `agent.wait` error with terminal `endedAt`; short timeout/ok/no terminal metadata stays unknown |
| Explicit bridge stop provenance | No error cascade; existing `/stop` response and collector behavior are unchanged |

Gateway `deliveryStatus=delivered` confirms that task's gateway return path, **not a new Feishu receipt**. This is sufficient to suppress a stale attempt error, not to declare that LMA delivered the main result. Exact LMA final outbox records provide a separate local delivery proof; an enqueued but unsent exact-run final defers an error rather than pretending it was delivered.

## Provenance, generic failure text and result isolation

- `ProactiveMessageMeta.error` carries canonical session key, full run ID, source (`chat`/`session.message`), event state, stopReason, detail and explicit-stop evidence. `inspectRunError` returns sanitized public task identity/status, not child result/prompt text.
- Errors enter `error_notices`, a new table in **LMA's own** message database, before any awaited lookup. They do not enter the ordinary assistant callback branch, cancel a delayed failure/result, complete/fail a pending live card, set a real-delivery marker, or claim `trigger:<id>`.
- Only authoritative terminal evidence admits a `run_error` outbox row. Its metadata retains provenance and the public task verdict. SHA-256 identities cover `(session, run)` for observations and `(session, task)` for terminal notices. Distinct retry attempts share the verified task's error key. Ordinary errors use `(session, run)`.
- The existing result delivery keys, attachment handling and collector paths remain intact. A withheld error row is never marked delivered. Its unsent same-task payload can be refreshed under **the same** key after later terminal evidence; it cannot enter assistant recovery/correction/attachment logic.
- Typed `error`/`aborted` assistant stopReason is error provenance, including a chat envelope whose state is `final`. It is not a successful assistant final.
- An untyped exact generic failure sentence is reclassified only when the same canonical session + **full run ID already has persisted error provenance**. A normal identical-text assistant, explicit successful stop, different run, or missing correlation is not globally filtered.
- Consequently, an untyped generic string with no trusted error metadata and no previously observed exact-run error remains ordinary content. Inferring failure from its words or an announce prefix would wrongly censor normal assistant text. An uncorrelated historical final cannot prove recovery; there is no history replay/backfill in this repair.

## Bounded reconciliation and restart semantics

- One lightweight unref'd timer and one in-flight check per chat; no background agent/model task.
- Six scheduled read-only checks per observed run: immediate, then delays of 15s, 60s, 120s, 300s, and the existing `FOREGROUND_WAIT_MS` (10min). This is about 18m15s plus bounded RPC time, **not** a new foreground deadline. Existing 10-minute effective inactivity, yield freeze and collector ownership behavior are unchanged.
- Each lookup is capped at two list pages plus one get, each with a 2s RPC deadline. Ordinary wait probes use `timeoutMs: 1`, 2s RPC deadline. No short wait is converted into a terminal timeout notice.
- Check counts are persisted **before** awaiting RPC. Startup resumes pending observations with their remaining budget and due time, independently of message triggers. Disconnection produces unknown, not failure.
- Duplicate/late observations do not renew the budget. One stronger gateway terminal envelope can upgrade a prior transcript/bare-abort observation and give it one final check if its budget was already exhausted; repeats of that stronger envelope cannot rearm it.
- After the budget, retain the row as `parked`, with its last unknown reason and evidence. Do not send a failure, success, or speculative recovery notice. Do not poll it forever. New attempts are separately observed; no business request is automatically retried.
- Parked diagnostics and dedupe records are intentionally retained. The repair does not add destructive expiry or automatically rescan historic transcripts/outbox.
- Before every actual notice send (including existing bounded platform retries), re-read task finality and check durable exact-run finals again. A matching queued final, delivered final, changed task, stop, or unavailable lookup withdraws the unsent notice and retains the appropriate state. These send-time reads are additional to the six scheduled checks and bounded by existing outbox attempts.
- If the platform exhausts retries for an error notice, keep the failed outbox diagnostic; do not generate a second error about the error notice.

There is no transaction spanning gateway task state and Feishu acceptance. The guard checks immediately before handing the message to the sender, and cannot retract a message already accepted remotely or guarantee exactly-once delivery across an ambiguous network response. This is the existing platform/outbox limitation, not proof of a new receipt.

## Offline verification

`npm run build` and `npm test` use the repository's existing offline suite; `tests/normal-flow-offline-guard.ts` rejects real TCP connects and fetch. `tests/terminal-errors.test.ts` uses fake clocks, memory RPC and fake Feishu senders with real temporary LMA SQLite databases.

Coverage includes captured announce forms, abort/retry/success, confirmed blocked delivery, separate failed/successful children, typed and exact-run-correlated late generic failures, normal identical text, ordinary terminal errors, explicit stop, query failure/timeout/unsupported responses, identity drift, bounded pagination, restart pending/receipt/dedupe, stable result key isolation, send-time final/unknown races, and platform retry revalidation. Existing routing/mention/Chairman/Free/Discuss/model/attachment/stop/insertion/collector/inactivity/yield tests remain in the full suite.

No live bot test, deployment, restart, gateway/config/permission/model edit, push, tag or release is part of this change. Live Feishu acceptance requires a separately authorized deployment and validation.
