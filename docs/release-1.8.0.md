# Release 1.8.0 — lma-core 统一插件 + ToolTrim 默认压缩（2026-10-10）

## 亮点

- **lma-core 统一插件**（`d4990c2`）：lma-steer + lma-go 合并为单一插件，一份清单、一条 allowlist、一次升级。方法名与持久化路径不变，零迁移。旧插件已从本机卸载归档。
- **`/compact tooltrim`**（`98659f8`）：自研压缩策略——官方 CompactionProvider 扩展点，保文本、过滤工具载荷、保留最近 10 条工具调用。不调 LLM，零成本秒级完成。编排走桥接侧 config 三步舞（插件不可调网关 RPC）。
- **toolTrim 设为默认压缩**（`3bb777d`）：裸 `/compact` 即 tooltrim；网关 `agents.defaults.compaction.provider=lma-tooltrim` 永久生效，溢出自动压缩同样走 ToolTrim（不再依赖压缩模型可用性——上周压缩模型故障的根治）。`/compact semantic` 显式走 LLM 总结（自动临时摘除 provider），`/compact trim`/`N` 机械裁剪仍可用。
- **插件标准更新脚本**（`6b0bfd7`）：`scripts/update-lma-core.sh`（构建→部署→热重载→验证一条龙）。

## 升级须知（部署方）

1. 部署新 dist 后需重启桥接服务。
2. 网关需部署 lma-core 插件目录至 extensions，allowlist 加 `lma-core`（可移除 `lma-steer`/`lma-go`）。
3. 要默认 ToolTrim：网关配置 `agents.defaults.compaction.provider: "lma-tooltrim"`（热生效）。
4. guangzi 从 1.5.0 升级：依赖无变化，直接替换包文件即可。

## 测试

全量 1035/1035（新增 tooltrim 模式用例、默认模式切换用例、semanticCompact 用例）。
