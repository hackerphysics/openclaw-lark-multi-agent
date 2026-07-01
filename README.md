# OpenClaw Lark Multi-Agent

[English](README.md) | [简体中文](README.zh-CN.md)

Run multiple Lark/Feishu bots against one OpenClaw Gateway, with each bot bound to its own model and isolated conversation state.

This project is a bridge layer for OpenClaw. It does **not** implement an agent runtime itself; messages are forwarded into normal OpenClaw sessions so every bot still uses the full OpenClaw pipeline, tools, memory, slash commands, and delivery behavior.

## Why this exists

Lark/Feishu gives each bot its own app identity, but OpenClaw normally exposes one assistant identity per channel account. This bridge lets you create several Lark bots such as:

- `GPT Bot` → `github-copilot/gpt-5.5`
- `Gemini Bot` → `github-copilot/gemini-3.1-pro-preview`
- `Claude Bot` → `github-copilot/claude-opus-4.7`

All of them connect to the same OpenClaw Gateway while keeping sessions, queues, and private chats isolated.

## Features

- Multiple Lark/Feishu bot apps in one process
- Per-bot model binding via OpenClaw session model override
- Per-chat OpenClaw sessions: `lma-<bot>-<chatId>`
- Private chat isolation: a p2p chat belongs to exactly one bot
- Group chat routing:
  - reply when directly mentioned
  - reply to `@all` / `@_all`
  - optional per-bot Free mode for plain human messages
  - targeted mentions are exclusive, so Free-mode bots do not steal messages addressed to another person or bot
  - mention-only messages can trigger a bot with the previous unsynced context
- Per-bot anti-loop guard, so one bot's free-discussion budget is not consumed by other bots
- Local SQLite message store for context, trigger tracking, and duplicate prevention
- `pending_triggers` queue so restart recovery does not replay every context message
- `delivered_replies` table so one trigger message gets at most one delivered reply per bot
- Durable delivery outbox for assistant-visible output, with stable delivery keys, atomic claim-before-send dispatch, and short-window duplicate suppression
- Message recall handling: recalled queued/pending user messages are removed before they reach OpenClaw and excluded from future context
- Feishu image download and OpenClaw multimodal attachment forwarding
- Bridge attachment marker protocol for generated files/images/documents
- Feishu CardKit v2 Markdown rendering, including native table elements for pipe tables
- Live status card: in non-verbose mode each run shows a single self-updating Feishu interactive card (title + recent activity window with per-line timestamps + elapsed/model footer, refreshed once per second), which collapses to a compact one-line summary on a clean finish and retains the recent activity on failure for debugging
- Bridge-level slash commands and escaped OpenClaw slash commands
- `/discuss` mode for barrier-style multi-bot group discussion, including per-round markers and no-reply status notices
- `/chairman` role: a single per-group chairman that answers plain messages when no bot is in Free mode, and acts as host, challenger, and summarizer inside `/discuss`
- `/locale zh|en` per-group language, with bot-level and global locale fallbacks for discussion prompts and system notices
- Shared group history catch-up: when a bot is newly mentioned after missing messages, it receives the unseen group messages it has not synced yet (large history is offloaded to a local file)
- Concurrency guards: a global `chat.send` limiter and a serialized maintenance limiter (e.g. `sessions.compact`) prevent multi-bot fan-out from saturating the gateway
- Linux systemd installer with separate runtime and state directories

## Architecture

```text
Lark Bot App A ┐
Lark Bot App B ├─ WebSocket events ─→ openclaw-lark-multi-agent ─→ OpenClaw Gateway
Lark Bot App C ┘                                              └─ SQLite state
```

The bridge stores every message as local context, but only messages that should trigger a bot response are inserted into `pending_triggers`. This distinction prevents startup drains from accidentally replaying unrelated history.

## Requirements

- Node.js 22+
- npm
- An OpenClaw Gateway reachable over HTTP/WebSocket
- One or more Lark/Feishu self-built apps with WebSocket event subscription enabled
- Linux systemd for the provided installer, or another process manager such as pm2

## Quick start with npm

After the package is published to npm:

```bash
npm install -g openclaw-lark-multi-agent
lma init
```

> The command is `lma` (short). It is also available under its full name
> `openclaw-lark-multi-agent` for back-compat.

This creates:

- config: `~/.openclaw/openclaw-lark-multi-agent/config.json`
- data dir: `~/.openclaw/openclaw-lark-multi-agent/data/`

Edit the generated config and fill in your OpenClaw Gateway token and Lark app credentials. Then run:

```bash
lma start
```

Install as a systemd user service:

```bash
lma install-systemd --user
```

On Windows, install [NSSM](https://nssm.cc/download), make sure `nssm.exe` is in `PATH`, then run PowerShell or Command Prompt as Administrator:

```powershell
lma install-windows-service
```

### Optional: real-time steering plugin

To let users nudge/correct a long-running agent turn in real time (instead of
waiting for it to finish), install the bundled `lma-steer` OpenClaw plugin:

```bash
lma install-steer-plugin
# then restart the OpenClaw gateway so it loads the plugin:
systemctl --user restart openclaw-gateway.service
```

When the agent is mid-run and a new message arrives, the bridge injects it into
the active run at the next tool-call boundary (Feishu shows the "Get" reaction).
Without the plugin, the bridge falls back to queuing the message until the run
finishes — everything still works, just without real-time steering. See
`plugins/lma-steer/README.md` for details.

Useful CLI commands:

```bash
lma --help
lma doctor
lma start [config]
lma init [--state-dir DIR] [--force]
lma install-systemd [--user|--system] [--state-dir DIR]
lma install-steer-plugin [--no-force]
```

## Quick start from source

```bash
git clone https://github.com/hackerphysics/openclaw-lark-multi-agent.git
cd openclaw-lark-multi-agent
npm ci
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "openclaw": {
    "baseUrl": "http://127.0.0.1:18789",
    "token": "YOUR_OPENCLAW_GATEWAY_TOKEN"
  },
  "bots": [
    {
      "name": "GPT",
      "appId": "cli_xxx",
      "appSecret": "YOUR_LARK_APP_SECRET",
      "model": "github-copilot/gpt-5.5"
    },
    {
      "name": "Gemini",
      "appId": "cli_yyy",
      "appSecret": "YOUR_LARK_APP_SECRET",
      "model": "github-copilot/gemini-3.1-pro-preview"
    }
  ]
}
```

Build and run locally:

```bash
npm run build
npm start -- config.json
```

> `config.json` contains secrets and is ignored by git. Do not commit it.

## Recommended Linux deployment

Use the installer:

```bash
./scripts/install-linux-systemd.sh --system
```

By default it uses:

- runtime files: `~/.local/lib/openclaw-lark-multi-agent/`
- state/config/data: `~/.openclaw/openclaw-lark-multi-agent/`
- systemd service: `openclaw-lark-multi-agent.service`

Only built runtime files are deployed to the runtime directory (`dist/`, `package.json`, `package-lock.json`, production `node_modules`). Source files are not copied there.

For a user service instead of a system service:

```bash
./scripts/install-linux-systemd.sh --user
```

Custom directories:

```bash
./scripts/install-linux-systemd.sh \
  --deploy-dir ~/.local/lib/openclaw-lark-multi-agent-prod \
  --state-dir ~/.openclaw/openclaw-lark-multi-agent-prod
```

Useful commands:

```bash
systemctl status openclaw-lark-multi-agent
journalctl -u openclaw-lark-multi-agent -f
sudo systemctl restart openclaw-lark-multi-agent
```


## Windows deployment

The npm CLI works on Windows as well. It uses `%USERPROFILE%\.openclaw\openclaw-lark-multi-agent` as the default state directory.

```powershell
npm install -g openclaw-lark-multi-agent
lma init
notepad $env:USERPROFILE\.openclaw\openclaw-lark-multi-agent\config.json
lma start
```

To run as a Windows service, install [NSSM](https://nssm.cc/download), put `nssm.exe` in `PATH`, open an elevated terminal, then run:

```powershell
lma install-windows-service
```

A legacy helper script is also available at `scripts/install-windows-service.bat`.

## macOS launchd

A sample launchd plist is available at `scripts/openclaw-lark-multi-agent.plist`. For most users, npm CLI + a process manager is simpler.

## Lark/Feishu app setup

For each bot:

1. Create a self-built Lark/Feishu app.
2. Enable bot capability.
3. Enable event subscription over WebSocket / long connection.
4. Subscribe to message receive events.
5. Copy the app ID and app secret into `config.json`.
6. Add the bot to the target chats.

Each bot app should have its own identity and credentials.

## Commands

Bridge-level commands use a single slash and are handled by this project:

- `/help` — show command help
- `/status` — show bot model, token usage, and session state
- `/compact` — compact the OpenClaw session
- `/reset` — reset the OpenClaw session
- `/stop` — force-stop a stuck run for this bot in this chat and unlock the queue
- `/verbose` — toggle tool-call messages for this bot in this chat
- `/livestatus [on|off]` — toggle, or explicitly enable/disable, the self-updating run-status card shown in non-verbose mode (default on)
- `/free [on|off]` — toggle, or explicitly enable/disable, this bot's Free mode in the current group chat
- `/mute` — toggle this bot's mute mode in the current group chat
- `/mode` — show this bot's current mode in the current chat
- `/model [id]` — show or switch this bot's bound model (persisted)
- `/discuss on|off|status|stop|rounds N` — control group-level multi-bot discussion mode (requires a chairman to enable; default 10 rounds)
- `/chairman [@Bot|off]` — set, view, or clear the single chairman for this group
- `/locale [zh|en]` — set or view this group's language

OpenClaw-level slash commands can be sent by escaping with a double slash:

```text
//status
//reset
//compact
```

The bridge converts `//status` to `/status` and forwards it to OpenClaw instead of handling it locally.

How to test the double-slash behavior:

1. In a private chat with one bot, send `//status`.
   - Expected: the message is forwarded to OpenClaw as `/status`.
   - It should **not** be handled by the bridge-level `/status` command.
2. In a group chat, mention a specific bot or use `@all` with a double slash:

```text
@GPT //status
@all //reset
```

Expected: the bridge strips the leading mention for routing, converts `//...` to `/...`, and forwards the command to OpenClaw.

To test bridge-level commands instead, use a single slash:

```text
/reset
@all /reset
```

Expected: the bridge handles the command locally and does not forward it to OpenClaw.

## Message routing rules

### Private chats

A private chat is owned by the bot connected to that chat. Other bots ignore it.

### Group chats

By default, a bot responds when:

- it is directly mentioned;
- `@all` / `@_all` appears in the message;
- this bot's Free mode is enabled and the message is a plain human message with no targeted mentions.

Free mode is intentionally per-bot and conservative:

- Free mode lets a bot reply to ordinary human messages without being mentioned.
- If a human message mentions another bot, only that bot may respond. Other Free-mode bots stay silent.
- If a human message mentions a regular person, Free-mode bots stay silent.
- `@all` remains a broadcast trigger and may activate every eligible bot.

Mention-only routing is supported. If a user first sends content and then sends only a bot mention, for example:

```text
Please analyze the contract risk.
@Claude
```

the mention-only message is treated as a trigger and is combined with the previous unsynced context before being sent to the mentioned bot.

Bot messages do not trigger other bots unless they mention them. The anti-loop guard is counted per bot per chat: other bots' replies do not consume the current bot's streak budget, and a human message resets the streak.

### Context injection

Catch-up context is the unseen group history a bot receives alongside the current message. It follows strict rules:

- Catch-up is injected only in group chats; private chats never get it.
- It contains messages this bot has not synced yet (both human and other-bot messages), so a mention-only reply can see the human message it refers to.
- It excludes the current trigger(s), other pending triggers, this bot's own messages, and escaped native commands.
- When there is nothing unseen, no context header is added; the current message is sent as-is.
- Consecutive plain human triggers are merged into a single run instead of being processed one by one. Native commands (`//x`) are always processed on their own and never merged.
- Escaped native commands (`//status`) are sent verbatim with no catch-up context and no attachment hint.
- The bridge attachment hint is only injected when the message combines an action word with an artifact word (for example "generate an image and send it"), so ordinary talk that merely mentions "file" or "document" does not trigger it.

Persistent constraints (such as "do not call Feishu send tools directly" and the chairman's non-discuss guidance) are injected once when a session is created or reset, never prepended to every message.

### `/discuss` mode

`/discuss` is an explicit group-level multi-agent discussion scheduler. It is separate from Free mode:

- `/free` controls whether a single bot may answer plain human messages.
- `/discuss on` requires a chairman to be set first (`/chairman @Bot`). It lets one coordinator take over plain human messages and run all non-muted bots plus the chairman in barrier-style rounds. Free mode is ignored inside discussion: every bot that is not muted participates regardless of its Free setting.
- Targeted mentions still fall through to normal routing, so `@GPT hello` works even while discuss mode is enabled.
- Each participant receives the same round prompt and does not see other participants' replies from the current round until the next round.
- The chairman speaks last each round: it gives its own view, challenges weak points, mediates disagreements, and decides whether to continue or conclude.
- Each visible discussion reply is annotated with a round marker such as `—— 第 2/3 轮 · Claude`.
- If some participants return `NO_REPLY` or an empty reply, the coordinator sends a lightweight status notice such as `💬 第 3/3 轮：Qwen、Gemini 无新增回复`.
- When the chairman emits a `FINAL_SUMMARY:` line, the discussion ends and discuss mode is automatically turned off; control markers (`FINAL_SUMMARY:` / `CHAIRMAN_NOTE:`) are stripped from what users see.
- The default round count is 10; reaching it forces the chairman to produce a final summary.

Commands:

```text
/discuss on
/discuss off
/discuss status
/discuss stop
/discuss rounds 10
```

### `/chairman`

Each group can have exactly one chairman, set with `/chairman @Bot`. Setting a new chairman replaces the previous one; `@`-ing more than one bot is rejected. The chairman has two roles:

- Normal mode: it is only a fallback responder. When no bot is in Free mode and nobody is explicitly addressed, the chairman answers plain messages. It does not summarize, moderate, or challenge other bots outside `/discuss`.
- Discuss mode: it participates, speaks last each round, challenges, mediates, and produces the final summary.

```text
/chairman @Bot   set the chairman
/chairman        show the current chairman
/chairman off    clear the chairman
```

`/chairman` is a group-level command handled by one coordinator bot, so it produces a single reply.

### `/locale`

Discussion prompts, chairman prompts, and system notices are localized. Language resolves as: group `/locale` setting > bot-level `locale` config > global `locale` config > `zh` (default).

```text
/locale       show the current group language
/locale zh    set this group to Chinese
/locale en    set this group to English
```

`/locale` is also a group-level command handled by one coordinator bot. The current language is shown in `/status`.

## Delivery outbox and duplicate prevention

All user-visible assistant outputs go through the local `delivery_outbox` before being sent to Feishu. This includes normal chat final replies, proactive `session.message` replies, delayed runtime-error notices, provider-error notices, discussion replies, and attachment marker deliveries.

The outbox provides several protections:

- stable trigger-based delivery keys such as `trigger:<message_row_id>`;
- `UNIQUE(bot_name, chat_id, delivery_key)` to prevent duplicate deliveries for the same logical output;
- `pending -> delivering -> delivered/failed` claim-before-send dispatch to avoid concurrent resend races;
- short-window content-hash dedupe for proactive-only outputs;
- short-window containment dedupe for cases where `chat final` contains an intermediate note plus final answer while proactive contains only the final answer;
- attachment-aware dedupe so file/image/document deliveries are not accidentally collapsed with text-only replies.

This keeps normal replies, subagent/proactive completions, discussion messages, delayed runtime failures, provider errors, and generated attachments on one consistent delivery path.

## Message recall

The bridge subscribes to Feishu `im.message.recalled_v1` events. When a user recalls a message that is still pending or queued:

1. the original message remains in the local `messages` ledger for audit;
2. the message is recorded in `recalled_messages`;
3. matching `pending_triggers` for each bot are removed;
4. pending local reaction acknowledgements are removed;
5. future context sync excludes the recalled message.

Version 1 behavior intentionally does **not** abort an OpenClaw run that has already started processing the recalled message, and it does not recall bot replies that were already sent. The first goal is to make recall reliable for queued/not-yet-processed messages.

## Session health and error recovery

The bridge distinguishes a failed *run* from a dead *session*:

- During an active run, a health monitor polls the OpenClaw session. Only true
  session-death states (`killed` / `dead` / `crashed`, matched on word
  boundaries) are treated as unhealthy; run-level outcomes such as `aborted`,
  `error`, or `timeout` are not, because the session usually remains usable for
  the next message. A short re-check guards against transient blips.
- When a session is genuinely unhealthy, the bridge warns the user but does not
  force a `/reset`: the current message is still attempted, and only an in-run
  confirmation of death stops the wait. Users decide whether to retry.
- Recoverable agent errors are not surfaced as failures. When OpenClaw emits a
  recoverable lifecycle error (for example `Context overflow: prompt too large`)
  it auto-compacts and keeps the same run alive; the bridge defers instead of
  rejecting, so a later real final reply wins. Only a genuine stall falls back to
  the deferred error via the idle timeout. Non-recoverable errors still fail fast.

## Markdown, tables, and attachments

Assistant replies are sent as Feishu CardKit v2 cards. Markdown is preprocessed for Feishu rendering:

- headings are downgraded to Feishu-friendly heading levels;
- fenced code blocks are preserved;
- unsupported external Markdown image URLs are stripped unless already resolved to Feishu `img_` keys;
- GitHub-style pipe tables are converted into native CardKit `table` elements.

For generated files/images/documents, agents should use the bridge attachment marker protocol instead of calling Feishu messaging tools directly. The bridge strips the marker from the visible reply, validates the file path under the configured attachment directory, uploads/sends the attachment, and records it in local context. Markdown documents can be converted into Feishu cloud documents through this path.

## Live status

In non-verbose mode, each run shows a single self-updating Feishu interactive
card so users can see progress without the noise of per-tool-call messages.
Verbose mode and live status are mutually exclusive: when `/verbose` is on, the
bridge emits the existing per-tool messages instead of a live status card.

While running, the card shows:

- a title (`<bot> is working`);
- a rolling window of the most recent activity lines (tool start `▸`, tool end
  `✓`, and intermediate assistant text `•`), each prefixed with the relative
  time `mm:ss` since the run started;
- a footer with elapsed time and the bound model name.

The card is created lazily (a fast reply that finishes within the create delay
never spawns a card, to avoid flicker) and is updated with `im.message.patch`,
which has no 20-edit cap. A 1-second ticker advances the elapsed timer even when
no new activity arrives.

When the run ends:

- a clean finish (normal reply or `NO_REPLY`) collapses the card to a single
  compact grey line: status emoji + total tool calls + total elapsed;
- a failure (provider error, killed/unhealthy session, delivery error, or idle
  timeout) keeps the recent activity window plus the summary, with an orange
  header, so the steps leading up to the failure stay visible for debugging.

The final answer is always delivered separately through the normal interactive-card
delivery path, so Markdown renders correctly; the live status card is a distinct
message and never replaces or blocks the final reply.

Live status is on by default and can be toggled per bot/chat with
`/livestatus [on|off]`. It can be disabled globally by setting
`OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS=0`. Tunable defaults:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS` | `1` | Master switch; `0` disables live status for all bots |
| `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_DELAY_MS` | `800` | Delay before creating the card, so fast replies do not flicker one |
| `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_TICK_MS` | `1000` | How often the elapsed-time footer auto-refreshes |
| `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_HISTORY` | `6` | Number of recent activity lines kept in the card |
| `OPENCLAW_LARK_MULTI_AGENT_LIVE_STATUS_MAX_CHARS` | `120` | Per-line character cap before truncation |

## Data model

SQLite state lives in the configured data directory. Important tables:

- `messages` — local conversation log and context (includes a `trigger_kind` column to mark escaped native commands)
- `sync_state` — per-bot/per-chat sync cursor (coarse high-water mark)
- `message_sync` — per-bot/per-chat/per-message sync ledger for shared group-history catch-up
- `chat_info` — per-chat settings such as `discuss`, `discuss_max_rounds`, `chairman_bot`, and `locale`
- `pending_triggers` — messages that should actively trigger a bot run
- `delivered_replies` — delivered response markers for idempotency
- `delivery_outbox` — durable user-visible delivery ledger with claim/dedupe state
- `recalled_messages` — recalled user messages excluded from pending work and future context
- `processed_events` — Feishu event de-duplication
- `bot_chat_settings` — per-bot/per-chat settings such as verbose mode, mode, and live-status toggle

## Development

```bash
npm ci
npm run build
npm run dev -- config.json
```

TypeScript output goes to `dist/`.


## npm release automation

This repository includes `.github/workflows/publish.yml`. To enable automated npm publishing:

1. Create an npm automation/granular token with package publish permission.
2. Add it to GitHub repository secrets as `NPM_TOKEN`.
3. Bump `package.json` version.
4. Commit and push.
5. Create a matching tag, for example:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

The publish workflow checks that the git tag matches the package version before running `npm publish`.

## Repository hygiene

The repository intentionally excludes:

- `config.json`
- `config*.json.bak*`
- `.env*`
- `data/`
- `dist/`
- `node_modules/`

Before publishing or pushing, run:

```bash
git status --short
git ls-files | grep -E 'config|secret|\.env' || true
```

If a secret is ever committed, remove it from the current tree and rewrite git history before making the repository public. Also rotate the leaked credential.

## Security notes

- Treat every Lark app secret and OpenClaw Gateway token as sensitive.
- Use one bot app per model/identity.
- Prefer private repositories until credentials have been audited and rotated if needed.
- Do not expose the OpenClaw Gateway to the public internet without authentication.

## License

MIT
