# Postman ZH Localizer

Postman 桌面版中文汉化补丁，当前主要面向 Windows 版 Postman 12.x。  
本项目通过解包 `resources/app.asar`、注入运行时汉化脚本、重新打包的方式实现，不修改用户数据。

> 本项目不是 Postman 官方项目。Postman 及相关商标归原权利方所有。

> 维护者 / AI 助手请先读 **[AGENT.md](./AGENT.md)**：那里有完整的维护闭环、脚本清单和陷阱说明。本 README 面向普通使用者。

## 功能

- 汉化主界面、工作区、请求编辑器、导入页、设置页、空状态、弹窗、输入框占位文字。
- 汉化标签页右键菜单、部分 Electron 原生菜单。
- 内置运行时汉化脚本（`payload/zh-localize.js`）：EXACT 词典 + 正则规则 + MutationObserver，覆盖动态渲染和同源 iframe。
- 内置漏翻自动收集：翻译未命中的英文自动记入浏览器本地存储，双击 `导出漏翻清单.bat` 即可导出清单，无需人工截图筛选。
- 提供静态全量扫描（`scripts/extract-ui-strings.js --disk`），从 Postman 磁盘缓存里枚举全部 UI 文案，主动找出漏翻。
- 自动备份原始 `app.asar` 为 `app.asar.original`。
- 支持自动检测已安装的 Postman `app-*` 目录。
- 支持 `-Latest` 按 `app-x.y.z` 版本号选择最新目录。
- 支持 `-CleanOldVersions` 打补丁成功后自动删除旧版本目录和旧安装包，根目录只保留当前版本。
- 支持自动验证汉化是否注入成功。
- 可选禁用 Postman 内置自动更新，避免更新后补丁失效（更新页仍正常显示"已是最新版本"）。
- 修复登录/授权页打开外部浏览器时 URL 被外层引号包住导致打不开的问题。
- 可选修复 Windows/VMware 默认浏览器处理器里 `--single-argument "%1"` 导致 Chrome 地址带引号的问题。
- 支持一键还原英文原版。

## 环境要求

- Windows 10/11。
- Postman Desktop 12.x。
- Node.js 18 或更高版本，脚本会通过 `npx --yes @electron/asar` 解包和打包。
- PowerShell 5 或更高版本。

检查 Node.js：

```powershell
node -v
npx -v
```

## 快速使用

普通用户推荐直接双击仓库根目录里的：

```text
install-latest-zh.bat
```

它会自动选择本机最新的 Postman `app-*` 版本目录，自动备份原版，安装汉化，禁用 Postman 自动更新，修复外部浏览器 URL 引号问题，清理旧版本目录，并在最后自动验证。看到：

```text
[postman-zh] VERIFY PASSED
```

就表示安装成功。以后 Postman 升级到新版后，重新双击一次 `install-latest-zh.bat` 即可给最新版本重新打补丁。

在 PowerShell 中进入本项目目录的上一级，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -Verify
```

脚本默认会优先使用当前正在运行的 Postman；如果没有运行，则按版本号自动查找 `%LOCALAPPDATA%\Postman\app-*` 或当前目录附近最新的 `app-*`。

只给最新版本安装，推荐加 `-Latest`：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -Latest -DisableUpdates -FixBrowserUrlHandler -Verify
```

指定版本目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -PostmanDir "$env:LOCALAPPDATA\Postman\app-12.19.6" -Verify
```

安装后照常启动 Postman 即可。

## 禁用 Postman 自动更新

推荐给普通用户使用这个入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-and-freeze-postman-zh.ps1
```

它等价于：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -DisableUpdates -Verify
```

`-DisableUpdates` 做的是可恢复补丁：

- 将 Postman 主进程里的更新开关置为关闭。
- 阻止内置 updater 下载新版本。
- 阻止已下载更新触发重启安装。
- 不删除 `Update.exe`，避免破坏 Squirrel 快捷方式或启动器。

如果以后想保留汉化但允许更新，重新运行安装脚本，不带 `-DisableUpdates`：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -Verify
```

## 还原英文原版

普通用户直接双击：

```text
restore-original.bat
```

也可以用命令还原：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\restore-postman-original.ps1
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File .\Postman-cn\scripts\install-postman-zh.ps1 -RestoreOriginal
```

## 常用参数

```text
-PostmanDir       指定 Postman app-* 目录，例如 C:\Users\xxx\AppData\Local\Postman\app-12.19.6
-Latest           忽略正在运行的旧版本，按 app-x.y.z 版本号选择最新目录
-PayloadPath      指定 zh-localize.js 路径，通常不用传
-Verify           安装后启动 Postman 并自动验证
-NoRestart        安装后不重启 Postman
-DisableUpdates   禁用 Postman 内置自动更新
-FixBrowserUrlHandler 修复 Chrome/VMware URL 协议处理器把链接带引号传给浏览器的问题
-CleanOldVersions 打补丁成功后删除旧 app-* 目录、旧 nupkg 并裁剪 RELEASES，根目录只保留当前版本
-RestoreOriginal  还原 app.asar.original
```

## 目录结构

```text
Postman-cn/
  AGENT.md                      # 维护者/AI 助手主文档（改动前必读）
  CLAUDE.md                     # 指向 AGENT.md
  README.md                     # 本文件，面向使用者
  install-latest-zh.bat         # 双击：装最新版汉化（含禁更新/清旧版/验证）
  restore-original.bat          # 双击：还原英文原版
  导出漏翻清单.bat               # 双击：导出运行时收集到的漏翻
  payload/
    zh-localize.js              # 运行时汉化脚本（词典 EXACT/PHRASES/RULES + 收集器），核心资产
    zh-auth-webview-preload.js  # 登录/授权 webview 的汉化预加载
  scripts/
    install-postman-zh.ps1      # 安装主脚本（解包→打补丁→重打包→验证）
    install-and-freeze-postman-zh.ps1  # = 安装 + -DisableUpdates
    fix-browser-url-handler.ps1
    restore-postman-original.ps1
    verify-postman-zh.js        # 安装后自动验证
    extract-ui-strings.js       # 静态全量扫描：从磁盘缓存找出所有漏翻候选
    collect-zh-misses.js        # 从运行中 Postman 导出运行时收集到的漏翻
    merge-translations.js       # 把批量译文 trans-*.json 合并进词典
    probe-update-page.js        # 验证“设置>更新”页
    audit-postman-*.js          # 各页面 CDP 巡检脚本
    scan-postman-clickables.js
  docs/
    汉化教程.md
    维护指南.md
```

> 维护者和 AI 助手请以 `AGENT.md` 为准，里面记录了架构、维护闭环、跨版本坑位和禁改项。

## 验证

安装命令加 `-Verify` 后，成功时会输出：

```text
[postman-zh] VERIFY PASSED
```

验证内容包括：

- 运行时汉化脚本是否注入。
- 主界面常见英文是否仍残留。
- 标签页右键菜单是否汉化。
- 翻译探针是否还有未覆盖字符串。
- 使用 `-DisableUpdates` 时，更新禁用补丁是否生效。
- 外部浏览器 URL 引号修复补丁是否写入主进程。

更深的点击扫描：

```powershell
node .\Postman-cn\scripts\scan-postman-clickables.js --out postman-click-scan --max-clicks 120 --delay-ms 180
```

扫描报告会输出剩余英文命中。`GET`、`POST`、`API`、`Git`、`Ctrl+K` 等技术词和快捷键会保留。

轻量工作台巡检（推荐先跑，覆盖新建、导入、设置弹窗、请求页签、顶部菜单和底部栏，速度更稳）：

```powershell
node .\Postman-cn\scripts\audit-postman-lightweight-ui.js --out postman-lightweight-ui-audit --delay-ms 500
```

报告会生成 `postman-lightweight-ui-audit.json` 和 `postman-lightweight-ui-audit.png`，`hitCount` 为 `0` 表示未发现非技术英文残留。

专门检查“新建请求”窗口的页签、下拉、右键和悬浮提示：

```powershell
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-new-request-audit --max-hover 220 --max-body-hover 90 --max-body-right-click 45 --max-right-click 140
```

它会依次检查文档、参数、授权、请求头、正文、脚本、设置、响应历史，并生成 JSON 报告和截图。正文页会逐个切换无、表单数据、x-www-form-urlencoded、原始数据、二进制、GraphQL，并检查这些模式里的悬浮提示和右键菜单。

如果全量请求审计在机器上跑得太久，推荐按模块分段跑，结果同样会落 JSON 和 PNG：

```powershell
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-request-tabs --tabs docs,params,auth,headers --skip-final-sweep --skip-response-history
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-request-body --tabs body --body-modes none,form-data,urlencoded,raw,binary,graphql --max-body-hover 14 --max-body-right-click 6 --skip-final-sweep --skip-response-history
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-request-scripts --tabs scripts --max-scripts-hover 24 --max-scripts-right-click 10 --skip-final-sweep --skip-response-history
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-request-settings --tabs settings --settings-positions 0,0.5,1 --max-settings-hover 28 --max-settings-right-click 10 --skip-final-sweep --skip-response-history
node .\Postman-cn\scripts\audit-postman-new-request.js --out postman-request-history --tabs docs --max-hover 0 --max-right-click 0 --skip-final-sweep
```

全局角落深度检查：

```powershell
node .\Postman-cn\scripts\audit-postman-deep-areas.js --out postman-deep-areas-audit --delay-ms 140 --overlay-hover 38 --overlay-right 16 --created-hover 20 --created-right 8 --settings-hover 38 --settings-right 12 --control-hover 12 --control-right 6 --new-menu-items 24 --import-items 18 --settings-tabs 14
```

它会主动打开导入弹窗、新建菜单、设置页、侧边栏、底部栏、右侧面板和流程模块库，检查可点击项、悬浮提示、右键菜单，并生成 JSON 报告和截图。

## 说明

`API`、`Git`、`Postman`、`HTTP`、`JSON`、`Ctrl+K` 这类技术词、品牌名和快捷键会保留英文。

Postman 更新后可能生成新的 `app-*` 目录。重新运行带 `-Latest` 的安装命令即可给最新版本重新打补丁。

## 是否能直接替换文件

技术上可以把已经打好补丁的 `resources\app.asar` 直接替换到别人电脑里，但只建议同一台机器或私下同版本应急使用，不建议作为公开发布物：

- `app.asar` 和 Postman 版本强绑定，例如 12.19.6 的文件不能保证适用于 12.19.5、12.18.4 或 12.12.3。
- `app.asar` 包含 Postman 官方程序代码，公开放到 GitHub 或网盘分发会有版权和再分发风险。
- Postman 自动更新后会切换到新的 `app-*` 目录，旧的直接替换文件会立刻失效。

所以给别人用的推荐产物是这个文件夹，而不是改好的 `app.asar`。别人只需要双击 `install-latest-zh.bat`，脚本会自动识别最新版本并重新生成适配当前版本的 `app.asar`。
