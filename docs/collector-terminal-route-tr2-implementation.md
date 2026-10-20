# TR2: authorize ordinary admitted errors against retained original custody

This source correction is directly above TR1 commit
`9660cfc38b98283dc1d216229fe3023f90fbed1d` in the isolated
`~/lma-terminal-cut-r2-1020` worktree. It completes the second blocker from the
independent D793 review; the old D793 worktree remains frozen and untouched.
No Core, schema, configuration, timeout, model, dependency, version, permission,
publication, deployed manifest or live-data change is made.

## Evidenced gap and narrow correction

An ordinary admitted lifecycle/provider error already retained the original app
in `provenance.error`, but new outbox metadata was stamped from current config.
The ordinary provider-error arm did not use the terminal journal's original
error authorization, allowing a known conflict to authorize itself at the mock
SDK boundary. A changed retained physical target likewise escaped that arm's
send-time checks.

The correction reuses one synchronous `errorRouteRevocation` check from both
terminal error inspection and the dispatcher's SDK effect guard. It consults
retained error provenance **and** the exact stored admission target for known
app, canonical/physical session, stop epoch and recalled-trigger conflicts.
New error outbox metadata retains the original provenance's known app/epoch
instead of stamping replacement config over it. Current metadata alone cannot
authorize the original error route. No separate manager or control flag is added.

Genuine unadmitted failures without a run/error provenance keep their existing
trigger-scoped behavior. Matching original-app ordinary errors still send once.
Error keys, pending/unknown-attempt custody, receipt reconciliation, original
historical rows and retry/requeue policy are not rewritten or migrated.

## Clean whole-chain RED and GREEN

Nine new cases extend the existing actual receiver → foreground collector →
ordinary queue catch → persistent outbox → guarded mocked SDK receipt path:

- Matching app: one delivered ordinary provider-error body, with consistent
  original app/physical/run/epoch provenance and one confirmed receipt.
- App/epoch/physical/recall changes before the ordinary foreground catch.
- Those same four changes **after** enqueue, while the ordinary footer read is
  held pending, proving that the real send-time boundary rechecks custody.

On unchanged 966 producer source, three cases were RED: changed app before the
catch, changed physical target before the catch, and changed physical target
after enqueue each invoked the SDK mock once. Six controls already passed.
The focused run terminated normally with expected assertion failures, not an
ad-hoc harness timeout or residual-timer cleanup error.

This is a dispatch-authorization proof with mocked RPC/SDK receipts, **not**
evidence of a real cross-app Feishu send or live SDK credential mutation.
All fixtures are synthetic and all real sockets/fetch remain blocked.

## TR1 retained

The post-await stale-abort-cut producer correction and all eight of its cases
are unchanged. Its three old-source RED controls remain in
`/tmp/lma-terminal-r2-red-1020.log`. The implementation and original proof are in
[the TR1 report](collector-terminal-cut-r2-implementation.md). The combined
candidate therefore includes both TR1 and TR2, rather than treating the previous
TR1-only source-ready state as deployment approval.

## Verification

Local gates use Node v26.10.0 and the supplied exact-lock dependency symlink
with SDK 1.73.3; this is not independent fresh-install or runtime acceptance.
Parent fresh review and final dual-runtime/deployment decisions remain required.

Final-source gates (2026-10-20), build prerequisites before the full suite:

- RED: `npm test -- tests/collector-terminal-reason.test.ts -t 'ordinary admitted error route:'`
  on unchanged 966 producer source: **3 expected failures / 6 passing controls**,
  normal cleanup/exit, 0.90 s wall time.
- Focused GREEN: `npm test -- tests/collector-terminal-reason.test.ts tests/terminal-errors.test.ts tests/core-error-information-boundary.test.ts`:
  **120 passed / 3 files** (including all 45 terminal-chain cases), 1.66 s.
- `npm run build`: bridge and all three plugins passed, 4.92 s.
- `npm run test:sdk-contract`: passed, 1.01 s.
- `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/collector-terminal-reason.test.ts`:
  passed, 1.69 s.
- `npm test`: **69 files / 1981 passed** (1972 retained + 9 new), 38.32 s.
- `git diff --check`: passed. TR1 source and prior privacy/credential, P2P,
  historical-delivery and unknown-attempt test cases are unchanged.

Evidence: `/tmp/lma-terminal-tr2-{red,focused,build,sdk,types,full}-1020.log`.
The source-ready manifest at `/tmp/lma-terminal-r2-source-ready-1020.json` is
replaced only after the new source is committed and final gates pass.
