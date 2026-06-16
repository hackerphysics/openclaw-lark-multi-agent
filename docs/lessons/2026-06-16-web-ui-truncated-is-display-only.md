---
status: active
importance: essential
category: lessons
tags: [truncated, web-ui, display-projection, context, false-alarm, openclaw]
last_reviewed: 2026-06-16
---

# `...(truncated)...` in the Web UI is a display-only projection, not data loss

## Summary

A long message (≈7.2k chars) shown in the OpenClaw Web UI / session history ended
with `...(truncated)...`. This looked like the message had been cut off before
reaching the model, and like LMA's long-context handling had failed.

**It had not.** The text is stored in full and the model receives it in full. The
`...(truncated)...` is produced purely by OpenClaw's **display projection layer**
when rendering chat history for the UI.

**Do not "fix" this by changing LMA's file-context threshold.** There is nothing
to fix; doing so would force perfectly-fine inline messages through the file
path, adding an extra `read` round-trip and more failure surface for no benefit.

## How it was verified (two independent proofs)

### 1. Storage layer — read the raw session jsonl

```bash
cd ~/.openclaw/agents/main/sessions
# find the session containing the message
grep -rl "<unique phrase from the message>" *.jsonl
# inspect the actual stored text right at the suspected cut point
grep -o "<phrase before cut>[^\"]\{0,200\}" <session>.jsonl
```

The stored line was 7245 chars, contained **no** `(truncated)` marker, and the
content continued normally to a clean ending (all sections present). The message
was complete in storage.

### 2. Code path — where the 8000-char truncation actually applies

In `~/.npm-global/lib/node_modules/openclaw/dist`:

- The truncation comes from `truncateChatHistoryText` with
  `DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8000` (8e3) in
  `chat-display-projection-*.js`.
- `resolveEffectiveChatHistoryMaxChars(_cfg, maxChars)` ignores `_cfg` (leading
  underscore) → the 8000 cap is effectively hard-coded, not config-tunable.
- Every caller of `projectChatDisplayMessages` / `projectRecentChatDisplayMessages`
  is a **display / history-query path**:
  - `session-history-state-*.js` (UI history pagination)
  - `server-session-events-*.js` (events pushed to the frontend)
  - `chat.history` RPC (UI history)
  - `openclaw-tools` history display
- **No** caller is on the LLM prompt-construction path. The model request is
  built from the raw session-store `content`, which does not pass through the
  display projection.

Conclusion: the 8000-char cap is a UI render optimization. Storage = full,
model input = full.

## What LMA's thresholds really mean (and why they're fine)

`src/openclaw-client.ts`:

```ts
MAX_INLINE_CONTEXT_MESSAGES = 20
MAX_INLINE_CONTEXT_BYTES     = 128 * 1024   // 128KB
// useFileContext = msgs > 20 || inlineBytes > 128KB
```

This governs whether the **history context** is inlined or written to a
context-sync file for the agent to `read`. It is unrelated to the UI's 8000-char
display truncation. A single message between 8KB and 128KB is inlined and reaches
the model in full; the UI just shows a truncated preview of it.

## Rule of thumb

When you see "truncated", separate the three layers before concluding data loss:

1. **Display layer** (Web UI render / `chat.history` projection) — truncates for
   readability. Cosmetic.
2. **Storage layer** (`sessions/*.jsonl`) — full.
3. **Model-input layer** (prompt sent to the LLM) — full.

Check layers 2 and 3 (read the jsonl, trace the prompt-build path) before
"fixing" anything. Reviewers without this context (including other bots) tend to
re-flag this as a P1 — point them here.

## History

- 2026-06-16: Re-flagged as P1 in a bug-bash. Confirmed (again) it is display-only
  via the raw jsonl + the projection call-site audit above. No code change made.
