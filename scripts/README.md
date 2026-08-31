# 脚本目录

普通用户不要直接运行这里的文件，请使用仓库根目录的 `postman-zh.bat`。

## 统一入口菜单

无参数运行或双击 `postman-zh.bat` 时，`统一入口.ps1` 显示中文 TUI。菜单输入使用 `Read-Host`；选中一项后只执行一次。任务结束后走 `Stop-WithCode`：打印中文结果，再倒计时若干秒（成功 8 秒、失败 25 秒）自动关闭双击窗口，倒计时期间按任意键可立即关闭。收尾**不使用**阻塞式按键等待。

倒计时是 2026-08-27 加的：在那之前任务一结束窗口就消失，用户看不到「验证通过」，反馈是"脚本闪退了"。轮询按键用 `[Console]::KeyAvailable`，stdin 被重定向时它会抛异常，必须 try/catch 兜住（自动化调用就是这种情况）。

| 序号 | TUI 操作 | 入口命令 |
|---:|---|---|
| `1` | 安装汉化 | `install` |
| `2` | 验证汉化状态 | `verify` |
| `3` | 还原英文原版 | `restore` |
| `4` | 启动 Postman | `start` |
| `5` | 关闭 Postman | `stop` |
| `6` | 导出运行时漏翻 | `collect` |
| `7` | 静态扫描界面文案 | `static-scan` |
| `8` | 合并译文 | `merge` |
| `9` | 深度审计界面 | `audit <名称>` |
| `10` | 自动更新开关 | `updates [on\|off]` |
| `11` | 修复浏览器链接 | `fix-browser` |
| `12` | 发布（维护者） | `publish` |
| `h` | 查看完整命令帮助 | `help` |
| `0` / `q` | 退出 | 不执行命令 |

直接回车等同于选择 `1`。深度审计子菜单输入 `0` 返回主菜单，输入 `q` 退出整个 TUI。`probe` 和通用 `scan` 保留为维护者 CLI 命令，不放入普通用户菜单。

自动更新开关默认关闭（拦截官方升级，保护汉化）。它读写 `%APPDATA%\Postman\postman-zh-updates.json`，和 Postman「设置 > 更新」页里注入的开关是同一份状态；命令行改完约 1 秒内页面开关会自动回正。

| 路径 | 用途 |
|---|---|
| `统一入口.ps1` | 显示中文 TUI、解析命令并分发到下列实现。 |
| `internal/` | 安装、还原、启动、停止和系统修复。 |
| `audit/` | CDP 点击、悬停、右键和弹窗审计。 |
| `audit/审计安全.js` | 统一裁剪审计报告中的 URL 参数、WebSocket 地址、请求/响应正文、令牌和本机路径。新增审计脚本必须复用它。 |
| `runtime/` | 运行时漏翻收集和更新页探测。 |
| `data/` | 静态文案扫描和译文合并。 |
| `maintenance/` | GitHub 发布和打包。 |
| `验证汉化.js` | 安装完成后的综合验证。 |

## 实现清单

### 内部 PowerShell 实现

| 脚本 | 作用 |
|---|---|
| `internal/安装汉化.ps1` | 核心安装实现，由 `postman-zh.bat install` 调用。 |
| `internal/修复浏览器链接.ps1` | 修复系统 URL 协议处理器的引号问题。 |
| `internal/关闭程序.ps1` | 循环关闭全部 Postman 进程。 |
| `internal/启动程序.ps1` | 启动 Postman 并等待当前 CDP 端口就绪。 |
| `internal/进程工具.ps1` | 让 Postman 脱离安装控制台启动并丢弃其内部日志。 |

`install` 的常用参数：

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
| `data/提取界面文案.js` | 静态扫描实现，由 `static-scan` 调用。 |
| `data/合并译文.js` | 合并 `_generated/trans-*.json` 译文。 |
| `runtime/收集漏翻.js` | 导出运行时漏翻清单。 |
| `runtime/探测更新页面.js` | 探测更新页。 |
| `验证汉化.js` | 安装验证实现，由 `verify` 或 `install` 调用；`verify --details` 输出完整诊断。 |

## 审计命令对应表

普通用户从 TUI 选择中文名称；维护者在命令行使用下列稳定审计名。内部脚本保持中文文件名，不应绕过统一入口直接调用。

| 序号 | TUI 名称 | 入口审计名 | 内部实现 | 默认档与 `--thorough` |
|---:|---|---|---|---|
| `1` | 轻量界面巡检 | `lightweight` | `audit/审计轻量界面.js` | 固定轻量档，不支持 `--thorough`。 |
| `2` | 新建请求界面 | `new-request` | `audit/审计新建请求.js` | 默认遍历当前请求类型的全部标签页，降低交互次数并跳过响应历史；`--thorough` 提高交互上限并检查响应历史。该脚本没有总审计时限参数。 |
| `3` | 新建集合界面 | `new-collection` | `audit/审计新建集合.js` | 固定档，不支持 `--thorough`。 |
| `4` | 导入界面 | `import` | `audit/审计导入界面.js` | 固定档，不支持 `--thorough`。 |
| `5` | 导航与设置界面 | `navigation` | `audit/审计导航界面.js` | 默认 180 秒；`--thorough` 默认 900 秒。 |
| `6` | 深层界面 | `deep-areas` | `audit/审计深层界面.js` | 默认 90 秒；`--thorough` 默认 600 秒。 |
| `7` | 容易漏翻的重点界面 | `targeted-surfaces` | `audit/审计易漏界面.js` | 默认 90 秒；`--thorough` 默认 600 秒。 |
| `8` | 入口弹窗 | `entry-modals` | `audit/审计入口弹窗.js` | 默认 60 秒，跳过重量级全局搜索和通用入口遍历；`--thorough` 默认 300 秒并扩大入口覆盖。 |
| `9` | 分阶段完整审计 | `phased` | `audit/审计分阶段流程.js` | 默认 90 秒；`--thorough` 默认 600 秒。遍历所有已打开请求标签还需独立参数 `--all-tabs`。 |
| `10` | 固定区域审计 | `targeted` | `audit/审计指定界面.js` | 默认 90 秒；`--thorough` 默认 300 秒。依赖预设坐标，运行前应保持预期窗口布局。 |
| `11` | 全部调试目标 | `all-targets` | `audit/审计全部调试目标.js` | 默认 90 秒、最多选择 20 个目标；`--thorough` 默认 600 秒并扩大目标、DOM/AX 和交互上限。 |

TUI 不传 `--thorough`。除 `new-request` 外，上表支持高强度档的脚本都有总时间预算：`entry-modals` 使用 `--budget-ms`，其余使用 `--audit-budget-ms`。平衡档不能通过数值参数突破自身上限；需要更高上限时先显式使用 `--thorough`。达到时间或扫描上限会保存部分报告并返回退出码 `2`，不能把部分报告当成完整覆盖。

`import` 是唯一负责导入弹窗的审计：它从页面侧入口打开 Postman 应用内弹窗，只检查链接、原始文本和代码仓库等安全页签，并在成功、失败或异常结束前关闭自己打开的弹窗和菜单。其他审计必须跳过所有可能唤起 Windows 原生文件选择器的控件，例如文件、文件夹、上传、浏览、选择文件和打开文件夹；`targeted-surfaces` 不再自行点击导入入口。

所有报告、截图和临时文件默认写入项目同级 `_generated`，入口会拒绝项目外路径，不写入根目录或 `scripts`。JSON 报告会经过安全模块脱敏。截图默认关闭；当前支持 `--screenshot` 的命令是 `probe`、`scan`，以及 `lightweight`、`new-request`、`new-collection`、`import`、`navigation`、`deep-areas`、`targeted` 审计。PNG 像素不会经过 JSON 脱敏，可能包含当前可见的工作区或请求内容，只应在本机安全环境中使用。默认输出只保留中文摘要；`collect`、`verify`、`static-scan`、`probe`、`scan` 和全部 11 个审计只有显式传入 `--details` 才显示脱敏后的详细诊断。

添加新能力时，优先给 `统一入口.ps1` 增加子命令，并把实现放入对应分类目录。脚本文件名使用简明中文，不要在仓库根目录增加新的 `.bat` 或 `.ps1` 入口。
