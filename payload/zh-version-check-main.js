"use strict";

// 汉化版本更新检查 + 下载（主进程侧）。
//
// 为什么放主进程、而不是像别的注入那样塞进 main.js 的单行 IIFE：
//   1. 渲染进程受 Postman 自己的 CSP 约束，connect-src 不一定放行 api.github.com；
//      主进程没有这层限制。
//   2. 这段逻辑有网络请求、超时、节流、重定向跟随、SHA-256 校验和 JSON 解析，
//      压成一行没法维护——走 Patch-Preload 已经用过的
//      「独立文件 + main.js 里 require」路子。
//
// 隐私：只对 api.github.com / objects.githubusercontent.com 发匿名请求，
// 不带任何本机数据、不带令牌，也不上报版本号。关掉开关后一次请求都不会发。
//
// 与 Postman 自身的自动更新完全无关：那个由 postman-zh:update-guard 管，
// 默认关闭；这个只管汉化包，默认开启。
//
// **下载到就地安装之间刻意留一道人工确认**：app.asar 是 Postman 正在执行的文件，
// 换它必须先杀干净进程（AGENTS.md 规则 13）。自动重启会打断用户正在编辑的请求，
// 所以下载完只提示「已就绪」，由用户点一下才装。

const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const crypto = require("crypto");

const RELEASE_API = "https://api.github.com/repos/Aerozb/Postman-cn/releases/latest";
const RELEASE_PAGE = "https://github.com/Aerozb/Postman-cn/releases";
const PREF_FILE = path.join(process.env.APPDATA || "", "Postman", "postman-zh-version-check.json");
// 下载暂存目录。放 APPDATA 而不是 TEMP：TEMP 常被清理工具扫，
// 155 MB 下到一半被删会很难查。
const STAGE_DIR = path.join(process.env.APPDATA || os.tmpdir(), "Postman", "postman-zh-download");

// 节流：GitHub 匿名接口每 IP 每小时 60 次，6 小时一次足够且不会撞限额
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
// 下载超时单独放宽：155 MB 在慢网络上要几分钟
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
// 单次响应静默多久算卡死（防止连接不断但零字节的僵死流）
const DOWNLOAD_STALL_MS = 60 * 1000;
// 失败后不要立刻重试，避免断网时每次开设置页都卡 10 秒
const ERROR_BACKOFF_MS = 30 * 60 * 1000;
// 资产体积上限，防异常响应把磁盘写满
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

let cached = null;          // 上一次检查结果
let inFlight = null;        // 正在进行的请求，避免并发重复打
let download = null;        // 当前下载状态

// 默认开启：偏好文件不存在就当开着（与 Postman 自动更新那个开关相反，
// 那个是「不存在即关闭」，因为拦截才是安全默认值）。
function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREF_FILE, "utf8"));
    return {
      enabled: raw.enabled !== false,
      autoDownload: raw.autoDownload === true,
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      dismissedTag: typeof raw.dismissedTag === "string" ? raw.dismissedTag : ""
    };
  } catch (e) {
    return { enabled: true, autoDownload: false, installedAt: "", dismissedTag: "" };
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

// 当前已装的汉化版本号 = app.asar 的 package.json version。
// 汉化包的 Release 标签跟 Postman 版本号一一对应（v12.25.7 ↔ app-12.25.7），
// 所以直接比这个即可，不必另存一份版本文件（会和实际安装脱节）。
//
// 两条取法：
//   1. 装进 app.asar 后 __dirname 是 <asar>/js，上一级就是 asar 根，那里有 package.json；
//   2. 从命令行（postman-zh.bat zh-updates check）直接 require 本文件时，__dirname
//      是仓库的 payload/ 目录，上一级没有 Postman 的 package.json——这时去磁盘上
//      找当前安装的 app-*/resources/app.asar 同级信息拿不到，改为读 Postman 安装目录名。
// 取不到就返回空串，check() 会因此判不出新版（isNewer 对空串返回 false），
// 宁可不提示也不误报。
function localVersion() {
  // 路径 1：asar 内
  try {
    const inAsar = path.join(__dirname, "..", "package.json");
    const meta = JSON.parse(fs.readFileSync(inAsar, "utf8"));
    if (meta && meta.name === "Postman" && meta.version) {
      return String(meta.version);
    }
  } catch (e) {}
  // 路径 2：命令行上下文，从 Postman 安装目录名 app-<版本> 推断
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
            // 资产里挑 app.asar：绿色版 zip 要用户自己解压安装，不适合就地替换
            const assets = Array.isArray(json.assets) ? json.assets : [];
            const asar = assets.filter((a) => a && a.name === "app.asar")[0] || null;
            done({
              tag: String(json.tag_name || ""),
              name: String(json.name || ""),
              url: String(json.html_url || RELEASE_PAGE),
              publishedAt: String(json.published_at || ""),
              asset: asar ? {
                name: String(asar.name || ""),
                size: Number(asar.size) || 0,
                // GitHub 现在给 digest 字段（"sha256:abc..."），有就用它校验
                digest: String(asar.digest || ""),
                url: String(asar.browser_download_url || "")
              } : null
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

// ── 下载 ────────────────────────────────────────────────────────────
//
// GitHub 的 browser_download_url 会 302 到 objects.githubusercontent.com，
// https.get 不自动跟随，得自己跟。只允许跳到 github 自家域名，
// 免得被劫持的响应把下载引到别处。
const ALLOWED_DOWNLOAD_HOSTS = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i;
// 155 MB 的连接在代理或弱网下经常中途被掐（2026-09-02 实测：本机代理在 50%
// 处 aborted）。GitHub 资产支持 Range（Accept-Ranges: bytes），所以断了就带
// Range 续传，而不是从头再来。
const MAX_DOWNLOAD_ATTEMPTS = 6;
const RETRY_DELAY_MS = 2000;

function httpsGetFollow(url, headers, onResponse, onError, depth) {
  if ((depth || 0) > 5) { onError(new Error("重定向次数过多")); return null; }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) { onError(new Error("下载地址无效")); return null; }
  if (parsed.protocol !== "https:") { onError(new Error("只允许 https 下载")); return null; }
  if (!ALLOWED_DOWNLOAD_HOSTS.test(parsed.hostname)) {
    onError(new Error("下载地址不在允许的域名内：" + parsed.hostname));
    return null;
  }

  const req = https.get(url, { headers: headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
    const code = res.statusCode;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume();
      // 相对跳转也要能处理
      const next = new URL(res.headers.location, url).toString();
      httpsGetFollow(next, headers, onResponse, onError, (depth || 0) + 1);
      return;
    }
    // 206 = 续传成功；200 = 从头开始（服务端忽略了 Range）
    if (code !== 200 && code !== 206) {
      res.resume();
      onError(new Error("下载失败：HTTP " + code));
      return;
    }
    onResponse(res);
  });
  req.on("timeout", () => { try { req.destroy(); } catch (e) {} onError(new Error("连接超时")); });
  req.on("error", (e) => onError(e instanceof Error ? e : new Error(String(e))));
  return req;
}

function downloadState() {
  if (!download) return { status: "idle" };
  const out = {
    status: download.status,
    version: download.version,
    receivedBytes: download.receivedBytes,
    totalBytes: download.totalBytes,
    percent: download.totalBytes
      ? Math.min(100, Math.round(download.receivedBytes / download.totalBytes * 100))
      : 0
  };
  if (download.status === "error") out.detail = download.detail;
  if (download.status === "ready") out.file = download.file;
  return out;
}

function cleanStage(keepFile) {
  try {
    if (!fs.existsSync(STAGE_DIR)) return;
    for (const name of fs.readdirSync(STAGE_DIR)) {
      const full = path.join(STAGE_DIR, name);
      if (keepFile && path.resolve(full) === path.resolve(keepFile)) continue;
      try { fs.unlinkSync(full); } catch (e) {}
    }
  } catch (e) {}
}

// 下载完成后必须确认这个包能装在当前 Postman 上。
// 直接读 asar 头里的 package.json，不解包——解包 155 MB 要几十秒还占磁盘。
// asar 格式：4B pickle 头 + 4B 头长度 + 4B 字符串长度 + 4B JSON 长度 + JSON + 文件区
function readAsarPackageJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
    const jsonSize = head.readUInt32LE(12);
    if (!jsonSize || jsonSize > 64 * 1024 * 1024) return null;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const baseOffset = 16 + Math.ceil(jsonSize / 4) * 4;
    const node = header.files && header.files["package.json"];
    if (!node || typeof node.offset === "undefined") return null;
    const size = Number(node.size);
    if (!size || size > 4 * 1024 * 1024) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, baseOffset + Number(node.offset));
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

async function startDownload() {
  if (download && (download.status === "downloading" || download.status === "verifying")) {
    return downloadState();
  }
  const prefs = readPrefs();
  if (!prefs.enabled) {
    return { status: "error", detail: "版本检查已关闭" };
  }
  // 必须有一次成功的检查结果，且确实有新版
  const info = await check(false);
  if (info.status !== "update-available") {
    return { status: "error", detail: "当前没有可下载的新版本" };
  }
  if (!info.asset || !info.asset.url) {
    return { status: "error", detail: "该版本没有提供 app.asar 资产，请到发布页手动下载" };
  }
  if (info.asset.size > MAX_ASSET_BYTES) {
    return { status: "error", detail: "资产体积异常（" + info.asset.size + " 字节）" };
  }

  try { fs.mkdirSync(STAGE_DIR, { recursive: true }); } catch (e) {}
  cleanStage(null);

  const target = path.join(STAGE_DIR, "app.asar." + String(info.latestVersion || "new").replace(/[^\w.-]/g, "") + ".download");
  const finalFile = path.join(STAGE_DIR, "app.asar." + String(info.latestVersion || "new").replace(/[^\w.-]/g, ""));

  download = {
    status: "downloading",
    version: info.latestVersion,
    receivedBytes: 0,
    totalBytes: info.asset.size || 0,
    file: null,
    detail: ""
  };

  // 下载在后台跑，IPC 立刻返回，渲染进程靠轮询 download-state 拿进度。
  (function run() {
    const fail = (msg) => {
      download = { status: "error", version: info.latestVersion, receivedBytes: 0, totalBytes: 0, detail: String(msg) };
      try { fs.unlinkSync(target); } catch (e) {}
    };

    // SHA-256 覆盖整个文件，而续传是分段拿的，所以落盘后从磁盘整体算，
    // 不做增量 hash —— 否则续传后校验和必然不符。
    const verify = () => {
      download.status = "verifying";
      let actualSize = 0;
      try { actualSize = fs.statSync(target).size; } catch (e) {}
      if (info.asset.size && actualSize !== info.asset.size) {
        fail("体积不符：预期 " + info.asset.size + "，实际 " + actualSize);
        return;
      }
      let digest = "";
      try {
        digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      } catch (e) {
        fail("无法读取下载文件进行校验：" + ((e && e.message) || e));
        return;
      }
      const expected = String(info.asset.digest || "").replace(/^sha256:/i, "").toLowerCase();
      if (expected && expected !== digest) {
        fail("校验和不符，文件可能损坏或被篡改");
        return;
      }
      const meta = readAsarPackageJson(target);
      if (!meta || meta.name !== "Postman" || !meta.version) {
        fail("下载的文件不是有效的 Postman app.asar");
        return;
      }
      const localVer = localVersion();
      if (localVer && meta.version !== localVer) {
        fail("该包对应 Postman " + meta.version + "，与本机 " + localVer +
          " 不一致，不能直接替换。请到发布页下载对应版本或使用完整绿色版。");
        return;
      }
      try {
        if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
        fs.renameSync(target, finalFile);
      } catch (e) {
        fail("无法完成暂存：" + ((e && e.message) || e));
        return;
      }
      cleanStage(finalFile);
      download = { status: "ready", version: info.latestVersion, receivedBytes: actualSize,
        totalBytes: actualSize, file: finalFile, sha256: digest, detail: "" };
    };
    /*__DL_TAIL__*/
    const startedAt = Date.now();
    let attempt = 0;

    // 断了就带 Range 从已落盘的字节数续传，而不是从头再来。
    // 155 MB 在代理或弱网下经常中途 aborted（2026-09-02 实测本机代理在 50% 处断）。
    const attemptOnce = () => {
      attempt += 1;
      let startAt = 0;
      try {
        startAt = fs.existsSync(target) ? fs.statSync(target).size : 0;
      } catch (e) { startAt = 0; }
      download.receivedBytes = startAt;

      const headers = { "User-Agent": "postman-zh-version-check" };
      if (startAt > 0) {
        headers.Range = "bytes=" + startAt + "-";
      }

      let out;
      try {
        // 续传要追加，首次要新建
        out = fs.createWriteStream(target, startAt > 0 ? { flags: "a" } : { flags: "w" });
      } catch (e) { fail("无法写入暂存目录：" + ((e && e.message) || e)); return; }

      let stallTimer = null;
      let settled = false;
      const clearTimers = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;
      };

      const retryOrFail = (reason) => {
        if (settled) return;
        settled = true;
        clearTimers();
        try { out.close(); } catch (e) {}
        // 总时长兜底：无论重试几次，超过 15 分钟就放弃
        if (Date.now() - startedAt > DOWNLOAD_TIMEOUT_MS) {
          fail("下载超时（超过 15 分钟）");
          return;
        }
        if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
          fail(reason + "（已重试 " + attempt + " 次）");
          return;
        }
        download.status = "downloading";
        setTimeout(attemptOnce, RETRY_DELAY_MS);
      };

      const req = httpsGetFollow(info.asset.url, headers, (res) => {
        // 服务端忽略 Range 时返回 200 且从头给，这时要丢掉已有内容重新落盘
        if (startAt > 0 && res.statusCode === 200) {
          try { out.close(); } catch (e) {}
          try { fs.unlinkSync(target); } catch (e) {}
          settled = true;
          clearTimers();
          res.destroy();
          download.receivedBytes = 0;
          setTimeout(attemptOnce, 0);
          return;
        }

        const declared = parseInt(res.headers["content-length"], 10);
        if (declared > 0) {
          // 206 的 content-length 只是本段长度，总长要加上已有部分
          download.totalBytes = info.asset.size || (startAt + declared);
        }

        const bumpStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            try { res.destroy(); } catch (e) {}
            retryOrFail("下载停滞超过 1 分钟");
          }, DOWNLOAD_STALL_MS);
        };
        bumpStall();

        res.on("data", (chunk) => {
          if (settled) return;
          download.receivedBytes += chunk.length;
          if (download.receivedBytes > MAX_ASSET_BYTES) {
            settled = true;
            clearTimers();
            try { res.destroy(); } catch (e) {}
            try { out.close(); } catch (e) {}
            fail("下载内容超过体积上限");
            return;
          }
          bumpStall();
        });

        res.pipe(out);

        out.on("error", (e) => {
          if (settled) return;
          settled = true;
          clearTimers();
          fail("写入失败：" + ((e && e.message) || e));
        });

        res.on("error", (e) => retryOrFail("网络中断：" + ((e && e.message) || e)));
        res.on("aborted", () => retryOrFail("网络中断：连接被中止"));

        out.on("finish", () => {
          if (settled) return;
          settled = true;
          clearTimers();
          // 收完了但字节数不够（服务端提前收尾）→ 继续续传
          let got = 0;
          try { got = fs.statSync(target).size; } catch (e) {}
          if (info.asset.size && got < info.asset.size) {
            if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
              fail("下载不完整：" + got + " / " + info.asset.size + " 字节");
              return;
            }
            download.status = "downloading";
            setTimeout(attemptOnce, RETRY_DELAY_MS);
            return;
          }
          verify();
        });
      }, (e) => retryOrFail((e && e.message) || String(e)), 0);

      if (!req) { try { out.close(); } catch (e) {} }
    };

    attemptOnce();
  })();

  return downloadState();
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
      // 有没有可直接下载的 app.asar 资产（绿色版 zip 要手动解压，不算）
      asset: latest.asset || null,
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

  // 下载：start 只启动并立刻返回，进度靠 state 轮询。
  // 渲染进程不传任何 URL 或路径进来，全部由本文件从 Release 元数据推出。
  ipcMain.handle("postman-zh:version-check:download", () => startDownload());
  ipcMain.handle("postman-zh:version-check:download-state", () => downloadState());
  ipcMain.handle("postman-zh:version-check:download-cancel", () => {
    if (download && download.status === "downloading") {
      download = { status: "idle" };
      cleanStage(null);
    }
    return downloadState();
  });
  // 打开暂存目录，让用户自己拿下载好的文件（不代替用户执行安装）
  ipcMain.handle("postman-zh:version-check:reveal", () => {
    try {
      const shell = require("electron").shell;
      if (download && download.status === "ready" && download.file) {
        shell.showItemInFolder(download.file);
      } else {
        shell.openPath(STAGE_DIR);
      }
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
  startDownload: startDownload,
  downloadState: downloadState,
  readAsarPackageJson: readAsarPackageJson,
  localVersion: localVersion,
  STAGE_DIR: STAGE_DIR
};


