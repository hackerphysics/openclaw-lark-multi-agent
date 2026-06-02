# LMA 上下文注入流程（最终版）

## 一句话原则

> catch-up 上下文 = 当前 bot 在这个**群聊**里还没看到的消息（人类的 + 其他 bot 的都算）。

> 连续的普通人类消息**合并成一次投递**；命令各自单独 run。

---

## pending triggers 处理

```
pending 里堆了多条待触发消息
        │
        ▼
  第一条是 native command (//x)？
        │是 ──▶ 只取这一条，单独 run，不合并、不注入 context
        │否
        ▼
  取开头连续的「非 native」普通消息 → 合并成一次 current
  [用户]: 第1条\n[用户]: 第2条 ...
  只触发 1 个 run，不逐条
```

合并后：所有 merged trigger 都标 delivered、都清 pending、reaction 都置 DONE。

---

## catch-up context 注入

```
当前要处理的批次
   │
   ▼ p2p 私聊？ ──是──▶ 不注入 context
   ▼ native command？ ──是──▶ 不注入 context，不注入 attachment hint
   ▼ （群聊普通消息）
   ▼
 取「当前 bot 在本群没看到」的消息，过滤掉：
   · 当前 merged trigger 自己
   · 其他 pending trigger（各自是 current）
   · 当前 bot 自己发的消息
   · native command
 → 剩下的（人类 + 其他 bot 的消息）就是 catch-up
   │
   ▼ 为空？ ──是──▶ 直接发当前消息，无 header
   ▼ 有 ──▶ 注入
   [以下是群里其他成员刚发、你还没看到的发言，供参考]
   [Alice]: ...
   [GPT (AI)]: ...
   ---
   [当前用户]: 当前消息
```

---

## 硬规则

1. p2p 永远不注入 catch-up
2. 当前 trigger 绝不进 catch-up
3. 其他 pending trigger 绝不进 catch-up
4. 当前 bot 自己的消息不进 catch-up
5. native command 不注入任何 context / attachment hint，且不和普通消息合并
6. catch-up 为空时不出现 header
7. attachment hint 只在「动作词＋产物词」组合时触发（如"生成图片发给我"）
8. mention-only（@bot 无正文）天然能看到前一条人类消息（因为人类消息进 catch-up）

---

## 持久约束（policy）注入

bridge policy（不主动发飞书、chairman 非 discuss 不总结等）只在 **session 创建 / reset** 时一次性注入，绝不每条消息 prepend。
