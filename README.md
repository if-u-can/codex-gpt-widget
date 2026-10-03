# 大肥龙 Codex 额度挂件

一个跟随 Codex 桌面窗口运行的 Windows 小挂件，显示官方订阅额度或 API 余额，并在每轮对话结束后显示本轮消耗。项目基于 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 Codex 适配分支改编。

## 使用

1. 安装 Node.js 24 或更高版本。
2. 双击 `启动大肥龙.cmd`。
3. 打开 Codex，挂件会自动跟随 Codex 显示；关闭 Codex 后挂件留在后台等待。
4. 双击 `停止大肥龙.cmd` 可退出挂件。

点击大肥龙可以查看额度。官方登录显示订阅剩余百分比和重置次数；API 或中转站配置显示余额。每轮结束后会显示本轮额度变化、金额或 token 消耗。

## 自定义

在挂件菜单中可以修改：

- 随机气泡文字、字体、颜色、图片和链接；
- 额度、今日消耗和每轮结算模板；
- 角色图片、动图、按压音和结束音；
- 低余额、高用量提醒及阈值。

已经保存的自定义内容会在更新默认文案时保留。

## 查询

包内提供 Codex 查询工具：`gpt_quota`、`gpt_usage`、`gpt_balance`、`gpt_status`、`gpt_open`。

也可以在项目目录运行：

```text
node scripts/control.mjs quota --refresh
node scripts/control.mjs usage
node scripts/control.mjs status
```

## 许可和素材

代码和文档采用 [MIT License](LICENSE)。本项目保留上游作者 MeteorNOX 的版权声明。

`assets/` 中沿用的图片、动图和音频按上游项目原有条款随项目分发，不因代码采用 MIT 而重新授予素材许可。大肥龙图片来自用户提供的素材，不声明为本项目原创或 MIT 授权。第三方组件和素材来源见 [PROVENANCE.md](PROVENANCE.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 说明

项目只读取本机 Codex 配置、日志和会话记录，不修改 Codex 安装或登录文件。请不要把 `data/` 目录、账号信息、日志或个人配置提交到公开仓库。
