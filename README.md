# Postman 中文版

Postman 桌面版汉化补丁，适用于 Windows 10/11 与 Postman 12.x。

> 本项目为非官方汉化，仅供学习交流。Postman 及相关商标归 Postman 公司所有。

<p align="center">
  <img src="assets/screenshots/01-overview-cn.png" width="49%" alt="中文概览界面">
  <img src="assets/screenshots/02-request-builder-cn.png" width="49%" alt="中文请求界面">
</p>

## 直接使用发布版

前往 [Releases 下载页](https://github.com/Aerozb/Postman-cn/releases)，按 Postman 版本选择：

- `Postman-cn-<版本>-win64.zip`：解压后直接运行，适合大多数人。
- `app.asar`：只替换同版本官方安装目录中的 `resources\app.asar`，替换前请先备份原文件。

## 使用统一入口

仓库根目录只有一个用户入口：[postman-zh.bat](./postman-zh.bat)。安装 Node.js 22+ 后直接双击它，在中文菜单中输入序号即可选择安装、验证、还原、启动、关闭、漏翻收集或深度审计；直接回车就是最常用的「安装汉化」，输入 `0` 退出。任务结束后窗口会自动关闭，不需要再按确认键，也不会显示大段内部 JSON 日志。

下面的命令行方式只供维护者、自动化测试或故障排查使用，普通用户不需要手敲命令：

```powershell
.\postman-zh.bat install       # 安装汉化、关闭自动更新并验证
.\postman-zh.bat restore       # 还原英文原版
.\postman-zh.bat help          # 查看所有命令
```

常用维护命令：

```powershell
.\postman-zh.bat collect       # 导出运行时漏翻
.\postman-zh.bat collect -Clear
.\postman-zh.bat verify        # 单独验证；加 --details 查看完整诊断
.\postman-zh.bat start         # 启动并等待 CDP 调试端口
.\postman-zh.bat stop
.\postman-zh.bat static-scan --disk  # 扫描磁盘缓存中的 UI 文案；不加 --disk 则扫描运行中的页面
.\postman-zh.bat scan          # 扫描可点击界面
.\postman-zh.bat audit new-request
```

TUI 中的高级审计默认使用受控档。发布前确需扩大覆盖时，维护者可在命令行给 `new-request`、`navigation`、`deep-areas`、`entry-modals`、`phased`、`targeted`、`targeted-surfaces` 或 `all-targets` 增加 `--thorough`；该参数不适用于其他审计名。`phased` 要遍历所有已打开的请求标签时，还需单独增加 `--all-tabs`。审计名、内部中文脚本名和预算参数见 [scripts/README.md](./scripts/README.md)。

自动审计会跳过“文件、文件夹、上传、浏览、选择文件”等会打开 Windows 文件选择器的入口。`audit import` 只从 Postman 页面内打开导入弹窗并检查无需选择本机文件的页签，结束后会自动关闭临时弹窗；通用审计不会重复点击导入入口。

安装到指定版本目录：

```powershell
.\postman-zh.bat install -PostmanDir C:\Path\To\Postman\app-12.19.6
```

脚本会自动备份 `resources\app.asar` 为 `app.asar.original`，从备份解包、注入汉化、重新打包并启动验证。Postman 更新后再次运行 `install` 即可。

`install` 只修改目标 Postman 版本目录，不会改动系统 HTTP/HTTPS 处理程序。仅在登录页外部链接确有异常时，才单独运行 `fix-browser`。

## 常见问题

- `GET`、`POST`、`API`、`JSON`、快捷键和产品名等技术词会刻意保留英文。
- 安装后仍是英文，通常是 Postman 更新到了新的 `app-*` 目录；重新运行 `install`。
- 登录页外部链接异常时运行 `.\postman-zh.bat fix-browser`。

完整使用说明见 [docs/汉化教程.md](./docs/汉化教程.md)，维护细节见 [AGENTS.md](./AGENTS.md) 和 [docs/维护指南.md](./docs/维护指南.md)。

审计过程产生的 JSON 报告会写入项目同级 `_generated`，并由统一安全模块裁剪账号参数、令牌、请求正文和本机路径。截图默认关闭，只有维护者显式传入 `--screenshot` 才会生成；PNG 像素不会经过 JSON 脱敏，可能包含当前可见的工作区或请求内容。这些临时产物都不会进入仓库。
