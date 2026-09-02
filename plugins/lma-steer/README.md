# lma-steer (legacy compatibility plugin)

This plugin is retained for older `openclaw-lark-multi-agent` deployments that
called the private `lma.steer` Gateway method.

Current LMA releases on OpenClaw 2026.8+ do **not** use this plugin. They submit
mid-run input through the public protocol API:

```text
chat.send { queueMode: "steer" }
```

The public path owns admission, while LMA retains its durable fallback trigger
until a matching `session.message` confirms transcript consumption. Only then
is the Feishu acknowledgement changed from Typing to Get, so provisional
acceptance and actual model consumption remain distinct.

## Legacy installation

Only install this plugin when maintaining an older LMA release that explicitly
requires `lma.steer`:

```bash
lma install-steer-plugin
```

Restart the OpenClaw Gateway after installation. For new deployments, skip this
step.

## Legacy method

- method: `lma.steer`
- params: `{ sessionKey: string, text: string }`
- result: `{ status: "steered" | "no_active_run" | "rejected", sessionId?: string }`

Its synchronous `steered` result reflects immediate queue eligibility only; it
cannot prove later runtime consumption. This limitation is why current LMA uses
the public native steering path instead.
