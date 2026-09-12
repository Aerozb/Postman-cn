# AGENTS.md — Postman 汉化工具链维护指南

本文件是自动化助手的项目约定；`CLAUDE.md` 导入本文件。普通用户看 [README](./README.md)，维护流程看 [维护指南](./docs/维护指南.md)。

## 1. 项目与边界

为 Windows x64 Postman Desktop 12.x 注入运行时汉化：解包原版 `resources/app.asar`，加入 payload，再打包。保留英文备份，不改用户请求、环境变量或账号数据。

`payload/zh-localize.js` 是唯一词典数据源。官方 i18n 文件用于取材，并非直接替换 Postman 的语言包；实际界面仍由 DOM、属性和菜单等运行时接口翻译。请求编辑器从 `desktop.postman.com` 远程加载，文案会独立更新，按官方资源和用户截图反馈补齐。

## 2. 目录与产物

```text
Postman/                         官方 Squirrel 安装根目录
  app-<版本>/resources/
    app.asar                     当前汉化目标
    app.asar.original            对应版本的英文备份
  postman-zh-workspace/
    Postman-cn/                  本仓库
      payload/                   汉化主体、授权 preload、版本检查、OOPIF 注入
      scripts/统一入口.ps1        命令分发与唯一收尾
      scripts/lib/               CDP、离线汉化沙箱、诊断输出脱敏
      scripts/internal/          安装、启动、停止、进程工具
      scripts/runtime/           离线回归与共享翻译样例
      scripts/data/              译文合并、词典统计
      scripts/maintenance/       发布、项目数据、PowerShell 回归
      .agents/skills/            skill 正文
      .claude/skills/            同名薄指针
      docs/                      按主题维护的说明
      postman-zh.bat              唯一操作入口
    _generated/                  可删除、可重建的语料与临时诊断
    _release/                    发布产物
```

`_generated` 与仓库同级。诊断报告和临时脚本放这里，不加入 Git；公共输出工具只接受该目录内的文件名。不要手改安装器的解包目录，它会在下一次安装时重建。

## 3. 环境

Windows 10/11、Postman Desktop 12.x、Node.js 22+、PowerShell 5+。asar 解包/打包使用 `npx --yes @electron/asar`；CDP 使用 Node 内置 WebSocket 和 fetch。

## 4. 操作入口

固定操作从根目录 `postman-zh.bat` 调用。命令、菜单和参数的唯一清单是 [scripts/README.md](./scripts/README.md)。不要另加根目录 `.bat` 或转发 `.ps1`。

- 默认仅显示简洁中文摘要；`--details` 才输出完整诊断，页面数据先脱敏。
- 菜单模式只执行一次，最终由 `Stop-WithCode` 等用户手动按回车关闭；CLI 模式直接返回退出码，不等待、不倒计时。
- `test` 是离线回归；`verify` 检查已运行的安装实例，两者互补。改翻译或注入后执行 `install`、`verify`，并重走受影响界面。
- 没有固定的自动巡检、缓存扫词、页面探测或漏翻收集命令；按需诊断不应恢复成每轮必跑的全界面任务。
- 临时 CDP 诊断复用公共客户端，报告使用 `writeDiagnosticReport`，截图使用 `writeDiagnosticScreenshot`，均来自 `scripts/lib/诊断输出.js`。截图按需显式采集，PNG 像素不做脱敏。
- 定点检查避免发送、删除、保存用户数据，跳过原生文件选择器和更新开关；结束时清理自己创建的测试节点和临时菜单。达到诊断上限时明确标记部分结果。

## 5. 汉化维护闭环

固定流程：发现准确原文 → 补词条 → 离线回归 → 安装验证 → 重走界面。按任务选择取材，不要求每次全跑：

- **使用反馈**：按用户截图定位具体界面，必要时通过 CDP 读取准确文本、属性、空白及撇号码位，不凭截图猜原串。
- **当前官方 i18n**：批量补齐和版本升级时重新抓取，覆盖官方登记的文案。

**按需源码补查**：前两者未覆盖或升级涉及本地页面时，再检查缓存 bundle 或原版 asar。提取方法与扫描盲区见 [维护指南](./docs/维护指南.md)。

候选先经过真实 `translate()` 再人工筛选。只补完整标题、标签和句子；通用单词或半句碎片不要批量入库，组合段落交给 `fixCompositeTextBlocks`。界面上泄露的 `namespace:a.b.c` 等未解析 i18next 键也按漏翻处理。

半截翻译按反馈页面和本轮语料核对，方法见维护指南。翻译器不再自动收集或持久化漏翻；DOM 变化监听仍是实时汉化的必要部分。

## 6. 修改前必须守住的规则

1. **动词规则保守兜底**：`Add/Delete/Create/...` 递归翻译剩余部分；翻不完整时保留整句英文，别退化成无条件“添加 $1”。
2. **保留 `data-placeholder`**：它属于 `ATTRS`，富文本评论框依靠它显示占位。
3. **两个更新开关独立**：官方更新默认关闭，偏好缺失即关闭；汉化版本检查默认开启。`-KeepUpdates` 表示不装官方更新守卫，守卫不改 `isUpdateEnabled`。定点诊断跳过 `data-postman-zh-audit-skip="true"`。改动前读 [更新守卫](./docs/更新守卫.md)。
4. **原生菜单全局包装**：在 `main.js` prepend `Menu.buildFromTemplate` 包装器，不依赖压缩变量名；嵌入脚本的中文使用 `\u` 转义。
5. **词典后写优先**：初始 `EXACT` 与后续 `Object.assign(EXACT, ...)` 同属精确词典；后面的人工词条优先。批量合并仍插在初始对象头部，保持该语义。
6. **保留实际翻译路径**：同源 iframe 和 shadow DOM 由运行时遍历；OOPIF 由主进程 `webFrameMain.executeJavaScript` 注入同一 payload，详见 [跨站子帧汉化](./docs/跨站子帧汉化.md)。Canvas 2D 已挂接 fillText/strokeText/measureText；位图、WebGL 等绘制路径不在此覆盖范围。移除辅助探测不等于移除 DOM 监听、延迟重试或跨帧注入。
7. **设置菜单使用真实键盘事件**：齿轮后用 `ArrowDown`、`Enter`；合成 click 对部分菜单无效。
8. **人工复核候选**：中文里保留 RBAC、API 等技术缩写是正常译文。诊断摘要按最终脱敏后的结果计算，不把部分检查说成全部覆盖。
9. **数据区保持原样**：HTTP 状态短语、请求头、请求/响应数据、变量值、代码标识、快捷键、品牌、模型名和技术参考资料不作普通 UI 翻译。特殊修补也必须复用文本或属性的数据保护判断，别绕过主路径。
10. **按运行时归一形态入库**：`normalize()` 去零宽字符、把 NBSP 转为空格、压缩空白并 trim；无需另存 NBSP 变体。直撇号和弯撇号仍有区别，按真实文案补齐。定位时检查码位，不凭肉眼判断。
11. **共享词典读取与实际回读**：合并、统计和离线测试使用 `scripts/lib/汉化沙箱.js` 获取最终词典，别用正则或括号切片另算一套。仅 EXACT 键参与合并查重，术语表同名不应屏蔽 UI 词条。合并后用 `rg -F` 确认落盘，`merge --check` 确认幂等，并通过真实 `translate()` 回读。
12. **连接前重新读端口文件**：`--remote-debugging-port=0` 每次重启分配新端口。读取 `%APPDATA%/Postman/DevToolsActivePort` 第一行，再查询 `/json/list`；主页面匹配 `desktop.postman.com` 或本地 requester/scratchpad，不选 helper frame。CDP 传输复用公共客户端，目标选择由各工具负责。
13. **统一进程控制**：通过 `postman-zh.bat stop` 关闭；公共停止函数最多 20 轮、每轮 500ms，并连续 3 次确认进程为零。启动与安装复用端口/页面就绪轮询，别恢复固定时长等待或单次 taskkill。
14. **保留半截翻译闸门**：`looksHalfTranslated` 只管 PHRASES 兜底；先剔除代码片段，再检查普通英文残留。新增技术词放入 `TECHNICAL_WORDS`，别放宽闸门。EXACT/RULES 的手工译文仍需自行检查。
15. **官方资源每次重新取材**：URL 形态和命名空间随版本改变，以当前实际资源为准，不假定必带哈希。含插值文案按展开后的形态写 RULES；合并值必须含中文。详见 [官方 i18n 清单与生成规则](./docs/官方i18n清单与生成规则.md)。

## 7. 词典与测试接口

| 结构 | 用途 |
|---|---|
| `EXACT` | 固定完整文案 |
| `PHRASES` | 可组合子串替换，受半译闸门保护 |
| `RULES` | 含变量的正则规则，先具体后通用，首个命中生效 |
| `EDITABLE_EXACT` | 受控输入框默认值，不是任意用户 value |
| `MENU_ITEM_EXACT` | 页面内菜单项 |
| `I18N_TERMS` / `i18nTerm()` | 生成规则里的实体、类型术语 |
| `ATTRS` | 翻译属性名单 |

生产环境仅公开 `window.__POSTMAN_ZH_LOCALIZER__` 的 `run`、`translate`、`walk`。离线沙箱只在内存副本读取词典，不添加生产接口，也不启动 DOM、计时器或网络。共享回归样例是测试数据，不是第二份词典。

## 8. 按任务阅读

| 工作 | 先读 |
|---|---|
| 日常补词条、半译排查、测试 | [维护指南](./docs/维护指南.md) |
| 升级、提交、发布 | [升级与发布](./docs/升级与发布.md) |
| 官方语料、批量词条、生成 RULES | [官方 i18n 清单与生成规则](./docs/官方i18n清单与生成规则.md) |
| 更新守卫与页面开关 | [更新守卫](./docs/更新守卫.md) |
| OOPIF 注入与验证 | [跨站子帧汉化](./docs/跨站子帧汉化.md) |
| 命令、菜单、安装参数 | [脚本说明](./scripts/README.md) |

本文件保持在 **32 KiB** 内；长步骤按主题放到 docs 并留普通 Markdown 链接，避免不同助手读取范围不一致。skill 正文仅维护在 `.agents/skills`，`.claude/skills` 保留薄指针，frontmatter 同步。
