# lma-steer

`lma-steer` provides observable mid-run insertion for
`openclaw-lark-multi-agent`.

OpenClaw's public `chat.send { queueMode: "steer" }` acknowledges admission with
`started` even when the message falls through to a later ordinary run. That is
not enough for LMA to tell users whether a message actually entered the active
run. This plugin resolves the active embedded run and reports one of:

- `steered` — queued into the active embedded run;
- `no_active_run` — no active embedded run was found;
- `rejected` — the runtime refused queueing.

LMA treats `steered` as provisional until the matching `session.message`
confirms transcript consumption. Any other outcome remains in LMA's durable
normal queue.

## Installation

Realtime mid-run insertion requires this plugin:

```bash
lma install-steer-plugin
```

Restart the OpenClaw Gateway after installation. LMA itself remains functional
without the plugin, but messages received during a run wait safely in the
normal queue.

## Gateway method

- method: `lma.steer`
- params: `{ sessionKey: string, text: string }`
- result: `{ status: "steered" | "no_active_run" | "rejected", sessionId?: string }`
