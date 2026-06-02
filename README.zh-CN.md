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
  - 可选的 per-bot Free 模式，用于普通人类消息
  - 定向 @ 具有排他性，Free 模式 bot 不会抢答发给其他人或其他 bot 的消息
  - 纯 @ 某个 bot 的消息可以结合前文未同步上下文触发回复
- per-bot anti-loop 防护，其他 bot 的发言不会消耗当前 bot 的发言额度
- 本地 SQLite 消息存储，用于上下文、触发队列和重复投递防护
- `pending_triggers` 队列，避免重启后把所有历史上下文都重新发给 OpenClaw
- `delivered_replies` 表，保证同一个触发消息每个 bot 最多投递一次回复
- 持久化 delivery outbox：所有用户可见输出先入库，再通过稳定 key、原子 claim 和短窗口去重后投递
- 消息撤回处理：已撤回且仍在排队/待处理的用户消息会从 pending 队列移除，并从后续上下文中排除
- 支持飞书图片下载，并以 OpenClaw multimodal attachment 形式转发
- Bridge attachment marker 协议，用于发送生成的文件、图片和文档
- Feishu CardKit v2 Markdown 渲染，并把 pipe table 转成原生 table 组件
- 桥接层 slash command + 转义后的 OpenClaw slash command
- `/discuss` 多 bot 结构化讨论模式，支持轮次标注和无新增回复提示
- `/chairman` 主席角色：每个群唯一一个主席，在没有 Free 模式 bot 时兑底回答普通消息；在 `/discuss` 里担任主持、质疑者和总结者
- `/locale zh|en` 群级语言设置，讨论/主席 prompt 和系统消息随语言切换，支持 bot 级和全局 locale 回退
- 共享群历史 catch-up：某个 bot 错过消息后被重新 @ 时，会拿到它还没同步过的群里发言（超大历史会卸到本地文件）
- 并发保护：全局 `chat.send` 限流 + 维护类 RPC（如 `sessions.compact`）串行限流，避免多 bot fan-out 打爆 gateway
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

## 使用 npm 快速开始

发布到 npm 后，可以这样安装：

```bash
npm install -g openclaw-lark-multi-agent
openclaw-lark-multi-agent init
```

这会创建：

- 配置文件：`~/.openclaw/openclaw-lark-multi-agent/config.json`
- 数据目录：`~/.openclaw/openclaw-lark-multi-agent/data/`

编辑生成的配置文件，填入 OpenClaw Gateway token 和 Lark/飞书应用凭证。然后运行：

```bash
openclaw-lark-multi-agent start
```

安装成 systemd user service：

```bash
openclaw-lark-multi-agent install-systemd --user
```

Windows 下先安装 [NSSM](https://nssm.cc/download)，确保 `nssm.exe` 在 `PATH`，然后用管理员权限打开 PowerShell 或命令提示符：

```powershell
openclaw-lark-multi-agent install-windows-service
```

常用 CLI 命令：

```bash
openclaw-lark-multi-agent --help
openclaw-lark-multi-agent doctor
openclaw-lark-multi-agent start [config]
openclaw-lark-multi-agent init [--state-dir DIR] [--force]
openclaw-lark-multi-agent install-systemd [--user|--system] [--state-dir DIR]
```

## 从源码快速开始

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


## Windows 部署

npm CLI 也支持 Windows。默认状态目录是 `%USERPROFILE%\.openclaw\openclaw-lark-multi-agent`。

```powershell
npm install -g openclaw-lark-multi-agent
openclaw-lark-multi-agent init
notepad $env:USERPROFILE\.openclaw\openclaw-lark-multi-agent\config.json
openclaw-lark-multi-agent start
```

如果要作为 Windows Service 运行，安装 [NSSM](https://nssm.cc/download)，把 `nssm.exe` 放进 `PATH`，用管理员权限打开终端，然后运行：

```powershell
openclaw-lark-multi-agent install-windows-service
```

兼容用的 bat 脚本也保留在 `scripts/install-windows-service.bat`。

## macOS launchd

示例 launchd plist 放在 `scripts/openclaw-lark-multi-agent.plist`。多数用户用 npm CLI 配合进程管理器会更简单。

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
- `/free [on|off]` — 切换，或显式开启/关闭当前 bot 在当前群聊里的 Free 模式
- `/mute` — 开关当前 bot 在当前群聊里的 mute 模式
- `/mode` — 查看当前 bot 在当前聊天里的模式
- `/discuss on|off|status|stop|rounds N` — 控制群级多 bot 讨论模式（需先设置 Chairman；默认 10 轮）
- `/chairman [@Bot|off]` — 设置/查看/清除本群唯一 Chairman
- `/locale [zh|en]` — 设置/查看当前群语言

如果你想把 slash command 直接发给 OpenClaw，可以用双斜杠转义：

```text
//status
//reset
//compact
```

桥接层会把 `//status` 转成 `/status` 并转发给 OpenClaw，而不是自己处理。

如何测试 double slash 行为：

1. 在某个 bot 私聊里发送 `//status`。
   - 预期：消息会被转成 `/status` 发给 OpenClaw。
   - 它**不会**被桥接层当成本地 `/status` 命令处理。
2. 在群聊里，先 @ 某个 bot，或者 @所有人，再加双斜杠命令：

```text
@GPT //status
@所有人 //reset
```

预期：桥接层只用前面的 @ 来做路由，然后把 `//...` 转成 `/...` 发给 OpenClaw。

如果要测试桥接层自己的命令，用单斜杠：

```text
/reset
@所有人 /reset
```

预期：桥接层本地处理这个命令，不会转发给 OpenClaw。

## 消息路由规则

### 私聊

私聊归属当前 bot，其他 bot 不会处理这个私聊。

### 群聊

默认情况下，bot 会在这些场景回复：

- 被直接 @；
- 消息里出现 `@all` / `@_all`；
- 当前 bot 开启了 Free 模式，并且这是一条没有定向 @ 的普通人类消息。

Free 模式是 per-bot 且保守的：

- Free 模式允许 bot 在没有被 @ 时回复普通人类消息。
- 如果人类消息 @ 了另一个 bot，只有被 @ 的 bot 可以回复，其他 Free 模式 bot 保持静默。
- 如果人类消息 @ 了普通人，Free 模式 bot 保持静默。
- `@all` 仍然是广播触发，可激活所有符合条件的 bot。

支持“纯 @ 触发”。例如用户先发：

```text
帮我分析一下这个合同风险。
@Claude
```

第二条纯 @ 消息会被当作触发器，并和前面未同步的上下文一起发给被 @ 的 bot。

bot 发出的消息默认不会触发其他 bot，除非明确 @。anti-loop 防护按 bot + chat 单独计算：其他 bot 的发言不会消耗当前 bot 的额度，人类发言会重置计数。

### 上下文注入

catch-up 上下文是 bot 随当前消息一起拿到的群里未看到的发言，遵循严格规则：

- catch-up 只在群聊注入；私聊永远不注入。
- 它包含当前 bot 还没同步过的消息（人类的和其他 bot 的都算），这样纯 @ 触发的回复能看到它要回的那条人类消息。
- 它排除当前 trigger、其他 pending trigger、当前 bot 自己的消息、以及转义的原生命令。
- 没有未看到的消息时，不加任何 context header，当前消息原样发送。
- 连续的普通人类消息会合并成一次 run，不逐条处理。原生命令（`//x`）始终单独处理，不与普通消息合并。
- 转义的原生命令（`//status`）原样发送，不带 catch-up 上下文、不带 attachment hint。
- attachment hint 只在消息同时出现「动作词 + 产物词」时注入（如“生成一张图发给我”），普通聊天提到“文件”“文档”不会误触发。

持久约束（如“不要直接调用飞书发送工具”、主席的非 discuss 约束）只在 session 创建/reset 时一次性注入，绝不每条消息 prepend。


## `/discuss` 讨论模式

`/discuss` 是显式的群级多智能体讨论调度器，和 Free 模式分工不同：

- `/free` 控制单个 bot 是否可以响应普通人类消息。
- `/discuss on` 需先设置 Chairman（`/chairman @Bot`）。它让一个 coordinator 接管普通人类消息，并按 barrier-style round 调度所有 Free 模式 bot 加上 Chairman。
- 定向 @ 仍然走普通路由，所以 discuss 开启时 `@GPT hello` 仍会只触发 GPT。
- 每个参与 bot 在同一轮拿到相同 prompt，本轮内看不到其他 bot 的回复，下一轮才会看到上一轮结果。
- Chairman 每轮最后发言：先给出自己的观点，质疑薄弱点，调停分歧，并决定继续还是总结。
- 每条可见讨论回复会自动追加轮次标注，例如 `—— 第 2/3 轮 · Claude`。
- 如果某些 bot 返回 `NO_REPLY` 或空回复，coordinator 会发送轻量提示，例如 `💬 第 3/3 轮：Qwen、Gemini 无新增回复`。
- 当 Chairman 输出 `FINAL_SUMMARY:` 行时，讨论结束并自动关闭 discuss 模式；控制标记（`FINAL_SUMMARY:` / `CHAIRMAN_NOTE:`）会从用户可见内容里剔除。
- 默认轮数是 10；达到上限会强制 Chairman 做最终总结。

命令：

```text
/discuss on
/discuss off
/discuss status
/discuss stop
/discuss rounds 10
```

### `/chairman` 主席

每个群只能有一个 Chairman，用 `/chairman @Bot` 设置。设置新 Chairman 会替换旧的；同时 @ 多个 bot 会报错。Chairman 有两个角色：

- 普通模式：只是兑底回答者。没有 bot 处于 Free 模式、也没有明确 @ 任何人时，Chairman 回答普通消息。它在 `/discuss` 之外不总结、不主持、不质疑其他 bot。
- Discuss 模式：参与讨论，每轮最后发言，质疑、调停、并做最终总结。

```text
/chairman @Bot   设置 Chairman
/chairman        查看当前 Chairman
/chairman off    清除 Chairman
```

`/chairman` 是群级命令，由一个 coordinator bot 统一处理，只产生一条回复。

### `/locale` 语言

讨论 prompt、主席 prompt 和系统消息都支持中英文。语言优先级：群 `/locale` 设置 > bot 级 `locale` 配置 > 全局 `locale` 配置 > `zh`（默认）。

```text
/locale       查看当前群语言
/locale zh    设置为中文
/locale en    设置为英文
```

`/locale` 也是群级命令，由一个 coordinator bot 统一处理。当前语言会在 `/status` 里显示。

## Delivery outbox 与重复投递防护

所有用户可见 assistant 输出都会先进入本地 `delivery_outbox`，再统一投递到飞书。覆盖普通 chat final、proactive `session.message`、延迟 runtime error、provider error、discussion 回复和附件 marker。

outbox 提供：

- 稳定 trigger key，例如 `trigger:<message_row_id>`；
- `UNIQUE(bot_name, chat_id, delivery_key)` 防止同一逻辑输出重复投递；
- `pending -> delivering -> delivered/failed` 原子 claim，避免并发重复发送；
- proactive-only 输出的短窗口 content hash 去重；
- chat final 包含“中间说明 + 最终答案”、proactive 只包含“最终答案”时的短窗口包含关系去重；
- 附件感知去重，避免把带文件/图片/文档的输出和纯文本误合并。

这样普通回复、subagent/proactive 回传、讨论消息、延迟错误、provider 错误和生成附件都走同一条可靠投递链路。

## 消息撤回

桥接层订阅飞书 `im.message.recalled_v1` 事件。用户撤回一条仍在 pending/排队中的消息时：

1. 原始消息仍保留在 `messages` 表，便于审计；
2. 撤回记录写入 `recalled_messages`；
3. 删除各 bot 对应的 `pending_triggers`；
4. 移除本地 pending reaction ack；
5. 后续同步上下文时排除这条撤回消息。

v1 行为边界：如果消息已经进入 OpenClaw 正在处理，暂不 abort；如果 bot 回复已经发出，也不自动撤回 bot 回复。第一版目标是可靠取消“尚未处理/排队中”的撤回消息。

## Markdown、表格和附件

助手回复会以 Feishu CardKit v2 卡片发送。Markdown 会先做飞书兼容预处理：

- 标题会降级到飞书更稳定的标题层级；
- fenced code block 会被保护；
- 未解析成飞书 `img_` key 的外部 Markdown 图片会被剥离，避免卡片发送失败；
- GitHub 风格 pipe table 会转换成 CardKit 原生 `table` 组件。

如果 Agent 需要发送生成的文件、图片或文档，应使用 bridge attachment marker 协议，而不是直接调用飞书消息工具。桥接层会从可见回复中剥离 marker，校验文件路径位于配置的附件目录下，然后上传/发送附件，并写入本地上下文。Markdown 文档也可以通过这个路径转换成飞书云文档。

## 数据模型

SQLite 状态位于配置的数据目录。主要表：

- `messages` — 本地对话日志和上下文（含 `trigger_kind` 列，标记转义的原生命令）
- `sync_state` — 每个 bot / chat 的同步游标（粗粒度水位线）
- `message_sync` — 每个 bot / chat / 消息的同步账本，用于共享群历史 catch-up
- `chat_info` — 每个 chat 的设置，例如 `discuss`、`discuss_max_rounds`、`chairman_bot`、`locale`
- `pending_triggers` — 应主动触发 bot run 的消息
- `delivered_replies` — 已投递回复标记，用于幂等防重复
- `delivery_outbox` — 持久化的用户可见投递账本，带 claim/去重状态
- `recalled_messages` — 已撤回的用户消息，从 pending 和后续上下文中排除
- `processed_events` — 飞书事件去重
- `bot_chat_settings` — 每个 bot / chat 的设置，例如 verbose mode

## 开发

```bash
npm ci
npm run build
npm run dev -- config.json
```

TypeScript 输出目录是 `dist/`。


## npm 自动发布

仓库里已经包含 `.github/workflows/publish.yml`。启用自动发布需要：

1. 在 npm 创建 automation/granular token，并授予 package publish 权限。
2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加 `NPM_TOKEN`。
3. 修改 `package.json` version。
4. 提交并推送。
5. 创建匹配的 tag，例如：

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

发布 workflow 会检查 git tag 是否和 package version 一致，然后再执行 `npm publish`。

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
