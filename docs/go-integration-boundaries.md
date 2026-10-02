# Independent LMA Go integration (2026-10-02)

Go is independent: MessageStore owns objective, acceptance criteria, revision fencing,
verdicts and completion. Native Goal creation/update/completion is not invoked. The
executor remains free to use its native Goal tools; these do not own LMA Go state.
Existing native helpers are optional unrelated APIs, not activation requirements.

## Production wiring

The real OpenClawClient implements `verifyGoSafety`, `initializeGoRuntime`,
`getGoSessionInfo`, guarded admission, exact-run collection and runtime query.
Controller uses public `chat.history` sessionInfo for generation and active-leaf
identity (describe alone does not project the leaf), pendingInputs.total and
inFlightRun recovery, plus plugin public task views for exact task/run/parent
identity and delivery status. SQLite independently fences user input, pause, stop,
reset, pending bridge triggers and visible-delivery receipts.

`lma-go` persistently binds a freshly created dedicated checker through the
operator.admin `lma.go.bind` RPC **before any checker model admission**. Its real
before_tool_call hook denies every Checker tool, including generic wrappers and
reads, across missing/replaced generations. Executor/unrelated tools are unchanged.
Bindings survive restart and are intentionally not auto-removed on stop.

## Goal execution and delivery contract

`/go <objective>` means **set the objective and begin executing it**, not merely
watch for a later user execution message. The command initializes the isolated
Checker, replies, clears only its own bridge pending row, and arms a cycle.
A durable `go_bootstrap` intent submits the original authorized objective once at
an observed idle boundary; existing main work, queues, descendants, task returns,
unknown runtime state and pending outbox receipts defer admission. Human input,
pause, stop and generation changes invalidate stale cycles through revision CAS.
An unsubmitted bootstrap superseded by new human work is paused rather than
silently replaying the old objective.

- `sendGoGuarded`: public `chat.send` with exact `sessionId`, `expectedLeafEntryId`,
  stable `idempotencyKey`, `deliver:false`, `suppressCommandInterpretation:true`.
  A bridge attachment capability hint changes transport instructions, not scope.
- `collectGoExecutorRun` / `readGoExecutorRunResult`: public `agent.wait` for the
  original run, bounded by before/after generation checks. Committed `terminalReply`
  distinguishes visible, silent/NO_REPLY and true empty; committed terminal error
  becomes error evidence and pauses. Missing terminalReply, yielded runs, pending
  errors and mismatched run/generation remain unknown, not invented completion.
- `deliverExecutorResult(chatId, result, goId)`: the real FeishuBot callback parses
  body and attachment markers into the existing outbox. Body chunks, attachment
  payloads and captions retain their actual platform `message_id` receipts.
  A late result remains attached to its original Go even after stop/new Go.
- Exact Go run ownership suppresses competing proactive delivery before admission
  and persists across restart/completion. Results do not depend on a host proactive
  send. Unknown platform operations also fence fallback card/text sends after restart.
- Initial execution and CONTINUE share send/result/delivery ledgers. Recovery reads
  original admission and terminal receipts and can deliver an already-proven result;
  it never replays the model/business request. Unconfirmed results remain paused.

`tests/go-execution-loop.test.ts` drives the real Controller, production runtime
adapters, FeishuBot command/callback/outbox and SQLite from only `/go <objective>`
through initial execution, platform receipts, CONTINUE execution/delivery and
COMPLETE, without manually inserting executor evidence. Host/model/platform
transports are synthetic and all real network sockets are forbidden in tests.
Legacy verdict-unit fixtures explicitly disable bootstrap to isolate supervision;
they are not represented as end-to-end execution proof.

## Guarantees and limitations

- Public queries are observations, **not a globally atomic snapshot**. Neither
  plugin nor client asserts atomicSnapshot=true. Controller rechecks before applying
  verdicts and uses normal generation/leaf guarded admission plus local revision CAS.
- Active/unknown sessions, recoverable inFlightRun, pending/unknown queue counts,
  active/unknown tasks, missing ancestors and pending task returns wait. Tasks are
  scoped to canonical session key; no invented generation field. Checking all visible
  tasks conservatively avoids missing work not yet associated with a local run.
- A missing task root alone does not imply busy: public live-run projection,
  recovery and input queue observations are independently checked. No global root
  completeness or native revision guarantee is required or claimed.
- Only actual delivered visible evidence of the exact executor generation/run can
  satisfy all structured criteria. Admission/upload alone is not delivery.
- Stable operation keys and original receipts reconcile lost admission responses;
  unknown sends, results or platform notifications are never blindly replayed.
- COMPLETE changes local durable state; restart settles accepted completion notices
  without another model/platform send. No native completion CAS exists or is needed.

## Local activation (operator-owned; not performed by this change)

1. Build/test this checkout locally (`npm run build`, `npm test`).
2. Install/load `plugins/lma-go` as an OpenClaw plugin using the host's supported
   plugin installation workflow; allow/enable plugin id `lma-go` preserving other
   configuration. No static bindings are needed: the bridge binds each new Checker.
3. Gateway operator reloads/restarts via its approved UI/chat workflow if required.
4. Bridge credential needs operator.read plus operator.admin for the binding RPC,
   alongside existing session/chat access. Do not paste credentials in chat.
5. Verify `lma.go.capabilities` responds with independent mode and taskQuery; then
   `/go <objective>`. Missing plugin or refused binding fails clearly before model work.

No Host edits, business Gateway activation/restart, real Feishu sends or real model
replays were performed. Independent production adapter is implemented and exercised
against isolated public-interface fixtures, not claimed as live production acceptance.
