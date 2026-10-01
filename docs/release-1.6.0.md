# v1.6.0

Go / Go Checker 独立验收监督（设计：`artifacts/lma-go-checker-design-20260917/DESIGN.md`，阶段 1）。

## 新增：/go 命令族

    @GPT /go <目标>        开始监督（群聊需点名；/go start <目标> 为别名）
    @GPT /go               查看状态
    @GPT /go model <id>    设置 Checker 模型偏好（default 清除；影响后续新 Go）
    @GPT /go pause|resume|stop

- 执行会话照常干活；独立 Checker 会话（`lma-go-<bot>-<chat>`）只审核增量证据，
  严格输出 WAIT / CONTINUE / COMPLETE JSON。
- 执行 Agent 自称"完成"不等于验收：只有当前 Checker run 的合法判定 + 程序门禁共同决定。
- 活动回复尾部显示 `🎯 Go待核验 / Go核验中 / Go已暂停`。
- CONTINUE 自动跟进：缺项转发给执行会话（带"Go Checker 跟进"来源标识，非新授权），
  飞书同步通知；默认上限 10 次跟进、连续 3 次缺项无实质变化自动暂停。
- COMPLETE 必须引用输入中真实存在的证据编号，否则拒绝并暂停。
- 程序级空闲门禁：执行会话运行中 / 有人类消息排队时不催办不完成（WAIT/推迟）。
- /stop 与 /reset 自动暂停相关 Go；重启后校验执行会话代际，不匹配即暂停并通知。

## v1 范围决定（设计文档明确允许的形态）

- 独立监督状态模式：Go 状态由 LMA 持久化（go_jobs/go_events/go_checks/go_actions 表），
  不宣称与原生 Goal 双状态联动（桥接无法调用模型侧 Goal 工具，设计 §2.1/§14）。
- Checker 为"基础消息审核型"：只看增量消息证据，不宣称独立产物核验（会话级工具
  隔离在当前 RPC 面不可实现，设计 §9）。
- 幂等：动作键（go:<id>:check:<n>:continue、go:<id>:complete-notice）+ 证据 sourceKey
  去重 + revision CAS；崩溃中断的瞬态在恢复时回落 WAITING_WORK，迟到 Checker 结果作废。

## 其他

- 修复 WAIT 判定后未回到 WAITING_WORK 的状态机缺陷（仅存在于本特性内部，未发布过）。
- 构建 + 725 项离线测试通过（新增 go-controller 20 项：解析严格性、门禁、三态、
  停滞/上限暂停、证据伪造拒绝、双 Bot 隔离、恢复、幂等原语）。
- 已知无关问题：StepFlask bot 的 stepfun provider 在网关侧未注册（升级遗留配置问题，
  与本版本无关）。
