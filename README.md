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
  - optional Free Discussion mode
- Local SQLite message store for context, trigger tracking, and duplicate prevention
- `pending_triggers` queue so restart recovery does not replay every context message
- `delivered_replies` table so one trigger message gets at most one delivered reply per bot
- Feishu image download and OpenClaw multimodal attachment forwarding
- Bridge-level slash commands and escaped OpenClaw slash commands
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

## Quick start

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
- `/verbose` — toggle tool-call messages for this bot in this chat
- `/free` — toggle Free Discussion mode in group chats

OpenClaw-level slash commands can be sent by escaping with a double slash:

```text
//status
//reset
//compact
```

The bridge converts `//status` to `/status` and forwards it to OpenClaw instead of handling it locally.

## Message routing rules

### Private chats

A private chat is owned by the bot connected to that chat. Other bots ignore it.

### Group chats

By default, a bot responds when:

- it is directly mentioned;
- `@all` / `@_all` appears in the message;
- Free Discussion is enabled for that group.

Bot messages do not trigger other bots unless they mention them. A bot-streak guard prevents infinite bot-to-bot loops.

## Data model

SQLite state lives in the configured data directory. Important tables:

- `messages` — local conversation log and context
- `sync_state` — per-bot/per-chat sync cursor
- `pending_triggers` — messages that should actively trigger a bot run
- `delivered_replies` — delivered response markers for idempotency
- `processed_events` — Feishu event de-duplication
- `bot_chat_settings` — per-bot/per-chat settings such as verbose mode

## Development

```bash
npm ci
npm run build
npm run dev -- config.json
```

TypeScript output goes to `dist/`.

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
