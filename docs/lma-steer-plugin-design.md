# LMA Steer Plugin — Design Spec (draft)

> Goal (Stephen, 2026-07-01): An OpenClaw plugin **inside the LMA project**, installed
> by command, that detects tool-call execution and **injects a user's message in the
> gap between tool calls** (not after the whole run finishes). Must be able to report
> whether the steer actually landed (observable status), which native `chat.send`+queue
> steer cannot.

## Evidence (from OpenClaw source + docs, 2026-07-01)

- **Native steer queue** lives in the harness runtime (`proxy:3203 steerQueue`). The turn
  loop drains `getSteeringMessages()` **after each model+tool round, before the next model
  call** (`proxy:278`). That is exactly the "between tool calls" injection point.
- `harness.steer(text)` (`proxy:3609`) pushes to `steerQueue` and **throws
  `invalid_state` when `phase === "idle"`** → built-in observable status (active vs no run).
- `sessions.steer` Gateway RPC = `handleSessionSend({ interruptIfActive: true })` →
  **aborts the active run first** (redirect semantics). NOT what we want (it interrupts).
- `chat.send`+`queue.mode=steer` → only returns `{runId,status:"started"}`. **No signal
  whether the message steered into the active run or fell back to a queued followup.**
  This is the gap that motivated "write a plugin".

## Plugin primitives we will use

- **`before_tool_call`** hook: fires at every tool-call boundary; exposes `event.runId`,
  `event.toolName`, `ctx.sessionKey`. This is the "detect tool-call execution" tick.
- **`api.enqueueNextTurnInjection({ text, idempotencyKey, ttlMs, placement })`**: durable,
  exactly-once, dedup-by-key context delivered to the **next model turn**; drained by the
  host **before prompt hooks** (`attempt.prompt-helpers:107`).
- **`agent_turn_prepare`** hook: receives `queuedInjections` drained for this session →
  lets us **observe** that our injection was consumed (→ status = `delivered`).
- `api.registerSessionExtension(...)` (optional): project per-session steer state
  (pending/delivered counts) so LMA/Control UI can read status without internals.

## Design

### Components (all inside `~/openclaw-lark-multi-agent`, e.g. `plugins/lma-steer/`)

1. **Pending-steer store** (in-memory Map keyed by `sessionKey`): queued steer messages
   with `{ id, text, enqueuedAt, status }`.
2. **`message_received` / Gateway method** entry: how a steer request enters. Two options
   (decision below). Each enqueues into the pending store + `enqueueNextTurnInjection`.
3. **`before_tool_call` hook**: on each boundary for an active `runId`, if there are
   pending steers for that session, ensure they're enqueued for next-turn injection and
   mark `status: in-flight` (we know a run is active → steer will land at the next model
   boundary). This is the "inject in the gap" trigger.
4. **`agent_turn_prepare` hook**: when our injection ids appear in `queuedInjections`,
   mark them `status: delivered` and emit an observable event/log. ← **status answer**
5. **`agent_end` hook**: any still-pending steer for a run that ended without delivery →
   `status: deferred_run_ended`; decide fallback (treat as normal new message vs drop).

### Status model (the thing native steer can't give us)

- `pending` — accepted, no active run observed yet
- `in-flight` — active run detected at a tool boundary; injection enqueued
- `delivered` — host drained our injection into a model turn (confirmed)
- `deferred_run_ended` — run finished before delivery (fallback path)

## ★ Observable-status primitive (the key find, 2026-07-01)

Native `chat.send` ack can't tell us if a steer landed. But ONE layer below, the
plugin-sdk exposes the embedded-run steer queue WITH a structured outcome:

- `openclaw/plugin-sdk/agent-harness-runtime`:
  - `resolveActiveEmbeddedRunSessionId(sessionKey) => string | undefined`
    (is there an active embedded run for this session? = "are we mid-run")
  - `queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, text, {steeringMode:"all"})`
    returns `EmbeddedAgentQueueMessageOutcome`:
    - `{ queued: true, target: "embedded_run", deliveredAtMs }` -> steered into the
      active run at the next model boundary (what we want + confirmation)
    - `{ queued: true, target: "reply_run" }` -> no active run; queued as followup
    - `{ queued: false, reason, errorMessage }` -> rejected, structured reason

This IS the observable status. No need to abort the run (unlike sessions.steer);
host drains it between tool calls (proxy:278 turn loop).

NOTE: enqueueNextTurnInjection drains ONCE PER RUN at run start (cached for retries,
attempt.prompt-helpers:98) => followup-ish, NOT true mid-run steering. Use the
embedded-run steer queue above for real between-tool-calls injection.

## Final shape

- Plugin registers Gateway method `lma.steer` via api.registerGatewayMethod.
- Handler: resolveActiveEmbeddedRunSessionId(sessionKey):
  - active -> queueEmbeddedAgentMessageWithOutcomeAsync(...) -> return
    { status: steered|deferred|rejected, outcome }.
  - none -> { status: no-active-run } (LMA decides: send as normal new msg).
- LMA bridge: when busy, call lma.steer({sessionKey,text}) instead of local queue;
  render status (steered -> note; no-active-run -> normal send).

## Open decision (need Stephen) -- RESOLVED: (A)

**How does a steer request enter the plugin, and what is the source of the message?**

- (A) **LMA bridge calls a plugin-exposed Gateway method** (e.g. `lma.steer`) when a
  Feishu message arrives while the chat is busy. Cleanest; LMA already detects "busy".
- (B) Plugin itself claims inbound via `inbound_claim`/`message_received` and decides.
  More self-contained but duplicates LMA's busy/session logic.

Leaning (A): LMA already knows busy + sessionKey + the user text; it just hands the
message to the plugin instead of queuing it locally. Plugin owns boundary-injection +
status; LMA renders status back to the user.

## Install

`openclaw plugins install <path>` from the in-repo plugin dir; enable in openclaw.json
`plugins.entries["lma-steer"]` with `hooks.allowConversationAccess` /
`allowPromptInjection` as required. Restart gateway.
