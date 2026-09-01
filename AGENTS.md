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
  app-12.25.7\                        ← 当前版本；resources\app.asar 是补丁目标
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
      .agents\skills\                ← skill 正文（`.agents/skills/` 是 Codex 的约定位置）
      .claude\skills\                ← 同名薄指针，只为让 Claude Code 也能发现该 skill；
                                        正文不复制，改 description 时两处要同步
      docs\                           ← 汉化教程、维护指南，以及第 8 节索引里的三份正文
      AGENTS.md  CLAUDE.md  README.md
      postman-zh.bat                  ← 普通用户唯一入口（双击）
    _generated\                       ← 审计、扫描和翻译临时产物（可再生，可被随时删除）
    _release\                         ← `publish` 生成的正式发布包（跑过 publish 才出现）
```

**重要**：`_generated` 必须与 `Postman-cn` **同级**，所有扫描产物默认写在那里，且入口会拒绝把报告写到项目外。它里面全是可再生产物，词典本体在 `payload/zh-localize.js`，不受影响。若装了清理工具，建议把 `Desktop\Postman` 加白名单。

---

## 3. 环境要求

- Windows 10/11，Postman Desktop 12.x
- Node.js 22+（脚本用 `npx --yes @electron/asar` 解包/打包；CDP 相关脚本使用 Node 内置 `WebSocket` 和 `fetch`）
- PowerShell 5+

---

## 4. 脚本清单（统一入口）

唯一入口是根目录 `postman-zh.bat`：普通用户双击走中文 TUI，维护者和自动化把子命令传给同一个入口，不要直接调内部脚本。

```powershell
.\postman-zh.bat help
.\postman-zh.bat install
.\postman-zh.bat restore
```

**菜单序号与命令的对应、内部 PowerShell / Node 脚本清单、`install` 的常用参数、审计名与各档位秒数上限，全部以 [`scripts/README.md`](./scripts/README.md) 为准**——那是唯一副本，别在本文件里再抄。`probe` 和通用 `scan` 是维护者 CLI 命令，不放入 TUI。

改入口时的硬约束：

- 默认输出必须是简洁中文，不要打印 Postman/Electron/npm 内部日志或大段 JSON；完整诊断只在显式 `--details` 时输出。
- 收尾走 `Stop-WithCode`（打印中文结果 + 倒计时几秒自动关闭），**禁止用 `Read-Host`、`pause` 等阻塞式按键等待**——双击窗口会看起来卡死。菜单选择本身可以用 `Read-Host`。
- 实现按用途归档在 `scripts/` 下，不要在根目录再加 `.bat` 或转发用 `.ps1`。

审计脚本（Node，走 CDP，需 Postman 带 `--remote-debugging-port=0` 启动）另有三条硬约束：

- 报告必须经 `scripts/audit/审计安全.js` 的 `writeAuditReport` 写出（它裁剪本机路径、URL 查询参数、WebSocket 地址、请求/响应正文、输入值和令牌），不得直接 `JSON.stringify` 原始 CDP 数据。截图走 `writeAuditScreenshot`，默认关闭，且**不脱敏 PNG 像素**。
- 不得点击会唤起 Windows 原生文件选择器的入口（“文件”“文件夹”“上传”“浏览”“选择文件”“打开文件夹”及其英文标签）。只有 `audit import` 从 Postman 页面侧打开应用内导入弹窗，它不选本机文件，并在结束前关掉自己开的弹窗和临时菜单。
- 达到时间或扫描上限时脚本会写出部分报告并返回退出码 `2`——可供排查，但**不算完整覆盖**。TUI 不会自动加 `--thorough`。

---

## 5. 核心维护闭环（最重要）

### A. 发现并补齐漏翻（治本，批量）
```powershell
# 1. 静态扫描出未翻译候选（覆盖全部界面，含没打开过的）
.\postman-zh.bat static-scan --disk
#    → _generated/zh-static-candidates.json（按出现频率排序）

# 2. 从候选里筛出"该翻的"，翻译成 _generated/trans-*.json
#    格式：{ "English source": "中文译文", ... }
#    大批量时可派并行子代理各翻一段（该跳过什么见本节末尾和规则 9）

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

五条取材路径互补，缺一不可：

| 路径 | 覆盖 | 盲区 |
|---|---|---|
| `static-scan --disk` | 属性形式 `uiKey:"value"` | createElement children、全大写标题、单词 children |
| `collect` | 用户实际触发过的界面 | 没走到的分支 |
| createElement/JSX children 抽取 | 弹窗标题、按钮文字、表头 | 远程 bundle 里改名过的 JSX 工厂函数 |
| 官方 i18n 资源包（见规则 15，**每次都要重新拉，别用旧快照**） | 官方登记的全部界面文案，权威、带命名空间 | 未走 i18next 的老代码、canvas 文本 |
| `app.asar` 里的**本地兜底页**（`html/*.html` + 对应 `js/*.js`） | 网络/启动出问题时才出现的界面 | 只有这批页面 |

最后那条 2026-09-01 补上：`html/desktop-offline.html`（离线兜底）、`html/loader.html`（启动画面）、`html/auth/error.html`、`html/proxyAuth.html`、`html/no-scratchpad.html` 等页面打包在本地、**不随服务端更新**，而且恰好是"出问题时用户盯着看"的界面，前四条路径都覆盖不到：它们不走 i18next，HTML 里是纯文本而非属性形式，`collect` 也只有用户真撞上才记。抽取用 `npx --yes @electron/asar extract-file <asar> html/xxx.html`；文案多在配套 `js/*.js` 的 JSX `children:"…"`／`text:"…"` 位置（含 `text:cond?"A":"B"` 这种三元，正则要能吃到）。当时查出 11 条漏翻，其中 5 条是 `aria-label` 直接**泄露了未解析的 i18next 原始键**（`app-header:window_controls.close_win_tooltip`）——离线页没加载资源包所以键没被替换，把这些键本身写进 `EXACT` 即可。

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

3. **更新守卫是开关，不是墙**（正文见 [docs/更新守卫.md](./docs/更新守卫.md)，改这块前必读）：`-KeepUpdates` = 不装守卫；默认装守卫即拦截，偏好文件不存在视为关闭。装守卫时**不要**改 `isUpdateEnabled`（会让"设置>更新"页报连接错误）。找不到可确认的源码锚点时应报错，不要假装成功。更新页那个开关带 `data-postman-zh-audit-skip="true"`，**审计脚本必须跳过带这个属性的元素**，别用合成点击去点它。

4. **菜单汉化用全局 `Menu.buildFromTemplate` 包装器**（prepend 到 `main.js`），不依赖压缩后的变量名锚点，跨版本稳定。若要加原生菜单词条，改这个包装器里的词典，且**只能用 `\u` 转义**中文，避免打包后 `main.js` 编码问题。

5. **词典重复键**：`EXACT` 是 JS 对象字面量，重复键后者覆盖前者。`合并译文.js` 把机器批量词条插到**头部**，所以文件靠后的人工词条自动优先。

6. **收集/扫描边界**：运行时翻译器已覆盖文本节点、全部翻译属性、shadow DOM、`document.title`、原生菜单、auth webview、同源 iframe。它仍不能直接进入任意跨域 iframe，也不能翻译 canvas 绘制文本；`audit all-targets` 可以通过 CDP 单独审计可附加的跨域/OOPIF 目标，但这不等于运行时翻译器能向其中注入译文。

   两条管线的字符串长度上限**不一样**，排查"某条超长文案两边都收集不到"时要分别看：静态扫描是 600 字符（`scripts/data/提取界面文案.js` 里的 `text.length > 600`，另有"不超过 90 个词"的限制），运行时收集器是 1200 字符（`payload/zh-localize.js` 的 `shouldRecordMiss`，另有最多攒 2000 条的上限）。两者都曾经是 200，导致超长悬浮提示两条管线都收集不到，已分别放宽。

7. **审计脚本的交互**：设置对话框要用 CDP **真实键盘事件**（齿轮点击后 `ArrowDown`+`Enter`），合成 click 对某些菜单无效。

8. **词典误报**：`基础版基于角色的访问控制（RBAC）` 这类"中文里含英文缩写"的会被审计误报为残留英文，可忽略。

9. **哪些刻意保留英文**（翻译时应跳过）：HTTP 状态短语（`404 Not Found`）、HTTP 请求头名、产品/品牌名（HashiCorp Vault、New Relic）、模型名（GPT-4o）、Flow 查询语言关键字、JSON Schema 元模式、CSS/字体/protobuf 技术参考文档、示例 API 数据（Streetlights、spacecraft）、代码标识符、快捷键（`Ctrl+K`）、`API`/`Git`/`Postman`/`HTTP`/`JSON` 等技术词。

10. **隐形字符陷阱（2026-07-22 定位，改词条前必读）**：`EXACT` 是整串精确匹配，页面渲染的文本里有两类"看不见的字符差异"会让匹配悄悄失败、整句翻不出：
    - **弯撇号 U+2019（`’`）vs ASCII 直撇号 U+0027（`'`）**：Postman 界面里 `don't`/`isn't`/`it's`/`you'd` 的撇号是**弯撇号**。若词条键用直撇号，`translate()` 匹配失败。
    - **不间断空格 U+00A0（`&nbsp;`）vs 普通空格 U+0020**：**带链接样式的行内文字**（如 `creating a variable`、`sharing and persisting variables`）单词间的空格是 `&nbsp;`。若词条键用普通空格，匹配失败。
    - **修复**：凡含撇号或属于"链接文字"的英文键，除标准版本外**必须再补一份弯撇号/`&nbsp;` 变体**（值相同）。少量词条直接写入译文 JSON；批量处理时可在 `_generated` 中编写一次性辅助脚本，但不要把临时脚本当作项目固定入口。
    - **排查手法**：用 CDP 取页面该文本的 `charCodeAt` 逐字符码位确认（`8217`=弯撇号，`160`=`&nbsp;`），再对比词条键。

11. **合并后必须用 `rg` 验证持久化，不能只信合并数量**：`合并译文.js` 与早期校验脚本对含撇号或特殊字符的键可能处理不一致。合并后应直接执行 `rg -F "中文译文片段" payload/zh-localize.js`，确认词条确实写入权威 payload。不要用 `node -e` 内联脚本检查含特殊字符的词条。**"合并 N 条"只说明脚本认为有 N 条可合，不等于 N 条都生效**——还要用沙箱 `translate()` 逐条回读（2026-09-01 就是这样查出下面那条边界 bug 的）。

    `合并译文.js` 判断"键是否已在 `EXACT`"时，**切片只能取 `EXACT` 这一个对象**（按括号深度扫到配对的 `}`，扫描时跳过字符串里的括号）。曾经是从 `var EXACT = {` 一路切到文件末尾，于是 `EDITABLE_EXACT`、`MENU_ITEM_EXACT`、`I18N_TERMS` 和函数内对象字面量的键（多算 2515 个）全被当成"已在 EXACT"，新词条被静默跳过。`I18N_TERMS` 是给生成规则做术语递归的表，语义和界面词条本就不同（`"group": "组"` 是术语，界面标签该是"群组"），**撞名属正常，不该互相屏蔽**。

12. **CDP 调试端口每次重启都会变，必须每次重读端口文件（2026-07-22，反复踩坑）**：Postman 用 `--remote-debugging-port=0` 启动，`0`=系统随机分配端口，**每次重启（进程真正退出再拉起）都换一个新端口**，写进 `%APPDATA%\Postman\DevToolsActivePort` 文件第一行。Postman 不重启则端口不变。**任何要连 CDP 的脚本，都必须在连接前重新读端口文件当前内容取端口，绝不能用上一次记住的旧端口**——这是"重装后验证一直连不上/`ECONNREFUSED`"的根源。注意端口文件第 2 行是 `/devtools/browser/...` 路径，只取第 1 行数字。拿到端口后用 `http://127.0.0.1:<port>/json/list` 取目标，找 `desktop.postman.com` 主页面（不是 `about:blank` 等 helper frame）。

13. **杀 Postman 用 `.\postman-zh.bat stop`，别用 `taskkill`（2026-07-22）**：Postman 有守护/子进程会互相拉起，`taskkill /F /IM Postman.exe` 单次执行后常残留 5 个进程（PID 还在变）。`scripts/internal/关闭程序.ps1` 的做法是最多 20 轮、每轮 `Stop-Process` 后等 500ms，且要**连续 3 次**确认进程为零才算成功。重装前务必确认清零，否则 `app.asar` 被占用锁定、写入失败。

14. **半截翻译闸门 `looksHalfTranslated`（2026-08-24 加入，改 PHRASES 前必读）**：`PHRASES` 是**子串**替换。一句话没进 `EXACT`、但句中某个词命中 `PHRASES` 时，会产出 `Validate 请求 correctness and test results` 这种中英混杂的半截文本——比纯英文更难看，且用户一眼就能发现。

    `translate()` 末尾的闸门负责兜底：短语替换结果里若还残留**英文虚词/高频动词**（`the`/`of`/`while`/`are`…，见 `HALF_TRANSLATION_STOPWORDS`），或残留**全小写的普通英文词**（≥3 字母，且不在 `TECHNICAL_WORDS` 里），就判定为半截，**整句退回英文**。这与规则 1 对 `RULES` 的原则一致：翻不干净就别翻。退回后运行时收集器会把它记成漏翻，正好进入第 5 节的补词条闭环。

    判定前会先用 `stripCodeSpans()` 剔除代码上下文（反引号/中英文引号里的字面量、点号标识符、camelCase、`:required`、`/path`、含数字 token、`foo(`），否则 `未通过 i18next.use 添加后端`、`可以是 'user'、'group' 或 'team'` 这类正常译文会被误判。**新增技术词请加进 `TECHNICAL_WORDS`，不要放宽闸门**。

    注意：闸门只管 `PHRASES` 兜底那条路径。走 `EXACT`/`RULES` 的结果是手工写的，视为可信、不过闸门——所以**手工词条本身写成半截也不会被拦**，改词条时要自己看清楚（本轮就修了一条 `The :local-link CSS 伪类…` 开头残留 `The` 的）。

    排查手法见第 5 节 E。

15. **官方 i18n 清单是第四条取材路径，写词条有三个静默失效陷阱**（正文见 [docs/官方i18n清单与生成规则.md](./docs/官方i18n清单与生成规则.md)，升级新版、批量补词条、改 `RULES` 生成规则区前必读）：官方 `en-US` 资源包是最权威的取材路径，但 URL 带内容哈希，**每次都要重新抓，不能用 `_generated` 里的旧快照**（12.24→12.25.7 新增 348 条）。三个让词条静默失效的坑：键必须是 `normalize()` 后的形态（首尾空白去掉、连续空白压成一个空格），`合并译文.js` 现在会在入口自动归一并报告归一条数，但**手改 payload 时仍要自己守**（2026-09-01 在 `EXACT` 里查出 34 条这样的死词条）；`合并译文.js` 会静默丢弃不含中文的译文；含 `{count}` 这类插值的文案原串永不出现在 DOM 里，**不能进 `EXACT`**，必须写 `RULES`。

---

## 7. `payload/zh-localize.js` 词典结构

单文件，运行时 IIFE。主要数据结构：
- `EXACT` — 完整文案精确匹配（最常用）。对象，`{ "English": "中文" }`
- `PHRASES` — 数组，可组合的子串替换片段
- `RULES` — 数组，带变量（数字/时间/名称）的正则规则，`[/正则/, "替换" 或 函数]`；数组顺序即优先级，首个命中即返回
- `EDITABLE_EXACT` — 输入框真实 value（如 `New Environment`）
- `MENU_ITEM_EXACT` — **页面内**菜单项（`[role='menuitem']` 里的文字）专用精确词典，只在该祖先存在时生效
- `ATTRS` — 需要翻译的元素属性名列表（含 `data-placeholder`）
- `I18N_TERMS` + `i18nTerm()` — 供生成规则递归翻译实体名/类型名用（见规则 15）

对外只挂这五个方法在 `window.__POSTMAN_ZH_LOCALIZER__` 上：`run`、`translate`、`walk`、`getMisses`、`clearMisses`。其中 **`translate` 是最重要的测试钩子**——所有沙箱脚本和 `_generated/regress-i18n.js` 都靠它在 Node 里离线跑整条翻译链路，不用重装。收集器的写入端 `recordMiss` 是内部函数，不对外暴露。

补词条决策：固定完整句 → `EXACT`；可复用片段 → `PHRASES`；含变量 → `RULES`；输入框默认值 → 同时看 `EDITABLE_EXACT`；**页面内**右键/下拉菜单项 → `MENU_ITEM_EXACT`；**原生** Electron 菜单（应用顶栏、托盘）→ 改 `scripts/internal/安装汉化.ps1` 里的 `Menu.buildFromTemplate` 包装器词典。

---

## 8. 更长的内容在哪（按任务查，动手前先读对应文件）

本文件只留「一句话说完、违反就直接出 bug」的规则。成段的操作步骤都在下面这些文件里，**做对应的事之前必须先完整读完**：

| 你要做的事 | 先读 |
|---|---|
| 升级 Postman 到新版本 / 发布 / 提交 | [docs/升级与发布.md](./docs/升级与发布.md) |
| 抓官方 i18n 清单、批量补词条、改 `RULES` 生成规则区 | [docs/官方i18n清单与生成规则.md](./docs/官方i18n清单与生成规则.md) |
| 改自动更新拦截、更新页开关 | [docs/更新守卫.md](./docs/更新守卫.md) |
| 改统一入口 / 菜单 / 加子命令 / 查审计档位和秒数 | [scripts/README.md](./scripts/README.md) |

**本文件必须保持在 32 KiB 以内**：Codex 默认只读 `AGENTS.md` 的前 32 KiB（`project_doc_max_bytes`），超出部分静默截断、不报错，而 Claude Code 那边是全文——两个助手看到的规则会不一致。新增长篇内容一律放 `docs/` 并在此加一行；指针写成普通 Markdown 链接，**不要写成 `@docs/...`**（那是 Claude Code 的导入语法，会让 Claude Code 内联全文而 Codex 只看到一行字面量，等于重新制造不一致）。`publish` 的预检会检查这个大小。
