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

A human message starts a discussion session. The bridge then orchestrates participants in barrier-style rounds:

```text
Human topic
  → Round 1: GPT, Claude, DeepSeek, GLM each answer the same topic independently
  → Wait until Round 1 finishes
  → Round 2: GPT, Claude, DeepSeek, GLM each respond again, now with Round 1 as shared context
  → Wait until Round 2 finishes
  → ... until stop condition
```

A “round” means every participant gets at most one turn against the same discussion state. A 10-round limit means each bot can speak up to 10 times, not that the whole group has only 10 total bot messages.

Within one round, bots should **not** be chained as “GPT speaks, then Claude sees GPT, then DeepSeek sees GPT+Claude”. Instead, all participants in the same round should receive the same base context and produce independent views. After the round completes, the next round may include all previous-round replies as shared context.

## Why Not Trigger on Bot Messages

A naive implementation would let bot messages trigger other bots in `free` mode. That is risky:

1. ordering becomes nondeterministic;
2. several bots may react concurrently to partial context;
3. loops are hard to control;
4. reaction / pending / done state becomes ambiguous;
5. one bot may miss another bot’s reply depending on Feishu event timing.

Discussion should therefore be an explicit scheduler/orchestrator, not normal message-trigger chaining. The scheduler should use a barrier between rounds: start a round, collect all participant replies, then start the next round.

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

Recommended first version: use bots with `mode = free`. Ordering still matters for Feishu delivery and deterministic logs, but the logical model should be barrier-style: all participants in one round answer the same topic/context rather than seeing earlier replies from the same round.

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

Within a round, every participant receives the same shared context:

- original human topic;
- all completed previous rounds;
- current round number;
- the current bot name.

They should **not** receive partial replies from other bots in the current round.

Example:

```text
This is a structured multi-agent discussion.

Topic:
<original human topic>

Current round: 2
You are: Claude

Completed previous rounds:
Round 1:
- GPT: ...
- Claude: ...
- DeepSeek: ...

Current-round replies are hidden from you so that each bot gives an independent view.

Instructions:
1. Do not repeat points already made in previous rounds.
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
- no participant remains eligible;
- a round-level timeout is hit while waiting for straggler bots.

## Interaction With Current Queue Logic

Discussion turns should not rely on ordinary Feishu bot-message events. The scheduler should invoke bot OpenClaw sessions directly through the same `chatSendWithContext` path, then send replies to Feishu and insert them into `messages`.

For the first MVP, use sequential execution for operational simplicity but preserve barrier semantics: build each bot's prompt from the same round context, not from replies already produced earlier in the current round. Later, this can be optimized to true parallel execution per round.

Need to be careful with:

- `sync_state`: discussion replies should be visible as context to all later participants;
- `pending_triggers`: discussion turns are scheduler-driven, not normal pending triggers;
- `delivered_replies`: still needed for idempotency;
- `sendQueue`: Feishu delivery should remain ordered per chat;
- error handling: one bot failure should not abort the whole discussion unless configured.

## Open Questions

1. Should a new human message interrupt the active discussion or become the next topic?
2. Should participants be manually selected or derived from `/free` mode?
3. Should bot replies be visible immediately as they finish, or buffered and sent after the whole round completes?
4. Should the MVP execute round participants sequentially with barrier semantics, or true parallel from day one?
5. What is the default max round count: 3 for safety, or 10 for full discussion?
6. Should later rounds include all previous rounds verbatim, or a compact rolling summary to control context size?

## Recommended Direction

Start with a conservative MVP:

- explicit `/discuss on` separate from `/free`;
- participants = bots with `mode = free`;
- barrier-style rounds over free-mode participants;
- implement sequential execution first, but build each prompt from the same per-round context;
- default `max_rounds = 3`;
- stop if all bots return `NO_REPLY` in one round;
- persist session and turns in SQLite.

After validating UX, add configurable participants and round counts.
