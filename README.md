# Postman 中文版 app.asar 替换包

这是 Postman Desktop 的中文 `app.asar` 替换包说明和 Windows 自动安装脚本仓库。

`app.asar` 是同版本通用资源包，Windows、macOS、Linux 都可以按版本手动替换使用。自动安装脚本目前只提供 Windows 版，所以脚本目录命名为 `Windows专用脚本`。

## 重要说明

- GitHub 仓库不要提交 `app.asar`，因为文件超过普通仓库限制。
- `app.asar` 请上传到 GitHub Release 附件。
- 用户下载 Release 里的 `app.asar` 后，可以放到 `Windows专用脚本` 目录里再运行脚本。
- `app.asar` 必须和 Postman 主程序版本一致，例如 `12.12.3\app.asar` 对应 Postman `app-12.12.3`。

## 推荐发布结构

为了避免把大文件误提交到 GitHub，仓库目录 `Postman-cn` 不放大文件。大文件可以放在仓库同级目录，或由用户从 Release 下载后放进脚本目录。

本地维护结构：

```text
Postman
|-- 12.12.3
|   `-- app.asar
`-- Postman-cn
    |-- Windows专用脚本
    |   |-- 安装汉化.bat
    |   |-- 安装汉化.ps1
    |   |-- 还原英文.bat
    |   `-- 还原英文.ps1
    `-- README.md
```

用户下载后也可以这样放：

```text
Postman-cn
`-- Windows专用脚本
    |-- app.asar
    |-- 安装汉化.bat
    |-- 安装汉化.ps1
    |-- 还原英文.bat
    `-- 还原英文.ps1
```

脚本会优先使用 `Windows专用脚本\app.asar`。如果脚本目录里没有 `app.asar`，会继续查找仓库目录或仓库同级目录中的 `版本号\app.asar`。

如果 `app.asar` 直接放在 `Windows专用脚本` 目录里，脚本会优先使用命令行里的 `-Version` 参数；没有指定时，会尝试根据本机已安装的 Postman `app-*` 目录推断最新版本。

## Postman 主程序下载

Postman 官方下载页：

```text
https://www.postman.com/downloads/
```

### 最新版直链

| 系统 | 架构 | 下载地址 |
|---|---|---|
| Windows | x64 | https://dl.pstmn.io/download/latest/win64 |
| macOS | Intel | https://dl.pstmn.io/download/latest/osx_64 |
| macOS | Apple Silicon | https://dl.pstmn.io/download/latest/osx_arm64 |
| Linux | x64 | https://dl.pstmn.io/download/latest/linux_64 |
| Linux | ARM64 | https://dl.pstmn.io/download/latest/linux_arm64 |

### 指定版本直链

把链接里的 `12.12.3` 换成你需要的 Postman 版本号即可。

| 系统 | 架构 | 下载地址 |
|---|---|---|
| Windows | x64 | https://dl.pstmn.io/download/version/12.12.3/win64 |
| macOS | Intel | https://dl.pstmn.io/download/version/12.12.3/osx_64 |
| macOS | Apple Silicon | https://dl.pstmn.io/download/version/12.12.3/osx_arm64 |
| Linux | x64 | https://dl.pstmn.io/download/version/12.12.3/linux_64 |
| Linux | ARM64 | https://dl.pstmn.io/download/version/12.12.3/linux_arm64 |

## Windows 自动安装

最简单方法：

1. 下载本仓库。
2. 下载 Release 里的 `app.asar`。
3. 把 `app.asar` 放到：

```text
Postman-cn\Windows专用脚本\app.asar
```

4. 关闭 Postman。
5. 双击：

```text
Windows专用脚本\安装汉化.bat
```

6. 安装完成后会自动启动 Postman。

如果脚本目录里直接放了 `app.asar`，建议使用 `-Version` 指定版本；不指定时，脚本会尝试使用本机已安装的最新 Postman 版本。

指定版本安装：

```bat
Windows专用脚本\安装汉化.bat -Version 12.12.3
```

PowerShell 指定版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows专用脚本\安装汉化.ps1 -Version 12.12.3
```

查看可用版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows专用脚本\安装汉化.ps1 -ListVersions
```

找不到 Postman 安装目录时手动指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows专用脚本\安装汉化.ps1 -Version 12.12.3 -PostmanDir "C:\Users\你的用户名\AppData\Local\Postman\app-12.12.3"
```

## 手动安装

手动安装适用于 Windows、macOS、Linux。请确保 `app.asar` 的版本和 Postman 主程序版本一致。

### Windows

1. 关闭 Postman。
2. 找到 Postman 版本目录，例如：

```text
C:\Users\你的用户名\AppData\Local\Postman\app-12.12.3\resources
```

3. 备份原文件：

```text
app.asar -> app.asar.original
```

4. 把对应版本的中文 `app.asar` 复制进去覆盖：

```text
中文 app.asar -> app-12.12.3\resources\app.asar
```

5. 启动 Postman。

### macOS

1. 关闭 Postman。
2. 找到资源目录：

```text
/Applications/Postman.app/Contents/Resources
```

3. 备份原文件：

```bash
cp app.asar app.asar.original
```

4. 用对应版本的中文 `app.asar` 覆盖：

```bash
cp /path/to/app.asar /Applications/Postman.app/Contents/Resources/app.asar
```

5. 启动 Postman。

### Linux

常见资源目录可能是：

```text
/opt/Postman/resources
/usr/lib/postman/resources
```

手动备份并覆盖：

```bash
cp app.asar app.asar.original
cp /path/to/app.asar /opt/Postman/resources/app.asar
```

如果你的 Postman 安装在其他目录，请替换为自己的实际路径。

## 还原英文

Windows 自动还原：

```bat
Windows专用脚本\还原英文.bat
```

指定版本还原：

```bat
Windows专用脚本\还原英文.bat -Version 12.12.3
```

手动还原时，把备份的 `app.asar.original` 改回 `app.asar` 即可。

## 注意事项

- `app.asar` 必须和 Postman 主程序版本一致。
- `app.asar` 是同版本通用文件；`Windows专用脚本` 只是自动安装脚本，不影响手动替换。
- Windows 自动脚本会备份原始文件为 `app.asar.original`，并额外生成一次替换前备份 `app.asar.before-cn-时间.bak`。
- 如果 Postman 自动更新到新版本，需要下载或制作对应新版本的中文 `app.asar`。
