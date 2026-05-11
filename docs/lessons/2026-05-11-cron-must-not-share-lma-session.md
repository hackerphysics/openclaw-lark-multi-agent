---
status: active
importance: essential
category: lessons
tags: [cron, lma-session, concurrency, empty-reply, regression]
last_reviewed: 2026-05-11
---

# Cron jobs must not share live LMA chat sessions

## Summary

A scheduled inspection job used the same long-lived LMA session as a real-time Feishu group bot:

```text
agent:main:lma-glm-oc_f8fff0533dc355b5dd7c9ba20d7ee7c7
```

While the cron run was active, a user sent a normal group message. The real-time message was marked completed, but no visible reply appeared.

## Impact

User-visible behavior:

- Feishu showed the message as completed / DONE.
- The group received no reply.
- Logs showed the bridge collected an empty reply for the user's message.
- The cron run later produced related output, suggesting the two runs contended for the same session context/lifecycle.

## Root Cause

Long-lived LMA sessions are live chat sessions. They should be reserved for real-time user interaction.

A background cron job using the same `lma-*` session can race with or occupy the session while a human message arrives. Even if OpenClaw serializes turns, bridge-level run collection can observe an empty final/NO_REPLY-like result for the real-time message.

This creates the same bad UX as a queue bug: message marked completed, no visible answer.

## Rule

**Background inspection / maintenance cron jobs must not target `lma-*` or `agent:main:lma-*` live chat sessions.**

Use one of these instead:

1. `sessionTarget: "isolated"` with a standalone `agentTurn`, and have the task send its final result to the intended group/user via the appropriate delivery path.
2. A dedicated non-live persistent session such as `session:lma-maintenance-<task>` if long-term background context is needed.
3. If the result must appear in a Feishu group, make the background task explicitly deliver the final result to that group after computation, but do not compute inside the group's live LMA bot session.

## Prevention

When creating or reviewing cron jobs, check:

- Does `sessionTarget` or `sessionKey` contain `lma-` or `agent:main:lma-`?
- Is the job background maintenance, inspection, scraping, download management, backup, cleanup, or monitoring?

If both are true, it is wrong.

## Related Fixes

- Move the Yongxin dataset inspection cron away from `agent:main:lma-glm-oc_f8fff0533dc355b5dd7c9ba20d7ee7c7`.
- Bridge should treat truly empty replies as an error/temporary failure, not a successful silent completion. Explicit `NO_REPLY` remains a valid silent success.

## Related Files

- `src/feishu-bot.ts`
- `docs/lessons/README.md`
