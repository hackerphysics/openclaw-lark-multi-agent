# Followup admission repair candidate — 2026-10-18

Isolated 1.8.15 candidate based on `129866c`; not a release or live acceptance claim. No Core/plugin-runtime/configuration/service/live-DB/version/dependency changes or deployment.

## Receiving is not starting execution

`hasActiveRun` is aggregate activity, not a universal veto on receiving input. `followupAdmissionEligible` is a **separate** positive proof: busy stays busy, never relabelled idle. A durable local queued card means local custody, not Gateway acceptance. Get requires a real admission receipt. A Gateway-accepted followup may remain queued until foreground work ends; neither its ACK nor another root's completion proves per-input commit or immediate execution.

The existing ordinary `chat.send` policy remains explicit `queueMode: "followup"`. The new restricted positive-busy path additionally sends observed `sessionId` + earliest genuinely observed nonempty `expectedLeafEntryId`, with command interpretation suppressed. No invented `expectedSessionId`, null leaf, private-symbol call, fabricated provenance/commit receipt, task-lifetime cutoff or queue clearing.

**Ordinary unknown-state rescue is preserved.** A genuinely unknown *activity observation* for a fresh never-attempted input still gets the existing 60-second bounded ordinary-followup rescue. That is distinct from an unknown *submission receipt*, which never gets a new-ID resend. Positive busy, archive/identity conflict, previous restricted proof, target-changed, stopped and possible-attempt custody cannot escape through this ordinary rescue. The original six A4 tests, including the unknown-state positive control, keep their assertions.

## Earliest leaf, not a motionless transcript

Static read of installed Linux 2026.9.9 `chat-send-handler-CxoF4cDR.mjs:4018–4029` confirms the host's public RPC guard: with the requested physical session ID, the observed leaf may be **exact or an ancestor on the current active path**. An off-path leaf or different physical session is refused. The candidate does not import or execute that helper.

Therefore normal background transcript advancement does **not** restart the 60-second observation or permanently mark input target-changed. The bridge keeps the earliest genuine leaf, revalidates current physical identity/nonarchive/no-target/eligibility, and sends that observed leaf to the supported RPC. Core atomically distinguishes ancestor advancement from off-path branch changes. Synthetic server-edge tests exercise both outcomes through the actual Client WS serializer/ACK handler, Bot and SQLite.

Each pending input keeps its own first observed guard. A newer C does not inherit an obsolete scheduler leaf from before C arrived. Guard cohorts are not merged across different proofs. If old B is refused off-path, B stays pending/unsynced with a visible notice; independently proved C can still proceed exactly once.

## State matrix

| State | Admission design and tested evidence | Execution / receipt boundary |
| --- | --- | --- |
| Positively idle | Existing ordinary explicit-followup path and positive-idle controls retained. | ACK -> Get; exact attributable final/delivery governs ordinary completion. |
| Direct injectable active target | Preserve coordinated SDK insertion. New integrated test traverses actual plugin/public SDK callback, Client, Bot and SQLite. | SDK enqueue acceptance is not commit; root end does not imply insertion DONE. |
| Aggregate maintenance/background busy; no injectable target; observed physical ID + nonempty leaf; nonarchived | Matching physical-session observations separated by 60s permit one guarded, noninterrupting followup. Client revalidates before attempt. Baseline keeps `busyConfirmed:true`, `idleConfirmed:false`. Existing queued, retained, hidden or incomplete pending metadata is **not** a receiving veto. | Synthetic Gateway ACK through the real handler proves admission logic, not immediate execution. Old exact-run recovery/target/Get persists. |
| Healthy background transcript advances the leaf | Keep earliest genuine leaf; host exact-or-ancestor CAS decides. Positive tests cover both still-busy and later-idle sessions and an independent subsequent C. | No permanent local block solely because the current leaf differs. |
| Off-path branch / generation change | Host named pre-effect guard refusal, or positive physical/archive conflict, retains affected input with a durable visible explanation. | No migration, silent sync/delete, new-ID retry or resurrection of accepted originals. |
| Trusted yield / detached or reopened admitted owner | Retire only the local scheduler after safe proof; preserve original exact-run observation, result target and Get. | No fabricated yield or terminal. Late A and new B/C still route independently. |
| Fresh input reserved during unresolved send/ACK | Monotone local batch epoch and owner/batch/stop/CAS prevent duplication. Never-attempted custody can use bounded positive proof once no replacement scheduler exists. | Newer input remains durable while the first ACK is unresolved; no duplicate root send. |
| Definitive SDK no-effect/not-ready receipt while `inFlightRun` remains present | After an actual valid `attempted:false`, supported no-effect receipt with `ordinaryEligible!==false`, the same physical-session/leaf/epoch proof permits one bounded noninterrupting followup even if a foreground ID remains. The stored old target is evidence of prior zero effect, **not** a guessed current receiver. | Initial genuinely injectable work still gets SDK priority. Accepted/unknown/stopped, explicit ineligible/target-change receipts and physical conflicts cannot enter this escape. Root end or time alone is not replay authority. |
| Genuinely unknown activity; fresh never-attempted input | Preserve existing 60s ordinary followup rescue. Tests include incomplete pending metadata (`total=1, items=[]`) with missing active projection and missing generation metadata. | Normal Gateway admission remains authoritative; no fake ACK/Get. No weakening of restricted guards. |
| Unknown / possibly accepted submission | Keep original idempotency/submission identity. Exact-run recovery queries that identity; insertion recovery must not steer/resend it. | No new-ID resend, guessed receipt or DONE from silence. Tested across SQLite reopen. |
| Busy/queued/retained/hidden pending work, including `total=1, items=[]`, missing pending data, and missing aggregate active projection | Receiving eligibility depends on matching physical identity, explicit nonarchive and real observed leaf, not pending emptiness. The existing complete paginated idle proof is preserved separately and still refuses incomplete/hidden evidence. | Input can be Gateway-accepted while `idleConfirmed:false`; no pending work is cleared or replayed to make that happen. |
| Offline / permission failure | Local receipt/card exists first; an ordinary unknown rescue can attempt admission once, but real send refusal never creates Get or accepted custody. | No success promise or blind replay. Tests initialize the session first, then refuse metadata and send responses. |
| Escaped native commands / bot input | Outside restricted ordinary-human rescue; existing command/routing policy remains separate. | No reinterpretation under a fabricated ordinary proof. |
| /stop before/after async reads or send | Fence stop epoch, actual owner/batch, monotone local admission epoch and client admission generation. | Late reads/ACKs never revive old input. Only explicit user stop retains existing abort semantics. |

## Custody invariants

- Positive followup proof requires canonical history identity, physical ID, explicit nonarchive and a genuinely observed nonempty active leaf. It is independent of pending count/state or a boolean aggregate activity projection. A direct foreground preserves SDK priority unless this exact input has a valid definitive zero-effect receipt. Explicit incompatible identity is not ordinary unknown rescue.
- An accepted local run may itself be queued behind another public foreground. Retire only that local scheduler and route same-generation never-attempted input to the genuinely observed foreground for SDK priority, preserving original queued result custody. Inputs with prior no-effect evidence retain their original journal identity/earliest leaf instead of being blindly re-steered under a new identity.
- Local stop/owner/actual batch/monotone admission epoch, complete custody snapshots and per-submission identity are checked around asynchronous boundaries.
- Scheduler release promotes only same-session, same-owner/batch, ordinary human, never-attempted/not-explicitly-ineligible reservations. Per-input observed guards are preserved transactionally. Accepted/unknown/stopped/target-changed records never enter replay.
- Restricted `onSendAttempt` persists an uncertainty fence **without syncing/clearing the current trigger**. Real acceptance synchronizes. Definitive pre-effect refusal parks only this new cohort with visible retained-input notice; newer eligible cohorts can continue.
- Restricted archive refusal never invokes the ordinary automatic unarchive/retry path. Errors without a supported positive zero-effect receipt remain uncertain under the original ID.
- Collector/scheduler retirement does not claim idle, commit, business failure or task completion, and does not stop a long-running tool.

## Evidence and remaining boundaries

Read public installed `docs/concepts/queue.md` and `docs/gateway/protocol/rpc-session-control.md`, the supplied bounded Windows 2026.9.6 review excerpts (`/tmp/lma-integrated-review-1018-followup-windows{,-extra}.json`), and the prior source handoff. Supplied Windows excerpts establish the request fields/followup path, but **do not include the exact-or-ancestor helper body**. This child has no connected Windows device/tool route (`presence` returned no devices), so independent Windows helper parity remains a parent verification item; no claim of Windows runtime/live acceptance is made. Linux helper semantics above were statically verified, never executed/imported.

The dependency manifest says OpenClaw 2026.8.2; build, SDK type gate and existing actual public SDK tests use the available read-only dependency tree. Installed Gateway docs/source identify Linux 2026.9.9. These facts are not misrepresented as a live two-host test.

Still intentionally bounded:

1. Pending count/state is **not** a remaining admission blocker. Gateway owns serialization, queue capacity and drop/summarize policy. The bridge cannot promise immediate execution, defeat an explicit queue limit, or guarantee that host overflow policy preserves one raw turn per input. A send refusal/uncertain response is visible and retains original identity without a blind resend.
2. Positively busy with missing physical identity, explicit nonarchive or a real nonempty leaf still lacks safe restricted CAS. Such input stays local with a bounded durable explanation rather than an endless unexplained Typing. If an SDK capability/no-effect proof cannot be confirmed, that too gets a bounded visible notice. The ordinary genuinely-unknown fresh-input rescue remains separate; prior restricted/positive-busy custody cannot bypass it.
3. Public SDK acceptance does not prove exact input consumption/commit. Existing accepted/Get and unknown no-replay records remain conservative.
4. Unknown submissions are only reconciled by original identity/exact result. Off-path/physical/archive refusals retain the input visibly rather than silently moving it.
5. The 60-second interval bounds bridge observation before admission, not tool lifetime, foreground lifetime, Gateway execution start or completion.
6. No live Feishu/model/cross-host canary, service change, publication or deployment was performed. Parent integration, review, host-parity confirmation and live acceptance remain separate.

## Verification

`tests/guarded-followup-admission.test.ts` uses actual `Client.rpc` JSON WS request/response/ACK handling, actual FeishuBot and actual SQLite, with synthetic Gateway/Feishu boundaries and a real public SDK callback case. Coverage includes queued-before-ACK, nonzero queued/retained/hidden pending input, missing pending/active projections without fake idle, healthy ancestor advancement, off-path refusal, separate newer guard cohorts, SDK accepted/unknown/zero-effect with a persistent active target, queued-local versus actual foreground SDK routing, owner/epoch/stop fences, archive retry suppression, durable reopen, original-ID-only recovery, ordinary unknown rescue, bounded visible capability/guard explanation and no current-message silent loss.

A read-only independent review identified sticky changed-leaf scheduling and missing observation-time refusal notices in an intermediate candidate. Final logic removes local current-leaf equality/sticky leaf veto in favor of host ancestor/off-path CAS, and emits durable notices on positive local guard refusal. Parent's frozen original A4 unknown positive control was restored rather than weakened.

Verified locally on the final source: `npm run build` PASS; `npm run test:sdk-contract` PASS; `npm test -- --reporter=dot` **65 files / 1760 tests PASS**. Original A4 plus the new integrated file: **2 files / 57 tests PASS** (6 unchanged original cases + 51 new cases). All 20 original A4 assertion lines match `129866c` exactly. Source/test/plugin-source SHA manifest verification reported zero changed files after QA. Raw evidence: `/tmp/lma-followup-final-{build,sdk,suite}.log`, `/tmp/lma-followup-original-a4-final.log`, `/tmp/lma-followup-original-a4-assertions.json`, and `/tmp/lma-followup-final-source-{manifest.txt,integrity.log}`. Build outputs and raw test logs are not source deliverables.
