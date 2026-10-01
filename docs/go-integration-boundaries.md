# Go public integration coverage (2026-10-02)

## Delivery status

Repository Controller/offline closed-loop work is implemented. **Production remains fail-closed; this is not production or real-Feishu acceptance.** No safety capability is asserted by the production client. No independent/standalone Goal mode is enabled.

| Requirement | Implemented and exercised | Real-host boundary |
|---|---|---|
| Native Goal authority | Controller requires authoritative native scope initialization and monotonic revision, stores native identity, verifies snapshot version, submits guarded native completion CAS before local completion | Installed native Goal API has no revision/CAS; production initializer/completion authority deliberately absent |
| Durable policy | Exact persisted checker/executor restrictions, deny Checker tools, generation conflicts; synthetic initialization binds real plugin registry | Final resolved generic-tool/native mutation dispatch enforcement not certified by installed host |
| Idle/task gates | Controller calls generation/root-scoped snapshot gate; all followup admissions extend exact root-run scope; descendants, task return, queued/recoverable inputs, pending platform receipts, incomplete association all defer | Public task list does not certify complete consistent generation-scoped queue/outbox/descendant state; production adapter returns complete=false |
| Guarded model work | Initialization, check, correction and CONTINUE all use stable ledger identity → guarded admission → exact admitted-run collection. No legacy context-send path remains in Controller | Public send adapter is implemented; activation still requires the above authority |
| Visible evidence | Common outbox captures every actual SDK create/reply response (body chunks, proactive text, files, images, captions, document links/fallback); body/attachment inventory and receipts are distinct. Each receipt is persisted before the next operation. Errors cannot certify success | Missing generation/run identity remains excluded from successful acceptance; it is never fabricated |
| At-most-once platform operations | Durable per-outbox/per-stage/per-operation ledger; accepted response is reused, unknown operation refuses platform retry/fallback. Upload alone never counts as delivered | A lost platform response with no message ID is not publicly queryable by this operation key. Conservative pause/failure, not guessed success or blind resend; ordinary non-Go delivery semantics unchanged |
| Acceptance criteria | Persisted authorized criterion C1 (the complete original objective), full historical E index and visible payload index. COMPLETE must cover every stored criterion with real delivered, generation/run-qualified E refs; malformed/fabricated/error-only/incomplete coverage rejected | Message-review acceptance, not independent file execution/inspection. Attachment content is not inferred from filename |
| Original-send reconciliation | Public chat.history(sessionId,inputRunIds) checks original stable admission run ID; agent.wait checks exact original committed terminalReply after generation validation. Resume/recovery reconcile without a new send/model action | Missing/expired original receipts remain unknown. No invented receipt API |
| Lifecycle | WAIT → CONTINUE → guarded executor work → COMPLETE; user input invalidates checker revision, init cancellation reserves one start, pause/stop/reset/archive/goal edit exclude stale verdicts; known native+notification receipts settle local COMPLETING on restart | Native CAS/final-dispatch authorization still required for real activation |
| Full isolated runtime | Synthetic authoritative host models the currently missing scope/policy/CAS guarantees. Uses actual Controller, SQLite reopen, public client send/history/terminal adapters, persisted plugin policy, real bridge body/file/image code with fake platform responses | Not a live Gateway/model/Feishu roundtrip |

## Exact installed-host evidence

Installed OpenClaw 2026.9.6 public closed GoalOperationIdentity (`/home/haipw/.npm-global/lib/node_modules/openclaw/dist/src-BRUl7oDv.mjs:1892`) has sessionKey/agentId/sessionId/goalId/operationId/issuedAtMs but no expectedGoalRevision. The repository SDK dependency separately reports 2026.8.2 and its `node_modules/openclaw/dist/sessions-goal-BYVxyU3E.js:70` has the same closed non-CAS identity. Goal schema has updatedAt, not a monotonic revision. A `sessions.goal.update` completion with guessed CAS fields would not establish atomic version control and is not used.

Public SDK TaskRunView provides id/sessionKey/parentTaskId/runId/status/deliveryStatus; bound list() does not certify a consistent complete generation/root-scoped view of all descendants, queued/recoverable inputs and pending deliveries. The shipped plugin reports complete=false rather than substituting local counters.

Public supported reconciliation is present in installed `chat-CESxHe7C.js`: inputRunIds → inputReceipts/inputConsumptions. Public agent.wait supplies committed terminalReply for an exact run; Controller recovery reads this instead of reissuing a model request. Guarded sends require the actual `activeLeafEntryId` field (including explicitly authoritative null), never synthesize null for an absent leaf.

## Minimum host authorization still needed (not executed)

1. Monotonic native Goal revision and atomic expected revision/input-leaf completion guard under the session mutation lock, with stable conflict response.
2. Trusted exact binding enforcement at final resolved tool/native mutation dispatch, covering generic wrappers and missing identity.
3. Authoritative consistent complete generation/root-run task/input/delivery snapshot (or a public API with equivalent guarantees).

The production OpenClaw client intentionally does not implement `verifyGoSafety`, `initializeGoRuntime` or `completeGoNativeGoalCas` from unproven capabilities. Their absence prevents any `/go` activation before session/model work. The synthetic host supplies those contracts solely inside offline tests.

## Verification levels

- **Repository code/offline:** full TypeScript/plugin build and complete offline suite; Controller lifecycle and durable delivery-operation fault tests are in `tests/go-runtime-loop.test.ts`, strict admitted-run and public original-result tests in `tests/go-integration.test.ts`; existing controller, policy, runtime-gate and bridge regressions retained.
- **Offline real installed-host evidence:** schema/implementation inspection only. No isolated real-host native CAS success is claimed: installed public API lacks the necessary contract.
- **Real Gateway/model/Feishu:** not exercised. No production configuration, Gateway lifecycle, real business messages, deployment or push was changed/performed.

The two pre-existing untracked review documents remain untouched.
