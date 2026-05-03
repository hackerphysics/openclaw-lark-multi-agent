# Feishu Multi-Bot Proxy

多个飞书机器人连接同一个 OpenClaw，每个机器人绑定固定模型。

## 架构

```
飞书机器人A (Claude) ─┐
飞书机器人B (GPT)   ──┤──→ Multi-Bot Proxy ──→ OpenClaw Local API
飞书机器人C (Gemini) ─┘
```

## 消息路由规则

- **私聊**：直接回复
- **群聊 - 用户 @了某个机器人**：只有被 @ 的机器人回复
- **群聊 - 用户没 @ 任何机器人**：所有机器人都回复
- **群聊 - 机器人的消息**：只有被 @ 的机器人回复，未被 @ 的不回复

## 配置

复制 `config.example.json` 为 `config.json`，填入：

1. OpenClaw Gateway 地址和 token
2. 每个飞书机器人的 App ID / App Secret
3. 每个机器人绑定的模型

```bash
cp config.example.json config.json
# 编辑 config.json
```

## 运行

```bash
npm install
npm run dev        # 开发模式
npm run build && npm start  # 生产模式
```

## 前置条件

1. OpenClaw Gateway 已启动，且开启了 HTTP API（chatCompletions endpoint）
2. 在飞书开放平台创建多个自建应用，每个应用开启机器人能力
3. 每个应用的事件订阅选择 WebSocket 模式
4. 添加事件：`im.message.receive_v1`
