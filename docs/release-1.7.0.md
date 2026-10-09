# v1.7.0

Go 监督深化、供应商错误安全分类加固、steer 重复投递修复与错误通知透明化。

## Go / Go-Checker（阶段 1 收尾，10-02）

- 公共 runtime 适配层：独立 LMA Checker 走公开网关方法，未验证的运行时安全
  fail-closed，过期判定围栏防复活（9362c46、fa53daa）。
- 持久化 goal guards 与诚实快照适配器：精确会话身份门禁，隔离 policy fixture（96f5b17、10a3aec）。
- 守卫式控制器证据闭环与离线运行循环（ceb8af3）。
- 初始目标经 outbox 精确投递 run 结果（6062354）。
- 配套网关插件 lma-go（工具隔离 enforcement，2026-10-04 修复清单字段后加载成功）。

## 供应商错误分类加固（10-07/10-08）

- 模型错误分类不再误报 tool-schema 拒绝（98a4bb5）。
- 识别网关 disabled-model 503 的封闭文案并安全分类（79b085d）。
- 根级 unknown-model 诊断的精确安全分类（d17ab58）。
- 补齐"Core 错误细节经完整 LMA 投递链丢失"的复现测试（16ca67a）。

## Steer（插入消息）修复（10-09，OpenClaw 2026.9.9 兼容）

- **重复投递修复**（cd08118）：2026.9.9 不再为插件注入消息发 session.message
  镜像，旧逻辑的转写确认永不触发导致每条插入消息 run 结束后被重发一遍。
  现在**接受即转移 custody**：接受时清除兜底 trigger；所属批次失败时经
  runFailureObservers 恢复重发（wait-paused 不触发；/stop 后不复活）。
- **Get → DONE 状态补全**（07a0b5c）：插入消息随所属批次成功收尾翻 DONE；
  失败恢复的走新批次正常 DONE；wait-paused/stop 保持 Get。
- Minimax 复核发现的遗漏一并修复：消费先于接受路径同样注册 DONE ack。

## 错误通知透明化（10-09，用户指令：转发透明第一）

- 未分类错误通知附带**原始错误（节选）**：脱敏展示原始诊断文本（1a5b778）。
  今日实例：content_filter 拒绝此前只显示"原因尚未分类"，现在直接可见。
- 安全闸门（对抗测试全过）：提示词/工具输出回显、PRIVATE 标记、凭据形态
  （api_key/secret/ghp_/eyJ/sk-/token）、压缩失败已知文案、JSON/HTML 包裹、
  畸形双斜杠 ID 一律不回显；URL 预脱敏为 [url]；长 token 打码；200 字上限。
- 已分类错误保持策展文案（防回显加固契约不变）；classifyProviderError
  返回形状不变（excerpt 在展示层计算）。

## 质量与部署

- 全量 1034/1034 离线测试通过（provider-errors 套件 77 例恢复并扩展 +6）。
- 运维修复记录：x provider baseUrl 补 /v1（Minimax 400 根因）；
  compaction 模型确认 x/gpt-6.1-sol；guangzi 的 OpenClaw 迁至
  D:\OfficeApps-20261004 后 lma-steer/lma-go 就绪。
