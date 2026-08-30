---
name: postman-zh-deep-audit
description: 审计并修复本仓库的 Postman 中文汉化。用于检查实际桌面界面的 DOM 文案、属性、菜单、弹窗和授权 webview，选择受控 CDP 审计，维护 payload/zh-localize.js 或 app.asar 注入逻辑，并完成安装验证；不用于普通 Postman API 调试或其他仓库的翻译任务。
---

# Postman 深度汉化审计（指针）

本文件只是让 Claude Code 也能发现这个 skill 的入口。**正文只有一份**，维护在 Codex
的约定位置，执行前先完整读取：

`.agents/skills/postman-zh-deep-audit/SKILL.md`

读完后按那份文件的步骤执行，同时遵守仓库根目录 `AGENTS.md` 的全部规则。

## 为什么要两个位置

Claude Code 只从 `.claude/skills/`（项目级）和 `~/.claude/skills/`（用户级）注册
skill；Codex 扫描的是 `.agents/skills/`（从当前目录向上直到仓库根）。两者路径不同，
所以同一个 skill 需要在两处各有一个 `SKILL.md` 才能被双方发现。

这里不用软链接：本仓库面向 Windows，`git config core.symlinks` 为 `false`，提交进去
的符号链接在 clone 时会被还原成普通文本文件，skill 目录就废了；目录联接（`mklink /J`）
则完全无法记录进 git。因此改为「薄指针 + 单一正文」：

- **重复的只有 frontmatter**（`name` 与 `description`）。改动 `.agents` 那份的
  `description` 时，记得同步这里——`name` 必须与各自的父目录同名，两处都叫
  `postman-zh-deep-audit`，本身已经一致。
- 正文、流程、清单只存在于 `.agents` 那一份，不会漂移。
