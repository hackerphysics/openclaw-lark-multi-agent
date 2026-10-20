# R2: revalidate the provisional abort cut after public lookup

Base: frozen `d7930880baf817892607228a979f34636a331775`.
Worktree: `~/lma-terminal-cut-r2-1020`, branch
`fix/lma-terminal-cut-r2-20261020`. The previous source worktree and deployed
artifacts/manifests are not edited.

## Confirmed boundary and repair

The earlier generic-abort collector checked its effective-activity generation
before awaiting `agent.wait`, but not after it returned. Verified same-run
progress arriving during that read could therefore be followed by an obsolete
unknown error or obsolete recorded timeout, persisting/sending an error before
a valid normal final. A rejected lookup crossed the same unguarded boundary.

The producer now drains already received frames and revalidates the original
provisional abort generation after the await, before using either a terminal
snapshot or the unknown-error fallback. The shared pre-rejection boundary also
covers lookup failure. Stale provisional hints yield to existing live
observation; the progress event has already advanced/rearmed that observation.
No new waiting policy, manager, clock, run timeout, automatic input retry or
model selection is introduced.

Wire finals, new closed same-run terminal metadata, and explicit stop receipts
retain precedence over the provisional cut. An unchanged cut still emits the
existing unknown abort notice; the correction is not blanket abort suppression.
All app/physical/session/run/epoch routing and historical delivery protections
remain in the existing unchanged journal/outbox code.

## Permanent whole-chain proof

`tests/collector-terminal-reason.test.ts` retains the previous 28 cases and adds
8 receiver → collector → queue catch → persistent outbox → mocked SDK cases:

- Progress **during** an already pending query, followed by query-only timeout,
  stale positive `endedAt` timeout, or lookup rejection: zero failure rows and
  zero error sends; the subsequent normal final is delivered once, with one
  original input submission and no abort/replay.
- Without intervening progress, query-only timeout and lookup rejection still
  produce one unknown abort notice without human-cancellation attribution.
- A wire final, new closed timeout, or explicit stop during the pending query
  keeps its established authority, including after verified progress.

On unchanged D793 producer source, all three post-await regressions were RED:
each observed **one** persisted failure row instead of zero. Only the new test
file had changed for that control. The supplied parent reproduction is retained
separately; no old source overlay or old-worktree edits were needed in R2.

The offline socket/fetch guard remains enabled. Identifiers and content in these
fixtures are synthetic. No original input or model/platform traffic is replayed.
No Core/schema/config/dependency/version/publication/live-data changes occur.

## Local verification

Commands use Node v26.10.0 and the pre-provided exact-lock dependency symlink
with SDK 1.73.3, not an independent fresh-install proof. Parent fresh review,
clean-runtime checks, deployment and publication decisions remain separate.

Final-source gates (2026-10-20), build prerequisites before the full suite:

- RED: `npm test -- tests/collector-terminal-reason.test.ts -t 'post-await abort cut:'`
  on unchanged D793 producer source: **3 expected failures**, 0.83 s wall time.
- Focused GREEN: `npm test -- tests/collector-terminal-reason.test.ts`:
  **36 passed** (28 retained + 8 new), 1.36 s.
- `npm run build`: bridge and all three plugins passed, 4.97 s.
- `npm run test:sdk-contract`: passed, 1.01 s.
- `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck tests/collector-terminal-reason.test.ts`:
  passed, 1.68 s.
- `npm test`: **69 files / 1972 passed** (1964 retained + 8 new), 38.50 s.
- `git diff --check`: passed. Existing privacy/credential fixtures, ownership,
  historical delivery and P2P tests remain unchanged.

Logs: `/tmp/lma-terminal-r2-{red,focused,build,sdk,types,full}-1020.log`.
