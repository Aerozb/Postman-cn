# 脚本目录

普通用户不要直接运行这里的文件，请使用仓库根目录的 `postman-zh.bat`。

## 统一入口菜单

无参数运行或双击 `postman-zh.bat` 时，`统一入口.ps1` 显示中文 TUI。菜单输入使用 `Read-Host`；选中一项后只执行一次。任务结束后走 `Stop-WithCode`：打印中文结果，再用 `Read-Host` 等用户**手动按回车**关闭窗口，不倒计时、不自动退出。

演进过程：最早任务一结束窗口就消失，用户看不到「验证通过」，反馈是"脚本闪退了"；2026-08-27 改成倒计时几秒自动关闭；2026-09-11 用户要求「执行完不要自动退出，搞成手动退出，不要倒计时啥的」，改成现在的手动按回车。倒计时的问题是没有一个秒数对所有命令都合适——`stats` 输出整屏表格，为此被迫单独放宽到 60 秒，而这个特例现在不需要了。

阻塞只发生在菜单模式（`$script:MenuMode`）：`postman-zh.bat <命令>` 走命令行模式，`Stop-WithCode` 直接 `exit`，自动化调用不受影响。`Read-Host` 在 stdin 被重定向时会抛异常，必须 try/catch 兜住并直接返回，否则自动化意外进了菜单模式就会永久挂住。

| 序号 | TUI 操作 | 入口命令 |
|---:|---|---|
| `1` | 安装汉化 | `install -CleanOldVersions` |
| `2` | 验证汉化状态 | `verify` |
| `3` | 还原英文原版 | `restore` |
| `4` | 启动 Postman | `start` |
| `5` | 关闭 Postman | `stop` |
| `6` | 导出运行时漏翻 | `collect` |
| `7` | 静态扫描界面文案 | `static-scan --disk` |
| `8` | 合并译文 | `merge` |
| `9` | 深度审计界面 | `audit <名称>` |
| `10` | 自动更新开关 | `updates [on\|off]` |
| `11` | 修复浏览器链接 | `fix-browser` |
| `12` | 发布（维护者） | `publish` |
| `13` | 查看项目数据 | `stats` |
| `h` | 查看完整命令帮助 | `help` |
| `0` / `q` | 退出 | 不执行命令 |

直接回车等同于选择 `1`。深度审计子菜单输入 `0` 返回主菜单，输入 `q` 退出整个 TUI。`probe`、通用 `scan` 和 `zh-updates` 保留为维护者 CLI 命令，不放入普通用户菜单（汉化版本检查默认开启，普通用户在「设置 > 更新」页里就能切换，不需要再占一个菜单位）。

**菜单第 1 项默认清理旧版本**：安装及默认验证成功后，删除同一 Squirrel 安装根目录中的旧 `app-*`、旧 `.nupkg`，并精简 `packages/RELEASES`。当前版本及其 `resources/app.asar.original`、用户数据和更新偏好均保留；安装或验证失败时跳过旧版清理。命令行直接运行 `install` 仍保留旧版，显式加 `-CleanOldVersions` 才清理。此开关由 `install` 分支作为 PowerShell 命名参数传给安装器，不放入菜单 `DefaultArgs`（该字段只进入透传参数）。

`verify`、`collect`、`probe`、`scan`、全部审计，以及不加 `--disk` 的 `static-scan`，都要连 CDP，**Postman 必须在运行**，否则会报「没有找到 Postman 页面目标」。先 `start` 再跑。`install` 自己会重启 Postman，所以它内置的那次验证不受影响；`static-scan --disk` 读磁盘缓存，不需要 Postman 在运行。

**菜单第 7 项自动补 `--disk`，别去掉**（2026-09-03 实测）：不带 `--disk` 走 CDP 路径，而 `Debugger.getScriptSource` 对 Postman 那几个 6 MB 级脚本（`monaco-editor-language-ts`、`requester-desktop`）单个就要 **120 秒以上**，前 3 个就烧掉 6 分钟，120 个根本跑不完——用户看到的是「选了 7 之后卡住不动」，会以为脚本挂了。`--disk` 读磁盘缓存约 28 秒扫完 845 个资源，是唯一适合放进菜单的走法。CDP 路径保留给维护者手敲 `static-scan`（不加 `--disk`）时用。菜单项的默认参数写在 `Show-Menu` 的 `DefaultArgs` 字段里。

「设置 > 更新」页里有**两个**汉化工具注入的开关，命令行也是两条命令，别混：

| | `updates [on\|off]` | `zh-updates [on\|off\|check]` |
|---|---|---|
| 管什么 | Postman 官方升级 | 本汉化包有没有新版 |
| 默认 | 关闭（拦截，保护汉化） | 开启（只提示不下载） |
| 偏好文件 | `%APPDATA%\Postman\postman-zh-updates.json` | `%APPDATA%\Postman\postman-zh-version-check.json` |
| 文件不存在 | 视为关闭 | 视为开启 |

两者都与页面开关共享同一份状态，命令行改完约 1 秒内页面开关自动回正。汉化检查在启动或进入更新页时立即执行，此后每小时检查；页面「立即检查」和 `zh-updates check` 刷新一小时普通缓存，仍遵守 GitHub 限额退避。关闭检查后手动按钮禁用。细节和边界见 [docs/更新守卫.md](../docs/更新守卫.md)。

`stats` 查 GitHub 项目数据，走 `gh` CLI（认证交给 gh，脚本里不出现也不存任何令牌），只读、不改仓库。两组数据的权限不同：**Star / Fork / Release 下载量是公开的**，任何人都能看；**访问量、克隆数、来源站点需要仓库 push 权限**，且 GitHub 只保留最近 14 天，过期即丢，想留长期趋势得自己定期导出。拿不到某一组时只跳过那一节并说明原因，不会让整条命令失败。注意 Release 下载量在覆盖同一标签重新发布后会清零（`-ReplaceRelease` 是删旧建新），所以只适合看趋势。

**明细默认就出，且必须压在一屏内**（2026-09-04 用户报「查看完数据咋闪退了」）：这是纯查看命令，不该让人再记一个开关。但输出一长，cmd 默认窗口就把最上面的 Star/Fork 滚出去，用户看到的只有尾巴——所以基础热度一行放两项、Release 的资产明细压进标签行（`asar 21 + 绿色版 99`）、逐日访问折成一行「最近 7 天走势」，默认 44 行。`--full` 才展开完整 14 天逐日和全部热门页面。（`stats` 曾为此把倒计时单独放宽到 60 秒，收尾改成手动按回车后这个特例已删除。）

| 路径 | 用途 |
|---|---|
| `统一入口.ps1` | 显示中文 TUI、解析命令并分发到下列实现。 |
| `internal/` | 安装、还原、启动、停止和系统修复。 |
| `audit/` | CDP 点击、悬停、右键和弹窗审计。 |
| `audit/审计安全.js` | 统一裁剪审计报告中的 URL 参数、WebSocket 地址、请求/响应正文、令牌和本机路径。新增审计脚本必须复用它。 |
| `runtime/` | 运行时漏翻收集和更新页探测。 |
| `data/` | 静态文案扫描和译文合并。 |
| `maintenance/` | GitHub 发布、打包和项目数据查询。 |

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
-CleanOldVersions      安装成功后删除旧 app-*、旧 nupkg、精简 RELEASES（菜单 1 默认启用）
-NoRestart             安装后不重启
```

### 发布预检（PowerShell）

菜单第 `12` 项和 CLI `publish` 复用 `maintenance/发布中文版.ps1`：通过 `gh api --hostname github.com user` 核验当前活动凭据，再读取目标仓库的实际写权限。网络异常、GitHub 限额、401 凭据失效、权限不足分别提示；网络/5xx 只读查询最多尝试 3 次，限额和写操作不自动重试。旧版把 `gh auth status` 的任意非零退出码都当成未登录，网络波动或其他账号异常就会误报。

未设置 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 时，仅在当前发布进程中继承 Windows 已启用的静态 HTTP(S) 代理和排除表；已有代理环境变量及 `NO_PROXY` 保持优先，不修改系统设置、Git 全局配置或 gh 凭据。仅 PAC 或 SOCKS 等配置请通过显式环境变量设置。

```powershell
.\postman-zh.bat publish -CheckOnly # 真实预检，不推送、不打包、不发布
.\postman-zh.bat publish -TestOnly  # 隔离回归，不连网络、不读凭据
```

`maintenance/验证发布预检.ps1` 由 `publish -TestOnly` 调用，覆盖错误分类、只读重试、账号/仓库响应缺失、写权限以及系统/显式代理优先级。只加载被测函数并使用内存响应；不执行发布流程。

### 汉化维护（Node）

| 脚本 | 作用 |
|---|---|
| `data/提取界面文案.js` | 静态扫描实现，由 `static-scan` 调用。 |
| `data/合并译文.js` | 合并 `_generated/trans-*.json` 译文。 |
| `data/统计词条.js` | 统计各字典词条数；`publish` 用它生成 Release 说明里的条数，`--details` 看分项。 |
| `maintenance/查看项目数据.js` | 查 GitHub 项目数据，由 `stats` 调用。走 `gh` CLI，脚本里不出现任何令牌。 |
| `runtime/收集漏翻.js` | 导出运行时漏翻清单。 |
| `runtime/探测更新页面.js` | 探测更新页。 |
| `runtime/验证版本检查.js` | 版本与发布附件状态的内存隔离回归，由 `verify` / `install` 自动调用，不发真实网络请求。 |
| `runtime/验证版本检查界面.js` | 立即 / 手动 / 每小时检查及并发状态回归，使用内存 DOM、IPC 和虚拟时钟，由 `verify` / `install` 自动调用。 |
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

TUI 不传 `--thorough`。**支持 `--thorough` 的只有这 8 个：`new-request`、`navigation`、`deep-areas`、`entry-modals`、`phased`、`targeted`、`targeted-surfaces`、`all-targets`**；给 `lightweight`、`new-collection`、`import` 传是无效的。除 `new-request` 外，支持高强度档的脚本都有总时间预算：`entry-modals` 使用 `--budget-ms`，其余使用 `--audit-budget-ms`。平衡档不能通过数值参数突破自身上限；需要更高上限时先显式使用 `--thorough`。达到时间或扫描上限会保存部分报告并返回退出码 `2`，不能把部分报告当成完整覆盖。

`import` 是唯一负责导入弹窗的审计：它从页面侧入口打开 Postman 应用内弹窗，只检查链接、原始文本和代码仓库等安全页签，并在成功、失败或异常结束前关闭自己打开的弹窗和菜单。其他审计必须跳过所有可能唤起 Windows 原生文件选择器的控件，例如文件、文件夹、上传、浏览、选择文件和打开文件夹；`targeted-surfaces` 不再自行点击导入入口。

所有报告、截图和临时文件默认写入项目同级 `_generated`，入口会拒绝项目外路径，不写入根目录或 `scripts`。JSON 报告会经过安全模块脱敏。截图默认关闭；当前支持 `--screenshot` 的命令是 `probe`、`scan`，以及 `lightweight`、`new-request`、`new-collection`、`import`、`navigation`、`deep-areas`、`targeted` 审计。PNG 像素不会经过 JSON 脱敏，可能包含当前可见的工作区或请求内容，只应在本机安全环境中使用。默认输出只保留中文摘要；`collect`、`verify`、`static-scan`、`probe`、`scan` 和全部 11 个审计只有显式传入 `--details` 才显示脱敏后的详细诊断。

**终端摘要里的条数，等于报告里实际留下的条数。** 脱敏会剔除身份噪声（团队名 slug、头像 alt、纯 role 文本、测试 id 等，见 `AGENTS.md` 规则 8），所以 `writeAuditReport` 返回写盘那份脱敏结果，审计脚本一律按它计数。曾经摘要用的是过滤前的原始数组，于是出现「发现 1 条待复核文本」而报告里 `hits` 是空数组、步骤日志里 `hitCount: 1` 配 `hits: []` 的情况，维护者无法判断那条是真漏翻还是误报（2026-08-30 实测踩到，那 1 条就是团队名 slug）。新写审计脚本请沿用同一套写法：`const written = writeAuditReport(...)`，再用 `written.hits` / `written.summary` 出摘要，不要用本地的原始数组。像 `new-collection` 那种把 `englishHits` 和导航失败一起计入的复合计数，脱敏层不会覆盖，由脚本自己按脱敏后的数组重算。

添加新能力时，优先给 `统一入口.ps1` 增加子命令，并把实现放入对应分类目录。脚本文件名使用简明中文，不要在仓库根目录增加新的 `.bat` 或 `.ps1` 入口。

本文件是审计档位、`--thorough` 名单和 `--screenshot` 名单的唯一 Markdown 副本，其他文档一律指过来。**唯一的例外是 `统一入口.ps1` 里 `Show-Help` 的正文**——那是用户直接跑 `help` 看到的文字，无法用链接代替，改这些名单时两处要一起改。
