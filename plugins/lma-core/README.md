# lma-core

The single consolidated LMA gateway plugin. Replaces:

- `lma-steer` 0.1.1 → steer module (`lma.steer`)
- `lma-go` 0.1.0 → go module (`lma.go.bind/capabilities/snapshot`, `before_tool_call` guard)

plus the new compaction R&D module (`lma.core.capabilities`).

## Why one plugin

Each extra plugin is one more manifest + allowlist + upgrade path that can
silently fail to load (two production incidents in one week proved it).
lma-core keeps ALL gateway method names and the persisted go-bindings path
(`<stateDir>/lma-go/bindings.json`) unchanged, so the LMA bridge and existing
state migrate with zero changes.

## Gateway methods

| Method | Scope | Purpose |
|---|---|---|
| `lma.steer` | (bridge) | Durable session-input submit/query; actual backend callback acceptance |
| `lma.steer.stop` | (bridge) | Persist session stop-epoch cutoff; late old attempts cannot revive |
| `lma.steer.capabilities` | (bridge) | Truthful acceptance/atomic-target capability report |
| `lma.go.bind` | operator.admin | Persist a checker tool-isolation binding |
| `lma.go.capabilities` | operator.read | Report Go module capability surface |
| `lma.go.snapshot` | operator.read | Session-scoped task snapshot |
| `lma.core.capabilities` | operator.read | Module inventory + compaction strategy report |

## Compaction R&D (Phase 1)

Custom compaction (tool-trim: drop tool payload, keep text) is being built as
a gateway-sanctioned projection — the transcript stays intact; only the model
context gets filtered. Phase 1 ships the capability report and an
env-gated api-surface probe (`LMA_CORE_LOG_API=1` logs the plugin api's
enumerable surface at registration) so Phase 2 targets real hook names
(candidates: `llmInputHook`, `Before/AfterCompactionHook`, ContextEngine
projections).

## Build

```bash
cd plugins/lma-core && ../../node_modules/.bin/tsc -p tsconfig.json
```

(Repo root `npm run build:core-plugin` runs the same.)

## 0.2.0 persistent callback-confirmed insertion

`lma.steer.capabilities` returns protocol 2, `acceptanceCallback:true`,
`durableAttempts:true`, `sessionGenerationBound:true`, **`atomicRunBound:false`**.
The latter is a disclosed public-host limitation, not a gate disabling insertion.

`lma.steer` requires `sessionKey`, `text`, stable `insertionId`, `expectedRunId`,
`expectedSessionId`, and integer `stopEpoch`. The bridge pins these before its
attempt journal and drives paced recovery; the method returns promptly rather
than holding an RPC for readiness/acceptance. `queryOnly:true` never queues.
The plugin synchronously resolves/checks/dispatches using public SDK exports,
fsyncs an unknown-attempt fence before queue invocation, and records the actual
`onQueueAccepted(true/false)` asynchronously under that exact attempt identity.
No `deliveryTimeoutMs` or unverified cross-version abort behavior is assumed.

- SDK immediate false: no queue dispatch, pending/no-effect, safe paced retry.
- SDK immediate true: attempt/unknown; only backend callback true permits Get.
- Explicit callback false: no-effect refusal; retries remain original-target
  scoped and paced, never a switch to whatever run happens to be current.
- No callback, lost journal after attempt, crash at/before dispatch: unknown,
  never a retry or ordinary fallback. Stable queue ID is not host idempotency.
- Delayed callback true: durable accepted, readable on later query/restart.
- Stop/reset epoch or changed generation/archive: cancel/pause, no migration.
- Exact old-run terminal + proven never dispatched + positive session idle: the bridge
  explicitly releases the original pending input to ordinary custody once.

The journal lives under `<OPENCLAW_STATE_DIR>/lma-core/steer-custody` (default
`~/.openclaw`). Only explicit never-attempted `capability_blocked` records from
an earlier local candidate are migrated; attempted uncertainty is not erased.
No OpenClaw internal DB, private hashed imports, handle replacement or invented
source authority is used. Backend acceptance is not model consumption or DONE.

Both inspected builtin SDK versions call the acceptance callback. Backends that
omit it stay explicitly unconfirmed and cannot get Get. The public SDK does not
provide final-effect original-run CAS across backend awaits: session generation
and observed lifecycle fencing must not be advertised as that stronger promise.
