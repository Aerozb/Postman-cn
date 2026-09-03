"use strict";

// 汉化版本更新检查（主进程侧）。**只检查、只提示，不下载不安装。**
//
// 为什么不做应用内下载（2026-09-02 试过又拆掉，别再加回来）：
//   本项目的版本约定是「汉化包 Release 标签 == Postman 版本号」
//   （v12.26.3 ↔ app-12.26.3），所以「汉化有新版」只可能发生在 Postman 出新版时，
//   那个 Release 里的 app.asar 装的必然是**新版 Postman** 的内容。于是两个条件互斥：
//     触发下载  需要 tag > 本机版本
//     可以安装  需要 包内 Postman 版本 == 本机版本（跨版本混装必坏，
//               app.asar 和目录里的 Electron 二进制、.pak 资源是配套的）
//   而 tag == 包内版本，所以只要提示了有新版，下载来的包就一定装不上。
//   升级汉化在本项目里等于升级 Postman，得走完整流程（换 app-<新版> 目录再打补丁），
//   不是替换单个 app.asar 能解决的。所以这里只把用户送到发布页。
//
// 为什么放主进程、而不是像别的注入那样塞进 main.js 的单行 IIFE：
//   1. 渲染进程受 Postman 自己的 CSP 约束，connect-src 不一定放行 api.github.com；
//      主进程没有这层限制。
//   2. 这段逻辑有网络请求、超时、节流和 JSON 解析，压成一行没法维护——
//      走 Patch-Preload 已经用过的「独立文件 + main.js 里 require」路子。
//
// 隐私：只对 api.github.com 发一个匿名 GET，不带任何本机数据、不带令牌，
// 也不上报版本号。用户关掉开关后一次请求都不会发。
//
// 与 Postman 自身的自动更新完全无关：那个由 postman-zh:update-guard 管，
// 默认关闭；这个只查汉化包有没有新版，默认开启。

const path = require("path");
const fs = require("fs");
const https = require("https");

const RELEASE_API = "https://api.github.com/repos/Aerozb/Postman-cn/releases/latest";
const RELEASE_PAGE = "https://github.com/Aerozb/Postman-cn/releases";
const PREF_FILE = path.join(process.env.APPDATA || "", "Postman", "postman-zh-version-check.json");

// 节流：GitHub 匿名接口每 IP 每小时 60 次，6 小时一次足够且不会撞限额
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
// 失败后不要立刻重试，避免断网时每次开设置页都卡 10 秒
const ERROR_BACKOFF_MS = 30 * 60 * 1000;

let cached = null;          // 上一次检查结果
let inFlight = null;        // 正在进行的请求，避免并发重复打

/*__TAIL__*/

// 默认开启：偏好文件不存在就当开着（与 Postman 自动更新那个开关相反，
// 那个是「不存在即关闭」，因为拦截才是安全默认值）。
function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREF_FILE, "utf8"));
    return {
      enabled: raw.enabled !== false,
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      dismissedTag: typeof raw.dismissedTag === "string" ? raw.dismissedTag : ""
    };
  } catch (e) {
    return { enabled: true, installedAt: "", dismissedTag: "" };
  }
}

function writePrefs(next) {
  const merged = Object.assign(readPrefs(), next);
  try {
    fs.mkdirSync(path.dirname(PREF_FILE), { recursive: true });
  } catch (e) {}
  try {
    // 不写 BOM：主进程和 PowerShell 侧读同一个文件，BOM 会让 JSON.parse 失败
    fs.writeFileSync(PREF_FILE, JSON.stringify(merged), "utf8");
  } catch (e) {}
  return merged;
}

// 版本号比较：只认 v?a.b.c[.d] 这种数字段，逐段比大小。
// 不用字符串比较——"12.9.0" > "12.10.0" 会判错。
function parseVersion(text) {
  const m = String(text || "").trim().match(/^v?(\d+(?:\.\d+){0,3})/);
  if (!m) return null;
  return m[1].split(".").map((x) => parseInt(x, 10));
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// 当前已装的汉化版本号 = app.asar 的 package.json version，也就是 Postman 版本号。
// 汉化包的 Release 标签跟它一一对应（v12.26.3 ↔ app-12.26.3），所以直接比这个，
// 不必另存一份版本文件（会和实际安装脱节）。
//
// 两条取法：
//   1. 装进 app.asar 后 __dirname 是 <asar>/js，上一级就是 asar 根，那里有 package.json；
//   2. 从命令行（postman-zh.bat zh-updates check）直接 require 本文件时，__dirname
//      是仓库的 payload/ 目录，读不到 Postman 的 package.json——改为扫安装目录名 app-<版本>。
// 都取不到就返回空串，check() 会因此判不出新版（isNewer 对空串返回 false），
// 宁可不提示也不误报。
function localVersion() {
  try {
    const inAsar = path.join(__dirname, "..", "package.json");
    const meta = JSON.parse(fs.readFileSync(inAsar, "utf8"));
    if (meta && meta.name === "Postman" && meta.version) {
      return String(meta.version);
    }
  } catch (e) {}
  try {
    const root = path.join(__dirname, "..", "..", "..");
    const dirs = fs.readdirSync(root)
      .filter((n) => /^app-\d+(?:\.\d+){1,3}$/.test(n))
      .map((n) => n.slice(4))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d) return d;
        }
        return 0;
      });
    if (dirs.length) return dirs[0];
  } catch (e) {}
  return "";
}

function fetchLatest() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = https.get(RELEASE_API, {
        headers: {
          // GitHub 要求带 UA，否则 403
          "User-Agent": "postman-zh-version-check",
          "Accept": "application/vnd.github+json"
        },
        timeout: REQUEST_TIMEOUT_MS
      }, (res) => {
        // 限额用尽（403/429）时 GitHub 会给 x-ratelimit-reset（Unix 秒），
        // 按它退避才准；否则用固定退避。匿名接口是每 IP 每小时 60 次，
        // 正常用户 6 小时一次撞不到，但同一 IP 下多台机器或反复手动检查会撞。
        if (res.statusCode === 403 || res.statusCode === 429) {
          res.resume();
          var reset = parseInt(res.headers["x-ratelimit-reset"], 10);
          var retryAfterMs = 0;
          if (reset && reset > 0) {
            retryAfterMs = Math.max(0, reset * 1000 - Date.now());
          }
          done({ error: "rate limited (" + res.statusCode + ")", rateLimited: true, retryAfterMs: retryAfterMs });
          return;
        }
        // 其他非 200 一律当「查不到」，静默放过
        if (res.statusCode !== 200) {
          res.resume();
          done({ error: "http " + res.statusCode });
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          // 正常响应几十 KB；设个上限防异常响应吃内存
          if (body.length > 512 * 1024) {
            req.destroy();
            done({ error: "response too large" });
          }
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            done({
              tag: String(json.tag_name || ""),
              name: String(json.name || ""),
              url: String(json.html_url || RELEASE_PAGE),
              publishedAt: String(json.published_at || "")
            });
          } catch (e) {
            done({ error: "bad json" });
          }
        });
      });
    } catch (e) {
      done({ error: String((e && e.message) || e) });
      return;
    }

    req.on("timeout", () => { try { req.destroy(); } catch (e) {} done({ error: "timeout" }); });
    req.on("error", (e) => done({ error: String((e && e.message) || e) }));
  });
}

// force=true 时忽略节流（用户在设置页手动点「立即检查」）
async function check(force) {
  const prefs = readPrefs();
  const local = localVersion();
  const base = { enabled: prefs.enabled, localVersion: local, page: RELEASE_PAGE };

  if (!prefs.enabled) {
    // 关掉了就一个请求都不发
    return Object.assign({}, base, { status: "disabled" });
  }

  const now = Date.now();
  if (!force && cached && now - cached.at < (cached.error ? cached.backoffMs : CHECK_INTERVAL_MS)) {
    return Object.assign({}, base, cached.result);
  }
  // 撞了 GitHub 限额时，连 force 也要挡住：用户狂点「立即检查」只会让限额更久，
  // 而且每次都要等一个必然失败的往返。
  if (cached && cached.rateLimitedUntil && now < cached.rateLimitedUntil) {
    return Object.assign({}, base, cached.result);
  }
  if (inFlight) {
    // 已经有请求在飞，复用它，别并发打 GitHub
    return Object.assign({}, base, await inFlight);
  }

  inFlight = (async () => {
    const latest = await fetchLatest();
    if (latest.error) {
      const backoffMs = latest.rateLimited && latest.retryAfterMs
        ? Math.max(latest.retryAfterMs, ERROR_BACKOFF_MS)
        : ERROR_BACKOFF_MS;
      cached = {
        at: Date.now(),
        error: true,
        backoffMs: backoffMs,
        rateLimitedUntil: latest.rateLimited ? Date.now() + backoffMs : 0,
        result: { status: "error", detail: latest.error }
      };
      return cached.result;
    }
    const newer = isNewer(latest.tag, local);
    const result = {
      status: newer ? "update-available" : "latest",
      latestVersion: latest.tag,
      latestName: latest.name,
      url: latest.url,
      publishedAt: latest.publishedAt,
      // 用户点过「不再提示这个版本」后，横幅不再弹，但设置页仍显示有新版
      dismissed: newer && prefs.dismissedTag === latest.tag
    };
    cached = { at: Date.now(), error: false, backoffMs: 0, rateLimitedUntil: 0, result: result };
    return result;
  })();

  try {
    return Object.assign({}, base, await inFlight);
  } finally {
    inFlight = null;
  }
}

function install(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    return false;
  }
  if (globalThis.__postmanZhVersionCheckIpc) {
    return true;
  }
  ipcMain.handle("postman-zh:version-check:get", () => readPrefs().enabled);
  ipcMain.handle("postman-zh:version-check:set", (event, value) => {
    const enabled = value !== false;
    writePrefs({ enabled: enabled });
    if (!enabled) {
      cached = null;   // 关掉时丢弃缓存，重新打开时立刻重查
    }
    return enabled;
  });
  ipcMain.handle("postman-zh:version-check:check", (event, force) => check(force === true));
  ipcMain.handle("postman-zh:version-check:dismiss", (event, tag) => {
    writePrefs({ dismissedTag: String(tag || "") });
    if (cached && cached.result) {
      cached.result.dismissed = true;
    }
    return true;
  });
  ipcMain.handle("postman-zh:version-check:open", () => {
    try {
      // 走 shell.openExternal，链接是本文件里写死的常量，不接受渲染进程传入的 URL
      require("electron").shell.openExternal(RELEASE_PAGE);
      return true;
    } catch (e) {
      return false;
    }
  });
  globalThis.__postmanZhVersionCheckIpc = true;
  return true;
}

module.exports = {
  install: install,
  check: check,
  isNewer: isNewer,
  parseVersion: parseVersion,
  localVersion: localVersion
};


