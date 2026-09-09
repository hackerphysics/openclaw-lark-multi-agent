# Normal conversation recovery — 2026-09-10

Base: v1.4.8, commit `8217eaa1d01c94f3d3acade166875413f1c91a67`. The ask_user experiment remains archived outside this working tree and is not re-enabled by this patch.

## Narrow changes

- Preserve the existing collector's user anchors, session bucket matching, continuation handling, live-status callbacks, normal chat.send, attachments, routing and plugin steering.
- Replace the 30-minute idle abort with read-only `agent.wait` reconciliation. Rechecks occur at most once per minute; pending, bare timeout, draining, missing/wrong identity and inconclusive records do not justify stopping execution. A matching recorded terminal can release the collector. A 24-hour local resource bound ends observation without sending abort.
- Use queue ownership instead of total elapsed time for the busy decision. Healthy runs past 30 minutes still attempt steering.
- When lma.steer explicitly reports no_active_run, immediately reconcile the original run. If its result is unavailable, a same-session `chat.history.sessionInfo.hasActiveRun === false` permits ending the stale local observation and draining new pending input. Unknown/true activity is not treated as idle. This path renders result-unconfirmed, does not mark the previous message DONE, and does not replay it or abort background work.
- Register steer consumption correlation before issuing its RPC and do not recreate stale cleanup if consumption precedes acknowledgment.

## Verification

`npm run build`, `git diff --check`, and `npx vitest run --config tests/normal-flow-offline.config.ts` passed: **10 files, 305 tests**. The offline guard blocks TCP/fetch, including the legacy tests' attempted mock-network calls. No test creates production chat messages or modifies Gateway sessions.

New cases cover >30-minute pending observations, genuine terminal timeout, early consumption, no-active-run terminal recovery, explicit idle vs unknown/active sessions, retained anchored continuation, late busy insertion, pending queue drain after an idle owner release, and truthful frozen status for unconfirmed old results. Existing baseline tests are retained; only the three assertions expecting silence alone to terminalize a run were revised.

## Deployment

Production LMA restarted at **2026-09-10 06:41:04 Asia/Shanghai**, PID **3085809**. Twelve bots started and Gateway WebSocket connected. Running client, bot, index and live-status output matched the tested build. Previous program backup: `/home/haipw/.openclaw/openclaw-lark-multi-agent/backups/before-minimal-idle-fix-I8sU8lXe`.

Gateway was not restarted (PID3049391 / start2026-09-09 22:46:34). No chat database, chairman/free settings, model configuration, private-key provisioning or question policy edits were performed by this fix.

## Limits

This does not guarantee that the legacy plugin's provisional synchronous acceptance is ultimately consumed. No-active-run means there is no direct run to inject into; it must not be reported as successful insertion. Gateway asynchronous rejection, lost child-completion wakes and cross-process durable collector recovery remain separate issues. Normal final/error/disconnect paths are intentionally not rewritten. A live Feishu interaction after this restart is still required to validate visible tool activity and actual mid-task consumption; startup and unit tests alone are not that proof.
