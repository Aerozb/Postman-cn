---
name: postman-zh-deep-audit
description: 深度审计并修复本仓库的 Postman 中文汉化。用于补齐界面漏翻，检查占位符、下拉框、设置页、右键菜单、悬浮提示、弹窗或登录授权页，修改 payload/zh-localize.js 或 app.asar 补丁，禁用自动更新，以及验证可发布的中文版。
---

# Postman 深度汉化审计

## 开始前

1. 在项目根目录工作，并完整阅读 `AGENTS.md`。
2. 确认权威汉化主体只有 `payload/zh-localize.js`，不要维护第二份 payload。
3. 只通过根目录 `postman-zh.bat` 调用安装、启动、验证和审计能力；不要绕过统一入口。
4. 将报告、截图和临时文件写入项目同级 `_generated`，不要放进项目根目录或 `scripts`。

## 漏翻修复流程

1. 从截图、DOM、属性或审计报告中确认准确英文原文和具体界面路径。
2. 先在 `payload/zh-localize.js` 搜索现有词条和可能的半翻译变体。
3. 按 `AGENTS.md` 的词典规则修改 `EXACT`、`PHRASES`、`RULES` 或 `EDITABLE_EXACT`；登录授权页面才修改 `payload/zh-auth-webview-preload.js`。
4. 对含弯撇号、非断行空格或先前部分替换的文本补齐真实 DOM 变体。
5. 运行 `postman-zh.bat install`，确认安装器和验证器均成功。
6. 重走用户报告的界面路径，再运行最贴近该页面的定向审计。
7. 最后运行轻量广扫，确认没有真实英文短语残留。

## 审计选择

- 快速巡检：`postman-zh.bat audit lightweight`
- 新建请求：`postman-zh.bat audit new-request`
- 新建集合：`postman-zh.bat audit new-collection`
- 导入界面：`postman-zh.bat audit import`
- 导航与设置：`postman-zh.bat audit navigation`
- 深层界面：`postman-zh.bat audit deep-areas`
- 易漏交互面：`postman-zh.bat audit targeted-surfaces`
- 全部调试目标：`postman-zh.bat audit all-targets`

需要 Postman 运行时，先执行 `postman-zh.bat start`，不要复用上一次的 CDP 端口。查看全部命令和中文说明时执行 `postman-zh.bat help`。

## 判定规则

- 完整英文短语、混合未翻译片段、输入框占位符、菜单项和悬浮提示属于问题。
- `API`、`URL`、`HTTP`、`JSON`、`OAuth`、`GraphQL`、`gRPC`、`Cookie`、`SDK`、`Git`、HTTP 方法、品牌名、代码和快捷键等技术标识可保留。
- 不要为了清零计数而翻译示例数据、协议字段、模型名或产品名。
- 避免点击删除、发送、发布、退出登录等破坏性操作；仅展开、悬浮、滚动或打开可安全关闭的菜单和弹窗。

## 完成条件

- 用户指出的文本已在实际界面显示为中文。
- 对应定向审计没有真实英文残留。
- `postman-zh.bat verify` 显示“验证通过”。
- `postman-zh.bat install` 完整成功，且安装后的 `app.asar` 哈希验证通过。
- 所有改过的 JavaScript 和 PowerShell 脚本通过语法检查。
- `git diff --check` 通过，且没有把 `_generated`、`app.asar`、截图或用户数据加入 Git。
