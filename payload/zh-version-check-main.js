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

// 自动检查缓存一小时；手动检查和进入更新页可刷新，限额退避始终保留。
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
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
  const m = String(text || "").trim().match(/^v?(\d+(?:\.\d+){0,3})$/);
  if (!m) return null;
  const parts = m[1].split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return null;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isNewer(remote, local) {
  return compareVersions(remote, local) === 1;
}

// 标签不等于可用的汉化包：公开、稳定的 Release 还要有同版本的两个已上传附件。
// 只核对 GitHub 元数据，不下载产物；上传中的 Release 单独显示，避免冒充最新版。
function inspectRelease(json) {
  const tag = json && typeof json.tag_name === "string" ? json.tag_name.trim() : "";
  if (!json || !parseVersion(tag) || json.draft !== false || json.prerelease !== false ||
      typeof json.published_at !== "string" || !Number.isFinite(Date.parse(json.published_at)) ||
      !Array.isArray(json.assets)) {
    return { error: "invalid release metadata" };
  }
  const version = tag.replace(/^v/, "");
  const expected = ["app.asar", "Postman-cn-" + version + "-win64.zip"];
  const missingAssets = expected.filter((name) => !json.assets.some((asset) =>
    asset && asset.name === name && asset.state === "uploaded" &&
    Number.isSafeInteger(asset.size) && asset.size > 0
  ));
  return {
    tag: tag,
    name: typeof json.name === "string" ? json.name : tag,
    url: RELEASE_PAGE + "/tag/" + encodeURIComponent(tag),
    publishedAt: json.published_at,
    assetsReady: missingAssets.length === 0,
    missingAssets: missingAssets
  };
}

// 当前已装的汉化版本号 = app.asar 的 package.json version，也就是 Postman 版本号。
// 汉化包的 Release 标签跟它一一对应（v12.26.3 ↔ app-12.26.3），所以直接比这个，
// 不必另存一份版本文件（会和实际安装脱节）。
//
// 两条取法：
//   1. 装进 app.asar 后 __dirname 是 <asar>/js，上一级就是 asar 根，那里有 package.json；
//   2. 从命令行（postman-zh.bat zh-updates check）直接 require 本文件时，__dirname
//      是仓库的 payload/ 目录，读不到 Postman 的 package.json——改为扫安装目录名 app-<版本>。
// 都取不到就返回空串，check() 显示查询错误，不把未知版本当成最新版。
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
        res.on("error", (e) => done({ error: String((e && e.message) || e) }));
        res.on("aborted", () => done({ error: "response aborted" }));
        // 限额用尽（403/429）时 GitHub 会给 x-ratelimit-reset（Unix 秒），
        // 按它退避才准；否则用固定退避。匿名接口是每 IP 每小时 60 次，
        // 自动检查每小时一次；同一 IP 下多台机器或反复手动检查仍可能触发限额。
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
            done(inspectRelease(JSON.parse(body)));
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

// 返回时重新读取偏好：请求途中关闭检查或忽略某版本，旧响应也要遵守新状态。
function withCurrentPrefs(result, local) {
  const prefs = readPrefs();
  const base = { enabled: prefs.enabled, localVersion: local, page: RELEASE_PAGE };
  if (!prefs.enabled) return Object.assign({}, base, { status: "disabled" });
  return Object.assign({}, base, result, {
    dismissed: result.status === "update-available" && prefs.dismissedTag === result.latestVersion
  });
}

// force=true 时刷新普通缓存（进入更新页或手动点「立即检查」）。
async function check(force) {
  const prefs = readPrefs();
  const local = localVersion();
  const base = { enabled: prefs.enabled, localVersion: local, page: RELEASE_PAGE };

  if (!prefs.enabled) {
    // 关掉了就一个请求都不发
    return Object.assign({}, base, { status: "disabled" });
  }
  if (!parseVersion(local)) {
    return Object.assign({}, base, { status: "error", detail: "unknown local version" });
  }

  const now = Date.now();
  if (!force && cached && now - cached.at < (cached.error ? cached.backoffMs : CHECK_INTERVAL_MS)) {
    return withCurrentPrefs(cached.result, local);
  }
  // 撞了 GitHub 限额时，连 force 也要挡住：用户狂点「立即检查」只会让限额更久，
  // 而且每次都要等一个必然失败的往返。
  if (cached && cached.rateLimitedUntil && now < cached.rateLimitedUntil) {
    return withCurrentPrefs(cached.result, local);
  }
  if (inFlight) {
    // 已经有请求在飞，复用它，别并发打 GitHub
    return withCurrentPrefs(await inFlight, local);
  }

  inFlight = (async () => {
    const latest = await fetchLatest();
    if (latest.error) {
      const backoffMs = latest.rateLimited && latest.retryAfterMs
        ? Math.max(latest.retryAfterMs, ERROR_BACKOFF_MS)
        : ERROR_BACKOFF_MS;
      const failure = {
        at: Date.now(),
        error: true,
        backoffMs: backoffMs,
        rateLimitedUntil: latest.rateLimited ? Date.now() + backoffMs : 0,
        result: { status: "error", detail: latest.error }
      };
      // 关闭期间只保留限额退避；普通缓存随开关关闭而清空。
      cached = latest.rateLimited || readPrefs().enabled ? failure : null;
      return failure.result;
    }
    const order = compareVersions(latest.tag, local);
    const status = !latest.assetsReady ? "release-incomplete"
      : order > 0 ? "update-available"
      : order < 0 ? "local-unpublished"
      : "latest";
    const result = {
      // 远端更旧表示本机对应版本尚未发布，不表示本机已是 GitHub 最新汉化版。
      status: status,
      latestVersion: latest.tag,
      latestName: latest.name,
      url: latest.url,
      publishedAt: latest.publishedAt,
      assetsReady: latest.assetsReady,
      missingAssets: latest.missingAssets
    };
    cached = readPrefs().enabled
      ? { at: Date.now(), error: false, backoffMs: 0, rateLimitedUntil: 0, result: result }
      : null;
    return result;
  })();

  try {
    return withCurrentPrefs(await inFlight, local);
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
    if (!enabled && !(cached && cached.rateLimitedUntil > Date.now())) {
      cached = null;   // 普通缓存清空；切换开关也要遵守 GitHub 限额退避
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
  compareVersions: compareVersions,
  inspectRelease: inspectRelease,
  parseVersion: parseVersion,
  localVersion: localVersion
};
