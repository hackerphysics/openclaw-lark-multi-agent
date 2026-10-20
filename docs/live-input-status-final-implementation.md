# Final live-input display corrections after d67a7a9

This source snapshot closes the three findings in the independent d67 review. It is not deployment, real-client visual acceptance or a public release.

## UI-1: recalled visible previews

The actual recall handler informs the existing presentation owner after preserving its original business pending/reaction behavior. The owner removes the exact recalled input's cached UI preview and snapshot preview, and refreshes only an already known, currently owned status-card ID. Running, frozen/waiting and terminal done/failed/replied display phase is retained.

A UI-only controller redaction operation uses its existing one-flight/pinned-view machinery with an effect-time restriction. It does not create a card, restart task execution, select a new receiver, alter admission or invoke a business terminal owner. Unknown create/edit effects remain fenced; a later known receipt may release only its own pending redaction. Protected same-card business-answer payloads are not overwritten. Restored known UI owners can perform the same restricted redaction; unknown/no-ID restoration persists only removal of copied preview data.

## UI-2: no fabricated outcome before admission

Terminal hint updates consult the pre-existing unconfirmed-input custody callback first. Only proven ordinary members receive the round outcome. A never-admitted input retains its local/submission-unconfirmed display, including when fail, complete, noReply or prepareTerminalDelivery is invoked. Its waiting note does not invent a root result. This adds no admission, Get/DONE, replay, retry or receipt authority.

## UI-3: literal captured human text

Explicit visible ingress is marked separately from legacy hydrated-row fallback. Normal text receives inert escaping, whitespace normalization and code-point-safe clipping only; a human can literally type the routing-placeholder phrase or Image/File/FeishuDoc/Attachment bracket syntax without substantive words being removed. Only actual structured media nodes receive typed localized markers. Rich-post text nodes remain literal while real image nodes become type markers. Legacy fallback retains its existing filtering for generated document/media hydration data. No server media path, file/image key or protected prompt is introduced into display.

## Preserved scope

The full d67 inventory of live input-delivery hints remains in place, including per-input A/B/C phases, coalescing/merged cohorts, exact source IDs, unavailable-source fallback, English, latest-input retention, inert user markup and full nested request byte budgeting. Tool/agent activity, trusted approval cards and ordinary business rendering retain their existing ownership. The reviewed 8f terminal-reason/one-error-owner source is unchanged. No Core, model, configured timeout, schema, dependency, version, live data, service or public package was changed.

## Evidence and recovery provenance

The original d67 negative proofs are retained in the parent diagnostic and independent review reports. Those controls used actual Card2 SDK methods and the actual recall/ingress handlers. The first ad-hoc underscore-marked recall fixture was corrected before crediting its causal result; only the corrected plain-marker failure is relied on.

The coding turn stopped with an unclassified model error after its expanded UI test command. The parent inspected the sanitized session history, the preserved working tree and the completed test log before resuming ownership. No code was discarded, no historical message was replayed and no second writer was started. This final snapshot includes that preserved work, subsequently validated by the parent.

Executed local gates, in build-before-test order, Node 26.10.0 / supplied exact-lock SDK 1.73.3:

- Bridge and all three plugin builds: pass, `/tmp/lma-ui-recovered-build-1020.log`.
- Public SDK strict contract: pass, `/tmp/lma-ui-recovered-sdk-1020.log`.
- Strict new UI suite type check: pass, `/tmp/lma-ui-recovered-types-1020.log`.
- Expanded actual UI suite: **74 tests passed**, `/tmp/lma-live-input-final-focused-expanded-1020.log`.
- Full offline suite: **2055 tests / 70 files passed**, preserving all 2028 cases plus 27 additional cases, 38.44 s runner duration, `/tmp/lma-ui-recovered-full-1020.log`.
- `git diff --check`: pass.

The 27 added cases cover after-created recall, running/waiting/terminal/restored states, unknown create/edit effects, late known receipts, protected business payloads, no-admission terminal hint truthfulness, literal original text and rich-post media.

These gates are not an independent fresh installation or actual platform/client proof. Parent final independent review, Node 24/26 clean runtime validation, artifact qualification and the user's requested combined deployment/restart remain required. No new activation was performed as part of these source fixes.

## Remaining held-reaction boundary, corrected

The first final review found that the recall hook still ran after awaited reaction cleanup. The permanent `UI1R` control now holds the actual prototype reaction lookup while entering the actual recall handler. It checks that both the accepted known-card payload and persisted copied preview are redacted before that unrelated lookup resolves, then releases the lookup and confirms normal reaction-handler completion without another create or business send.

On unchanged e181 source this corrected control failed on `displayedBeforeReaction` (expected false, received true); `/tmp/lma-ui-held-reaction-confirmed-red-1020.log`. An earlier fixture lacked the reaction SDK mock namespace and failed before exercising the product; `/tmp/lma-ui-held-reaction-red-1020.log` is not credited as defect evidence.

The production correction only moves initiation of the same owned UI invalidation before the first reaction SDK await. Durable recall/pending cleanup, reaction ownership, UI error handling and all known/unknown effect restrictions remain unchanged. All **75 UI tests passed** in `/tmp/lma-ui-held-reaction-green-1020.log`. Final release/source-wide gates are renewed after release metadata is selected. The user subsequently reported Windows GPT responding again; no restart or deployment was performed to produce that reported recovery, and its transient upstream cause is not claimed resolved by this UI change.
