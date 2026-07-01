# lma-steer

An OpenClaw plugin bundled with **openclaw-lark-multi-agent**. It registers a
Gateway method `lma.steer` that the bridge uses to inject a message into an
**active** OpenClaw run at the next tool-call boundary — so a user can nudge or
correct a long-running task in real time instead of waiting for it to finish.

## Why a plugin

Native `chat.send` with `queue.mode=steer` only acks `{status:"started"}` — it
cannot tell the bridge whether the message actually steered into the active run,
was queued as a followup, or was rejected. This plugin uses the runtime
primitives `resolveActiveEmbeddedRunSessionId` + `queueAgentHarnessMessage`,
which expose that distinction, so the bridge can render an accurate Feishu
reaction.

## Install

From an installed `openclaw-lark-multi-agent`:

```bash
openclaw-lark-multi-agent install-steer-plugin
```

Then restart the OpenClaw gateway so it loads the plugin:

```bash
systemctl --user restart openclaw-gateway.service
```

Verify (an idle session returns `no_active_run`):

```bash
openclaw gateway call lma.steer --params '{"sessionKey":"test","text":"ping"}'
```

## Gateway method

`lma.steer`

- params: `{ sessionKey: string, text: string }`
- result: `{ status: "steered" | "no_active_run" | "rejected", sessionId?: string }`
  - `steered` — queued into the active run; seen at the next tool-call boundary
  - `no_active_run` — no active run; caller should send as a normal new message
  - `rejected` — active run refused the injection (e.g. compacting / not streaming)
