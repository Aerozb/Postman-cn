#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { fileURLToPath } = require("url");
const { sanitizeDiagnosticReport } = require("./lib/诊断输出.js");
const { runVersionCheckTests } = require("./runtime/验证版本检查.js");
const { runVersionCheckUiTests } = require("./runtime/验证版本检查界面.js");
const { runOopifInjectTests } = require("./runtime/验证跨帧注入.js");
const { samples, evaluateTranslations } = require("./runtime/翻译回归样例.js");
const { connectCdp: connectSharedCdp } = require("./lib/CDP客户端.js");

const POSTMAN_PAGE_URL_RE = /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i;

const UPDATE_PATCH_MARKERS = [
  "postman-zh:update-guard",
  "__postmanZhUpdateGuard",
  "postman-zh:updates:get",
  'p("checkForUpdates"',
  'p("quitAndInstall"',
  "updates disabled by postman-zh",
  "update restart blocked by postman-zh"
];
const EXTERNAL_URL_PATCH_MARKERS = [
  "postmanZhPatchOpenExternalQuotes",
  "__postmanZhOpenExternalPatched",
  "openExternal=function"
];
const MAIN_MENU_PATCH_MARKERS = [
  "postmanZhLocalizeMenuTemplate",
  "Show DevTools (Current View)",
  "\\u663e\\u793a\\u5f00\\u53d1\\u8005\\u5de5\\u5177\\uff08\\u5f53\\u524d\\u89c6\\u56fe\\uff09",
  "View Logs in Explorer",
  "\\u5728\\u8d44\\u6e90\\u7ba1\\u7406\\u5668\\u4e2d\\u67e5\\u770b\\u65e5\\u5fd7"
];
// 汉化包自己的版本检查：main.js 里的 require 钩子 + 主进程实现文件里的 IPC 通道名。
// 与上面的 UPDATE_PATCH_MARKERS 无关——那个管 Postman 官方升级（默认关闭），
// 这个只查本汉化包有没有新版（默认开启，只提示不下载）。
const VERSION_CHECK_PATCH_MARKERS = [
  "postman-zh:version-check",
  "zh-version-check-main.js"
];
const VERSION_CHECK_IPC_MARKERS = [
  "postman-zh:version-check:get",
  "postman-zh:version-check:set",
  "postman-zh:version-check:check",
  "postman-zh:version-check:open"
];
// 跨站 iframe（OOPIF）汉化。为什么它必须是独立于 preload 的一条补丁：
// 2026-09-11 在 Electron 37.10.3（与 Postman 12.27.5 同版本）实测，
// webPreferences.preload 不会在独立进程的跨站子帧里运行（标记读回 null），
// 只有主进程侧 webFrameMain.executeJavaScript 能注进去。
// 这两条标记都出现在 main.js 的 require 钩子里，所以可以参与交叉比对。
const OOPIF_INJECT_PATCH_MARKERS = [
  "postman-zh:oopif-inject",
  "zh-oopif-inject-main.js"
];
// main.js 里应当出现的标记。安装阶段的临时 main.js 与 app.asar 互相比对时只能用这批
// ——见下面 MAIN_JS_PATCH_MARKERS 的说明。
const ALL_PATCH_MARKERS = Array.from(new Set([
  ...UPDATE_PATCH_MARKERS,
  ...EXTERNAL_URL_PATCH_MARKERS,
  ...MAIN_MENU_PATCH_MARKERS,
  ...VERSION_CHECK_PATCH_MARKERS,
  ...VERSION_CHECK_IPC_MARKERS,
  ...OOPIF_INJECT_PATCH_MARKERS
]));
// 交叉比对专用子集：VERSION_CHECK_IPC_MARKERS 在 js\zh-version-check-main.js 里，
// 那个文件打进 app.asar 但**不在** main.js 里。若把它们算进交叉比对，
// onlyInAppAsar 会永远列出这几条，看起来像安装不一致，其实是正常的。
const MAIN_JS_PATCH_MARKERS = Array.from(new Set([
  ...UPDATE_PATCH_MARKERS,
  ...EXTERNAL_URL_PATCH_MARKERS,
  ...MAIN_MENU_PATCH_MARKERS,
  ...VERSION_CHECK_PATCH_MARKERS,
  ...OOPIF_INJECT_PATCH_MARKERS
]));

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const SHOW_DETAILS = hasFlag("--details");

function isPostmanPageUrl(value) {
  return POSTMAN_PAGE_URL_RE.test(String(value || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeForConsole(value) {
  return JSON.stringify(sanitizeDiagnosticReport(value), null, 2);
}

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
    }
    return await response.json();
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`HTTP 请求超过 ${timeoutMs} 毫秒，已取消。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolvePortFile() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("未设置 APPDATA，无法定位 Postman 的 DevToolsActivePort。");
  }
  return path.join(appData, "Postman", "DevToolsActivePort");
}

function isPostmanAppDir(candidate) {
  return !!candidate &&
    fs.existsSync(path.join(candidate, "Postman.exe")) &&
    fs.existsSync(path.join(candidate, "resources", "app.asar"));
}

function normalizePath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalizeCase = (value) => {
    const normalized = normalizePath(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalizeCase(left) === normalizeCase(right);
}

function inferPostmanDirFromTarget(targetUrl) {
  if (!/^file:/i.test(String(targetUrl || ""))) return null;

  let filePath;
  try {
    filePath = path.normalize(fileURLToPath(new URL(targetUrl)));
  } catch (error) {
    throw new Error(`无法解析本地 Postman 目标网址：${targetUrl}。${error.message}`);
  }

  const marker = `${path.sep}resources${path.sep}app.asar`.toLowerCase();
  const index = filePath.toLowerCase().lastIndexOf(marker);
  if (index < 0) {
    throw new Error(
      `本地页面目标不在 app-*/resources/app.asar 中：${targetUrl}。` +
      "请从目标安装目录重新启动 Postman。"
    );
  }

  const suffix = filePath.slice(index + marker.length);
  if (suffix && !suffix.startsWith(path.sep)) {
    throw new Error(`目标网址中的 app.asar 页面路径无效：${targetUrl}`);
  }

  const inferred = normalizePath(filePath.slice(0, index));
  if (!/^app-.+/i.test(path.basename(inferred)) || !isPostmanAppDir(inferred)) {
    throw new Error(
      `本地页面目标解析到了无效的 Postman 版本目录：${inferred}。` +
      "请从目标安装目录重新启动 Postman。"
    );
  }
  return inferred;
}

function targetDesktopVersion(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl || ""));
    if (!/^https?:$/i.test(parsed.protocol) || !/desktop\.postman\.com$/i.test(parsed.hostname)) {
      return null;
    }
    const version = parsed.searchParams.get("desktopVersion");
    return version && /^\d+(?:\.\d+){1,3}$/.test(version) ? version : null;
  } catch (_) {
    return null;
  }
}

function discoverPostmanDirs(targetUrl) {
  const roots = [];
  const addRoot = (value) => {
    if (!value) return;
    const normalized = normalizePath(value);
    if (!roots.some((item) => samePath(item, normalized))) roots.push(normalized);
  };

  if (process.env.LOCALAPPDATA) {
    addRoot(path.join(process.env.LOCALAPPDATA, "Postman"));
    addRoot(path.join(process.env.LOCALAPPDATA, "Programs", "Postman"));
  }
  // Keep discovery bounded to the installation locations already used by the
  // start script and this repository; never scan an entire drive.
  let current = path.resolve(__dirname);
  while (current && current !== path.dirname(current)) {
    addRoot(current);
    current = path.dirname(current);
  }
  if (process.env.USERPROFILE) {
    addRoot(path.join(process.env.USERPROFILE, "Desktop"));
    addRoot(path.join(process.env.USERPROFILE, "Downloads"));
  }

  const version = targetDesktopVersion(targetUrl);
  const candidates = [];
  const readDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (_) {
      return [];
    }
  };
  const collectFrom = (root) => {
    for (const entry of readDirs(root)) {
      if (!/^app-.+/i.test(entry.name)) continue;
      if (version && entry.name.slice(4).toLowerCase() !== version.toLowerCase()) continue;
      const candidate = path.join(root, entry.name);
      if (isPostmanAppDir(candidate)) candidates.push(normalizePath(candidate));
    }
  };
  for (const root of roots) {
    collectFrom(root);
    // 安装根常常是搜索根下面一层（例如 Desktop\Postman\app-x.y.z），只多下降一层，
    // 且只看名字含 postman 的目录，保持扫描有界。
    for (const child of readDirs(root)) {
      if (/postman/i.test(child.name)) collectFrom(path.join(root, child.name));
    }
  }
  return Array.from(new Map(candidates.map((item) => [
    process.platform === "win32" ? item.toLowerCase() : item,
    item
  ])).values());
}

function resolvePostmanDirFromTargetVersion(explicitDir, targetUrl) {
  const version = targetDesktopVersion(targetUrl);
  if (!version) return null;
  const explicit = explicitDir ? normalizePath(explicitDir) : null;
  if (explicit && path.basename(explicit).slice(4).toLowerCase() !== version.toLowerCase()) return null;
  const candidates = discoverPostmanDirs(targetUrl);
  if (candidates.length !== 1) return null;
  if (explicit && !samePath(explicit, candidates[0])) return null;
  return {
    dir: explicit || candidates[0],
    method: explicit ? "explicit-and-target-version" : "target-version-unique",
    targetVersion: version,
    candidates
  };
}

function processRecordCandidates(record) {
  const candidates = [];
  if (record && record.ExecutablePath) {
    candidates.push(path.dirname(String(record.ExecutablePath)));
  }

  const commandLine = String(record && record.CommandLine || "");
  const appPathMatch = commandLine.match(/--app-path(?:=|\s+)(?:"([^"]+)"|([^\s]+))/i);
  const appAsar = appPathMatch && (appPathMatch[1] || appPathMatch[2]);
  if (appAsar && path.basename(appAsar).toLowerCase() === "app.asar") {
    candidates.push(path.dirname(path.dirname(appAsar)));
  }

  return candidates
    .map(normalizePath)
    .filter((candidate) => /^app-.+/i.test(path.basename(candidate)) && isPostmanAppDir(candidate));
}

function uniqueProcessCandidates(records) {
  const candidates = new Map();
  for (const record of records) {
    for (const candidate of processRecordCandidates(record)) {
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      const current = candidates.get(key) || { dir: candidate, processIds: [] };
      const processId = Number(record.ProcessId);
      if (Number.isInteger(processId) && !current.processIds.includes(processId)) {
        current.processIds.push(processId);
      }
      candidates.set(key, current);
    }
  }
  return Array.from(candidates.values());
}

function queryWindowsPostmanProcesses(port) {
  if (process.platform !== "win32") {
    return {
      ownerPids: [],
      processes: [],
      connectionError: "仅支持在 Windows 上绑定进程。",
      processError: null
    };
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error(`用于进程绑定的 DevTools 端口无效：${port}`);
  }

  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$portNumber = ${portNumber}`,
    "$connectionError = $null",
    "$processError = $null",
    "$ownerPids = @()",
    "$processes = @()",
    "try { $ownerPids = @(Get-NetTCPConnection -State Listen -LocalPort $portNumber -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { $connectionError = $_.Exception.Message }",
    "try { $processes = @(Get-CimInstance Win32_Process -Filter \"Name = 'Postman.exe'\" -ErrorAction Stop | Select-Object ProcessId, ExecutablePath, CommandLine) } catch { $processError = $_.Exception.Message }",
    "$result = [ordered]@{ ownerPids = @($ownerPids); processes = @($processes); connectionError = $connectionError; processError = $processError }",
    "$result | ConvertTo-Json -Depth 4 -Compress"
  ].join("; ");

  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
    ).trim();
    if (!output) {
      throw new Error("PowerShell 没有返回进程数据。");
    }
    const result = JSON.parse(output);
    result.ownerPids = Array.isArray(result.ownerPids) ? result.ownerPids : [];
    result.processes = Array.isArray(result.processes) ? result.processes : [];
    return result;
  } catch (error) {
    return {
      ownerPids: [],
      processes: [],
      connectionError: `查询 Windows 进程失败：${error.message}`,
      processError: null
    };
  }
}

function resolvePostmanDirFromProcess(port) {
  const query = queryWindowsPostmanProcesses(port);
  const ownerIds = new Set(query.ownerPids.map(Number).filter(Number.isInteger));
  const ownerRecords = query.processes.filter((record) => ownerIds.has(Number(record.ProcessId)));
  const ownerCandidates = uniqueProcessCandidates(ownerRecords);
  if (ownerCandidates.length === 1) {
    return {
      dir: ownerCandidates[0].dir,
      method: "devtools-port-owner",
      processIds: ownerCandidates[0].processIds,
      warnings: [query.connectionError, query.processError].filter(Boolean)
    };
  }

  const runningCandidates = uniqueProcessCandidates(query.processes);

  return {
    dir: null,
    method: "unresolved",
    ownerCandidates: ownerCandidates.map((item) => item.dir),
    runningCandidates: runningCandidates.map((item) => item.dir),
    warnings: [query.connectionError, query.processError].filter(Boolean)
  };
}

function assertPostmanDir(candidate, source) {
  const resolved = normalizePath(candidate);
  if (!/^app-.+/i.test(path.basename(resolved)) || !isPostmanAppDir(resolved)) {
    throw new Error(
      `${source} 不是有效的 Postman app-* 目录：${resolved}。` +
      "目录中应包含 Postman.exe 和 resources/app.asar。"
    );
  }
  return resolved;
}

function resolvePostmanDir(explicitDir, targetUrl, port) {
  const inferred = inferPostmanDirFromTarget(targetUrl);
  const explicit = explicitDir ? assertPostmanDir(explicitDir, "--postman-dir") : null;

  if (explicit && inferred && !samePath(explicit, inferred)) {
    throw new Error(
      `--postman-dir 指向 ${explicit}，但运行中的本地页面属于 ${inferred}。` +
      "不能混用两个安装目录的运行时结果和 app.asar。"
    );
  }
  if (explicit && inferred) {
    return { dir: explicit, method: "explicit-and-local-target" };
  }
  if (inferred) {
    return { dir: inferred, method: "local-target-url" };
  }

  const processBinding = resolvePostmanDirFromProcess(port);
  // Windows security policy can deny both WMI and TCP-owner queries even when
  // the caller can read the installation. In that case accept only a unique
  // app-* directory whose version exactly matches desktopVersion in the active
  // Postman page. Multiple matching installs remain an explicit failure.
  const targetVersionBinding = resolvePostmanDirFromTargetVersion(explicit, targetUrl);
  if (explicit && !processBinding.dir && targetVersionBinding) {
    return {
      ...targetVersionBinding,
      processBinding
    };
  }
  if (explicit) {
    if (!processBinding.dir) {
      const candidates = Array.from(new Set([
        ...(processBinding.ownerCandidates || []),
        ...(processBinding.runningCandidates || [])
      ]));
      const detail = candidates.length ? ` 候选目录：${candidates.join(", ")}。` : "";
      const warnings = processBinding.warnings && processBinding.warnings.length
        ? ` 进程查询错误：${processBinding.warnings.join(" | ")}。`
        : "";
      throw new Error(
        `无法通过监听中的 Postman 进程将 DevTools 端口 ${port} 绑定到 --postman-dir ${explicit}。${detail}${warnings} ` +
        "不能把运行时结果与未经确认的 app.asar 组合验证。"
      );
    }
    if (!samePath(explicit, processBinding.dir)) {
      throw new Error(
        `--postman-dir 指向 ${explicit}，但 DevTools 端口 ${port} 属于 ` +
        `${processBinding.dir}。不能混用两个 Postman 安装目录。`
      );
    }
    return {
      dir: explicit,
      method: "explicit-and-process",
      processBinding
    };
  }
  if (processBinding.dir) {
    return { ...processBinding };
  }

  if (targetVersionBinding) {
    return {
      ...targetVersionBinding,
      processBinding
    };
  }

  const candidates = Array.from(new Set([
    ...(processBinding.ownerCandidates || []),
    ...(processBinding.runningCandidates || [])
  ]));
  const detail = candidates.length ? ` 候选目录：${candidates.join(", ")}。` : "";
  const warnings = processBinding.warnings && processBinding.warnings.length
    ? ` 进程查询错误：${processBinding.warnings.join(" | ")}。`
    : "";
  throw new Error(
    `无法通过监听进程将 DevTools 端口 ${port} 唯一绑定到正在运行的 Postman 安装目录。${detail}${warnings} ` +
    "请重新启动 Postman，并确认 Windows 进程查询功能可用。"
  );
}

function scanFileForMarkers(filePath, markers) {
  const pending = markers.map((text) => ({ text, bytes: Buffer.from(text, "utf8") }));
  const found = new Set();
  const maxMarkerLength = Math.max(...pending.map((item) => item.bytes.length));
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let tail = Buffer.alloc(0);
  const handle = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(handle, chunk, 0, chunk.length, null)) > 0 && found.size < pending.length) {
      const current = chunk.subarray(0, bytesRead);
      const data = tail.length ? Buffer.concat([tail, current]) : current;
      for (const marker of pending) {
        if (!found.has(marker.text) && data.indexOf(marker.bytes) >= 0) {
          found.add(marker.text);
        }
      }
      const keep = Math.min(maxMarkerLength - 1, data.length);
      tail = keep > 0 ? Buffer.from(data.subarray(data.length - keep)) : Buffer.alloc(0);
    }
  } finally {
    fs.closeSync(handle);
  }
  return found;
}

function createPatchSource(postmanDir) {
  if (!postmanDir) {
    return { checked: false, reason: "找不到 Postman 版本目录。", includes: () => false };
  }
  const appAsar = path.join(postmanDir, "resources", "app.asar");
  if (!fs.existsSync(appAsar)) {
    return { checked: false, reason: `找不到 app.asar：${appAsar}`, includes: () => false };
  }

  // The packed app.asar is what Electron is currently executing. A leftover
  // installer tree is diagnostic only and must never make verification pass.
  const activeMarkers = scanFileForMarkers(appAsar, ALL_PATCH_MARKERS);
  const mainJs = path.join(postmanDir, "resources", "app.asar.unpacked.zh", "main.js");
  let temporaryCrossCheck = {
    checked: false,
    source: mainJs,
    reason: "不存在安装阶段的临时 main.js。"
  };
  if (fs.existsSync(mainJs)) {
    const temporaryMarkers = scanFileForMarkers(mainJs, MAIN_JS_PATCH_MARKERS);
    temporaryCrossCheck = {
      checked: true,
      source: mainJs,
      matchesAppAsar: MAIN_JS_PATCH_MARKERS.every((marker) => {
        return activeMarkers.has(marker) === temporaryMarkers.has(marker);
      }),
      onlyInTemporary: MAIN_JS_PATCH_MARKERS.filter((marker) => {
        return temporaryMarkers.has(marker) && !activeMarkers.has(marker);
      }),
      onlyInAppAsar: MAIN_JS_PATCH_MARKERS.filter((marker) => {
        return activeMarkers.has(marker) && !temporaryMarkers.has(marker);
      })
    };
  }

  return {
    checked: true,
    source: appAsar,
    temporaryCrossCheck,
    includes: (needle) => activeMarkers.has(needle)
  };
}

function inspectUpdatePatch(source) {
  if (!source.checked) {
    return { checked: false, installed: false, reason: source.reason };
  }
  // isUpdateEnabled is intentionally left untouched now; gating
  // downloadUpdate/restartAppToUpdate is what actually controls updates
  // while keeping the Settings > Update page functional.
  // The guard is a user-facing switch (default off), so we verify that it is
  // INSTALLED — not that updates are currently blocked. Whether they are
  // blocked right now depends on %APPDATA%\Postman\postman-zh-updates.json,
  // which the user owns via the Settings page toggle or `updates on|off`.
  const runtimeGuard = UPDATE_PATCH_MARKERS.slice(0, 5).every((needle) => source.includes(needle));
  const sourceOptimizations = {
    download: source.includes(UPDATE_PATCH_MARKERS[5]),
    restart: source.includes(UPDATE_PATCH_MARKERS[6])
  };
  return { checked: true, source: source.source, installed: runtimeGuard, runtimeGuard, sourceOptimizations };
}

function inspectExternalUrlPatch(source) {
  if (!source.checked) {
    return { checked: false, installed: false, reason: source.reason };
  }
  const installed = EXTERNAL_URL_PATCH_MARKERS.every((needle) => source.includes(needle));
  return { checked: true, source: source.source, installed };
}

function inspectMainMenuPatch(source) {
  if (!source.checked) {
    return { checked: false, installed: false, missing: [source.reason] };
  }
  const missing = MAIN_MENU_PATCH_MARKERS.filter((needle) => !source.includes(needle));
  return { checked: true, source: source.source, installed: missing.length === 0, missing };
}

// 汉化版本检查：main.js 的 require 钩子必须在，主进程实现文件的四个 IPC 通道也必须在。
// 只查「装没装」，不查「当前开没开」——后者由
// %APPDATA%\Postman\postman-zh-version-check.json 决定，用户自己在设置页控制。
function inspectVersionCheckPatch(source) {
  if (!source.checked) {
    return { checked: false, installed: false, missing: [source.reason] };
  }
  const missing = VERSION_CHECK_PATCH_MARKERS
    .concat(VERSION_CHECK_IPC_MARKERS)
    .filter((needle) => !source.includes(needle));
  return { checked: true, source: source.source, installed: missing.length === 0, missing };
}

// 跨站 iframe（OOPIF）汉化：main.js 的 require 钩子 + 被 require 的实现文件名。
// 两条标记都在 main.js 里，所以能参与临时 main.js 与 app.asar 的交叉比对。
// 只查「装没装」。这条补丁存在的理由见 OOPIF_INJECT_PATCH_MARKERS 上方注释：
// preload 进不去独立进程的跨站子帧，只有主进程侧注入能覆盖。
function inspectOopifInjectPatch(source) {
  if (!source.checked) {
    return { checked: false, installed: false, missing: [source.reason] };
  }
  const missing = OOPIF_INJECT_PATCH_MARKERS.filter((needle) => !source.includes(needle));
  return { checked: true, source: source.source, installed: missing.length === 0, missing };
}

const CONTEXT_TRANSITION_RE = /execution context was destroyed|cannot find (?:default )?(?:execution )?context|inspected target navigated/i;

async function connectCdp(wsUrl) {
  const cdp = await connectSharedCdp(wsUrl);
  return {
    ...cdp,
    async send(...args) {
      try { return await cdp.send(...args); } catch (error) {
        if (error.code !== "CDP_PROTOCOL") throw error;
        const details = SHOW_DETAILS ? " 诊断：" + JSON.stringify(sanitizeDiagnosticReport({ message: error.message, code: error.protocolCode, data: error.data })) : "";
        const wrapped = new Error("CDP 命令执行失败。" + details);
        wrapped.code = error.code;
        wrapped.contextTransition = CONTEXT_TRANSITION_RE.test(error.message);
        throw wrapped;
      }
    }
  };
}

async function waitForPostmanTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets;
      const pageTargets = targets.filter((item) => {
        return item.type === "page" &&
          item.webSocketDebuggerUrl &&
          !String(item.url || "").startsWith("devtools://");
      });
      const target = pageTargets.find((item) => {
        return isPostmanPageUrl(item.url);
      });
      if (target) {
        return target;
      }
    } catch (_) {}
    await sleep(1000);
  }
  const targetDetails = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(sanitizeDiagnosticReport(lastTargets))}` : "";
  throw new Error(`没有找到 Postman 页面目标。${targetDetails}`);
}

// 首次升级时页面目标可能已出现，但远端脚本和菜单管理器仍在加载。
// 只读轮询实际依赖；就绪前不创建探针，也不把缺少菜单当成可跳过项。
const VERIFICATION_READY_EXPRESSION = `(() => {
  const localizer = window.__POSTMAN_ZH_LOCALIZER__;
  const manager = window.pm && window.pm.contextMenuManager;
  return {
    documentReady: document.readyState !== "loading" && !!document.body,
    localizerReady: !!(localizer && typeof localizer.translate === "function" &&
      typeof localizer.walk === "function" &&
      document.documentElement.getAttribute("data-postman-zh-localized") === "true"),
    contextMenuReady: !!(manager && typeof manager.buildMenu === "function" &&
      manager.__postmanZhBuildMenuPatched === true)
  };
})()`;

async function waitForVerificationReady(cdp, timeoutMs, { now = Date.now, delay = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("页面就绪超时必须是正数。");
  }
  const deadline = now() + timeoutMs;
  let state = {};
  let lastReadError = null;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const response = await cdp.send("Runtime.evaluate", {
        expression: VERIFICATION_READY_EXPRESSION,
        returnByValue: true
      }, { timeoutMs: Math.min(5000, remaining) });
      state = response.exceptionDetails ? {} : response.result?.value || {};
      lastReadError = response.exceptionDetails ? { code: "PAGE_EVALUATION", message: "页面执行上下文尚未就绪" } : null;
      if (now() >= deadline) break;
      if (state.documentReady && state.localizerReady && state.contextMenuReady) return state;
    } catch (error) {
      // 导航切换上下文、单次读取超时可在同一预算内重试；连接断开立即失败。
      const contextTransition = error.code === "CDP_PROTOCOL" &&
        (error.contextTransition || CONTEXT_TRANSITION_RE.test(error.message));
      if (!contextTransition && error.code !== "CDP_TIMEOUT") throw error;
      state = {};
      lastReadError = { code: error.code, message: error.message };
    }
    const afterRead = deadline - now();
    if (afterRead > 0) await delay(Math.min(200, afterRead));
  }
  const missing = [
    !state.documentReady && "页面 DOM",
    !state.localizerReady && "汉化运行时",
    !state.contextMenuReady && "右键菜单汉化"
  ].filter(Boolean);
  const detail = missing.length ? missing.join("、") : "页面响应超出时间预算";
  const error = new Error(`等待 Postman 验证就绪超时（${timeoutMs} ms）：${detail}。`);
  error.code = "POSTMAN_READY_TIMEOUT";
  error.readiness = state;
  error.lastReadError = lastReadError;
  throw error;
}

async function main() {
  const versionCheckRegression = await runVersionCheckTests();
  const versionCheckUiRegression = await runVersionCheckUiTests();
  const oopifInjectRegression = await runOopifInjectTests();
  const timeoutMs = Number(argValue("--timeout-ms") || 30000);
  const explicitPostmanDir = argValue("--postman-dir");
  const expectUpdatesDisabled = hasFlag("--expect-updates-disabled");
  const portFile = resolvePortFile();

  if (!fs.existsSync(portFile)) {
    throw new Error(
      "找不到 DevToolsActivePort。请先通过 postman-zh.bat start 启动 Postman。"
    );
  }

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  if (!/^\d+$/.test(port)) {
    throw new Error(`DevTools 端口无效：${port}`);
  }

  const target = await waitForPostmanTarget(port, timeoutMs);
  const postmanDirResolution = resolvePostmanDir(explicitPostmanDir, target.url, port);
  const postmanDir = postmanDirResolution.dir;
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await waitForVerificationReady(cdp, timeoutMs);

    const expression = `(() => {
      const sampleData = ${JSON.stringify(samples)};
      const evaluateTranslations = ${evaluateTranslations.toString()};
      const { knownEnglish, translationProbeTargets, translationProbeExpectations, translationPreservationTargets } = sampleData;
      const menuEnglishPattern = /New Request|Duplicate Tab|Selected Tab|Recently Closed Tabs|Close Tab|Force Close|Close Other|Close All|Reveal in Sidebar|Clone|flow link|analytics/i;
      const bodyText = document.body ? document.body.innerText : "";
      const localizer = window.__POSTMAN_ZH_LOCALIZER__;
      const translationProbe = {
        available: !!(localizer && typeof localizer.translate === "function"),
        untranslated: [],
        englishHits: [],
        unexpectedTranslations: [],
        preservationFailures: [],
        keyValueEditor: {
          available: !!(localizer && typeof localizer.walk === "function" && document.body),
          headerActual: [],
          placeholderActual: [],
          dataActual: [],
          failures: []
        },
        compositeCards: {
          available: !!(localizer && typeof localizer.walk === "function" && document.body),
          actual: [],
          failures: []
        }
      };
      if (translationProbe.available) {
        Object.assign(translationProbe, evaluateTranslations(localizer, sampleData));

        if (translationProbe.keyValueEditor.available) {
          const fixture = document.createElement("div");
          fixture.hidden = true;
          fixture.setAttribute("data-postman-zh-validation", "key-value-editor");
          fixture.innerHTML = [
            '<div class="key-value-form-editor-sortable">',
            '  <div class="key-value-form-row header-row">',
            '    <span data-probe="header">Key</span>',
            '    <span data-probe="header">Value</span>',
            '    <span data-probe="header">Description</span>',
            '  </div>',
            '  <div class="key-value-form-row">',
            '    <span class="key-value-cell__placeholder" data-probe="placeholder">Key</span>',
            '    <span class="key-value-cell__placeholder" data-probe="placeholder">Value</span>',
            '    <span class="key-value-cell__placeholder" data-probe="placeholder">Description</span>',
            '  </div>',
            '  <div class="key-value-form-row">',
            '    <span data-probe="data">Key</span>',
            '    <span data-probe="data">Value</span>',
            '    <span data-probe="data">Description</span>',
            '    <span data-probe="data">Selected</span>',
            '  </div>',
            '</div>'
          ].join("");
          document.body.appendChild(fixture);
          try {
            localizer.walk(fixture);
            const values = (selector) => Array.from(fixture.querySelectorAll(selector)).map((el) => el.textContent);
            translationProbe.keyValueEditor.headerActual = values('[data-probe="header"]');
            translationProbe.keyValueEditor.placeholderActual = values('[data-probe="placeholder"]');
            translationProbe.keyValueEditor.dataActual = values('[data-probe="data"]');
            const expectations = [
              ["header", translationProbe.keyValueEditor.headerActual, ["键", "值", "描述"]],
              ["placeholder", translationProbe.keyValueEditor.placeholderActual, ["键", "值", "描述"]],
              ["data", translationProbe.keyValueEditor.dataActual, ["Key", "Value", "Description", "Selected"]]
            ];
            for (const [scope, actual, expected] of expectations) {
              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                translationProbe.keyValueEditor.failures.push({ scope, expected, actual });
              }
            }
          } finally {
            fixture.remove();
          }
        } else {
          translationProbe.keyValueEditor.failures.push({
            scope: "fixture",
            expected: "可调用的 walk() 和 document.body",
            actual: "不可用"
          });
        }

        if (translationProbe.compositeCards.available) {
          const fixture = document.createElement("div");
          fixture.hidden = true;
          fixture.setAttribute("data-postman-zh-validation", "composite-cards");
          fixture.innerHTML = [
            '<p data-probe="composite"><span>Collaborate with </span><strong>unlimited</strong><span> teammates and assign the right access levels.</span></p>',
            '<p data-probe="composite"><span>Run all requests in </span><strong>your collections</strong><span> to efficiently test your endpoints</span></p>',
            '<div class="error-block"><h3 data-probe="composite">Check if your internet connection is stable. If you are using a firewall or a proxy server, disable it or whitelist <u>getpostman.com</u> and then retry. If the problem persists, try again after some time. (Error code: <span id="error-code">AUTH-01</span>)</h3></div>'
          ].join("");
          document.body.appendChild(fixture);
          try {
            const errorCodeNode = fixture.querySelector('#error-code');
            const domainNode = fixture.querySelector('u');
            localizer.walk(fixture);
            translationProbe.compositeCards.actual = Array.from(fixture.querySelectorAll('[data-probe="composite"]')).map((el) => el.textContent);
            const expected = [
              "与不限数量的团队成员协作，并分配适当的访问级别。",
              "运行集合中的所有请求，高效测试你的端点。",
              "请检查网络连接是否稳定。如果正在使用防火墙或代理服务器，请关闭它们或将 getpostman.com 加入白名单后重试。若问题仍然存在，请稍后再试。（错误代码：AUTH-01）"
            ];
            if (JSON.stringify(translationProbe.compositeCards.actual) !== JSON.stringify(expected)) {
              translationProbe.compositeCards.failures.push({ expected, actual: translationProbe.compositeCards.actual });
            }
            if (fixture.querySelector('#error-code') !== errorCodeNode || fixture.querySelector('u') !== domainNode) {
              translationProbe.compositeCards.failures.push({ scope: "auth-error-nodes", expected: "保留域名和动态错误码节点" });
            }
            errorCodeNode.textContent = "AUTH-02";
            localizer.walk(fixture);
            if (errorCodeNode.parentElement.textContent !== expected[2].replace("AUTH-01", "AUTH-02")) {
              translationProbe.compositeCards.failures.push({ scope: "auth-error-refresh", expected: "错误码更新后保持中文段落" });
            }
          } finally {
            fixture.remove();
          }
        } else {
          translationProbe.compositeCards.failures.push({
            scope: "fixture",
            expected: "可调用的 walk() 和 document.body",
            actual: "不可用"
          });
        }
      } else {
        translationProbe.untranslated = translationProbeTargets;
        translationProbe.englishHits = translationProbeTargets.map((text) => ({ input: text, output: text, hits: ["翻译探针不可用"] }));
        translationProbe.unexpectedTranslations = translationProbeExpectations.map(([input, expected]) => ({ input, expected, output: input }));
        translationProbe.preservationFailures = translationPreservationTargets.map((input) => ({ input, output: "翻译探针不可用" }));
        translationProbe.compositeCards.failures.push({ scope: "fixture", expected: "复合卡片翻译探针可用", actual: "不可用" });
      }
      const tabs = Array.from(document.querySelectorAll("[data-tab-id]")).slice(0, 10).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: el.innerText || "",
          tabId: el.dataset && el.dataset.tabId || "",
          className: String(el.className || ""),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      });
      const output = {
        url: location.href,
        title: document.title,
        localized: document.documentElement.getAttribute("data-postman-zh-localized"),
        bodyEnglishHits: knownEnglish.filter((text) => bodyText.includes(text)),
        translationProbe,
        tabs,
        managerPatched: false,
        contextMenuSkipped: false,
        menuLabels: null,
        menuEnglishHits: null,
        error: null
      };

      try {
        const manager = window.pm && window.pm.contextMenuManager;
        output.managerPatched = !!(manager && manager.__postmanZhBuildMenuPatched);
        const target = tabs.length ? Array.from(document.querySelectorAll("[data-tab-id]")).find((el) => /GET/.test(el.innerText || "")) || document.querySelector("[data-tab-id]") : null;
        if (!manager || typeof manager.buildMenu !== "function") {
          output.error = "右键菜单管理器不可用。";
        } else if (!target) {
          output.contextMenuSkipped = true;
          output.menuLabels = [];
          output.menuEnglishHits = [];
        } else {
          const rect = target.getBoundingClientRect();
          const eventLike = {
            target,
            clientX: rect.left + Math.min(30, rect.width / 2),
            clientY: rect.top + Math.min(10, rect.height / 2),
            preventDefault() {},
            stopPropagation() {}
          };
          const menu = manager.buildMenu(eventLike);
          output.menuLabels = menu && menu.items ? Array.from(menu.items).map((item) => item.label || "") : [];
          output.menuEnglishHits = output.menuLabels.filter((label) => menuEnglishPattern.test(label || ""));
        }
      } catch (error) {
        output.error = String(error && error.message || error);
      }
      return output;
    })()`;

    try {
      new Function(`return ${expression};`);
    } catch (error) {
      throw new Error(`验证器生成的浏览器代码存在语法错误：${error.message}`);
    }

    const evaluation = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (evaluation.exceptionDetails) {
      const evaluationDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(evaluation.exceptionDetails))}` : "";
      throw new Error(`Postman 页面执行验证代码时返回异常${evaluationDetails}`);
    }

    const result = evaluation.result && evaluation.result.value;
    if (!result) {
      throw new Error("Postman 没有返回验证结果。");
    }
    const patchSource = createPatchSource(postmanDir);
    result.postmanDir = postmanDir;
    result.postmanDirResolution = postmanDirResolution;
    result.staticPatchSource = {
      checked: patchSource.checked,
      source: patchSource.source || null,
      reason: patchSource.reason || null,
      temporaryCrossCheck: patchSource.temporaryCrossCheck || null
    };
    result.updatePatch = inspectUpdatePatch(patchSource);
    result.externalUrlPatch = inspectExternalUrlPatch(patchSource);
    result.mainMenuPatch = inspectMainMenuPatch(patchSource);
    result.versionCheckPatch = inspectVersionCheckPatch(patchSource);
    result.oopifInjectPatch = inspectOopifInjectPatch(patchSource);
    result.versionCheckRegression = versionCheckRegression;
    result.versionCheckUiRegression = versionCheckUiRegression;
    result.oopifInjectRegression = oopifInjectRegression;

    const failures = [];
    if (result.localized !== "true") {
      failures.push("data-postman-zh-localized 标记不是 true。");
    }
    if (/\bMy Workspace\b|\bTeam Workspace\b|\bPersonal Workspace\b/.test(result.title || "")) {
      failures.push(`标题中仍有英文：${result.title}`);
    }
    if (result.bodyEnglishHits && result.bodyEnglishHits.length) {
      failures.push(`页面正文中仍有英文：${result.bodyEnglishHits.join(", ")}`);
    }
    if (!result.translationProbe || !result.translationProbe.available) {
      failures.push("翻译探针不可用。");
    } else {
      if (result.translationProbe.untranslated && result.translationProbe.untranslated.length) {
        failures.push(`翻译探针发现未翻译文案：${result.translationProbe.untranslated.join(", ")}`);
      }
      if (result.translationProbe.englishHits && result.translationProbe.englishHits.length) {
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.translationProbe.englishHits))}` : "";
        failures.push(`翻译探针发现英文残留${probeDetails}`);
      }
      if (result.translationProbe.unexpectedTranslations && result.translationProbe.unexpectedTranslations.length) {
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.translationProbe.unexpectedTranslations))}` : "";
        failures.push(`技术词混排翻译结果不符合预期（${result.translationProbe.unexpectedTranslations.length} 项）${probeDetails}`);
      }
      if (result.translationProbe.preservationFailures && result.translationProbe.preservationFailures.length) {
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.translationProbe.preservationFailures))}` : "";
        failures.push(`标识符或不完整动态短语被误翻（${result.translationProbe.preservationFailures.length} 项）${probeDetails}`);
      }
      if (!result.translationProbe.keyValueEditor || result.translationProbe.keyValueEditor.failures.length) {
        const keyValueFailures = result.translationProbe.keyValueEditor && result.translationProbe.keyValueEditor.failures || [];
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(keyValueFailures))}` : "";
        failures.push(`键值编辑器表头翻译或数据保护异常${probeDetails}`);
      }
      if (!result.translationProbe.compositeCards || result.translationProbe.compositeCards.failures.length) {
        const compositeFailures = result.translationProbe.compositeCards && result.translationProbe.compositeCards.failures || [];
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(compositeFailures))}` : "";
        failures.push(`复合卡片文案翻译异常${probeDetails}`);
      }
    }
    if (result.error) {
      failures.push(result.error);
    }
    if (result.menuEnglishHits && result.menuEnglishHits.length) {
      failures.push(`右键菜单中仍有英文：${result.menuEnglishHits.join(", ")}`);
    }
    if (!result.contextMenuSkipped && (!Array.isArray(result.menuLabels) || !result.menuLabels.length)) {
      failures.push("没有采集到右键菜单文案。");
    }
    if (expectUpdatesDisabled && (!result.updatePatch || !result.updatePatch.installed)) {
      const updateDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.updatePatch))}` : "";
      failures.push(`自动更新守卫未安装${updateDetails}`);
    }
    if (!result.externalUrlPatch || !result.externalUrlPatch.installed) {
      const externalUrlDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.externalUrlPatch))}` : "";
      failures.push(`外部链接引号补丁未安装${externalUrlDetails}`);
    }
    if (!result.mainMenuPatch || !result.mainMenuPatch.installed) {
      const mainMenuDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.mainMenuPatch))}` : "";
      failures.push(`应用菜单汉化补丁不完整${mainMenuDetails}`);
    }
    if (!result.versionCheckPatch || !result.versionCheckPatch.installed) {
      const versionCheckDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.versionCheckPatch))}` : "";
      failures.push(`汉化版本检查补丁未安装${versionCheckDetails}`);
    }
    if (!result.oopifInjectPatch || !result.oopifInjectPatch.installed) {
      const oopifDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeDiagnosticReport(result.oopifInjectPatch))}` : "";
      failures.push(`跨站 iframe 汉化补丁未安装${oopifDetails}`);
    }

    if (SHOW_DETAILS) {
      console.log("汉化验证详情：");
      console.log(escapeForConsole(result));
    }

    if (failures.length) {
      console.error("[Postman 汉化] 验证失败");
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      console.error("需要完整诊断时，请运行 postman-zh.bat verify --details。");
      process.exit(1);
    }

    console.log("[Postman 汉化] 验证通过");
  } finally {
    cdp.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[Postman 汉化] 验证过程出错");
    const message = error && error.message ? error.message : String(error);
    console.error(`- ${message}`);
    if (SHOW_DETAILS) {
      console.error(JSON.stringify(sanitizeDiagnosticReport({
        ok: false, error: message, readiness: error.readiness, lastReadError: error.lastReadError
      }), null, 2));
    } else {
      console.error("需要完整诊断时，请运行 postman-zh.bat verify --details。");
    }
    process.exit(1);
  });
}

module.exports = {
  createPatchSource,
  inferPostmanDirFromTarget,
  isPostmanPageUrl,
  inspectExternalUrlPatch,
  inspectMainMenuPatch,
  inspectUpdatePatch,
  inspectVersionCheckPatch,
  inspectOopifInjectPatch,
  resolvePostmanDir,
  resolvePostmanDirFromProcess,
  targetDesktopVersion,
  discoverPostmanDirs,
  resolvePostmanDirFromTargetVersion,
  scanFileForMarkers,
  waitForVerificationReady,
  VERIFICATION_READY_EXPRESSION
};
