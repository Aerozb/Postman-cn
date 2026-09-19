# 脚本目录

统一使用仓库根目录 `postman-zh.bat`，内部脚本不是另一套用户入口。源码按职责归档，公共 CDP 与离线词典读取位于 `lib/`。

## 菜单与 CLI

无参数显示中文 TUI，默认回车安装；选中任务只执行一次，末尾由 `Stop-WithCode` 等用户手动回车关闭。CLI `postman-zh.bat <命令>` 直接返回退出码，不等待、不倒计时。

| 序号 | 菜单操作 | 命令 |
|---:|---|---|
| 1 | 安装汉化 | `install -CleanOldVersions` |
| 2 | 验证汉化状态 | `verify` |
| 3 | 还原英文原版 | `restore` |
| 4 | 启动 Postman | `start` |
| 5 | 关闭 Postman | `stop` |
| 6 | 合并译文 | `merge` |
| 7 | 自动更新开关 | `updates [on/off]` |
| 8 | 修复浏览器链接 | `fix-browser` |
| 9 | 发布（维护者） | `publish` |
| 10 | 查看项目数据 | `stats` |
| h | 完整帮助 | `help` |
| 0 / q | 退出 | — |

`test` 和 `zh-updates` 是 CLI 专用命令，不增加菜单项。

`verify` 需要运行中的 Postman/CDP。先执行 `start`；它会重启已运行实例，以确保随机调试端口生效。`test` 和 `merge` 不要求应用启动。

旧的 `collect`、`static-scan`、`probe`、`scan`、`audit` 及审计子菜单已移除，裸命令按未知命令返回 `2`。日常维护以当前官方 i18n 和用户截图反馈为主，不再后台收集漏翻或自动遍历界面。

## 安装与进程

| 参数 | 作用 |
|---|---|
| `-PostmanDir <path>` | 指定包含 Postman.exe 和 resources 的版本目录，默认自动发现 |
| `-UserDataDir <path>` | 仅 `start`：指定独立 Postman 数据目录及其调试端口文件，默认位置不变 |
| `-KeepUpdates` | 不注入官方自动更新守卫 |
| `-NoVerify` | 跳过安装后的验证 |
| `-CleanOldVersions` | 成功后清理同一安装根目录的旧 app-*、旧 nupkg，并精简 RELEASES |
| `-NoRestart` | 安装后不启动，因此跳过运行时验证 |

菜单安装默认清理旧版本，CLI 普通 `install` 保留旧版本，显式加开关才清理。当前版本、英文备份、用户数据和偏好保留；安装失败跳过清理。

`install -KeepUpdates` 刻意不装官方更新守卫，之后独立验证也使用 `verify -KeepUpdates`；普通 `verify` 默认要求守卫存在。

启动、停止和安装共用 `internal/进程工具.ps1`：完全停止后再启动，轮询新的端口文件及页面就绪，替代固定等待。`start -NoWait` 跳过就绪等待，`-TimeoutSec` 控制等待上限。

旧版回归可用 `start -PostmanDir <旧版目录> -UserDataDir <临时目录>`，透传 Postman 的 `--user-data-path` 并从该目录读取 `DevToolsActivePort`，避免旧版打开日常数据。汉化偏好仍位于 `%APPDATA%/Postman`；完整隔离时，在测试命令进程内设置临时 `APPDATA`/`LOCALAPPDATA`，并令 `UserDataDir` 为该临时 `APPDATA/Postman`。不更改用户级或系统级环境变量；只调整 `APPDATA` 不等于已隔离 Electron 的数据目录。

## 离线回归

```powershell
.\postman-zh.bat test
.\postman-zh.bat test --details
```

按顺序执行 Node 回归、PowerShell 入口/进程回归和发布预检回归；任一阶段失败即返回非零。默认中文摘要，details 显示分组耗时和失败诊断。测试不连接真实 Postman/GitHub，不操作真实进程或偏好。

覆盖：JS/PowerShell 语法、文档链接、skill 元数据一致性、AGENTS 大小、最终词典计数/合并、固定翻译语料、数据保护与重试调度、CDP 生命周期/会话/预算、诊断脱敏与截断、版本检查、跨帧注入、命令出口、进程就绪与验证前的菜单汉化就绪轮询。存储回归确认翻译器不再读写历史漏翻记录。

`runtime/翻译回归样例.js` 同时供离线测试和 `verify` 的浏览器探针使用。实机验证仍需检查实际注入、界面布局和真实动态内容，不能由离线桩替代。

## 更新开关与项目数据

| 命令 | 含义 | 默认 |
|---|---|---|
| `updates [on/off]` | Postman 官方升级；偏好 `postman-zh-updates.json` | 关闭 |
| `zh-updates [on/off/check]` | 汉化包 Release 检查；偏好 `postman-zh-version-check.json` | 开启 |

偏好位于 `%APPDATA%/Postman`，与页面开关独立同步。汉化检查只提示、不下载或安装；立即/手动/小时检查、限额退避和状态含义见 [更新守卫](../docs/更新守卫.md)。

`stats` 通过 gh CLI 查询项目数据。Star/Fork/Release 下载量公开，流量和克隆数据需要仓库 push 权限，GitHub 仅保留最近 14 天。默认压缩显示，`--full` 展开明细；部分数据获取失败只跳过相应部分。重建同标签 Release 会重置旧资产的下载计数。

## 发布预检（PowerShell）

```powershell
.\postman-zh.bat publish -CheckOnly  # 真实账号/仓库/网络预检，无发布写操作
.\postman-zh.bat publish -TestOnly   # 仅内存桩回归，无网络和凭据读取
```

预检区分登录失效、权限、限额和网络故障。网络/5xx 只读查询最多尝试 3 次，限额和写操作不自动重试。仅在无显式代理环境变量时继承 Windows 静态 HTTP(S) 代理；已有环境变量及 NO_PROXY 优先，只作用于当前进程。PAC/SOCKS 场景通过适用的显式环境配置处理。

完整发布会提交、推送和上传，`-SkipRelease` 也不是只读模式。执行前核对工作区及产物，详见 [升级与发布](../docs/升级与发布.md)。

同标签 Release 默认重建：同一个 Postman 版本多次补词条后重发是常态，`publish` 遇到已存在的标签会删除旧 Release 及其资产再重建，旧资产的下载计数随之重置。需要保住线上现有 Release 时传 `-NoReplaceRelease`，脚本遇到同标签即停止并保留原资产。该默认只作用于 Release；git 推送仍是普通 push，覆盖远端历史依旧要显式 `-Force`。删除前仍会询问一次，`-Yes` 跳过询问。

## 实现分工

| 文件 / 目录 | 职责 |
|---|---|
| `统一入口.ps1` | 菜单、参数分发、唯一结果与退出收尾 |
| `运行回归.js` | Node 回归总入口 |
| `lib/CDP客户端.js` | WebSocket 生命周期、会话、事件、超时与预算 |
| `lib/汉化沙箱.js` | 只读执行内存 payload，提供真实翻译和最终词典 |
| `lib/诊断输出.js` | 定点诊断的路径约束、脱敏、报告与截图写入 |
| `internal/安装汉化.ps1` | 原版校验、注入、打包、替换、回滚 |
| `internal/进程工具.ps1` | 停止、后台启动、端口/页面就绪 |
| `internal/启动程序.ps1`、`关闭程序.ps1` | 共用进程能力的命令封装 |
| `internal/修复浏览器链接.ps1` | 显式修复系统 URL 处理器引号 |
| `data/` | 合并译文、统计最终词条 |
| `runtime/` | 共享翻译样例和离线回归 |
| `验证汉化.js` | 已安装实例的翻译、DOM、菜单与补丁验证 |
| `maintenance/` | 发布、GitHub 数据、入口进程与发布预检测试 |

## 按需定点诊断

截图反馈时可在同级 `_generated` 写临时脚本，复用 `lib/CDP客户端.js` 和 `lib/诊断输出.js`；无需恢复自动巡检入口。

报告用 `writeDiagnosticReport` 写入，摘要按最终脱敏后的返回值计算；条目裁剪或诊断超时应标明部分结果。截图显式调用 `writeDiagnosticScreenshot`，它验证路径和格式，但不脱敏 PNG 像素。

定点检查跳过原生文件选择器及 `data-postman-zh-audit-skip="true"`，避免发送、保存、删除用户数据。结束后清理自己的测试节点、弹窗和菜单。运行时 DOM 监听、延迟重试与跨帧注入仍保留，它们负责实时汉化，不是已移除的辅助探测。

本文件是菜单和支持参数的唯一 Markdown 清单；调整时同步入口 Show-Help 的用户可见帮助。
