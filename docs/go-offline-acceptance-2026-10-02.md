# Independent Go offline acceptance — 2026-10-02

Supersedes the earlier native-Goal-gated acceptance report. Independent mode does
not create or complete native Goals and has no native CAS activation dependency.

## Verified scope

- Full TypeScript, lma-steer and lma-go plugin builds.
- Existing complete regression suite retained; independent public-adapter and
  Controller closed-loop tests added (772 tests total).
- Actual production client binding/capability/history/task-query adapters exercised
  through an isolated local public-interface runtime fixture, with real Controller,
  SQLite store and persisted plugin restriction registry.
- Initialization → WAIT → CONTINUE → guarded executor admission → delivered evidence
  and complete criterion coverage → COMPLETE → restart without replay.
- Real Checker hook denies generic tools; executor native goal tools remain usable.
- Pending human inputs prevent checking. Existing regressions cover descendant
  busy/pending returns, unknown state, generation changes, user input/stop/pause/reset
  stale verdict fencing, original receipt/result recovery, attachment delivery and
  unknown platform operation no-replay.

Legacy conservative snapshot fixtures remain as extra regression coverage; they
are not production requirements. No global atomic snapshot guarantee is asserted.

## Not performed

No business Gateway/plugin activation/restart, real model replay, real Feishu
roundtrip, push or deployment. Operator still needs to enable the included `lma-go`
plugin and use a bridge credential authorized for dynamic operator.admin binding.
See `go-integration-boundaries.md` for concrete activation and observation limits.
