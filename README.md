# Lark Multi-Agent

Multiple Feishu/Lark bots connected to one OpenClaw instance, each bound to a specific AI model with full agent capabilities.

## Architecture

```
Feishu Bot A (Claude) ─┐
Feishu Bot B (GPT)   ──┤──→ Lark Multi-Agent ──WS──→ OpenClaw Gateway
Feishu Bot C (Gemini) ─┘         │
                            SQLite (message log)
```

Each bot owns a dedicated OpenClaw **session** connected via the Gateway WebSocket protocol. This means every bot has:

- Full agent pipeline (tools, memory, skills, system prompt)
- Persistent conversation history managed by OpenClaw
- Same capabilities as a native OpenClaw channel

Messages from other participants (humans and other bots) are **injected** into each bot's session as context via `chat.inject`, so every bot is aware of the full conversation.

## Message Routing Rules

- **Private chat**: Bot always responds
- **Group chat — user @'s a bot**: Only the mentioned bot responds
- **Group chat — user sends without @**: All bots respond
- **Group chat — bot message @'s another bot**: Only the mentioned bot responds
- **Group chat — bot message without @**: No bot responds (prevents loops)
- **Anti-loop**: After 10 consecutive bot messages without a human message, all bots stop and wait

## Setup

### 1. Create Feishu Apps

Create multiple self-built apps on [Feishu Open Platform](https://open.feishu.cn):

1. Enable "Bot" capability for each app
2. Set event subscription to **WebSocket** mode
3. Add event: `im.message.receive_v1`
4. Note down each app's App ID and App Secret

### 2. Configure

```bash
cp config.example.json config.json
# Edit config.json with your settings
```

### 3. Enable OpenClaw Gateway Auth

Ensure your OpenClaw gateway has auth configured (`gateway.auth.mode: "token"`).

### 4. Run

```bash
npm install
npm run dev        # Development
npm run build && npm start  # Production
```

## Config Reference

```jsonc
{
  "openclaw": {
    "baseUrl": "http://127.0.0.1:18789",  // Gateway address
    "token": "your-gateway-token"           // gateway.auth.token
  },
  "bots": [
    {
      "name": "Claude",                     // Display name
      "appId": "cli_xxx",                   // Feishu App ID
      "appSecret": "xxx",                   // Feishu App Secret
      "model": "anthropic/claude-opus-4",   // Model for this bot
      "systemPrompt": "You are Claude..."   // Optional system prompt
    }
  ]
}
```

## Data

- `data/messages.db` — SQLite database storing all messages for anti-loop tracking
- OpenClaw manages conversation history per session (in `~/.openclaw/sessions/`)

## License

MIT
