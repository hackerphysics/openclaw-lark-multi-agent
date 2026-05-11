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
- Feishu image download and OpenClaw multimodal attachment forwarding
- Bridge attachment marker protocol for generated files/images/documents
- Feishu CardKit v2 Markdown rendering, including native table elements for pipe tables
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

## Quick start with npm

After the package is published to npm:

```bash
npm install -g openclaw-lark-multi-agent
openclaw-lark-multi-agent init
```

This creates:

- config: `~/.openclaw/openclaw-lark-multi-agent/config.json`
- data dir: `~/.openclaw/openclaw-lark-multi-agent/data/`

Edit the generated config and fill in your OpenClaw Gateway token and Lark app credentials. Then run:

```bash
openclaw-lark-multi-agent start
```

Install as a systemd user service:

```bash
openclaw-lark-multi-agent install-systemd --user
```

On Windows, install [NSSM](https://nssm.cc/download), make sure `nssm.exe` is in `PATH`, then run PowerShell or Command Prompt as Administrator:

```powershell
openclaw-lark-multi-agent install-windows-service
```

Useful CLI commands:

```bash
openclaw-lark-multi-agent --help
openclaw-lark-multi-agent doctor
openclaw-lark-multi-agent start [config]
openclaw-lark-multi-agent init [--state-dir DIR] [--force]
openclaw-lark-multi-agent install-systemd [--user|--system] [--state-dir DIR]
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
openclaw-lark-multi-agent init
notepad $env:USERPROFILE\.openclaw\openclaw-lark-multi-agent\config.json
openclaw-lark-multi-agent start
```

To run as a Windows service, install [NSSM](https://nssm.cc/download), put `nssm.exe` in `PATH`, open an elevated terminal, then run:

```powershell
openclaw-lark-multi-agent install-windows-service
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
- `/verbose` — toggle tool-call messages for this bot in this chat
- `/free` — toggle this bot's Free mode in the current group chat
- `/mute` — toggle this bot's mute mode in the current group chat
- `/mode` — show this bot's current mode in the current chat

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

`/free` is not a full multi-agent discussion scheduler. Notes for a future explicit `/discuss` mode live in [`docs/ideas/discussion-mode.md`](docs/ideas/discussion-mode.md).


## Markdown, tables, and attachments

Assistant replies are sent as Feishu CardKit v2 cards. Markdown is preprocessed for Feishu rendering:

- headings are downgraded to Feishu-friendly heading levels;
- fenced code blocks are preserved;
- unsupported external Markdown image URLs are stripped unless already resolved to Feishu `img_` keys;
- GitHub-style pipe tables are converted into native CardKit `table` elements.

For generated files/images/documents, agents should use the bridge attachment marker protocol instead of calling Feishu messaging tools directly. The bridge strips the marker from the visible reply, validates the file path under the configured attachment directory, uploads/sends the attachment, and records it in local context. Markdown documents can be converted into Feishu cloud documents through this path.

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
