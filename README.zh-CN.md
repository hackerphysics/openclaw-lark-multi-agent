# OpenClaw Lark Multi-Agent

[English](README.md) | [简体中文](README.zh-CN.md)

让多个 Lark/飞书机器人接入同一个 OpenClaw Gateway，并且每个机器人可以绑定不同模型、拥有隔离的会话状态。

这个项目是 OpenClaw 的桥接层。它本身不实现 Agent Runtime；消息会被转发到标准 OpenClaw Session，因此每个机器人仍然走完整的 OpenClaw pipeline，包括工具、记忆、slash commands 和交付逻辑。

## 为什么需要它

Lark/飞书里每个机器人都有自己的 App 身份，但 OpenClaw 通常在一个 channel account 下暴露一个助手身份。这个桥接层可以让你创建多个飞书机器人，例如：

- `GPT Bot` → `github-copilot/gpt-5.5`
- `Gemini Bot` → `github-copilot/gemini-3.1-pro-preview`
- `Claude Bot` → `github-copilot/claude-opus-4.7`

它们共享同一个 OpenClaw Gateway，同时保持各自的 session、队列和私聊隔离。

## 功能特性

- 单进程接入多个 Lark/飞书机器人应用
- 每个 bot 绑定独立模型（通过 OpenClaw session model override）
- 每个聊天一个 OpenClaw session：`lma-<bot>-<chatId>`
- 私聊隔离：一个私聊只归属一个 bot
- 群聊路由：
  - 直接 @ 某个 bot 时回复
  - `@all` / `@_all` 时回复
  - 可选 Free Discussion 模式
- 本地 SQLite 消息存储，用于上下文、触发队列和重复投递防护
- `pending_triggers` 队列，避免重启后把所有历史上下文都重新发给 OpenClaw
- `delivered_replies` 表，保证同一个触发消息每个 bot 最多投递一次回复
- 支持飞书图片下载，并以 OpenClaw multimodal attachment 形式转发
- 桥接层 slash command + 转义后的 OpenClaw slash command
- Linux systemd 安装脚本，运行产物和状态目录分离

## 架构

```text
Lark Bot App A ┐
Lark Bot App B ├─ WebSocket events ─→ openclaw-lark-multi-agent ─→ OpenClaw Gateway
Lark Bot App C ┘                                              └─ SQLite state
```

桥接层会把所有消息存为本地上下文，但只有真正应该触发回复的消息才会写入 `pending_triggers`。这样重启恢复时不会误把普通上下文消息重新发给 OpenClaw。

## 环境要求

- Node.js 22+
- npm
- 可访问的 OpenClaw Gateway（HTTP/WebSocket）
- 一个或多个 Lark/飞书自建应用，并启用 WebSocket 事件订阅
- 使用内置安装脚本时需要 Linux systemd；也可以用 pm2 等其他进程管理器

## 快速开始

```bash
git clone https://github.com/hackerphysics/openclaw-lark-multi-agent.git
cd openclaw-lark-multi-agent
npm ci
cp config.example.json config.json
```

编辑 `config.json`：

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

本地构建和运行：

```bash
npm run build
npm start -- config.json
```

> `config.json` 包含密钥，已被 git ignore。不要提交它。

## 推荐的 Linux 部署方式

使用安装脚本：

```bash
./scripts/install-linux-systemd.sh --system
```

默认目录：

- 程序运行产物：`~/.local/lib/openclaw-lark-multi-agent/`
- 状态、配置、数据：`~/.openclaw/openclaw-lark-multi-agent/`
- systemd 服务：`openclaw-lark-multi-agent.service`

安装脚本只会把运行所需文件部署到 runtime 目录：`dist/`、`package.json`、`package-lock.json` 和 production `node_modules`。源码不会复制过去。

如果想安装成 user service：

```bash
./scripts/install-linux-systemd.sh --user
```

自定义目录：

```bash
./scripts/install-linux-systemd.sh \
  --deploy-dir ~/.local/lib/openclaw-lark-multi-agent-prod \
  --state-dir ~/.openclaw/openclaw-lark-multi-agent-prod
```

常用命令：

```bash
systemctl status openclaw-lark-multi-agent
journalctl -u openclaw-lark-multi-agent -f
sudo systemctl restart openclaw-lark-multi-agent
```

## Lark/飞书应用配置

每个 bot 都需要一个独立的自建应用：

1. 创建 Lark/飞书自建应用。
2. 启用机器人能力。
3. 启用 WebSocket / 长连接事件订阅。
4. 订阅消息接收事件。
5. 把 App ID 和 App Secret 写入 `config.json`。
6. 把机器人加入目标聊天。

建议每个模型/身份对应一个独立 bot app。

## 命令

单斜杠命令由桥接层处理：

- `/help` — 显示命令帮助
- `/status` — 显示 bot 模型、token 使用和 session 状态
- `/compact` — 压缩 OpenClaw session
- `/reset` — 重置 OpenClaw session
- `/verbose` — 开关当前 bot 在当前聊天里的 tool-call 展示
- `/free` — 开关群聊 Free Discussion 模式

如果你想把 slash command 直接发给 OpenClaw，可以用双斜杠转义：

```text
//status
//reset
//compact
```

桥接层会把 `//status` 转成 `/status` 并转发给 OpenClaw，而不是自己处理。

## 消息路由规则

### 私聊

私聊归属当前 bot，其他 bot 不会处理这个私聊。

### 群聊

默认情况下，bot 会在这些场景回复：

- 被直接 @；
- 消息里出现 `@all` / `@_all`；
- 当前群开启了 Free Discussion 模式。

bot 发出的消息默认不会触发其他 bot，除非明确 @。同时有 bot-streak 防护，避免 bot 之间无限互相回复。

## 数据模型

SQLite 状态位于配置的数据目录。主要表：

- `messages` — 本地对话日志和上下文
- `sync_state` — 每个 bot / chat 的同步游标
- `pending_triggers` — 应主动触发 bot run 的消息
- `delivered_replies` — 已投递回复标记，用于幂等防重复
- `processed_events` — 飞书事件去重
- `bot_chat_settings` — 每个 bot / chat 的设置，例如 verbose mode

## 开发

```bash
npm ci
npm run build
npm run dev -- config.json
```

TypeScript 输出目录是 `dist/`。

## 仓库卫生

仓库会忽略：

- `config.json`
- `config*.json.bak*`
- `.env*`
- `data/`
- `dist/`
- `node_modules/`

发布或 push 前建议检查：

```bash
git status --short
git ls-files | grep -E 'config|secret|\.env' || true
```

如果密钥曾经被提交，需要从当前 tree 删除、重写 git 历史、force push，并轮换泄露的凭证。

## 安全说明

- Lark/飞书 App Secret 和 OpenClaw Gateway token 都是敏感信息。
- 建议一个模型/身份对应一个 bot app。
- 在完成凭证审计和必要轮换前，建议保持私有仓库。
- 不要在没有认证保护的情况下把 OpenClaw Gateway 暴露到公网。

## License

MIT
