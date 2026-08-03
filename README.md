# Postman 中文版

Postman 桌面版汉化补丁，界面全中文，开箱即用。

> 本项目为非官方汉化，仅供学习交流。Postman 及相关商标归 Postman 公司所有。

<p align="center">
  <img src="assets/screenshots/01-overview-cn.png" width="49%" alt="中文概览界面">
  <img src="assets/screenshots/02-request-builder-cn.png" width="49%" alt="中文请求界面">
</p>

**适用系统：** Windows 10 / 11 · Postman 桌面版 12.x（已在 12.19.6 上测试）

---

## 方式一：下载现成的，直接用（推荐）

适合大多数人：**不用装任何环境**，下载解压就能用中文。

前往 **[Releases 下载页](https://github.com/Aerozb/Postman-cn/releases)**，里面有两个文件，**二选一**下载：

### A. 完整版 `Postman-cn-<版本>-win64.zip`（新手首选）

1. 下载后解压到任意文件夹（比如 `D:\Postman-cn`）；
2. 双击里面的 **`Postman.exe`**；
3. 打开就是中文，无需安装。

### B. 单个文件 `app.asar`（已装了官方 Postman、且版本号相同时用）

1. **先完全退出 Postman**（连同右下角托盘里的图标一起退出）；
2. 按 `Win + R`，输入 `%LOCALAPPDATA%\Postman` 后回车，打开 Postman 安装目录；
3. 进入与你版本号一致的文件夹里的 `resources`，例如 `app-12.19.6\resources`；
4. 把这里原来的 `app.asar` 改名备份（比如改成 `app.asar.bak`），再把下载的 `app.asar` 放进去；
5. 重新打开 Postman，界面变中文即成功。

> ⚠️ `app.asar` 和版本号强绑定：必须下载与你 Postman 版本**完全一致**的文件。版本对不上就用上面的 A，或用下面的方式二。

---

## 方式二：自己运行脚本汉化（适合新版本）

适合：Postman 升级到了 Releases 里还没发布的新版本，想自己给它打中文补丁。脚本会自动找到本机最新版本、打补丁、关闭自动更新并验证。

**需要先准备：**

- Windows 10 / 11，并已安装 Postman；
- **Node.js 18 或更高版本**（到 [nodejs.org](https://nodejs.org) 下载 LTS 版安装即可）。
  装好后在命令行输入 `node -v`，能显示版本号就说明成功了。

**使用步骤：**

1. 下载本项目：仓库首页点绿色的 **Code → Download ZIP**，然后解压；
2. 双击文件夹里的 **`install-latest-zh.bat`**；
3. 等它自动运行完，看到这一行就成功了：

   ```
   [postman-zh] VERIFY PASSED
   ```

4. 以后 Postman 又更新了，重新双击一次 `install-latest-zh.bat` 即可。

---

## 还原成英文原版

- 用**方式二**脚本装的：双击 **`restore-original.bat`**。
- 用**方式一 A**（绿色版）的：直接删掉解压出来的文件夹即可。
- 用**方式一 B**（替换过 `app.asar`）的：把之前备份的 `app.asar.bak` 改回 `app.asar`。

---

## 常见问题

- **打开又变回英文了？** 多半是 Postman 自动更新到了新版本。重新双击 `install-latest-zh.bat` 给新版本重新汉化即可（脚本默认已关闭自动更新，正常情况下不会发生）。
- **有些词还是英文？** `GET`、`POST`、`API`、`JSON`、`Ctrl+K` 这类技术词、快捷键和产品名是**故意保留**的，不属于漏翻。
- **方式一和方式二怎么选？** 只想马上用中文 → 方式一；Postman 已是最新版、Releases 里还没有对应下载 → 方式二。

---

<sub>维护者与技术细节见 [AGENT.md](./AGENT.md) 和 [docs/](./docs)。</sub>
