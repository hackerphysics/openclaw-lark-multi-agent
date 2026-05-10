---
status: draft
importance: reference
category: idea
tags: [discussion-mode, free-mode, multi-agent, lark, orchestration]
last_reviewed: 2026-05-10
---

# Multi-Agent Discussion Mode Idea

## Background

Current `free` mode means: a bot may reply to human messages in a group without being explicitly mentioned.

It is **not** a true multi-agent discussion mode:

- human message triggers free bots once;
- bot messages do not trigger other bots unless explicitly mentioned;
- therefore a group may get one reply per free bot, but there is no automatic second round.

This is intentional enough for simple participation, but it does not match the desired behavior for structured multi-agent debate.

## Desired Behavior

Introduce a separate discussion mode, independent from `free` mode.

A human message starts a discussion session. The bridge then orchestrates participants in rounds:

```text
Human topic
  → Round 1: GPT → Claude → DeepSeek → GLM → ...
  → Round 2: GPT → Claude → DeepSeek → GLM → ...
  → ... until stop condition
```

A “round” means every participant gets at most one turn. A 10-round limit means each bot can speak up to 10 times, not that the whole group has only 10 total bot messages.

## Why Not Trigger on Bot Messages

A naive implementation would let bot messages trigger other bots in `free` mode. That is risky:

1. ordering becomes nondeterministic;
2. several bots may react concurrently to partial context;
3. loops are hard to control;
4. reaction / pending / done state becomes ambiguous;
5. one bot may miss another bot’s reply depending on Feishu event timing.

Discussion should therefore be an explicit scheduler/orchestrator, not normal message-trigger chaining.

## Proposed MVP

### Commands

Possible bridge commands:

- `/discuss on` — enable discussion mode in the current group;
- `/discuss off` — disable discussion mode;
- `/discuss rounds <n>` — configure max rounds, default 3;
- `/discuss status` — show current settings and active discussion;
- `/discuss stop` — stop the active discussion.

`/free` remains per-bot “reply to human without mention”. It should not imply multi-agent round orchestration.

### Participants

MVP participant selection can be one of:

1. all bots in the group with `mode = free`;
2. all bots explicitly mentioned by the human;
3. all bots when the trigger is `@all`.

Recommended first version: use bots with `mode = free`, ordered by config order.

### Discussion Session State

Persist active sessions in SQLite so restart does not corrupt state.

Suggested table:

```sql
CREATE TABLE discussion_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  root_message_row_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_round INTEGER NOT NULL DEFAULT 1,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  participant_names TEXT NOT NULL,
  next_participant_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

A second table may track turns:

```sql
CREATE TABLE discussion_turns (
  session_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  bot_name TEXT NOT NULL,
  prompt_message_row_id INTEGER,
  reply_message_row_id INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, round, bot_name)
);
```

## Turn Prompt Shape

Each participant should receive a discussion prompt, not just the raw human message.

Example:

```text
This is a structured multi-agent discussion.

Topic:
<original human topic>

Current round: 2
You are: Claude

Previous turns:
- GPT: ...
- DeepSeek: ...

Instructions:
1. Do not repeat points already made.
2. Add only new, useful information.
3. If you have nothing useful to add, reply exactly NO_REPLY.
4. Keep the answer concise unless asked otherwise.
```

## Stop Conditions

Discussion should stop when any of these happens:

- `current_round > max_rounds`;
- every bot in a round returns `NO_REPLY` or empty output;
- user sends `/discuss stop`;
- a new human message arrives and policy says “interrupt current discussion”; 
- too many consecutive errors occur;
- no participant remains eligible.

## Interaction With Current Queue Logic

Discussion turns should not rely on ordinary Feishu bot-message events. The scheduler should invoke bot OpenClaw sessions directly through the same `chatSendWithContext` path, then send replies to Feishu and insert them into `messages`.

Need to be careful with:

- `sync_state`: discussion replies should be visible as context to all later participants;
- `pending_triggers`: discussion turns are scheduler-driven, not normal pending triggers;
- `delivered_replies`: still needed for idempotency;
- `sendQueue`: Feishu delivery should remain ordered per chat;
- error handling: one bot failure should not abort the whole discussion unless configured.

## Open Questions

1. Should a new human message interrupt the active discussion or become the next topic?
2. Should participants be manually selected or derived from `/free` mode?
3. Should bot replies be visible immediately or buffered until a round is complete?
4. Should the scheduler support parallel mode later, or always sequential for determinism?
5. What is the default max round count: 3 for safety, or 10 for full discussion?

## Recommended Direction

Start with a conservative MVP:

- explicit `/discuss on` separate from `/free`;
- participants = bots with `mode = free`;
- sequential turns in config order;
- default `max_rounds = 3`;
- stop if all bots return `NO_REPLY` in one round;
- persist session and turns in SQLite.

After validating UX, add configurable participants and round counts.
