---
name: codex-gpt-widget
description: 查询大肥龙桌面挂件观测到的 Codex 订阅额度、可用重置次数、重置时间、token 消耗和 API 余额，或检查、显示该挂件。
---

优先调用随包 MCP 工具：订阅额度用 `gpt_quota`，本机用量用 `gpt_usage`，API 余额用 `gpt_balance`，运行状态用 `gpt_status`，显示挂件用 `gpt_open`。

额度百分比是本机 Codex 会话日志中的官方快照。可用重置次数单独读取官方 App Server 的 `rateLimitResetCredits.availableCount`；`refresh=true` 重新扫描日志并刷新次数。报告快照时间及过期状态；缺少额度或次数时说明不可用，不把它当作零，也不从重置详情数组长度推算次数。不能从剩余百分比换算固定的剩余 token。仅查询次数，不消费重置机会。

每轮消耗是本机已观测输入加输出 token；缓存输入、推理输出已包含在对应总数内。不同设备和没有落盘的调用不在其中，`complete=false` 表示扫描统计不完整。API 金额可能按配置价格估算，与订阅百分比区分。

工具未连接时，可在插件根目录运行 `node scripts/control.mjs quota --refresh`、`usage` 或 `status`；需要 Node 24+。挂件未启动则使用随包 `启动大肥龙.cmd`。Windows 启动器只准备本包的桌面组件，数据保存在本包 `data/`。不使用上游的安装/回滚脚本来安装此改编包。

不展示凭据或原始会话内容，不为查询额度改动 Codex 登录或模型配置。尊重用户停止、隐藏挂件的选择。说明见 [README](../../README.md)。
