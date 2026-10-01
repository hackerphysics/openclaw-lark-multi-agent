# Go Controller offline acceptance — 2026-10-02

Baseline: `main` at `96f5b17`. Repository-only change; no deployment/push/Gateway configuration or lifecycle mutation/real business messages.

## Verified result

- `npm run build`: PASS (bridge TypeScript, lma-steer plugin, lma-go plugin).
- `npm test`: PASS — **19 files, 770 tests**; final run started 05:50:11 Asia/Shanghai, 37.35 seconds.
- `git diff --check`: PASS.
- Existing two untracked review documents preserved and excluded from the commit.

## Closed-loop evidence

`tests/go-runtime-loop.test.ts` adds 21 isolated runtime tests using the actual Controller, SQLite persistence, persisted Go plugin policy, public guarded-send/history adapter and bridge dispatch implementation. An explicitly synthetic host supplies the otherwise missing monotonic native Goal CAS and complete runtime snapshot authority. All model outputs/platform responses are fixtures; no real model or Feishu request is sent.

Covered:

- WAIT → CONTINUE → guarded executor admission/collection → body/attachment evidence → criterion-mapped COMPLETE.
- Main running, descendants running, pending task returns, queued/recoverable input, pending platform delivery and incomplete snapshots: no checker/executor model invocation.
- Goal revision edits, absent criterion coverage, forged refs, error-only refs, exact source generation/run qualification.
- Pause/stop/reset/new user input invalidate an in-flight checker verdict and each of the four initialization races; concurrent init admits once.
- Accepted but lost RPC response reconciles its original `chat.history` input receipt; no resend on restart/resume.
- Original committed terminalReply is read through exact-generation `agent.wait` reconciliation; another run's session text cannot substitute for the admitted checker result.
- Full long-body fallback chunks, file/image attachments and captions have separate actual message IDs and platform payload receipts. Authorized transport artifacts (uploads/document operations) are cached separately and never count as delivery.
- Actual SQLite close/reopen preserves accepted and unknown platform operation outcomes. Accepted response is reused; unknown cannot resend/fallback into a second platform operation.
- Existing regressions cover schema parsing, limits, persistent policy conflicts, generation/archive refusal, task ancestry and ordinary chat/routing/attachment/error behavior.

## What is and is not accepted

**Repository/offline synthetic closed loop:** accepted by the above tests. Controller no longer uses its legacy unguarded context-send path. It requires native scope initialization, exact runtime gates, guarded admission/run collection, structured delivered evidence coverage and guarded native completion authority.

**Installed real-host inspection:** repository SDK is 2026.8.2; globally installed host is 2026.9.6. Both public native Goal operation schemas lack expected revision CAS. Global evidence: `/home/haipw/.npm-global/lib/node_modules/openclaw/dist/src-BRUl7oDv.mjs:1892`; repository evidence: `node_modules/openclaw/dist/sessions-goal-BYVxyU3E.js:70`. Installed public task list does not certify a complete consistent generation/root scope snapshot. Final generic-tool/native mutation binding enforcement has not been certified. No real-host CAS success is claimed.

**Real Gateway/model/Feishu roundtrip:** not run and not accepted. Production Go stays closed because the production client does not assert safety or implement native initialization/completion authority from unsupported public APIs.

Only authorized host capability work remains before real activation: native monotonic revision/input-leaf CAS, final resolved binding enforcement, and an authoritative complete task/input/delivery snapshot. See `go-integration-boundaries.md` for the precise boundaries. A platform response lost without any message ID is intentionally conservative unknown, not a claim of exactly-once platform reconciliation.

Preserved untracked file SHA-256:

- `docs/review-commands-2026-06-10.md`: `2d1049850702dc86faf2e1177a1aa400490064ee171f544638274de85824abfa`
- `docs/review-delivery-2026-06-10.md`: `242f82319592ad52ac7da28086b5713d3598bfd699513264cc9cfd70e51f149e`
