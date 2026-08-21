---
name: postman-zh-deep-audit
description: 审计并修复本仓库的 Postman 中文汉化。用于检查实际桌面界面的 DOM 文案、属性、菜单、弹窗和授权 webview，选择受控 CDP 审计，维护 payload/zh-localize.js 或 app.asar 注入逻辑，并完成安装验证；不用于普通 Postman API 调试或其他仓库的翻译任务。
---

# Postman 深度汉化审计

## 开始前

1. 在项目根目录工作，并完整阅读 `AGENTS.md`。
2. 确认权威汉化主体只有 `payload/zh-localize.js`，不要维护第二份 payload。
3. 只通过根目录 `postman-zh.bat` 调用安装、启动、验证和审计能力；普通用户走中文 TUI，自动化和维护任务可向同一入口传入命令，不要绕过统一入口。
4. 将报告、截图和临时文件写入项目同级 `_generated`，不要放进项目根目录或 `scripts`；输出路径只能使用该目录下的文件名。
5. 默认输出保持简洁中文；只有显式使用 `--details` 时才打印完整诊断，禁止向普通用户输出大段 JSON 或 Postman/Electron/npm 内部日志。
6. 审计报告必须通过 `scripts/audit/审计安全.js` 的 `writeAuditReport` 写入；不要把原始 CDP 目标、URL 参数、WebSocket 地址、请求/响应正文、输入值或令牌写入 `_generated`。
7. 截图默认关闭；确需截图时显式使用 `--screenshot` 并通过 `writeAuditScreenshot` 写入。PNG 像素不会经过 JSON 脱敏，可能包含当前可见的工作区或请求内容。
8. 无参数 TUI 每次选择并完成一项任务后应直接退出；不要增加 `Read-Host`、`pause` 或其他收尾按键等待。
9. 通用审计不得点击文件、文件夹、上传、浏览或选择文件等会打开 Windows 原生文件选择器的入口。导入界面只用 `audit import` 从 Postman 页面侧审计；不选择本机文件或目录，结束前清理脚本打开的弹窗和菜单。

## 漏翻修复流程

1. 从截图、DOM、属性或审计报告中确认准确英文原文和具体界面路径。
2. 先在 `payload/zh-localize.js` 搜索现有词条和可能的半翻译变体。
3. 按 `AGENTS.md` 的词典规则修改 `EXACT`、`PHRASES`、`RULES` 或 `EDITABLE_EXACT`；登录授权页面才修改 `payload/zh-auth-webview-preload.js`。
4. 对含弯撇号、非断行空格或先前部分替换的文本补齐真实 DOM 变体。
5. 运行 `.\postman-zh.bat install`，确认安装器和验证器均成功。
6. 重走用户报告的界面路径，再运行最贴近该页面的定向审计。
7. 最后运行轻量广扫，确认没有真实英文短语残留。

## 审计选择

- 快速巡检：`.\postman-zh.bat audit lightweight`
- 新建请求：`.\postman-zh.bat audit new-request`
- 新建集合：`.\postman-zh.bat audit new-collection`
- 导入界面：`.\postman-zh.bat audit import`
- 导航与设置：`.\postman-zh.bat audit navigation`
- 深层界面：`.\postman-zh.bat audit deep-areas`
- 易漏交互面：`.\postman-zh.bat audit targeted-surfaces`
- 入口弹窗：`.\postman-zh.bat audit entry-modals`
- 分阶段审计：`.\postman-zh.bat audit phased`
- 固定区域：`.\postman-zh.bat audit targeted`
- 全部调试目标：`.\postman-zh.bat audit all-targets`

TUI 使用默认受控档。只有 `new-request`、`navigation`、`deep-areas`、`entry-modals`、`phased`、`targeted`、`targeted-surfaces` 和 `all-targets` 支持 `--thorough`；仅在发布前确需扩大覆盖时使用。

- `new-request` 没有总审计时限参数；默认仍遍历当前请求类型的全部标签页，但降低交互次数并跳过响应历史。
- 其余高级审计有总时间、DOM/AX、候选和动作上限。`entry-modals` 的时间参数是 `--budget-ms`，其他脚本使用 `--audit-budget-ms`。
- `entry-modals` 默认跳过重量级全局搜索；`phased` 要逐个审计所有已打开请求标签时必须另加 `--all-tabs`。
- 达到预算会保存部分报告并返回退出码 `2`。不要把部分报告当成完整覆盖；精确时限和内部中文脚本名见 `scripts/README.md`。

需要 Postman 运行时，先执行 `.\postman-zh.bat start`，不要复用上一次的 CDP 端口。查看全部命令和中文说明时执行 `.\postman-zh.bat help`。

## 判定规则

- 完整英文短语、混合未翻译片段、输入框占位符、菜单项和悬浮提示属于问题。
- `API`、`URL`、`HTTP`、`JSON`、`OAuth`、`GraphQL`、`gRPC`、`Cookie`、`SDK`、`Git`、HTTP 方法、品牌名、代码和快捷键等技术标识可保留。
- 不要为了清零计数而翻译示例数据、协议字段、模型名或产品名。
- 避免点击删除、发送、发布、退出登录等破坏性操作；仅展开、悬浮、滚动或打开可安全关闭的菜单和弹窗。

## 完成条件

- 用户指出的文本已在实际界面显示为中文。
- 对应定向审计已完整结束，候选已人工复核，没有真实英文残留；退出码 `2` 的部分报告不算完成。
- `.\postman-zh.bat verify` 显示“验证通过”。
- `.\postman-zh.bat install` 完整成功，且安装后的 `app.asar` 哈希验证通过。
- 所有改过的 JavaScript 和 PowerShell 脚本通过语法检查。
- `git diff --check` 通过，且没有把 `_generated`、`app.asar`、截图或用户数据加入 Git。
