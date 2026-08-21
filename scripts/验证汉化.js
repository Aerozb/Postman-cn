#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { fileURLToPath } = require("url");
const { sanitizeAuditReport } = require("./audit/审计安全.js");

const POSTMAN_PAGE_URL_RE = /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i;

const UPDATE_PATCH_MARKERS = [
  "postman-zh:update-guard",
  "__postmanZhUpdatesDisabled",
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
const ALL_PATCH_MARKERS = Array.from(new Set([
  ...UPDATE_PATCH_MARKERS,
  ...EXTERNAL_URL_PATCH_MARKERS,
  ...MAIN_MENU_PATCH_MARKERS
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
  return JSON.stringify(sanitizeAuditReport(value), null, 2);
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

  if (process.env.LOCALAPPDATA) addRoot(path.join(process.env.LOCALAPPDATA, "Postman"));
  // Keep discovery bounded to the installation locations already used by the
  // start script and this repository; never scan an entire drive.
  let current = path.resolve(__dirname);
  while (current && current !== path.dirname(current)) {
    addRoot(current);
    current = path.dirname(current);
  }

  const version = targetDesktopVersion(targetUrl);
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^app-.+/i.test(entry.name)) continue;
      if (version && entry.name.slice(4).toLowerCase() !== version.toLowerCase()) continue;
      const candidate = path.join(root, entry.name);
      if (isPostmanAppDir(candidate)) candidates.push(normalizePath(candidate));
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
    const temporaryMarkers = scanFileForMarkers(mainJs, ALL_PATCH_MARKERS);
    temporaryCrossCheck = {
      checked: true,
      source: mainJs,
      matchesAppAsar: ALL_PATCH_MARKERS.every((marker) => {
        return activeMarkers.has(marker) === temporaryMarkers.has(marker);
      }),
      onlyInTemporary: ALL_PATCH_MARKERS.filter((marker) => {
        return temporaryMarkers.has(marker) && !activeMarkers.has(marker);
      }),
      onlyInAppAsar: ALL_PATCH_MARKERS.filter((marker) => {
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
    return { checked: false, disabled: false, reason: source.reason };
  }
  // isUpdateEnabled is intentionally left untouched now; blocking
  // downloadUpdate/restartAppToUpdate is what actually prevents updates
  // while keeping the Settings > Update page functional.
  const runtimeGuard = UPDATE_PATCH_MARKERS.slice(0, 4).every((needle) => source.includes(needle));
  const sourceOptimizations = {
    download: source.includes(UPDATE_PATCH_MARKERS[4]),
    restart: source.includes(UPDATE_PATCH_MARKERS[5])
  };
  return { checked: true, source: source.source, disabled: runtimeGuard, runtimeGuard, sourceOptimizations };
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

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      reject(new Error("连接 CDP WebSocket 超时。"));
    }, 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("连接 CDP WebSocket 失败。"));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(callbacks.timer);
    if (message.error) {
      const details = SHOW_DETAILS
        ? ` 诊断：${JSON.stringify(sanitizeAuditReport(message.error))}`
        : "";
      callbacks.reject(new Error(`CDP 命令执行失败。${details}`));
    } else {
      callbacks.resolve(message.result);
    }
  });

  const rejectPending = () => {
    for (const callbacks of pending.values()) {
      clearTimeout(callbacks.timer);
      callbacks.reject(new Error("CDP 连接已关闭。"));
    }
    pending.clear();
  };
  ws.addEventListener("close", rejectPending);

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 命令执行超时：${method}`));
          }
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      rejectPending();
      try {
        ws.close();
      } catch (_) {}
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
  const targetDetails = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(sanitizeAuditReport(lastTargets))}` : "";
  throw new Error(`没有找到 Postman 页面目标。${targetDetails}`);
}

async function main() {
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
    await sleep(1500);

    const expression = `(() => {
      const knownEnglish = [
        "Duplicate Tab",
        "Force Close All Tabs",
        "Reveal in Sidebar",
        "New Environment",
        "New Request",
        "Untitled Request",
        "Clone",
        "Copy flow link",
        "View analytics",
        "Confirm force close",
        "Force Close",
        "Establish a connection to send and receive messages.",
        "Type to filter",
        "Send request to get a response",
        "Agent Mode is not available for your account. Contact your team admin for more.",
        "You can enable Agent Mode for your team. Access can be revoked in the product access page.",
        "Add documentation to help others get started…",
        "Want to learn more about Enterprise Trial?",
        "Your Enterprise Trial ends in 28 days",
        "Take the next step to continue without interruption",
        "Your team grew to 1 teammates",
        "Keep your team working together",
        "Contact us",
        "You can take this action when you're back online.",
        "You do not have permission to add items",
        "You cannot create a flow when you’re offline.",
        "You cannot create an environment when you’re offline.",
        "You need to be online to create a webhook.",
        "You cannot create a collection when you’re offline.",
        "You cannot create a monitor when you're offline.",
        "You cannot create an insights project when you're offline.",
        "You cannot generate an SDK when you're offline.",
        "People in the workspace",
        "Start live session",
        "Unknown Item",
        "RECENTLY VIEWED",
        "Add workspaces to the Private API Network",
        "Make workspaces easily discoverable for your team by adding them to the network.",
        "Welcome to the Private API Network",
        "This is a central directory of all workspaces in your organization. Your teams can discover available workspaces and use tags to organize and find them easily.",
        "Request workspaces from where you build",
        "Add workspaces directly from where you create and manage them.",
        "Get quick approvals from designated managers",
        "Add comments and let Team Managers and Network Managers help review and curate workspaces with intent.",
        "Added workspaces",
        "Review",
        "Last 100 runs",
        "Run by",
        "Run status",
        "Source",
        "Start time",
        "Duration",
        "All tests",
        "Passed",
        "Skipped",
        "Avg. Resp. Time",
        "Your collection has not been run yet",
        "Runs triggered for this collection via",
        "and Postman CLI.",
        "No performance runs for this collection",
        "No scheduled runs for this collection",
        "No 计划运行 for this collection",
        "Choose how to run your performance test",
        "In the app",
        "Via the CLI",
        "Deselect All",
        "20 VUs",
        "10 mins",
        "Field cannot be empty",
        "Response Time",
        "Average",
        "Others",
        "Error %",
        "Requests per second",
        "is less than",
        "is greater than",
        "is less than equal to",
        "is greater than equal to",
        "Request Timeout",
        "Timeout for requests in milliseconds. Setting this to 0 will disable the timeout.",
        "Timeout for 请求s in milliseconds. Setting this to 0 will disable the timeout.",
        "Save request to share",
        "Save 请求 to share",
        "Before sharing this request, you need to save it to a collection.",
        "Before sharing this 请求, you need to save it to a collection.",
        "Save and Share",
        "Verify server certificate when connecting over a secure connection.",
        "Client version",
        "Choose client version that should be used for connecting with the server.",
        "Client version that will be used for connecting with the server.",
        "Handshake path",
        "Set the server path that should be used during the handshake request.",
        "Set the server path that should be used during the handshake 请求.",
        "Server path that will be used during the handshake request.",
        "Server path that will be used during the 握手请求.",
        "Handshake request timeout",
        "Handshake 请求 timeout",
        "Set how long the handshake request should wait before timing out in milliseconds. To never time out, set to 0.",
        "Set how long the handshake 请求 should wait before timing out in milliseconds. To never time out, set to 0.",
        "Reconnection attempts",
        "Maximum reconnection attempts when the connection closes abruptly.",
        "Reconnection intervals",
        "Interval between each reconnection attempt in milliseconds.",
        "No variables used yet. Learn more about variables.",
        "No variables used yet. 了解更多： variables.",
        "Prepend // to any row you want to add but keep disabled",
        "前置 // to any row you want to add but 保持禁用",
        "Share collection",
        "More Actions",
        "Enter name, group name or email...",
        "can view collection via link",
        "Include environment",
        "Collaborate with your teammates in real time.",
        "With Postman's Enterprise Trial,",
        "you can share with unlimited teammates",
        "Select from computer",
        "Files uploaded to this workspace",
        "No files uploaded yet. Upload files to this workspace to share and reuse test data.",
        "Loading runs",
        "Periodic runs scheduled on the Postman Cloud.",
        "Upcoming run",
        "Simulate real-world traffic from your local machine and observe the performance of your APIs.",
        "You can schedule runs for this collection to periodically run it at a certain time or frequency on the Postman Cloud.",
        "Performance test runs for this collection.",
        "性能 test runs for this collection.",
        "Result",
        "Total requests",
        "Requests/s",
        "Resp. time (Avg ms)",
        "createdBy",
        "Run options",
        "Run performance Test",
        "Run 性能 Test",
        "Share all",
        "Reset all",
        "Show as column",
        "Shared Value",
        "Completed",
        "Aborted",
        "SDKS",
        "SDKs",
        "Create Fork",
        "创建 Fork",
        "This authorization method will be used for every request in this collection. You can override this by specifying one in the request.",
        "This collection does not use any authorization.",
        "This collection 不使用任何授权.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "You need to be online to access all features in this workspace.",
        "scheduled-collection-runs-table-Table Body",
        "performance-runs-runs-table-Table Body",
        "No variables defined in this collection.",
        "This variable is overwritten by a duplicated key",
        "Share value with teammates and use it with monitors and scheduled runs.",
        "Share value with teammates and use it with monitors and 计划运行.",
        "Search Variables",
        "Write description",
        "Use JavaScript to configure requests dynamically.",
        "设置 vault",
        "There are no forks",
        "All forks created from this collection will appear here. Learn more:",
        "Source collection",
        "Forking creates a copy of the collection and enables you to perform changes without affecting the original. Learn more:",
        "Fork label",
        "Specify a label to distinguish this fork from the original collection.",
        "The fork will be created in the selected workspace.",
        "Environment to fork",
        "环境 to fork",
        "Selected environments will be forked and pinned for this collection.",
        "Select environments",
        "选择环境s",
        "Auto-pull changes",
        "Auto-pull changes from source collection",
        "Watch source collection to get notified of updates",
        "Watch forked collection to get notified of updates",
        "You'll be notified about changes made to the original collection.",
        "press Space or Enter to open",
        "Fork Collection",
        "No watchers",
        "People who watch this collection will show up here.",
        "Pull requests",
        "There are no pull requests",
        "Once a pull request is created for this collection, you will be able to manage it from here. Learn more:",
        "Ask questions or provide feedback. Use @mention to notify people.",
        "Filter comments",
        "Reload Changelog",
        "Collapse changelog for June 1, 2026",
        "Nested changelog entries",
        "查看 user information (1 user)",
        "1 change made:",
        "2 changes made:",
        "Branded, customizable developer docs",
        "Write guides in markdown (docs-as-code)",
        "Consumable by AI agents",
        "Fern is a Postman company.",
        "Generate SDK",
        "No collections or specifications found. Create a collection or specification to get started with SDK generation.",
        "Active webhook",
        "New Webhook",
        "Receive a Mock Event",
        "Webhook details",
        "Every hour",
        "Integrations will be created after you save monitor",
        "More templates",
        "Speed up your work with collection templates",
        "Postman has encountered an error. Learn more",
        "Enter vault key",
        "Set active",
        "Sign up to save your work remotely",
        "You are currently using the lightweight API Client. Sign in or create an account to save and back up your work into a workspace.",
        "to unlock this feature",
        "Workspaces help you stay organized and collaborate with your teammates.",
        "Recently Closed Tabs",
        "Duplicate Selected Tab",
        "Close Selected Tab",
        "Close All but Selected Tab"
      ];
      const translationProbeTargets = [
        "Search resources",
        "Search 资源",
        "button",
        "Build faster with environments thumbnail",
        "Invite and assign roles thumbnail",
        "Test your entire collection thumbnail",
        "Build faster with environments",
        "Create environments for Team Workspace to save your long API keys or passwords.",
        "Invite and assign roles",
        "Collaborate with unlimited teammates and assign the right access levels.",
        "Run all requests in your collections to efficiently test your endpoints",
        "Set up a first test for it",
        "设置 a first test for it",
        "In this Workspace",
        "Add collection-wide smoke checks",
        "Use Overview to document what’s next",
        "Write a clear and well-structured collection description that briefly explains the purpose of this collection based on the elements it contains",
        "Pre-request scripts are written in JavaScript, and are run before the request is sent. Learn more:",
        "Pre-request scripts are written in JavaScript, and are run before the 请求 is sent. 了解更多：",
        "Pre-request scripts are written in JavaScript, and are run before the request is sent.",
        "Read less...Ctrl+Space",
        "Two pane view (Ctrl + Alt + V)",
        "Hide Sidebar (Ctrl+\\\\)",
        "Enter a URL or cURL command",
        "Get started by adding the API request URL or cURL command to test an endpoint. A URL typically has a base location and a path. For example, https://postman-echo.com/get.",
        "开始使用 by adding the API 请求 URL or cURL command to test an endpoint. A URL typically has a base location and a path. For example, https://postman-echo.com/get.",
        "Enter a URL or cURL command Get started by adding the API request URL or cURL command to test an endpoint. A URL typically has a base location and a path. For example, https://postman-echo.com/get.",
        "Enter a URL or cURL command 开始使用 by adding the API 请求 URL or cURL command to test an endpoint. A URL typically has a base location and a path. For example, https://postman-echo.com/get.",
        "Stay on top of your APIs",
        "Upgrade to enterprise for detailed reports on team productivity, API behavior, and performance.",
        "Upgrade to Enterprise",
        "Learn more about reporting",
        "No workspaces",
        "MQTT Request",
        "Collapse section",
        "Connect",
        "Connect to send and receive messages",
        "Establish a connection to send and receive messages.",
        "Type to filter",
        "Send request to get a response",
        "Agent Mode is not available for your account. Contact your team admin for more.",
        "智能代理模式 is not available for your account. Contact your team admin for more.",
        "You can enable Agent Mode for your team. Access can be revoked in the product access page.",
        "You can enable 智能代理模式 for your team. Access can be revoked in the product access page.",
        "Add documentation to help others get started…",
        "添加 documentation to help others get started…",
        "View guide",
        "查看 guide",
        "Want to learn more about Enterprise Trial?",
        "Your Enterprise Trial ends in 28 days",
        "Take the next step to continue without interruption",
        "Your team grew to 1 teammates",
        "Keep your team working together",
        "Contact us",
        "You’re using features that require a paid plan to continue",
        "Keep shared workspaces, collaboration, and access for your 1 teammates",
        "Team Members are part of example-workspace team",
        "团队成员 are part of example-workspace team",
        "Postman 的 Enterprise Trial",
        "Postman's Enterprise Trial",
        "Postman’s Enterprise Trial",
        "Share with unlimited teammates with",
        "Select dataset",
        "Select view",
        "Select a dataset and view in Test data to see data here.",
        "Global variables for a workspace are a set of variables that are always available within the scope of that workspace. They can be viewed and edited by anyone in that workspace.",
        "Global\u00a0variables\u00a0for\u00a0a\u00a0workspace\u00a0are\u00a0a\u00a0set\u00a0of\u00a0variables\u00a0that\u00a0are\u00a0always\u00a0available\u00a0within\u00a0the\u00a0scope\u00a0of\u00a0that\u00a0workspace.\u00a0They\u00a0can\u00a0be\u00a0viewed\u00a0and\u00a0edited\u00a0by\u00a0anyone\u00a0in\u00a0that\u00a0workspace.",
        "Learn more about globals",
        "Learn\u00a0more\u00a0about\u00a0globals",
        "了解更多： globals",
        "Describe what you want to do in the Private API Network.",
        "Loading Agent Mode...",
        "Loading 智能代理模式...",
        "Open Postbot",
        "option default, selected.",
        "选项 default 已选中。",
        "are part of",
        "(You)",
        "can access",
        "Total:",
        "1 teammates",
        "Internal Workspaces",
        "用户 distribution over time",
        "A comprehensive view of your organization 分析 and metrics",
        "Active workspaces over time",
        "API requests",
        "API requests by response code",
        "API requests sent by users",
        "Current Usage (Last 30 days)",
        "Elements in workspaces over time",
        "Explore Postman API",
        "Monthly snapshot",
        "Open Postman Public API",
        "Open Postman Public Workspace",
        "Percentage",
        "Team member engagement over time",
        "Top 5 active users by API requests sent",
        "Top 5 collections by API requests sent",
        "Top 5 workspaces by API requests sent",
        "Total number",
        "Usage Trends Over Time (Feb - Aug 2026)",
        "Use Postman APIs to access this report’s data.",
        "Users who used Postman at least once",
        "Workspace with views, creates, edits, or made API requests",
        "System Environments",
        "Only members with the API Catalog Manager role can access Service discovery page",
        "Generate SDK",
        "Generate SDKs",
        "SDKS",
        "SDKs",
        "Create Fork",
        "创建 Fork",
        "This authorization method will be used for every request in this collection. You can override this by specifying one in the request.",
        "This collection does not use any authorization.",
        "This collection 不使用任何授权.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "No performance runs for this collection",
        "No scheduled runs for this collection",
        "No 计划运行 for this collection",
        "Choose how to run your performance test",
        "In the app",
        "Via the CLI",
        "Deselect All",
        "20 VUs",
        "10 mins",
        "Share collection",
        "More Actions",
        "Enter name, group name or email...",
        "can view collection via link",
        "Include environment",
        "Collaborate with your teammates in real time.",
        "With Postman's Enterprise Trial,",
        "you can share with unlimited teammates",
        "Select from computer",
        "Files uploaded to this workspace",
        "No files uploaded yet. Upload files to this workspace to share and reuse test data.",
        "Loading runs",
        "Periodic runs scheduled on the Postman Cloud.",
        "Upcoming run",
        "Simulate real-world traffic from your local machine and observe the performance of your APIs.",
        "You can schedule runs for this collection to periodically run it at a certain time or frequency on the Postman Cloud.",
        "Performance test runs for this collection.",
        "性能 test runs for this collection.",
        "Result",
        "Total requests",
        "Requests/s",
        "Resp. time (Avg ms)",
        "createdBy",
        "Run options",
        "Run performance Test",
        "Run 性能 Test",
        "Share all",
        "Reset all",
        "Show as column",
        "Shared Value",
        "Completed",
        "Aborted",
        "You need to be online to access all features in this workspace.",
        "scheduled-collection-runs-table-Table Body",
        "performance-runs-runs-table-Table Body",
        "No variables defined in this collection.",
        "This variable is overwritten by a duplicated key",
        "Share value with teammates and use it with monitors and scheduled runs.",
        "Share value with teammates and use it with monitors and 计划运行.",
        "Search Variables",
        "Write description",
        "Use JavaScript to configure requests dynamically.",
        "设置 vault",
        "There are no forks",
        "All forks created from this collection will appear here. Learn more:",
        "Source collection",
        "Forking creates a copy of the collection and enables you to perform changes without affecting the original. Learn more:",
        "Fork label",
        "Specify a label to distinguish this fork from the original collection.",
        "The fork will be created in the selected workspace.",
        "Environment to fork",
        "环境 to fork",
        "Selected environments will be forked and pinned for this collection.",
        "Select environments",
        "选择环境s",
        "Auto-pull changes",
        "Auto-pull changes from source collection",
        "Watch source collection to get notified of updates",
        "Watch forked collection to get notified of updates",
        "You'll be notified about changes made to the original collection.",
        "press Space or Enter to open",
        "Fork Collection",
        "No watchers",
        "People who watch this collection will show up here.",
        "Pull requests",
        "There are no pull requests",
        "Once a pull request is created for this collection, you will be able to manage it from here. Learn more:",
        "Ask questions or provide feedback. Use @mention to notify people.",
        "Filter comments",
        "Reload Changelog",
        "Collapse changelog for June 1, 2026",
        "Nested changelog entries",
        "查看 user information (1 user)",
        "1 change made:",
        "2 changes made:",
        "Branded, customizable developer docs",
        "Write guides in markdown (docs-as-code)",
        "Consumable by AI agents",
        "Fern is a Postman company.",
        "No collections or specifications found. Create a collection or specification to get started with SDK generation.",
        "Active webhook",
        "New Webhook",
        "Receive a Mock Event",
        "Webhook details",
        "Webhook events preview",
        "Every hour",
        "Hour timer",
        "Integrations will be created after you save monitor",
        "Notify a Slack or Microsoft Teams channel or chat",
        "More templates",
        "Speed up your work with collection templates",
        "Postman has encountered an error. Learn more",
        "Postman has encountered an error. 了解更多",
        "Private Network (0)",
        "Filter variables",
        "variable type",
        "variable values",
        "Share environment",
        "Set active",
        "Autosave changes to your requests and collections.",
        "Audit logs",
        "Postman keys",
        "Public elements",
        "Enter vault key",
        "Enter your vault key",
        "Reset vault",
        "Open Vault",
        "Set up HashiCorp integration",
        "Create Collection",
        "Create Specification",
        "Add description…",
        "Add new variable",
        "Created on",
        "Couldn't find the key?",
        "Looking to configure HashiCorp Vault for your team?",
        "Save this key to native password manager",
        "Store sensitive data in variable type secret to keep its values masked on the screen. Learn more:",
        "Work with the current value of a variable to prevent sharing sensitive values with your team. Learn more:",
        "Upgrade to the Team plan to share requests",
        "Upgrade to the Solo plan to access more features",
        "Upgrade to the Team plan to access more features",
        "Upgrade to the Enterprise plan to access more features",
        "Continue with Team Plan",
        "Continue with Solo Plan",
        "Continue with Enterprise Plan",
        "Advanced RBAC & organization controls",
        "Governance, audit logs & reporting",
        "Private runners (tests and Flows)",
        "Start Trial",
        "API monitoring",
        "Unlimited Collection Runner & Performance Testing runs",
        "Use mqtts:// to connect over TLS",
        "Hypertext Transfer Protocol (HTTP) is an application-layer protocol often used to build REST APIs. Test your HTTP API with an HTTP request.",
        "GraphQL is a query language for APIs that’s designed to provide the client with exactly the information it asks for. Test your GraphQL APIs with a GraphQL request.",
        "Test and customize Large Language Model (LLM) behaviors with custom instructions.",
        "The Model Context Protocol (MCP) is an open standard that enables developers to build secure, two-way connections between their data sources and AI-powered tools.",
        "gRPC is a highly performant RPC framework often used to build microservices. Test your gRPC APIs with a gRPC request.",
        "WebSocket enables real-time communication between the client and the server using a persistent communication channel. Test WebSocket based APIs with a WebSocket request.",
        "Socket.IO is a framework built on top of WebSocket to enable event driven client-server communication. Test Socket.IO based APIs with a Socket.IO request.",
        "MQTT is a lightweight messaging protocol widely used for the internet of things (IoT). Test MQTT based APIs with an MQTT request.",
        "Create a collection to organize, document and share your API requests with others.",
        "You are currently using the lightweight API Client. Sign in or create an account to organize your requests into collections and workspaces.",
        "Sign up to save your work remotely",
        "You are currently using the lightweight API Client. Sign in or create an account to save and back up your work into a workspace.",
        "Sign up to unlock this feature.",
        "注册 to unlock this feature.",
        "Workspaces help you stay organized and collaborate with your teammates.",
        "Recently Closed Tabs",
        "Duplicate Selected Tab",
        "Close Selected Tab",
        "Force Close Selected Tab",
        "强制关闭 Selected Tab",
        "Force 关闭选中的标签页",
        "Close All but Selected Tab",
        "Sign up to organize your work",
        "Search anything on the Public API Network",
        "搜索 anything on the Public API Network",
        "Search for anything on the Public API Network",
        "搜索 for anything on the Public API Network",
        "Search APIs on the Public API Network",
        "搜索 APIs on the Public API Network",
        "Search for APIs on the Public API Network",
        "搜索 for APIs on the Public API Network",
        "Search collections on the Public API Network",
        "搜索 collections on the Public API Network",
        "Search for collections on the Public API Network",
        "搜索 for collections on the Public API Network",
        "Search workspaces on the Public API Network",
        "搜索 workspaces on the Public API Network",
        "Search for workspaces on the Public API Network",
        "搜索 for workspaces on the Public API Network",
        "Search teams on the Public API Network",
        "搜索 teams on the Public API Network",
        "Search for teams on the Public API Network",
        "搜索 for teams on the Public API Network",
        "搜索 work pace  on the Public API Network",
        "Current",
        "Publisher",
        "Teams",
        "illustration-signIn",
        "You can take this action when you're back online.",
        "You can take this action when you’re back online.",
        "You do not have permission to add items",
        "You cannot create a flow when you’re offline.",
        "You cannot create an environment when you’re offline.",
        "You need to be online to create a webhook.",
        "You cannot create a collection when you’re offline.",
        "You cannot create a monitor when you're offline.",
        "You cannot create an insights project when you're offline.",
        "You cannot generate an SDK when you're offline.",
        "SETTINGS",
        "Request timeout in ms",
        "Max response size in MB",
        "Language detection",
        "Always open requests in new tab",
        "Allow reading files outside working directory",
        "Collaborate on files used in requests by sharing your working directory.",
        "Collaborate on files used in 请求s by sharing your working directory. 了解如何",
        "Expand connection configuration",
        "Personalize your Postman experience with a theme of your choice.",
        "System Default",
        "Manual",
        "Resize Request or Response Pane",
        "Alt + scroll",
        "Ctrl + 1 through Ctrl + 8",
        "through",
        "Rename Item",
        "重命名 Item",
        "Copy Item",
        "复制 Item",
        "Submit Modal",
        "Search Console",
        "Download Newman from npm",
        "CA Certificates",
        "Client Certificates",
        "Default Proxy Configuration",
        "Specify a proxy setting to act as an intermediary for requests sent through the Builder in Postman. These configurations do not apply to any Postman services.",
        "Use the system proxy",
        "Add a custom proxy configuration",
        "Automatically download major updates",
        "Checking for updates...",
        "Postman automatically downloads minor updates and bug fixes.",
        "Postman uses the system's proxy configurations by default to connect to any online services, or to send API requests.",
        "Respect HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.",
        "You're on Postman v12.12.3",
        "Privacy",
        "Define and use sets of variables across multiple API requests using environments.",
        "Schedule your Postman collections to run periodically using monitors.",
        "Create a webhook to receive and inspect requests.",
        "Get near real-time insights into your API performance.",
        "Flows let you visualize, test, and automate API workflows",
        "GraphQL Request",
        "AI Request",
        "MCP Request",
        "gRPC Request",
        "WebSocket request",
        "Explore data available from server",
        "Select a provider or enter URL",
        "Enter command or paste JSON config",
        "Compose message",
        "Expand messages pane",
        "Listen",
        "Add event",
        "添加 event",
        "Create Mock Server",
        "Mock server name",
        "Create Monitor",
        "Monitor name",
        "Unable to load webhooks",
        "Insights: Observability for your APIs and AI",
        "Welcome to Insights",
        "Clone",
        "Copy flow link",
        "View analytics",
        "复制 flow link",
        "查看 analytics ↗",
        "Confirm force close",
        "Force Close",
        "1 tab has unsaved changes. Your changes will be lost if you force close this tab. Are you sure you want to force close?",
        "1 tab has unsaved changes. Your changes will be lost if you force close this tab. 确定吗 you want to force close?",
        "10 tabs have 未保存的更改. 你的更改将会丢失 if you 强制关闭 these tabs. 确定吗 you want to 强制关闭?",
        "Run order",
        "Runner - 我的工作区",
        "Drag a collection or folder from your sidebar to get started",
        "Run Sequence",
        "Drag a collection from the sidebar to run",
        "Runner sends all your requests sequentially and gathers test results.",
        "Choose how to run your collection",
        "Schedule runs",
        "Periodically run collection at a specified time on the Postman Cloud.",
        "Automate runs via CLI",
        "Configure CLI command to run on your build pipeline.",
        "Run configuration",
        "Iterations",
        "No. of times to loop through the collection during the run.",
        "Test data file",
        "An interval delay before each request.",
        "Test your APIs with various inputs by uploading a dataset. Only JSON and CSV files are accepted.",
        "Persist responses for a session",
        "Responses are persisted only for a session and not saved permanently. Enabling this may impact performance for large collection runs.",
        "Turn off logs during run",
        "Turn off logging to the Postman Console to improve performance during the run",
        "Stop run if an error occurs",
        "Keep variable values",
        "Enabling this will write the value of the variables at the end of the run to its value in the session.",
        "Run collection without using stored cookies",
        "Save cookies after collection run",
        "Update the cookies stored in this session and save them to your cookie manager.",
        "Start run",
        "Functional",
        "Performance",
        "Scheduled",
        "Last 100 runs",
        "Run by",
        "Run status",
        "Source",
        "Start time",
        "Duration",
        "All tests",
        "Passed",
        "Skipped",
        "Avg. Resp. Time",
        "Your collection has not been run yet",
        "Runs triggered for this collection via",
        "and Postman CLI.",
        "Run this collection in the 集合运行器.",
        "Set your performance test",
        "设置 your performance test",
        "Load profile",
        "Virtual users",
        "Determines how the number of virtual users changes during the test.",
        "Each user runs the collection in parallel and repeatedly for the test duration.",
        "Test duration",
        "Data file enables you to assign unique datasets to each virtual user, simulating real-world scenarios.",
        "20 virtual users run for 10 minutes, each executing all requests sequentially.",
        "Set conditions to determine if the test passes or fails based on performance metrics.",
        "New Session - 我的工作区",
        "New proxy session",
        "Capture HTTPS traffic",
        "Use Postman 的 proxy to inspect HTTPS communication from your Android, iOS, Linux, macOS, and Windows devices and build client-side applications faster!",
        "System traffic",
        "Browser traffic",
        "Capture and inspect app traffic on your devices.",
        "To capture and inspect traffic on your browser, download Postman 的 interceptor extension.",
        "We'll request to install certificate the first time you start a proxy session.",
        "Start proxy session",
        "Internal Workspace",
        "Last activity",
        "Workspace ID:",
        "Toggle left sidebar Ctrl+" + String.fromCharCode(92),
        "Toggle bottom bar Ctrl+" + String.fromCharCode(96),
        "Toggle right sidebar Ctrl+Alt+" + String.fromCharCode(92),
        "Toggle switch, currently OFF",
        "Toggle switch, currently ON",
        "Almost there! We’re loading your Vault.",
        "Filter secrets",
        "Add new secret",
        "Allowed domains",
        "Store your sensitive data locally. Local Vault secrets work across workspaces, available only to you, stay local, and aren't synced.",
        "Add description",
        "Add Value",
        "Bottom bar",
        "Export globals",
        "Save request to a collection",
        "Save Untitled Request to a collection",
        "Document this request...",
        "QUERY",
        "GRAPHQL VARIABLES",
        "Define variables in JSON format to use in the query",
        "Auto Fetch",
        "Could not auto fetch. Make sure Authorization, URL & selected environment are valid. Check console for more details.",
        "Editor content",
        "Description only appears in Postman documentation and is not sent with your request.",
        "Key-Value Edit",
        "Rows are separated by new lines",
        "Keys and values are separated by :",
        "Prepend // to any row you want to add but keep disabled",
        "No request history",
        "Send the request and browse through its history.",
        "Clear response",
        "Auth Type",
        "Edit Auth in collection",
        "This request does not use any authorization.",
        "The authorization header will be automatically generated when you send the request. Learn more about authorization.",
        "Hawk Authentication",
        "AWS Signature",
        "NTLM Authentication",
        "Akamai EdgeGrid",
        "ASAP (Atlassian)",
        "New Chat",
        "Describe what you need. Press @ for context, / for Skills.",
        "Build APIs faster with AI!",
        "Start using 智能代理模式!",
        "Your plan includes 50 AI credits per month to use 智能代理模式.",
        "Your plan includes 50 AI credits per month 可用于智能代理模式。",
        "Share request",
        "Switch AI model",
        "Couldn’t initialize Agent Mode",
        "Looks like we couldn't initialize Agent Mode for you. Try restarting your app, or contact Postman Support at help@postman.com.",
        "Close dropdown",
        "Packages",
        "Snippets",
        "Presets",
        "Pre-request",
        "Post-response",
        "Pre-req",
        "Post-res",
        "Use JavaScript to write tests, visualize response, and more.",
        "Use JavaScript to write tests, visualize responses, and more.",
        "These headers will be automatically added and sent with the request. Click to view and modify these headers.",
        "Type a new method",
        "No new changes to save.",
        "Click Send to get a response",
        "DO YOU WANT TO SAVE?",
        "This tab Untitled Request has unsaved changes which will be lost if you choose to close it. Save these changes to avoid losing your work.",
        "This tab https://example.com 有未保存的更改 如果选择关闭，这些更改将会丢失。 保存这些更改 to avoid losing your work.",
        "has unsaved changes which will be lost if you choose to close it. Save these changes to avoid losing your work.",
        "有未保存的更改 如果选择关闭，这些更改将会丢失。 保存这些更改 to avoid losing your work.",
        "Always discard unsaved changes when closing a tab",
        "You'll no longer be prompted to save changes when closing a tab. You can change this anytime from your Settings.",
        "Discard changes",
        "Create account to save",
        "Local Vault",
        "Store your API secrets locally in vault.",
        "Workspace activity",
        "Recently closed",
        "Loading Folder...",
        "A workspace lets you organize and collaborate on APIs. Learn more about workspaces",
        "Learn More",
        "Workspace name",
        "Owned By",
        "Waiting for the crew... No connections yet!",
        "When you are invited to join external workspaces by your partners, they will appear here, ready for you to explore and collaborate.",
        "Make your APIs, collections, and workspaces easily discoverable for everyone in your organization.",
        "Upgrade to access the Private API Network",
        "The Private API Network is available on Enterprise plans. Upgrade your plan to unlock centralised API discovery for your organization.",
        "Add workspaces to the Private API Network",
        "Make workspaces easily discoverable for your team by adding them to the network.",
        "Welcome to the Private API Network",
        "This is a central directory of all workspaces in your organization. Your teams can discover available workspaces and use tags to organize and find them easily.",
        "Request workspaces from where you build",
        "Add workspaces directly from where you create and manage them.",
        "Get quick approvals from designated managers",
        "Add comments and let Team Managers and Network Managers help review and curate workspaces with intent.",
        "Added workspaces",
        "Review",
        "What's New",
        "Find out new updates or content from publishers and the community.",
        "Browse APIs",
        "New...",
        "Import...",
        "Exit",
        "Toggle Workbench",
        "Swap Left and Right Sidebar",
        "Reset Layout",
        "Go Back",
        "Go Forward",
        "Next Tab",
        "Previous Tab",
        "Show Postman Console",
        "Disable Hardware Acceleration",
        "Region Preference for New Accounts",
        "Use US Region by Default",
        "Use EU Region by Default",
        "Always Ask for Region Selection",
        "Trust and Security",
        "Github Issues",
        "GitHub Issues",
        "Build and test APIs within your team.",
        "Change",
        "People in the workspace",
        "People in this workspace",
        "Start live session",
        "Manage People",
        "Sidebar panels",
        "Customize which panels appear in the sidebar for everyone in this workspace.",
        "Workspace theme",
        "Make the workspace unique by having its theme reflect its content and your team's identity. These changes will reflect for all your members.",
        "Accent color",
        "Color for buttons and highlights.",
        "No color chosen",
        "No color cho en",
        "Theme color",
        "Overall interface color.",
        "Apply theme",
        "Reset to default",
        "Delete workspace",
        "Once deleted, a workspace is gone forever along with its data."
      ];
      const translationProbeExpectations = [
        ["Search resources", "搜索资源"],
        ["Search 资源", "搜索资源"],
        ["Build faster with environments thumbnail", "通过环境加速构建的缩略图"],
        ["Invite and assign roles thumbnail", "邀请并分配角色的缩略图"],
        ["Test your entire collection thumbnail", "测试整个集合的缩略图"],
        ["Build faster with environments", "使用环境加速构建"],
        ["Create environments for Team Workspace to save your long API keys or passwords.", "为团队工作区创建环境，以保存较长的 API 密钥或密码。"],
        ["Invite and assign roles", "邀请成员并分配角色"],
        ["Collaborate with unlimited teammates and assign the right access levels.", "与不限数量的团队成员协作，并分配适当的访问级别。"],
        ["Run all requests in your collections to efficiently test your endpoints", "运行集合中的所有请求，高效测试你的端点。"],
        ["capture cookies using Interceptor", "使用 Interceptor 捕获 Cookie"],
        ["e.g. read:org", "例如 read:org"],
        ["HashiCorp integration", "HashiCorp 集成"],
        ["Drag and drop or choose a .proto file from your local system.", "拖放或从本地系统选择 .proto 文件。"],
        ['while resolving "import" directives.', '解析“import”指令时。'],
        ["团队成员 are part of example-workspace team", "团队成员属于 example-workspace 团队"],
        ["Postman 的 Enterprise Trial", "Postman 企业试用版"],
        ["Postman's Enterprise Trial", "Postman 企业试用版"],
        ["Postman’s Enterprise Trial", "Postman 企业试用版"],
        ["Share with unlimited teammates with", "与不限数量的队友共享"],
        ["Select dataset", "选择数据集"],
        ["Select view", "选择视图"],
        ["Select a dataset and view in Test data to see data here.", "在“测试数据”中选择数据集和视图，即可在此处查看数据。"],
        ["Global variables for a workspace are a set of variables that are always available within the scope of that workspace. They can be viewed and edited by anyone in that workspace.", "工作区的全局变量是一组在该工作区范围内始终可用的变量。工作区中的任何人都可以查看和编辑这些变量。"],
        ["Global\u00a0variables\u00a0for\u00a0a\u00a0workspace\u00a0are\u00a0a\u00a0set\u00a0of\u00a0variables\u00a0that\u00a0are\u00a0always\u00a0available\u00a0within\u00a0the\u00a0scope\u00a0of\u00a0that\u00a0workspace.\u00a0They\u00a0can\u00a0be\u00a0viewed\u00a0and\u00a0edited\u00a0by\u00a0anyone\u00a0in\u00a0that\u00a0workspace.", "工作区的全局变量是一组在该工作区范围内始终可用的变量。工作区中的任何人都可以查看和编辑这些变量。"],
        ["Learn more about globals", "详细了解全局变量"],
        ["Learn\u00a0more\u00a0about\u00a0globals", "详细了解全局变量"],
        ["了解更多： globals", "详细了解全局变量"],
        ["Describe what you want to do in the Private API Network.", "描述你想在私有 API 网络中执行的操作。"],
        ["Loading Agent Mode...", "正在加载智能代理模式..."],
        ["Loading 智能代理模式...", "正在加载智能代理模式..."],
        ["Open Postbot", "打开 Postbot"],
        ["option default, selected.", "选项“默认”已选中。"],
        ["选项 default 已选中。", "选项“默认”已选中。"],
        ["are part of", "属于"],
        ["(You)", "（你）"],
        ["can access", "可访问"],
        ["Total:", "总计："],
        ["1 teammates", "1 位队友"],
        ["Internal Workspaces", "内部工作区"],
        ["User distribution over time", "用户分布趋势"],
        ["用户 distribution over time", "用户分布趋势"],
        ["A comprehensive view of your organization analytics and metrics", "全面查看组织的分析数据和指标"],
        ["A comprehensive view of your organization 分析 and metrics", "全面查看组织的分析数据和指标"],
        ["Active workspaces over time", "活跃工作区趋势"],
        ["API requests", "API 请求"],
        ["API requests by response code", "按响应码统计的 API 请求"],
        ["API requests sent by users", "用户发送的 API 请求"],
        ["Current Usage (Last 30 days)", "当前用量（最近 30 天）"],
        ["Elements in workspaces over time", "工作区元素趋势"],
        ["Explore Postman API", "探索 Postman API"],
        ["Monthly snapshot", "月度快照"],
        ["Open Postman Public API", "打开 Postman 公共 API"],
        ["Open Postman Public Workspace", "打开 Postman 公共工作区"],
        ["Percentage", "百分比"],
        ["Team member engagement over time", "团队成员参与度趋势"],
        ["Top 5 active users by API requests sent", "按 API 请求发送量排名前 5 的活跃用户"],
        ["Top 5 collections by API requests sent", "按 API 请求发送量排名前 5 的集合"],
        ["Top 5 workspaces by API requests sent", "按 API 请求发送量排名前 5 的工作区"],
        ["Total number", "总数"],
        ["Usage Trends Over Time (Feb - Aug 2026)", "使用趋势（2026年2月至8月）"],
        ["Use Postman APIs to access this report’s data.", "使用 Postman API 访问此报告的数据。"],
        ["Users who used Postman at least once", "至少使用过一次 Postman 的用户"],
        ["Workspace with views, creates, edits, or made API requests", "有查看、创建、编辑或发送 API 请求活动的工作区"],
        ["System Environments", "系统环境"],
        ["Only members with the API Catalog Manager role can access Service discovery page", "只有拥有 API 目录管理员角色的成员才能访问服务发现页面"]
      ];
      const translationPreservationTargets = [
        "OverviewController",
        "Add My Collections Backup",
        "editor",
        "Collaborate with",
        "teammates and assign the right access levels.",
        "Run all requests in",
        "to efficiently test your endpoints",
        "unlimited",
        "your collections"
      ];
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
        translationProbe.untranslated = translationProbeTargets.filter((text) => {
          return localizer.translate(text) === text;
        });
        translationProbe.englishHits = translationProbeTargets.map((text) => {
          const output = localizer.translate(text);
          const hits = [
            "tabs have",
            "tab has",
            "Your changes",
            "if you",
            "these tabs",
            "this tab",
            "you want to",
            "Force Close",
            "Force 关闭",
            "Confirm force close",
            "Establish a connection",
            "Type to filter",
            "Send request to get",
            "Agent Mode is not available",
            "Contact your team admin",
            "documentation to help others",
            "Enterprise Trial",
            "Your team grew",
            "Keep your team working",
            "Take the next step",
            "Contact us",
            "Generate SDK",
            "No collections or specifications",
            "Active webhook",
            "New Webhook",
            "Receive a Mock Event",
            "Every hour",
            "Integrations will be created",
            "More templates",
            "collection templates",
            "Postman has encountered an error",
            "Filter variables",
            "variable type",
            "variable values",
            "Share environment",
            "Set active",
            "Autosave changes",
            "Audit logs",
            "Public elements",
            "Enter vault key",
            "Reset vault",
            "Open Vault",
            "Created on",
            "Couldn't find the key",
            "Save this key",
            "variable type secret",
            "current value of a variable",
            "Sign up to save",
            "lightweight API Client",
            "save and back up",
            "unlock this feature",
            "Workspaces help",
            "stay organized",
            "Recently Closed Tabs",
            "Duplicate Selected Tab",
            "Close Selected Tab",
            "Selected Tab",
            "Close All but Selected Tab",
            "Pre-request scripts",
            "are written in",
            "are run before",
            "is sent",
            "Learn more",
            "Read less",
            "Two pane view",
            "Hide Sidebar",
            "Enter a URL or cURL command",
            "Get started by adding",
            "by adding the API",
            "command to test an endpoint",
            "typically has a base location",
            "and a path",
            "For example"
          ].filter((needle) => String(output || "").includes(needle));
          return hits.length ? { input: text, output, hits } : null;
        }).filter(Boolean);
        translationProbe.unexpectedTranslations = translationProbeExpectations.map(([input, expected]) => {
          const output = localizer.translate(input);
          return output === expected ? null : { input, expected, output };
        }).filter(Boolean);
        translationProbe.preservationFailures = translationPreservationTargets.map((input) => {
          const output = localizer.translate(input);
          return output === input ? null : { input, output };
        }).filter(Boolean);

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
              ["data", translationProbe.keyValueEditor.dataActual, ["Key", "Value", "Description"]]
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
            '<p data-probe="composite"><span>Run all requests in </span><strong>your collections</strong><span> to efficiently test your endpoints</span></p>'
          ].join("");
          document.body.appendChild(fixture);
          try {
            localizer.walk(fixture);
            translationProbe.compositeCards.actual = Array.from(fixture.querySelectorAll('[data-probe="composite"]')).map((el) => el.textContent);
            const expected = [
              "与不限数量的团队成员协作，并分配适当的访问级别。",
              "运行集合中的所有请求，高效测试你的端点。"
            ];
            if (JSON.stringify(translationProbe.compositeCards.actual) !== JSON.stringify(expected)) {
              translationProbe.compositeCards.failures.push({ expected, actual: translationProbe.compositeCards.actual });
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
      const evaluationDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(evaluation.exceptionDetails))}` : "";
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
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.translationProbe.englishHits))}` : "";
        failures.push(`翻译探针发现英文残留${probeDetails}`);
      }
      if (result.translationProbe.unexpectedTranslations && result.translationProbe.unexpectedTranslations.length) {
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.translationProbe.unexpectedTranslations))}` : "";
        failures.push(`技术词混排翻译结果不符合预期（${result.translationProbe.unexpectedTranslations.length} 项）${probeDetails}`);
      }
      if (result.translationProbe.preservationFailures && result.translationProbe.preservationFailures.length) {
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.translationProbe.preservationFailures))}` : "";
        failures.push(`标识符或不完整动态短语被误翻（${result.translationProbe.preservationFailures.length} 项）${probeDetails}`);
      }
      if (!result.translationProbe.keyValueEditor || result.translationProbe.keyValueEditor.failures.length) {
        const keyValueFailures = result.translationProbe.keyValueEditor && result.translationProbe.keyValueEditor.failures || [];
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(keyValueFailures))}` : "";
        failures.push(`键值编辑器表头翻译或数据保护异常${probeDetails}`);
      }
      if (!result.translationProbe.compositeCards || result.translationProbe.compositeCards.failures.length) {
        const compositeFailures = result.translationProbe.compositeCards && result.translationProbe.compositeCards.failures || [];
        const probeDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(compositeFailures))}` : "";
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
    if (expectUpdatesDisabled && (!result.updatePatch || !result.updatePatch.disabled)) {
      const updateDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.updatePatch))}` : "";
      failures.push(`自动更新拦截补丁未生效${updateDetails}`);
    }
    if (!result.externalUrlPatch || !result.externalUrlPatch.installed) {
      const externalUrlDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.externalUrlPatch))}` : "";
      failures.push(`外部链接引号补丁未安装${externalUrlDetails}`);
    }
    if (!result.mainMenuPatch || !result.mainMenuPatch.installed) {
      const mainMenuDetails = SHOW_DETAILS ? `：${JSON.stringify(sanitizeAuditReport(result.mainMenuPatch))}` : "";
      failures.push(`应用菜单汉化补丁不完整${mainMenuDetails}`);
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
      console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
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
  resolvePostmanDir,
  resolvePostmanDirFromProcess,
  targetDesktopVersion,
  discoverPostmanDirs,
  resolvePostmanDirFromTargetVersion,
  scanFileForMarkers
};
