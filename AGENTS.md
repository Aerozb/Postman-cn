# AGENTS.md — Postman 汉化工具链维护指南

> 本文件是本项目对 AI 助手（Claude Code、Codex 等）的**权威说明**。任何自动化助手打开本项目都应先读本文件。
> `CLAUDE.md` 通过 `@AGENTS.md` 导入本文件，内容以本文件为准。面向普通人类用户的使用说明见 `README.md`。

---

## 1. 这个项目是什么

给 **Windows 版 Postman 桌面端**做中文汉化的补丁工具链。做法：解包 Postman 的 `resources/app.asar` → 注入运行时汉化脚本 `zh-localize.js` → 重新打包，不修改用户数据。

汉化是**运行时 DOM 翻译**：`zh-localize.js` 在页面里用 `MutationObserver` 监听 DOM，把英文文本节点和属性按词典替换成中文。不是改源码字符串，因此对 Postman 版本升级有较好的兼容性。

**关键事实**：Postman 的请求编辑器等界面从 `desktop.postman.com` **远程加载**，服务端会随时下发新的英文文案。因此**没有一劳永逸的 100% 覆盖**——必须周期性审计、补词条。这个工具链的核心价值就是让这个"发现漏翻 → 补词条 → 验证"的闭环尽量自动化。

---

## 2. 目录布局

```
Desktop\Postman\                     ← Postman 官方 Squirrel 安装目录（勿动其官方文件）
  Postman.exe  Update.exe
  app-12.25.5\                        ← 当前版本；resources\app.asar 是补丁目标
    resources\app.asar.original       ← 首次安装时自动备份的英文原版
  packages\                           ← 官方安装包 + RELEASES
  postman-zh-workspace\               ← 所有非官方内容都在这里
    Postman-cn\             ← 本工具链（= 本项目根）
      payload\
        zh-localize.js                ← 汉化主体：词典 + 翻译逻辑 + 收集器（唯一的"数据源"）
        zh-auth-webview-preload.js    ← 登录/授权 webview 的预加载汉化
      scripts\
        统一入口.ps1                   ← 命令分发器（唯一实现入口）
        internal\                     ← 安装、启动、停止等内部 PowerShell 实现
        audit\                        ← 点击、悬停、右键等 CDP 审计
        runtime\                      ← 运行时收集和页面探测
        data\                         ← 静态扫描和译文合并
        maintenance\                 ← 发布脚本
      .agents\skills\                ← 本项目专属 Codex skill
      docs\  汉化教程.md  维护指南.md
      AGENTS.md  CLAUDE.md  README.md
      postman-zh.bat                  ← 普通用户唯一入口（双击）
    _generated\                       ← 审计、扫描和翻译临时产物（可再生，可被随时删除）
    _release\                         ← `publish` 生成的正式发布包
```

**重要**：`_generated` 必须与 `Postman-cn` **同级**，所有扫描产物默认写在那里，且入口会拒绝把报告写到项目外。它里面全是可再生产物，词典本体在 `payload/zh-localize.js`，不受影响。若装了清理工具，建议把 `Desktop\Postman` 加白名单。

---

## 3. 环境要求

- Windows 10/11，Postman Desktop 12.x
- Node.js 22+（脚本用 `npx --yes @electron/asar` 解包/打包；CDP 相关脚本使用 Node 内置 `WebSocket` 和 `fetch`）
- PowerShell 5+

---

## 4. 脚本清单（统一入口）

普通用户只需双击根目录 `postman-zh.bat`，通过中文交互菜单选择操作，不需要手敲命令。维护者和自动化测试只使用同一个入口：

```powershell
.\postman-zh.bat help
.\postman-zh.bat install
.\postman-zh.bat restore
```

**不带命令运行（或双击 bat）会显示中文交互菜单**，主菜单为：1 安装、2 验证、3 还原、4 启动、5 关闭、6 导出漏翻、7 静态扫描、8 合并译文、9 深度审计、10 自动更新开关、11 修复浏览器链接、12 发布、`h` 帮助、`0` 退出；空回车默认安装，`q` 等同退出。选“深度审计界面”后会显示 11 项中文审计子菜单，选“自动更新开关”后显示当前状态和开/关两项，`0` 均返回主菜单。菜单只是 `统一入口.ps1` 里 `Show-Menu` 对同一批子命令的包装，带命令调用的行为完全不变。`probe` 和通用 `scan` 是维护者 CLI 命令，不放入 TUI。

菜单选择可以使用 `Read-Host`。每次选中任务后只执行一次。任务结束后走 `Stop-WithCode`：它会打印中文结果，然后**倒计时几秒**（成功 8 秒、失败 25 秒）再退出，倒计时期间按任意键立即关闭。**禁止用 `Read-Host`、`pause` 等阻塞式按键等待收尾**——那会让双击窗口看起来卡死。倒计时是 2026-08-27 加的：在那之前任务一结束窗口就消失，用户根本看不到「验证通过」，反馈是"脚本闪退了"。轮询按键用 `[Console]::KeyAvailable`，stdin 被重定向时它会抛异常，必须 try/catch 兜住（自动化调用就是这种情况）。

默认输出必须是简洁中文，不要打印 Postman/Electron/npm 内部日志或独立的大段 JSON。完整诊断只能由维护者显式传入 `--details` 后显示。

实现按用途归档在 `scripts/` 下，不要从根目录再新增 `.bat` 或转发用 `.ps1`。

### 内部 PowerShell 实现
| 脚本 | 作用 |
|---|---|
| `scripts/internal/安装汉化.ps1` | 核心安装实现，由 `postman-zh.bat install` 调用。 |
| `scripts/internal/修复浏览器链接.ps1` | 修复系统 URL 协议处理器的引号问题。 |
| `scripts/internal/关闭程序.ps1` | 循环关闭全部 Postman 进程。 |
| `scripts/internal/启动程序.ps1` | 启动 Postman 并等待当前 CDP 端口就绪。 |
| `scripts/internal/进程工具.ps1` | 让 Postman 脱离安装控制台启动并丢弃其内部日志。 |

安装命令常用参数：
```
-PostmanDir <path>     指定 app-* 目录（不传则自动发现）
-KeepUpdates           不注入禁止自动更新补丁（默认会禁用更新）
-NoVerify              安装后不运行验证
-CleanOldVersions      打补丁成功后删除旧 app-* 目录、旧 nupkg、裁剪 RELEASES
-NoRestart             安装后不重启
```

### 汉化维护（Node）
| 脚本 | 作用 |
|---|---|
| `scripts/data/提取界面文案.js` | 静态扫描实现，由 `static-scan` 调用。 |
| `scripts/data/合并译文.js` | 合并 `_generated/trans-*.json` 译文。 |
| `scripts/runtime/收集漏翻.js` | 导出运行时漏翻清单。 |
| `scripts/runtime/探测更新页面.js` | 探测更新页。 |
| `scripts/验证汉化.js` | 安装验证实现，由 `verify` 或 `install` 调用；`verify --details` 输出完整诊断。 |

### 审计（Node，走 CDP，需 Postman 带 `--remote-debugging-port=0` 启动）
`scripts/audit/` 下的脚本通过 CDP 模拟点击、悬停和右键遍历页面。使用 `postman-zh.bat audit <名称>` 调用，不要直接记内部文件名。

所有审计脚本都通过 `scripts/audit/审计安全.js` 写报告。该模块会裁剪 JSON 中的本机路径、URL 查询参数、WebSocket 地址、请求/响应正文、输入值和令牌；新增审计脚本必须调用 `writeAuditReport`，不能直接 `JSON.stringify` 原始 CDP 数据。截图默认关闭；当前只有 `probe`、`scan` 和 `lightweight`、`new-request`、`new-collection`、`import`、`navigation`、`deep-areas`、`targeted` 审计实现 `--screenshot`，并必须调用 `writeAuditScreenshot`。该函数只限制输出位置和数据格式，不会脱敏 PNG 像素，截图可能包含当前可见的工作区或请求内容。默认终端只输出中文摘要，`--details` 才输出脱敏诊断。

自动审计不得点击会唤起 Windows 原生文件选择器的入口，包括“文件”“文件夹”“上传”“浏览”“选择文件”“打开文件夹”及其英文标签。只有 `audit import` 可以从 Postman 页面侧安全入口打开应用内导入弹窗；它只检查链接、原始文本和代码仓库等页签，不选择本机文件或目录，并在结束前关闭自己打开的弹窗和临时菜单。`targeted-surfaces` 等通用审计只记录这类控件，不负责点击导入入口。

TUI 不会自动添加 `--thorough`，因此日常选择高级审计时使用的是默认受控档。当前只有以下 8 个审计名支持显式 `--thorough`：`new-request`、`navigation`、`deep-areas`、`entry-modals`、`phased`、`targeted`、`targeted-surfaces`、`all-targets`。不要给 `lightweight`、`import` 或 `new-collection` 传这个参数。

- `new-request` 默认仍遍历当前请求类型的全部标签页，但降低悬停、右键和滚动探测次数，并默认跳过响应历史；它没有总审计时限参数。`--thorough` 会提高交互上限并检查响应历史。
- 其余 7 个高级审计同时限制 DOM/AX 节点、候选、动作次数和总时间。默认/高强度总时限分别为：`navigation` 180/900 秒，`deep-areas` 90/600 秒，`entry-modals` 60/300 秒，`phased`、`targeted-surfaces`、`all-targets` 均为 90/600 秒，`targeted` 为 90/300 秒。
- `entry-modals` 单独使用 `--budget-ms` 调整时限；其余带总时限的脚本使用 `--audit-budget-ms`。`phased --thorough` 不等于遍历所有已打开请求标签，确需逐标签审计还要显式加 `--all-tabs`。
- 达到时间或扫描上限时，脚本会写入部分报告并返回退出码 `2`；这表示结果可供排查，但不能当成完整覆盖。

入口审计名、内部中文脚本名和各档位的完整对应表见 `scripts/README.md`。

---

## 5. 核心维护闭环（最重要）

### A. 发现并补齐漏翻（治本，批量）
```powershell
# 1. 静态扫描出未翻译候选（覆盖全部界面，含没打开过的）
.\postman-zh.bat static-scan --disk
#    → _generated/zh-static-candidates.json（按出现频率排序）

# 2. 从候选里筛出"该翻的"，翻译成 _generated/trans-*.json
#    格式：{ "English source": "中文译文", ... }
#    大批量时可派并行子代理各翻一段（见第 7 节的跳过规则）

# 只检查可合并数量，不修改词典
.\postman-zh.bat merge --check

# 3. 合并进词典
.\postman-zh.bat merge

# 4. 重装 + 验证
.\postman-zh.bat install
```

**`static-scan` 有一块固定盲区，别只靠它（2026-08-27 定位）**：它只抽 `uiKey:"value"` 这种**属性形式**的字符串，而 React 有大量界面文字放在 `createElement` 的**位置参数（children）**里：

```js
createElement(ModalHeader, null, "RESTART AND INSTALL UPDATE")
createElement(Button, {type:"primary"}, "Restart and Install Update")
```

这种写法属性形式一条都抽不到；更糟的是弹窗标题常是**全大写**，`static-scan` 里"必须含小写字母"的启发式还会额外排除掉它们。用户报的"重启并安装更新"弹窗就是这样连续漏了好几轮。

补法是加一条取材路径：**按 `createElement(组件, props, "文字")` 的第 3 个及以后字符串参数抽取**，另外把 JSX 自动运行时的 `children:"…"` 也一并抽（`static-scan` 虽然认 `children` 这个键，但把它归进 `WEAK_KEYS`，单个词的值会被"至少两个词"的规则丢掉，所以按钮上的单词标签会漏）。这条路径精度很高——本地 `app.asar` 抽出约 1700 条候选，噪声主要是通用单词和半句碎片。一次性脚本可写在 `_generated` 里。

四条取材路径互补，缺一不可：

| 路径 | 覆盖 | 盲区 |
|---|---|---|
| `static-scan --disk` | 属性形式 `uiKey:"value"` | createElement children、全大写标题、单词 children |
| `collect` | 用户实际触发过的界面 | 没走到的分支 |
| createElement/JSX children 抽取 | 弹窗标题、按钮文字、表头 | 远程 bundle 里改名过的 JSX 工厂函数 |
| 官方 i18n 资源包（见规则 15） | 官方登记的全部界面文案，权威、带命名空间 | 未走 i18next 的老代码、canvas 文本 |

**翻的时候只翻完整的标题/标签/句子**，通用单词（`error`/`import`/`share`）和半句碎片（`Make sure the`、`or create a collection`）一律跳过——碎片由 `fixCompositeTextBlocks` 负责整句拼装，单独翻会破坏整句结果并触发 `验证汉化.js` 的守卫（本轮返工过一次）。

### B. 兜底：运行时收集用户实际遇到的漏翻
```powershell
.\postman-zh.bat collect          # 导出 _generated/zh-misses.json
.\postman-zh.bat collect -Clear   # 清空，重新开始攒
```
用户正常使用 Postman，界面上凡是翻译器没命中的英文会自动记进 localStorage。适合捕获服务端新下发的动态文案。

### C. 手工补单条词条
直接编辑 `payload/zh-localize.js`（见第 7 节词典结构），重装即可。**不要**直接改 `app.asar.unpacked.zh`——每次安装都会从 `app.asar.original` 重新解包覆盖。

### D. 冒烟测试单条译文（不重装）
连 CDP 后插入一个隐藏 div 写入英文，等约 1.2s 让 MutationObserver 处理，再读回它的文本看是否变中文。比重装快。

### E. 排查"半截翻译"（中英混杂，比漏翻更显眼）
纯漏翻用户还能忍，`Validate 请求 correctness and test results` 这种一眼就看出来。它不属于"没翻"，所以 `static-scan` 和 `collect` 都不会报——必须单独查。见规则 14。

两条互补的查法：

1. **离线全量**：把磁盘缓存（`%APPDATA%\Postman\Partitions`，gzip/brotli 压缩）和 `app.asar.original` 里所有像界面文案的英文串抽出来，逐个过 `translate()`，输出里**同时含中文和残留英文词**的就是半截。剔除代码上下文和技术词后再判定，否则误报极多。
2. **实时页面**：走 CDP 遍历活页面的全部文本节点（含 shadow DOM）和翻译属性，挑出中英混杂的。离线抽取拿不到运行时拼装的文案（运行器的运行类型说明就是这样漏掉的），只能从活页面取。

查出来后分两类修：走 `PHRASES` 兜底的补整句 `EXACT` 词条；走 `EXACT`/`RULES` 的直接改词典里那条的值。用 `git show HEAD:payload/zh-localize.js` 和工作区版本各建一个沙箱对比 `translate()` 输出，能精确列出"因闸门而退回英文"的条目，那批就是该补译文的对象。

一次性脚本可以写在 `_generated` 里，但别当成项目固定入口。

---

## 6. 关键规则与陷阱（改代码前必读）

1. **动词兜底规则不能退化成无条件 `$1`**。`RULES` 里 `Add/Delete/Create/...` 这类规则必须"递归翻译剩余部分，翻不出中文则整句保留英文"。若改回无条件 `"添加 $1"` 会重现 `添加 a new comment` 式半截混合文本。

2. **`data-placeholder` 必须在 `ATTRS` 列表里**。评论框等富文本编辑器用它渲染占位符，漏了评论面板占位符就不翻译。

3. **更新守卫是开关，不是墙**：`-DisableUpdates` **不要**改 `isUpdateEnabled`（会让"设置>更新"页报"出现了一些问题"连接错误）。当前实现在 `main.js` 顶部装一个运行时守卫，并用版本无关锚点把 `downloadUpdate`、`restartAppToUpdate` 改写成**条件**分支；更新页仍应正常显示"已是最新版本"。找不到可确认的源码锚点时应报错，而不是假装成功。

   守卫每次更新调用都读 `%APPDATA%\Postman\postman-zh-updates.json`（缓存约 1 秒），**文件不存在即视为关闭**，所以默认行为和以前一样是拦截。允许时走 Postman 原始实现（覆盖前已 `bind` 保存）。三个入口写同一个文件：Postman「设置 > 更新」页里注入的开关（经守卫注册的 `postman-zh:updates:get/set` IPC）、`postman-zh.bat updates on|off`、TUI 菜单第 10 项。

   改这块时注意：**写偏好文件必须无 BOM**，守卫用 `JSON.parse` 读，BOM 会让解析失败并静默退回"已关闭"；`验证汉化.js` 校验的是"守卫已安装"（`updatePatch.installed`），不是"当前已拦截"——当前是否拦截由用户的开关决定，不该让 `verify` 失败。

   **开关是滑动开关，单击即切换**：页面开关做成 `role=switch` 的滑动样式（轨道 + 圆钮 + 右侧「已开启/已关闭」文字），单击直接写偏好、无需二次确认。曾经为防误触加过"点两次确认开启"，但用户觉得不方便，已改回单击（2026-08-25）。防自动化误点改为只靠按钮上的 `data-postman-zh-audit-skip="true"` 标记——**新写审计脚本必须跳过带这个属性的元素**，别再靠合成点击去点它。渲染状态只改 `data-enabled`/`aria-checked` 和 label 文字，`refreshUpdateToggle`（900ms 轮询）和初始 `updates:get` 会照常把外部（命令行）改动同步回按钮。

   **注入锚点不能只认一个**：更新页在不同状态下渲染的是完全不同的组件。`findUpdateToggleSlot()` 按三级兜底找位置——`.settings-autoupdate`（旧版“已是最新”里 Postman 自带的自动下载开关）、`.settings-update-changelog-container`（“有可用更新”的发布说明视图），都没有时再靠 `[class*="update-"][class*="__button"]`（`update-not-available__button`、`update-idle__button` 这类语义类名）确认当前在更新页，插到 `.settings-tab-contents` 里状态块之后。12.25.5 的“已是最新”状态前两个锚点**都不存在**，只有第三级能兜住；换 Postman 版本后要重新确认这三级还有效。

4. **菜单汉化用全局 `Menu.buildFromTemplate` 包装器**（prepend 到 `main.js`），不依赖压缩后的变量名锚点，跨版本稳定。若要加原生菜单词条，改这个包装器里的词典，且**只能用 `\u` 转义**中文，避免打包后 `main.js` 编码问题。

5. **词典重复键**：`EXACT` 是 JS 对象字面量，重复键后者覆盖前者。`合并译文.js` 把机器批量词条插到**头部**，所以文件靠后的人工词条自动优先。

6. **收集/扫描边界**：运行时翻译器已覆盖文本节点、全部翻译属性、shadow DOM、`document.title`、原生菜单、auth webview、同源 iframe。它仍不能直接进入任意跨域 iframe，也不能翻译 canvas 绘制文本；`audit all-targets` 可以通过 CDP 单独审计可附加的跨域/OOPIF 目标，但这不等于运行时翻译器能向其中注入译文。字符串长度上限 600 字符（曾是 200，导致超长悬浮提示两条管线都收集不到，已修）。

7. **审计脚本的交互**：设置对话框要用 CDP **真实键盘事件**（齿轮点击后 `ArrowDown`+`Enter`），合成 click 对某些菜单无效。

8. **词典误报**：`基础版基于角色的访问控制（RBAC）` 这类"中文里含英文缩写"的会被审计误报为残留英文，可忽略。

9. **哪些刻意保留英文**（翻译时应跳过）：HTTP 状态短语（`404 Not Found`）、HTTP 请求头名、产品/品牌名（HashiCorp Vault、New Relic）、模型名（GPT-4o）、Flow 查询语言关键字、JSON Schema 元模式、CSS/字体/protobuf 技术参考文档、示例 API 数据（Streetlights、spacecraft）、代码标识符、快捷键（`Ctrl+K`）、`API`/`Git`/`Postman`/`HTTP`/`JSON` 等技术词。

10. **隐形字符陷阱（2026-07-22 定位，改词条前必读）**：`EXACT` 是整串精确匹配，页面渲染的文本里有两类"看不见的字符差异"会让匹配悄悄失败、整句翻不出：
    - **弯撇号 U+2019（`’`）vs ASCII 直撇号 U+0027（`'`）**：Postman 界面里 `don't`/`isn't`/`it's`/`you'd` 的撇号是**弯撇号**。若词条键用直撇号，`translate()` 匹配失败。
    - **不间断空格 U+00A0（`&nbsp;`）vs 普通空格 U+0020**：**带链接样式的行内文字**（如 `creating a variable`、`sharing and persisting variables`）单词间的空格是 `&nbsp;`。若词条键用普通空格，匹配失败。
    - **修复**：凡含撇号或属于"链接文字"的英文键，除标准版本外**必须再补一份弯撇号/`&nbsp;` 变体**（值相同）。少量词条直接写入译文 JSON；批量处理时可在 `_generated` 中编写一次性辅助脚本，但不要把临时脚本当作项目固定入口。
    - **排查手法**：用 CDP 取页面该文本的 `charCodeAt` 逐字符码位确认（`8217`=弯撇号，`160`=`&nbsp;`），再对比词条键。

11. **合并后必须用 `rg` 验证持久化，不能只信合并数量**：`合并译文.js` 与早期校验脚本对含撇号或特殊字符的键可能处理不一致。合并后应直接执行 `rg -F "中文译文片段" payload/zh-localize.js`，确认词条确实写入权威 payload。不要用 `node -e` 内联脚本检查含特殊字符的词条。

12. **CDP 调试端口每次重启都会变，必须每次重读端口文件（2026-07-22，反复踩坑）**：Postman 用 `--remote-debugging-port=0` 启动，`0`=系统随机分配端口，**每次重启（进程真正退出再拉起）都换一个新端口**，写进 `%APPDATA%\Postman\DevToolsActivePort` 文件第一行。Postman 不重启则端口不变。**任何要连 CDP 的脚本，都必须在连接前重新读端口文件当前内容取端口，绝不能用上一次记住的旧端口**——这是"重装后验证一直连不上/`ECONNREFUSED`"的根源。注意端口文件第 2 行是 `/devtools/browser/...` 路径，只取第 1 行数字。连通性用 `http://127.0.0.1:<port>/json/version` 探活，再 `/json/list` 找 `desktop.postman.com` 主页面（不是 `about:blank` 等 helper frame）。

13. **杀 Postman 要用 PowerShell 循环杀到清零，`taskkill` 杀不干净（2026-07-22）**：Postman 有守护/子进程会互相拉起，`taskkill /F /IM Postman.exe` 单次执行后常残留 5 个进程（PID 还在变）。可靠做法：PowerShell 里 `while (Get-Process Postman -EA SilentlyContinue) { Stop-Process -Name Postman -Force -EA SilentlyContinue; Start-Sleep 1 }` 循环杀到 `Get-Process` 返回空为止（通常 2 轮压制住）。重装前务必确认进程清零，否则 `app.asar` 被占用锁定、写入失败。

14. **半截翻译闸门 `looksHalfTranslated`（2026-08-24 加入，改 PHRASES 前必读）**：`PHRASES` 是**子串**替换。一句话没进 `EXACT`、但句中某个词命中 `PHRASES` 时，会产出 `Validate 请求 correctness and test results` 这种中英混杂的半截文本——比纯英文更难看，且用户一眼就能发现。

    `translate()` 末尾的闸门负责兜底：短语替换结果里若还残留**英文虚词/高频动词**（`the`/`of`/`while`/`are`…，见 `HALF_TRANSLATION_STOPWORDS`），或残留**全小写的普通英文词**（≥3 字母，且不在 `TECHNICAL_WORDS` 里），就判定为半截，**整句退回英文**。这与规则 1 对 `RULES` 的原则一致：翻不干净就别翻。退回后运行时收集器会把它记成漏翻，正好进入第 5 节的补词条闭环。

    判定前会先用 `stripCodeSpans()` 剔除代码上下文（反引号/中英文引号里的字面量、点号标识符、camelCase、`:required`、`/path`、含数字 token、`foo(`），否则 `未通过 i18next.use 添加后端`、`可以是 'user'、'group' 或 'team'` 这类正常译文会被误判。**新增技术词请加进 `TECHNICAL_WORDS`，不要放宽闸门**。

    注意：闸门只管 `PHRASES` 兜底那条路径。走 `EXACT`/`RULES` 的结果是手工写的，视为可信、不过闸门——所以**手工词条本身写成半截也不会被拦**，改词条时要自己看清楚（本轮就修了一条 `The :local-link CSS 伪类…` 开头残留 `The` 的）。

    排查手法见第 5 节 E。

15. **官方 i18n 清单取材路径与两个写词条陷阱（2026-08-29 定位）**：Postman 自己用 i18next 做多语言，`en-US` 资源包在 `https://desktop.postman.com/_ar-assets/locales/en-US/<namespace>-<hash>.json`，URL 可从磁盘缓存里挖出来（`_generated/i18n-assets.json`）。这是第四条、也是最权威的取材路径——每一条都是官方登记为「需要翻译」的界面文案，不是启发式猜的。工具链：`_generated/fetch-i18n-en.js` 拉取，`diff-i18n.js` 对比当前词典给出覆盖率和待翻清单，`batch-i18n.js` 按命名空间/长度切批，`probe-i18n-rules.js` 单独评估含占位符那批。

    写词条时有两个坑，都会让词条**静默失效**（合并成功、`rg` 也能查到，但运行时永远命中不了）：
    - **键必须是 `normalize()` 之后的形态**。`translate()` 先 `normalize()`（去零宽字符、`&nbsp;`→空格、**连续空白压成单个空格**、`trim()`）再查 `EXACT`。所以官方原文里带首尾空格的（`"Parse Error: "`）或带换行的多段文案，键都要写成去首尾空白、换行压成空格的形式；输出的首尾空白由 `preserveOuter` 自动补回。
    - **`合并译文.js` 会拒收不含中文的译文**。像 `"SCIM API keys": "SCIM API Key"` 这种全英文的值会被静默丢弃，得给出含中文的写法（`"SCIM API 密钥"`）。

    含 `{count}` 这类单花括号插值的官方文案（约 1300 条）**不能进 `EXACT`**——运行时 DOM 里出现的是填好值的结果，原串永远不会出现，必须写 `RULES`。这批已用一条生成管线做完，工具在 `_generated`：

    | 脚本 | 作用 |
    |---|---|
    | `rules-skeletons.js` | 把官方文案的 ICU plural/select 展开成「运行时真正出现的骨架」，只留下现有词典还翻不出的；`rules-skip.json` / `rules-rejected.json` 里的骨架会跳过 |
    | `rules-compile.js` | 把「骨架 → 中文模板」编译成 `[正则, 替换]`，含四项自检（填样例必须命中、译文必须含中文、不得命中常见短串、名称插值不得过宽） |
    | `gen-rules-b*.js` | 逐批手写的翻译表，输出 `rules-b*.json` |
    | `merge-rules.js` | 用一对 `BEGIN/END` 哨兵注释整块重写 payload 里的生成规则区，幂等 |
    | `regress-i18n.js save\|diff` | 全量语料回归：改动前存快照，改动后列出「丢了中文」和「新增半截」的条目 |

    写生成规则时踩过四个坑，都由上面的自检/回归兜住了，改这块前务必理解：
    - **生成规则要插在 RULES 头部**。手写规则里有 `^Delete (.+)$`、`^Copy (.+)$` 这种通用动词兜底，排在前面会把具体规则整个吃掉。具体优先于通用。
    - **同一块内也要按具体度排序**：先比骨架里的字面量字符数，相同再让「实体名候选列表」型规则优先。否则 `^Delete (.+?)\?$` 会抢在 `^Delete (环境|集合|…)\?$` 前面，把 `Delete environment?` 只翻出半截。
    - **名称插值贴在句首最危险**：`^(名称) workspace$` 会把 `Share workspace` 变成「Share 工作区」。所以要求句首名称插值的字面量至少两个英文单词（或 ≥12 个非空白字符），句尾的至少 6 个字符；不达标的骨架直接拒收并记进 `rules-rejected.json`。
    - **实体名/类型名插值必须走 `i18nTerm()`**（payload 里新加的辅助函数 + `I18N_TERMS` 词表）。做法是把已知实体名的候选列表直接编进正则，这样输入不是实体名时规则根本不命中、会继续往后走手写兜底，而不是被吃掉后返回英文。

    每次 `merge-rules.js` 之后都要跑 `regress-i18n.js diff`，指标是「新增半截 = 0」；仍需人工判断的骨架清单见 `rules-skeletons.txt`。

---

## 7. `payload/zh-localize.js` 词典结构

单文件，运行时 IIFE。主要数据结构：
- `EXACT` — 完整文案精确匹配（最常用）。`{ "English": "中文" }`
- `PHRASES` — 可组合的子串替换片段
- `RULES` — 带变量（数字/时间/名称）的正则规则，`[/正则/, "替换" 或 函数]`
- `EDITABLE_EXACT` — 输入框真实 value（如 `New Environment`）
- `ATTRS` — 需要翻译的元素属性名列表（含 `data-placeholder`）
- 运行时收集器 `recordMiss` + `getMisses()`（对外挂在 `window.__POSTMAN_ZH_LOCALIZER__`）

补词条决策：固定完整句 → `EXACT`；可复用片段 → `PHRASES`；含变量 → `RULES`；输入框默认值 → 同时看 `EDITABLE_EXACT`；原生菜单 → 改 `scripts/internal/安装汉化.ps1` 里的菜单包装器词典。

---

## 8. Postman 升级到新版本的完整流程

1. 查最新版：`https://dl.pstmn.io/update/status?currentVersion=<当前版本>&arch=64&platform=win`
2. 下载 full nupkg 到 `packages/`，校验 SHA1 与 feed 一致
3. 解压 nupkg 的 `lib/net45` 为 `app-<新版本>`
4. 在 `packages/RELEASES` 追加新版本行
5. 运行 `.\postman-zh.bat install -CleanOldVersions`——打补丁成功后自动删除旧 `app-*`、旧 nupkg，只保留当前版本
6. 运行 `.\postman-zh.bat static-scan --disk` 扫新版新增文案，走第 5A 节闭环补齐

看到 `[Postman 汉化] 验证通过` 即成功。

---

## 9. 发布前自检

```powershell
Get-ChildItem .\payload,.\scripts -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw "JavaScript 语法错误：$($_.FullName)" } }
Get-ChildItem .\scripts -Recurse -File -Filter *.ps1 | ForEach-Object { [scriptblock]::Create((Get-Content -Raw -Encoding UTF8 $_.FullName)) | Out-Null }
.\postman-zh.bat help
.\postman-zh.bat verify
git diff --check
```

不要提交任何 `app.asar` / `app.asar.original` / `app.asar.unpacked.zh` / 截图 / `_generated` 产物 / 用户数据。
