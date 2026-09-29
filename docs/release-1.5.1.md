# v1.5.1

Typo-proof bridge commands, Feishu 230025 auto-chunking, and the chairman
"always Claude" root-cause fix. No behavioral change to compaction or steer.

## Near-miss command hints

- A mistyped single-slash command (e.g. `/chiarman`) now gets an immediate
  "did you mean `/chairman`?" hint from the bridge instead of silently falling
  through to the chairman/model chat path, where it burned model calls and
  created the "setting the chairman never works" illusion.
- Matching is Damerau-Levenshtein distance ≤ 1 over the known bridge commands.
  In groups the hint comes from the coordinator (or the explicitly mentioned
  bot) exactly once; p2p always answers. Unmatched far-off commands behave as
  before.

## Feishu 230025 (content over limit) chunked delivery

- `sendMessage` and `replyMessage` detect Feishu's 230025 "message content
  reaches its limit" error and re-deliver the text as multiple plain-text
  messages (~3200 chars each, split at paragraph/line boundaries) instead of
  retrying the same oversized payload until the retry budget is exhausted.
  The model/thinking footer is kept on the final chunk.
- `replyMessage` resolves the chat id via the message store for chunked sends.
- Previously an oversized reply failed card → text → all 5 delivery retries.

## Chairman "always Claude" — root cause and fix

- Root cause was NOT chairman routing: Claude had per-chat `free` mode enabled
  in the affected group, and free mode deliberately answers unaddressed
  messages regardless of the chairman setting. Chairman writes were verified
  correct in storage (Gemini).
- Operational fix (data, applied in place, not code): Claude's free mode was
  disabled for that chat. `/chairman` semantics unchanged.

## Operational notes (no code change)

- Windows (guangzi) steer breakage after the OpenClaw 2026.9.6 upgrade was
  caused by the lma-steer extension (0.1.0) missing from the gateway plugin
  allowlist and being stale; fixed by upgrading the extension to 0.1.1 and
  adding `plugins.allow: ["lma-steer"]` on that host. LMA code is unchanged.

- Build and 705 offline tests passed before release (after rebuilding the
  dev-tree better-sqlite3 native module for Node 26; the deployed service
  tree keeps its own node_modules).
