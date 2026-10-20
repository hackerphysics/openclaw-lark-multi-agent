# Collector terminal-reason preservation and one error owner

## Scope and evidence

This is an LMA-only correction after `eaa941f`. No Core, database schema,
configuration, permission, protocol version, dependency, manifest, timeout limit,
model, retry-input policy, deployed artifact, or live record is changed.

The evidenced producer loss is an ignored public `chat.state=aborted` frame with
closed `stopReason=timeout`, followed by a generic lifecycle error. The active
collector previously rejected plain `Error("Agent error: aborted")`; the queue
created a trigger-only provider notice, while a later same-run chat error could
create a second run notice. A terminal run deadline is not an idle collector
pause and must not say that the underlying run may still continue.

The new test IDs and account names are synthetic. The aborted-frame shape is
based on observed safe public metadata. Lifecycle/late-error fixture envelopes
are source-derived, **not** a claim that the complete historical lifecycle wire
was captured. No original input, raw Core store, model call or platform traffic
was needed.

## Producer contract

- Normalize aborted chat frames into the exact-run collector buffer, retaining
  physical session identity and a strictly closed metadata reason.
- Preserve meaningful lifecycle terminal reasons without bypassing recoverable
  context-error handling. Bare `aborted` triggers bounded cause reconciliation,
  not a timeout or human-cancellation classifier rule.
- A 350 ms same-run grace allows already received or shortly following closed
  metadata/finals to win. Missing cause can use only bounded public `agent.wait`
  for the **same** run. Recorded terminal time and compatible physical identity
  distinguish terminal snapshots from query timeout, pending, yield or queue
  projections. An abort envelope without cause may remain unknown; query timeout
  by itself never establishes a run deadline. Verified newer progress cancels a
  provisional generic-abort hint.
- `RunTerminalError` carries exact session/run metadata through collection and
  the foreground catch. Explicit stop receipts and final delivery retain
  precedence. Superseded writer, Gateway restart and total deadline have distinct
  presentation; no person is inferred from a generic abort.

## Durable notice/outbox ownership

Known terminal foreground failures use the existing error journal and guarded
`run_error` outbox, not a new manager. Complete new identities include original
Bot/app, chat, canonical/physical session, run and stop epoch. Legacy records
without complete physical scope keep their compatible old identity; no physical
session is invented. Original routing/epoch and known physical conflicts are
checked again before sending.

Ordinary foreground provider errors retain their established trigger key, with
exact admitted-run provenance when available. Truly unadmitted failures retain
trigger-only behavior. A later same-run error consults that existing owner;
different runs/details are not deduplicated by text.

Compatibility lookup is read-only, bounded to matching run/provenance or known
legacy run/trigger keys, and checks original app/epoch and nonconflicting known
physical identity. Original legacy outbox route evidence is not replaced by the
currently configured app. Existing attempted, unknown, pending or delivered
owners are not requeued under another key. In particular, already delivered
historical trigger/run error rows are not migrated, rewritten or resent.

Existing platform receipt, unknown-attempt custody, explicit stop, recalled
trigger, original app/epoch and exact-final send-time safeguards remain in the
normal dispatcher. The curated provider classifier and raw-excerpt sanitizer
are unchanged; closed metadata uses fixed localized rendering, and unknown
prose still passes the existing anti-echo/credential guards.

## Verification

Two independent whole-chain RED controls used frozen `eaa941f` source:

1. Receiver → owned collector → foreground queue catch → formatter → persistent
   outbox → mocked SDK receipt rendered the wrong unknown `aborted` notice instead
   of the proven total deadline (0.77 s wall time).
2. The same path plus late same-run chat/session error produced **two delivered
   rows, one attempt each, and two SDK sends** rather than one (0.79 s).
   The controlled old-source overlay was restored byte-for-byte in `finally`;
   no commit or deployed manifest was altered.

`tests/collector-terminal-reason.test.ts` exercises the complete path, including
metadata order, exact public lookup, bare unknown abort, pending/yield/query-only
negative cases, superseded/restart, explicit stop, concurrent distinct runs,
known final priority, current and legacy ownership, no-run admission rejection,
recoverable context, original app/epoch/physical/recall guards, and durable
unknown-attempt restart without resend. All sockets/fetch remain blocked by the
existing offline guard.

The original 1936 test cases are retained. Two pre-existing assertions are
intentionally corrected, not removed: a recorded terminal deadline now asserts
structured terminal metadata instead of the old "may continue" wording, and
an abort-versus-yield case permits the bounded reconciliation grace instead of
expecting immediate rejection at 100 ms. Privacy/credential suites are unchanged.

Local verification uses the pre-provided exact-lock dependency symlink with SDK
1.73.3 and Node v26.10.0; it is not a fresh-install or live-recovery proof. Parent
review, clean-lock/runtime checks, deployment and publication remain separate.

Final-source gates (2026-10-20), run in build-before-test order:

- `npm run build`: bridge and all three plugins passed, **4.95 s**.
- `npm run test:sdk-contract`: passed, **1.02 s**.
- `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/collector-terminal-reason.test.ts`: passed, **1.68 s**.
- `npm test`: **69 files / 1964 tests passed**, **38.28 s** wall time: the
  original 1936 cases plus 28 new whole-chain/ownership cases.
- `git diff --check`: passed. Curated provider-error/credential/anti-echo tests
  were not weakened; package/lock files and the prior P2P implementation are
  unchanged.

Evidence logs (local only): `/tmp/lma-terminal-reason-red-1020.log`,
`/tmp/lma-terminal-duplicate-red-eaa-1020.log`, and
`/tmp/lma-terminal-final-{build,sdk,types,full}-1020.log`.
