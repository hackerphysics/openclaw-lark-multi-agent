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
| `lma.steer` | (bridge) | Durable strict-run intent/query; fail closed when host run-CAS is unavailable |
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

## 0.2.0 strict insertion boundary

The currently supported public OpenClaw SDK exposes a boolean queue eligibility
helper and an optional real `onQueueAccepted` callback, but **no host-owned atomic
`expectedRunId` assertion or durable per-insertion submit/query contract**. A
successor run can reuse the same sessionId. A local event map is not authority.

Therefore strict original-run insertion is retained as `capability_blocked`; it is
not injected into an unverified handle, acknowledged with Get, moved to a new run,
or silently replayed as an ordinary message. The bridge persists each intent and
surfaces the limitation. There is no opt-in switch that manufactures acceptance.
Short RPC deadlines do not expire long business tasks.

`lma.steer` requires `sessionKey`, `text`, stable `insertionId`, and
`expectedRunId`; `queryOnly` never creates a new attempt. The plugin-owned journal
is under `<OPENCLAW_STATE_DIR>/lma-core/steer-custody` (default `~/.openclaw`).
No OpenClaw internal database or private hashed SDK imports are used.
