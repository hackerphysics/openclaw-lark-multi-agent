# Lark Multi-Agent

多个飞书机器人接入同一个 OpenClaw 实例，每个机器人绑定不同 AI 模型，共享完整的 Agent 能力。

## 为什么需要这个？

飞书原生只支持一个机器人对应一个 AI 服务。如果你想在同一个群里同时和 GPT、Claude、Gemini 对话，或者给不同群分配不同模型，就需要一个中间层来路由。

Lark Multi-Agent 就是这个中间层：

- **一个 OpenClaw 实例** 提供所有 Agent 能力（工具、记忆、Skills）
- **多个飞书机器人** 各自绑定不同模型
- **本地消息缓存** 实现智能消息批量发送，避免重复回复

## 架构

```
飞书 Bot A (Claude) ─┐
飞书 Bot B (GPT)   ──┤──→ Lark Multi-Agent ──WebSocket──→ OpenClaw Gateway
飞书 Bot C (Gemini) ─┘         │
                          SQLite (消息缓存)
```

## 核心特性

### 🔀 消息路由
- **私聊**：机器人直接回复
- **群聊 @ 某个机器人**：只有被 @ 的机器人回复
- **群聊无 @**：所有机器人都回复
- **防死循环**：连续 10 条机器人消息后自动暂停，等人类发言

### 🧠 独立会话
- 每个机器人 × 每个聊天 = 独立的 OpenClaw Session
- Session Key 格式：`lma-<bot名>-<chatId>`
- 模型绑定、上下文、记忆完全隔离

### 📦 智能消息批量
- Agent 处理中时，新消息自动排队
- Agent 完成后，所有积压消息**打包一起发送**
- 像跟人说话一样自然——连续发的多条消息会被当作一个整体理解
- 3 分钟超时保护，防止队列永远卡死

### ✅ 消息确认
- 收到消息立即加 Reaction（随机表情）
- 回复完成后替换为 ✅ DONE
- 让你知道机器人收到了消息、正在处理

### 🛡️ 模型漂移检测
- 每次对话前自动检查 Session 当前模型
- 如果被篡改，自动修复并在对话中通知

### 🔧 管理命令
| 命令 | 说明 |
|------|------|
| `/status` | 显示当前 Bot、模型、Token 用量、Session 状态 |
| `/compact` | 手动压缩 Session 上下文 |
| `/reset` | 重置 Session（清空对话历史） |

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) >= 18
- 运行中的 [OpenClaw](https://github.com/openclaw/openclaw) Gateway
- 一个或多个[飞书自建应用](https://open.feishu.cn/)

### 1. 创建飞书应用

在[飞书开放平台](https://open.feishu.cn/)为每个模型创建一个自建应用。

> 💡 如果你已经配置过 OpenClaw 的飞书机器人，新建的应用需要**与 OpenClaw 机器人具有相同的权限配置**。

**快速配置：**

1. 创建自建应用，开启「机器人」能力
2. 事件订阅方式选择 **WebSocket（长连接）**
3. 添加事件：`im.message.receive_v1`
4. 添加权限（与 OpenClaw 飞书机器人一致）：
   - `im:message` — 读写消息（收发消息必需）
   - `im:message.reactions:write_only` — 发送表情回复（消息确认反馈）
   - `im:chat:readonly` — 读取群信息（获取群名称和成员列表）
5. 记下 App ID 和 App Secret

详细步骤参考[飞书官方文档：创建自建应用](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)。

### 2. 克隆 & 安装

```bash
git clone https://github.com/hackerphysics/lark-multi-agent.git
cd lark-multi-agent
npm install
```

### 3. 配置

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```jsonc
{
  "openclaw": {
    "baseUrl": "http://127.0.0.1:18789",   // OpenClaw Gateway 地址
    "token": "your-gateway-token"            // gateway.auth.token
  },
  "bots": [
    {
      "name": "GPT",                         // 显示名称（需唯一）
      "appId": "cli_xxx",                    // 飞书 App ID
      "appSecret": "xxx",                    // 飞书 App Secret
      "model": "openai/gpt-5.5"             // OpenClaw 模型标识
    },
    {
      "name": "Claude",
      "appId": "cli_yyy",
      "appSecret": "yyy",
      "model": "anthropic/claude-opus-4-6"
    },
    {
      "name": "Gemini",
      "appId": "cli_zzz",
      "appSecret": "zzz",
      "model": "google/gemini-3.1-pro-preview"
    }
  ]
}
```

### 4. 运行

```bash
# 开发模式
npm run dev

# 生产模式
npm run build
npm start
```

### 5. 安装为系统服务（推荐）

#### 方案一：pm2（跨平台，推荐）

适用于 Linux / macOS / Windows，最简单的方式：

```bash
# 安装 pm2
npm install -g pm2

# 先编译
npm run build

# 启动
pm2 start dist/index.js --name lark-multi-agent -- config.json

# 设置开机自启
pm2 startup    # 按提示执行输出的命令
pm2 save

# 常用命令
pm2 status                    # 查看状态
pm2 logs lark-multi-agent     # 查看日志
pm2 restart lark-multi-agent  # 重启
pm2 stop lark-multi-agent     # 停止
```

#### 方案二：systemd（Linux）

```bash
sudo cp lark-multi-agent.service /etc/systemd/system/

# 根据实际情况修改 User 和 WorkingDirectory
sudo vim /etc/systemd/system/lark-multi-agent.service

sudo systemctl daemon-reload
sudo systemctl enable lark-multi-agent
sudo systemctl start lark-multi-agent

# 查看状态和日志
sudo systemctl status lark-multi-agent
journalctl -u lark-multi-agent -f
```

#### 方案三：launchd（macOS）

```bash
# 复制 plist 文件（需要根据实际路径修改）
cp lark-multi-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/lark-multi-agent.plist
```

### 用 OpenClaw 配置（推荐）

如果你已经有一个 OpenClaw 实例在运行，最简单的方式是直接告诉它：

> 帮我配置 lark-multi-agent。GPT bot 的 App ID 是 cli_xxx，Secret 是 yyy，用 gpt-5.5 模型。

OpenClaw 会自动克隆仓库、写配置、启动服务。

## 配置参考

| 字段 | 说明 |
|------|------|
| `openclaw.baseUrl` | OpenClaw Gateway 的 HTTP 地址 |
| `openclaw.token` | Gateway 认证 Token（`openclaw.json` 里的 `gateway.auth.token`） |
| `bots[].name` | Bot 名称，必须唯一，用于 Session Key 和日志 |
| `bots[].appId` | 飞书自建应用的 App ID |
| `bots[].appSecret` | 飞书自建应用的 App Secret |
| `bots[].model` | OpenClaw 模型标识（如 `openai/gpt-5.5`） |
| `adminOpenId` | （可选）管理员的飞书 Open ID，用于接收系统通知 |

## 数据存储

- `data/messages.db` — SQLite，存储消息记录、同步状态、聊天信息
- OpenClaw 管理各 Session 的对话历史（在 `~/.openclaw/sessions/`）

## 工作原理

### 消息流

```
用户发消息 → 飞书 SDK (WebSocket) → handleMessage
  → 存入 SQLite
  → 加 Reaction 确认收到
  → 检查 Agent 是否忙碌
    → 忙碌：消息留在队列，等 Agent 完成后一起发
    → 空闲：打包所有未同步消息 → OpenClaw chat.send
      → 收到回复 → 回复飞书 → 替换 Reaction 为 DONE
      → 检查是否有新的积压消息 → 循环处理
```

### 防串台机制

- 飞书 SDK 层面：每个 Bot 独立的 WSClient，只收自己的事件
- OpenClaw 层面：Session Key 按 `bot名+chatId` 隔离
- 回复层面：每个 Bot 用自己的 `lark.Client` 发消息
- 本地存储：`sync_state` 按 `(bot_name, chat_id)` 独立追踪

### 容错机制

- **消息去重**：内存 Set + 数据库 UNIQUE 约束双重保护
- **队列超时**：3 分钟未完成自动解锁，防止永远卡死
- **启动排水**：重启后自动处理上次未发送的消息
- **模型守护**：每次对话前检查模型是否正确

## License

MIT
