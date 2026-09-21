# v1.5.0

Compaction overhaul: `/compact` now defaults to the fast, model-free transcript
tail trim, and sessions archived by the Gateway are restored automatically.

## /compact redesign (modes strictly separated)

- `/compact` — Gateway-owned transcript tail trim via `sessions.compact` with
  `maxLines`, default 800 (was 200; env
  `OPENCLAW_LARK_MULTI_AGENT_COMPACT_FALLBACK_MAX_LINES` still overrides).
  Model-free: never times out on oversized sessions the way LLM summarization
  did. This is now the default path; the LLM-summary path is no longer
  attempted implicitly.
- `/compact semantic` — explicit LLM summarization, with automatic trim fallback
  if summarization cannot run.
- `/compact 500` / `/compact maxLines=500` — trim with a custom depth.
- Compact progress card shows a distinct phase line for explicit trims.
- Help text updated. The historic tool-trim approach (rewriting JSONL directly,
  removed in 2026.8 storage migration) is NOT revived: the Gateway owns the
  SQLite transcript store, and LMA never mutates it.

## Archived-session auto-restore

- `chat.send` and `sessions.compact` now detect the Gateway's
  "Session ... is archived. Restore it before starting new work" refusal
  (sessions auto-archived by the active-session cap), restore the session via
  `sessions.describe` → `sessions.patch { archived: false, expectedSessionId }`,
  and retry once. Users no longer need manual recovery; `/reset` never fixed
  this because archived sessions refuse all work.

## Live status thinking level

- The live status footer and finished summary now show the current thinking
  level next to the model: `🧠 phgeek-gw/glm-5.3 · high`.
- Source priority: session override (`thinkingLevel`, e.g. set via `//think`)
  → session `thinkingDefault` (e.g. `adaptive`) → bot config `thinking`.

## Notes

- Build and 701 offline tests passed before release validation.
- Known behavior (not a regression): restarting the bridge freezes live status
  cards of runs that were in flight at restart; in-memory card handles are lost.
- Bundled lma-steer unchanged; no Gateway/plugin update needed.
