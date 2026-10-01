# Go public integration coverage (2026-10-02)

Production remains fail-closed. No independent Goal mode is authorized. No safety booleans have been asserted. This is **not** a completed production Go acceptance.

| Requirement | Implementation / verifiable scope | Remaining boundary |
|---|---|---|
| Native Goal create/read/update | Public chat.send intent, sessions.describe, sessions.goal.update with exact session/goal/operation identity | Completion rejected; installed host lacks monotonic revision/CAS |
| Durable policy binding | Public admin-scoped lma.go.bind; atomic registry loaded at plugin registration; exact identity conflicts rejected; no automatic unbind | Plugin must be installed/enabled by authorized operator; final resolved dispatch/native mutations not fully proven |
| Task snapshots | Public runtime.tasks.runs.bindSession().list() via read-scoped lma.go.snapshot, raw task/parent/run/return fields | Session-key scoped, no generation or consistent queue/recoverable/outbox snapshot; complete=false deliberately |
| Guarded admission | sendGoGuarded sends sessionId, expectedLeafEntryId, suppressCommandInterpretation, stable idempotency key; returns exact runId; never restore | Admin scope needed; no live runtime roundtrip; controller activation remains fenced |
| Visible evidence | Raw full agent/chat/session.message observer; exact generation/run/item identity required; durable full-body/attachment payload and separate receipt APIs | Events without exact identity are excluded, not fabricated. Bridge delivery paths do not yet all write these receipts |
| Initialization/acceptance/history | Durable initialization check; acceptance retains authorized objective; all historical evidence refs supplied | Structured criteria coverage not algorithmically certified; init acknowledgement is not acceptance |
| Action recovery | attempted/accepted/unknown durable ledger; stable key from Go/action identity; accepted not downgraded; unknown never resend | Host receipt query unavailable in adapter; existing legacy controller sends remain behind safety fence |
| Timer lifecycle | Store-close observers cancel boot recovery and controller timers; disposed recovery no-op | No Gateway lifecycle modifications |
| Offline fault injection | Persistence restart, binding conflicts, unknown response, archived refusal, completion rejection, full attachment metadata/receipt separation | Synthetic RPC and hooks only, not end-to-end actual host/model/Feishu delivery |

## Evidence and minimal host changes

Installed host 2026.9.6 public closed GoalOperationIdentity (`dist/src-BRUl7oDv.mjs:1892`) has sessionKey/agentId/sessionId/goalId/operationId/issuedAtMs but no expectedGoalRevision. Goal schema has updatedAt but no revision. Completion must gain atomic expected revision under session mutation lock, with stable conflict error.

Public SDK TaskRunView provides id, sessionKey, parentTaskId, runId, status, deliveryStatus; bound list() has no pagination parameters, but does not certify complete generation-scoped descendants, queued/recoverable inputs, or all outbox deliveries. The adapter returns these truth boundaries; the missing guarantee is not replaced by local counters.

Minimum proposed host authorization (not executed):
1. Monotonic native Goal revision + expected revision mutation CAS.
2. Trusted binding enforcement at final tool dispatch/native Goal mutation, covering generic wrappers and missing identity without falling back to prompt policy.
3. Consistent generation/root-run scope snapshot and receipt reconciliation if existing public APIs cannot expose these guarantees. Current task-list API is implemented; missing global atomic completeness is specifically unresolved.

Repository-only remaining work is explicitly **not a host blocker**: connecting guarded admission/receipt collection to the controller, comprehensive Feishu body/attachment receipt hooks, structured acceptance verification, original receipt reconciliation where supported, and isolated full runtime harness. No claim that these are finished. No production activation, push, deploy, Gateway configuration/restart, real messaging, or business task runs occurred.
