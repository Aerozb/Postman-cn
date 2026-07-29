# AGENT.md — Postman 汉化工具链维护指南

> 本文件是本项目对 AI 助手（Claude Code、Codex 等）的**权威说明**。任何自动化助手打开本项目都应先读本文件。
> `CLAUDE.md` 只是一个指针，内容以本文件为准。面向普通人类用户的使用说明见 `README.md`。

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
  app-12.19.6\                        ← 当前版本；resources\app.asar 是补丁目标
    resources\app.asar.original       ← 首次安装时自动备份的英文原版
  packages\                           ← 官方安装包 + RELEASES
  postman-zh-workspace\               ← 所有非官方内容都在这里
    Postman-cn\             ← 本工具链（= 本项目根）
      payload\
        zh-localize.js                ← 汉化主体：词典 + 翻译逻辑 + 收集器（唯一的"数据源"）
        zh-auth-webview-preload.js    ← 登录/授权 webview 的预加载汉化
      scripts\                        ← 见第 4 节
      docs\  汉化教程.md  维护指南.md
      AGENT.md  CLAUDE.md  README.md
      install-latest-zh.bat           ← 普通用户主入口（双击）
      restore-original.bat            ← 还原英文原版（双击）
      导出漏翻清单.bat                 ← 导出运行时收集到的漏翻（双击）
    _generated\                       ← 所有脚本产物输出到这里（可再生，可被随时删除）
```

**重要**：`_generated` 必须与 `Postman-cn` **同级**——脚本用 `scripts/../../_generated` 相对定位输出。它发生过不明删除（疑似系统清理软件），里面全是可再生产物，词典本体在 `payload/zh-localize.js`，不受影响。若装了清理工具，建议把 `Desktop\Postman` 加白名单。

---

## 3. 环境要求

- Windows 10/11，Postman Desktop 12.x
- Node.js 18+（脚本用 `npx --yes @electron/asar` 解包/打包；CDP 相关脚本用 Node 内置 `WebSocket`/`fetch`，需 Node 18+）
- PowerShell 5+

---

## 4. 脚本清单（scripts/）

### 安装 / 还原（PowerShell）
| 脚本 | 作用 |
|---|---|
| `install-postman-zh.ps1` | **核心安装脚本**。解包 → 注入 preload/汉化/菜单包装/外链引号修复/禁更新 → 打包 → 覆盖 app.asar → 可选验证。所有 `.bat` 和其他 ps1 都最终调它。 |
| `install-and-freeze-postman-zh.ps1` | 便捷入口，等价 `install-postman-zh.ps1 -DisableUpdates -Verify` |
| `restore-postman-original.ps1` | 便捷入口，等价 `install-postman-zh.ps1 -RestoreOriginal` |
| `fix-browser-url-handler.ps1` | 单独修复系统 URL 协议处理器 `--single-argument "%1"` 引号问题 |
| `kill-postman.ps1` | **彻底杀掉 Postman**。循环杀最多 10 轮（处理守护进程互相拉起），清零返回 exit 0。重装/验证前先跑它。已 10 次压力测试稳定清零。 |
| `start-postman.ps1` | **启动 Postman 并等页面级调试端口就绪**，打印当前真实端口。因 `--remote-debugging-port=0` 每次重启端口随机变，连 CDP 前务必用它拿当前端口，勿用旧值。 |

`install-postman-zh.ps1` 关键参数：
```
-PostmanDir <path>     指定 app-* 目录（不传则自动发现）
-Latest                按 app-x.y.z 版本号选最新目录（忽略正在运行的旧版）
-DisableUpdates        注入"禁止自动更新"补丁（见第 6 节）
-FixBrowserUrlHandler  修复浏览器 URL 引号
-CleanOldVersions      打补丁成功后删除旧 app-* 目录、旧 nupkg、裁剪 RELEASES
-Verify                安装后启动 Postman 并跑 verify-postman-zh.js
-NoRestart             安装后不重启
-RestoreOriginal       还原 app.asar.original
-PayloadPath <path>    指定 zh-localize.js（通常不用）
```

### 汉化维护（Node）—— 日常最常用
| 脚本 | 作用 |
|---|---|
| `extract-ui-strings.js --disk` | **静态全量扫描**。从 `%APPDATA%\Postman\Partitions` 磁盘缓存解压所有 JS bundle，抽取 UI 属性键后的字符串，逐条过 `translate()`，未翻译候选按频率排序输出到 `_generated/zh-static-candidates.json`。**这是发现漏翻的主力**，不需要打开界面。 |
| `merge-translations.js` | 把 `_generated/trans-*.json` 的译文合并进 `zh-localize.js` 的 `EXACT` 词典头部（重复键后者被覆盖，故已有人工词条自动优先）。合并后自检 JS 语法。 |
| `collect-zh-misses.js` | **运行时漏翻导出**。连正在运行的 Postman（CDP），调 `window.__POSTMAN_ZH_LOCALIZER__.getMisses()` 取出你使用过程中攒的漏翻，写 `_generated/zh-misses.json`。加 `--clear` 清空收集器。 |
| `verify-postman-zh.js` | 安装验证。检查注入是否成功、菜单/外链/禁更新补丁是否就位、残留英文等。`-Verify` 会自动调它。 |
| `probe-update-page.js` | 打开"设置 > 更新"页并读文本，验证更新页是否正常 + 汉化。 |

### 审计（Node，走 CDP，需 Postman 带 `--remote-debugging-port=0` 启动）
`audit-postman-*.js` 系列、`scan-postman-clickables.js`：通过 CDP 模拟点击/悬停/右键遍历各页面，报告残留英文。用于定位交互后才出现的漏翻。`-Verify` 安装会自动带调试端口启动。日常优先用 `extract-ui-strings.js`（更全更快），审计脚本用于补充特定交互路径。

---

## 5. 核心维护闭环（最重要）

### A. 发现并补齐漏翻（治本，批量）
```powershell
# 1. 静态扫描出未翻译候选（覆盖全部界面，含没打开过的）
node scripts/extract-ui-strings.js --disk
#    → _generated/zh-static-candidates.json（按出现频率排序）

# 2. 从候选里筛出"该翻的"，翻译成 _generated/trans-*.json
#    格式：{ "English source": "中文译文", ... }
#    大批量时可派并行子代理各翻一段（见第 7 节的跳过规则）

# 3. 合并进词典
node scripts/merge-translations.js

# 4. 重装 + 验证
powershell -ExecutionPolicy Bypass -File scripts/install-postman-zh.ps1 -Latest -DisableUpdates -Verify
```

### B. 兜底：运行时收集用户实际遇到的漏翻
```powershell
node scripts/collect-zh-misses.js          # 导出 _generated/zh-misses.json
node scripts/collect-zh-misses.js --clear  # 清空，重新开始攒
```
用户正常使用 Postman，界面上凡是翻译器没命中的英文会自动记进 localStorage。适合捕获服务端新下发的动态文案。

### C. 手工补单条词条
直接编辑 `payload/zh-localize.js`（见第 7 节词典结构），重装即可。**不要**直接改 `app.asar.unpacked.zh`——每次安装都会从 `app.asar.original` 重新解包覆盖。

### D. 冒烟测试单条译文（不重装）
连 CDP 后插入一个隐藏 div 写入英文，等约 1.2s 让 MutationObserver 处理，再读回它的文本看是否变中文。比重装快。

---

## 6. 关键规则与陷阱（改代码前必读）

1. **动词兜底规则不能退化成无条件 `$1`**。`RULES` 里 `Add/Delete/Create/...` 这类规则必须"递归翻译剩余部分，翻不出中文则整句保留英文"。若改回无条件 `"添加 $1"` 会重现 `添加 a new comment` 式半截混合文本。

2. **`data-placeholder` 必须在 `ATTRS` 列表里**。评论框等富文本编辑器用它渲染占位符，漏了评论面板占位符就不翻译。

3. **禁更新补丁策略**：`-DisableUpdates` **不要**改 `isUpdateEnabled`（会让"设置>更新"页报"出现了一些问题"连接错误）。正确做法是只把 `downloadUpdate` 补丁成直接回报 `updateNotAvailable`→ 更新页正常显示"已是最新版本"，且不会自动更新覆盖汉化。补丁用版本无关的锚点，找不到足够锚点时应报错而非假装成功。

4. **菜单汉化用全局 `Menu.buildFromTemplate` 包装器**（prepend 到 `main.js`），不依赖压缩后的变量名锚点，跨版本稳定。若要加原生菜单词条，改这个包装器里的词典，且**只能用 `\u` 转义**中文，避免打包后 `main.js` 编码问题。

5. **词典重复键**：`EXACT` 是 JS 对象字面量，重复键后者覆盖前者。`merge-translations.js` 把机器批量词条插到**头部**，所以文件靠后的人工词条自动优先。

6. **收集/扫描盲区**：已覆盖文本节点、全部翻译属性、shadow DOM、`document.title`、原生菜单、auth webview、同源 iframe。**无法覆盖**：跨域 iframe（浏览器安全边界）、canvas 绘制文本。字符串长度上限 600 字符（曾是 200，导致超长悬浮提示两条管线都收集不到，已修）。

7. **审计脚本的交互**：设置对话框要用 CDP **真实键盘事件**（齿轮点击后 `ArrowDown`+`Enter`），合成 click 对某些菜单无效。

8. **词典误报**：`基础基于角色的访问控制 (RBAC)` 这类"中文里含英文缩写"的会被审计误报为残留英文，可忽略。

9. **哪些刻意保留英文**（翻译时应跳过）：HTTP 状态短语（`404 Not Found`）、HTTP 请求头名、产品/品牌名（HashiCorp Vault、New Relic）、模型名（GPT-4o）、Flow 查询语言关键字、JSON Schema 元模式、CSS/字体/protobuf 技术参考文档、示例 API 数据（Streetlights、spacecraft）、代码标识符、快捷键（`Ctrl+K`）、`API`/`Git`/`Postman`/`HTTP`/`JSON` 等技术词。

10. **隐形字符陷阱（2026-07-22 定位，改词条前必读）**：`EXACT` 是整串精确匹配，页面渲染的文本里有两类"看不见的字符差异"会让匹配悄悄失败、整句翻不出：
    - **弯撇号 U+2019（`’`）vs ASCII 直撇号 U+0027（`'`）**：Postman 界面里 `don't`/`isn't`/`it's`/`you'd` 的撇号是**弯撇号**。若词条键用直撇号，`translate()` 匹配失败。
    - **不间断空格 U+00A0（`&nbsp;`）vs 普通空格 U+0020**：**带链接样式的行内文字**（如 `creating a variable`、`sharing and persisting variables`）单词间的空格是 `&nbsp;`。若词条键用普通空格，匹配失败。
    - **修复**：凡含撇号或属于"链接文字"的英文键，除标准版本外**必须再补一份弯撇号/`&nbsp;` 变体**（值相同）。用 `_generated/gen-curly-variants.js`、`gen-nbsp-variants.js` 批量生成。
    - **排查手法**：用 CDP 取页面该文本的 `charCodeAt` 逐字符码位确认（`8217`=弯撇号，`160`=`&nbsp;`），再对比词条键。

11. **合并后必须用 grep 验证持久化，不能只信 `merged N` 输出（2026-07-22）**：`merge-translations.js` 与早期校验脚本用同一套 `"(...)":"(...)"` 正则提取键，对含撇号/特殊字符的键处理不一致——合并会报 `merged N`、校验也自证"已入库"，但那几条可能没真正写进 `payload` 或形态不对。**合并后一律用命令行 `grep` 直接查中文译文片段确认写入**（`grep` 走权威字面匹配，且**必须带正确的 payload 路径**）。**不要**用 `node -e` 内联脚本查——撇号形态在 bash→node 传参时会漂移，产生假阴性；`node` 脚本一律写成 `.js` 文件再跑。

12. **CDP 调试端口每次重启都会变，必须每次重读端口文件（2026-07-22，反复踩坑）**：Postman 用 `--remote-debugging-port=0` 启动，`0`=系统随机分配端口，**每次重启（进程真正退出再拉起）都换一个新端口**，写进 `%APPDATA%\Postman\DevToolsActivePort` 文件第一行。Postman 不重启则端口不变。**任何要连 CDP 的脚本，都必须在连接前重新读端口文件当前内容取端口，绝不能用上一次记住的旧端口**——这是"重装后验证一直连不上/`ECONNREFUSED`"的根源。注意端口文件第 2 行是 `/devtools/browser/...` 路径，只取第 1 行数字。连通性用 `http://127.0.0.1:<port>/json/version` 探活，再 `/json/list` 找 `desktop.postman.com` 主页面（不是 `about:blank` 等 helper frame）。

13. **杀 Postman 要用 PowerShell 循环杀到清零，`taskkill` 杀不干净（2026-07-22）**：Postman 有守护/子进程会互相拉起，`taskkill /F /IM Postman.exe` 单次执行后常残留 5 个进程（PID 还在变）。可靠做法：PowerShell 里 `while (Get-Process Postman -EA SilentlyContinue) { Stop-Process -Name Postman -Force -EA SilentlyContinue; Start-Sleep 1 }` 循环杀到 `Get-Process` 返回空为止（通常 2 轮压制住）。重装前务必确认进程清零，否则 `app.asar` 被占用锁定、写入失败。

---

## 7. `payload/zh-localize.js` 词典结构

单文件，运行时 IIFE。主要数据结构：
- `EXACT` — 完整文案精确匹配（最常用）。`{ "English": "中文" }`
- `PHRASES` — 可组合的子串替换片段
- `RULES` — 带变量（数字/时间/名称）的正则规则，`[/正则/, "替换" 或 函数]`
- `EDITABLE_EXACT` — 输入框真实 value（如 `New Environment`）
- `ATTRS` — 需要翻译的元素属性名列表（含 `data-placeholder`）
- 运行时收集器 `recordMiss` + `getMisses()`（对外挂在 `window.__POSTMAN_ZH_LOCALIZER__`）

补词条决策：固定完整句 → `EXACT`；可复用片段 → `PHRASES`；含变量 → `RULES`；输入框默认值 → 同时看 `EDITABLE_EXACT`；原生菜单 → 改 `install-postman-zh.ps1` 里的菜单包装器词典。

---

## 8. Postman 升级到新版本的完整流程

1. 查最新版：`https://dl.pstmn.io/update/status?currentVersion=<当前版本>&arch=64&platform=win`
2. 下载 full nupkg 到 `packages/`，校验 SHA1 与 feed 一致
3. 解压 nupkg 的 `lib/net45` 为 `app-<新版本>`
4. 在 `packages/RELEASES` 追加新版本行
5. 双击 `install-latest-zh.bat`（`-Latest -DisableUpdates -FixBrowserUrlHandler -CleanOldVersions -Verify`）——打补丁成功后自动删除旧 `app-*`、旧 nupkg，只保留当前版本
6. 跑一遍 `extract-ui-strings.js --disk` 扫新版新增文案，走第 5A 节闭环补齐

看到 `[postman-zh] VERIFY PASSED` 即成功。

---

## 9. 发布前自检

```powershell
node -c payload/zh-localize.js
node -c payload/zh-auth-webview-preload.js
node -c scripts/verify-postman-zh.js
node -c scripts/extract-ui-strings.js
node -c scripts/merge-translations.js
node -c scripts/collect-zh-misses.js
powershell -NoProfile -ExecutionPolicy Bypass -Command "[scriptblock]::Create((Get-Content -Raw scripts/install-postman-zh.ps1)) | Out-Null; 'PS_PARSE_OK'"
```

不要提交任何 `app.asar` / `app.asar.original` / `app.asar.unpacked.zh` / 截图 / `_generated` 产物 / 用户数据。
