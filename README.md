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

## 使用统一脚本入口

仓库根目录只有一个用户入口：[postman-zh.bat](./postman-zh.bat)。安装 Node.js 22+ 后双击它即可安装最新版汉化；也可以在 PowerShell 中带命令运行：

```powershell
.\postman-zh.bat install       # 安装汉化、关闭自动更新并验证
.\postman-zh.bat restore       # 还原英文原版
.\postman-zh.bat help          # 查看所有命令
```

常用维护命令：

```powershell
.\postman-zh.bat collect       # 导出运行时漏翻
.\postman-zh.bat collect -Clear
.\postman-zh.bat verify        # 单独验证
.\postman-zh.bat start         # 启动并等待 CDP 调试端口
.\postman-zh.bat stop
.\postman-zh.bat static-scan   # 扫描磁盘缓存中的 UI 文案
.\postman-zh.bat scan          # 扫描可点击界面
.\postman-zh.bat audit new-request
```

安装到指定版本目录：

```powershell
.\postman-zh.bat install -PostmanDir C:\Path\To\Postman\app-12.19.6
```

脚本会自动备份 `resources\app.asar` 为 `app.asar.original`，从备份解包、注入汉化、重新打包并启动验证。Postman 更新后再次运行 `install` 即可。

## 常见问题

- `GET`、`POST`、`API`、`JSON`、快捷键和产品名等技术词会刻意保留英文。
- 安装后仍是英文，通常是 Postman 更新到了新的 `app-*` 目录；重新运行 `install`。
- 登录页外部链接异常时运行 `.\postman-zh.bat fix-browser`。

维护细节见 [AGENTS.md](./AGENTS.md) 和 [docs/维护指南.md](./docs/维护指南.md)。
