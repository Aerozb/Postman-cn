#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputBase, writeAuditReport, writeAuditScreenshot } = require("./审计安全.js");
const SHOW_DETAILS = process.argv.includes("--details");
const SAVE_SCREENSHOT = process.argv.includes("--screenshot");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function resolveOutBase(value) {
  return resolveAuditOutputBase(value, "postman-audit");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
  return response.json();
}

function resolvePortFile() {
  if (!process.env.APPDATA) throw new Error("未设置 APPDATA 环境变量，无法定位 Postman 的 DevToolsActivePort 文件。");
  return path.join(process.env.APPDATA, "Postman", "DevToolsActivePort");
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 CDP WebSocket 超时。")), 10000);
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
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(callbacks.timer);
    if (message.error) {
      const details = SHOW_DETAILS ? ` 诊断：${JSON.stringify(sanitizeAuditReport(message.error))}` : "";
      callbacks.reject(new Error(`${message.error.message || "CDP 命令执行失败。"}${details}`));
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
        }, 20000);
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
      try { ws.close(); } catch (_) {}
    }
  };
}

function selectPostmanPageTarget(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter((item) => item &&
    item.type === "page" &&
    item.webSocketDebuggerUrl &&
    /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(String(item.url || "")));
  return pages.find((item) =>
    /(?:未命名请求|新建请求|我的工作区|Untitled Request|New Request|My Workspace)/i.test(String(item.title || ""))) ||
    pages.find((item) =>
      !/^(?:导入|Import|API 目录|API Catalog|应用清单|App Catalog|报告|Reports?)$/i.test(String(item.title || "").trim())) ||
    pages[0] || null;
}

async function waitForPostmanTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets;
      const page = selectPostmanPageTarget(targets);
      if (page) return page;
    } catch (_) {}
    await sleep(800);
  }
  const details = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(sanitizeAuditReport(lastTargets))}` : "";
  throw new Error(`未找到 Postman 页面调试目标。${details}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.text || (details.exception && details.exception.description) || "页面脚本执行失败。";
    const diagnostic = SHOW_DETAILS ? ` 诊断：${JSON.stringify(sanitizeAuditReport(details))}` : "";
    throw new Error(`${message}${diagnostic}`);
  }
  return result.result.value;
}

async function key(cdp, type, keyName, code) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    key: keyName,
    code: keyName
  });
}

async function pressEsc(cdp) {
  await key(cdp, "keyDown", "Escape", 27);
  await key(cdp, "keyUp", "Escape", 27);
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function hoverAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

function clickTargetScript(pattern, options = {}) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, "i");
    const maxX = ${JSON.stringify(options.maxX ?? null)};
    const minY = ${JSON.stringify(options.minY ?? null)};
    const maxY = ${JSON.stringify(options.maxY ?? null)};
    const overlayOnly = ${JSON.stringify(!!options.overlayOnly)};
    function norm(text) { return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim(); }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        "";
    }
    const targetSelector = "button,a,[role='button'],[role='tab'],[role='menuitem'],[aria-label],[title],[tabindex]";
    const overlaySelector = [
      "[role='dialog']", "[aria-modal='true']", ".ReactModal__Content", ".ReactModal__Overlay",
      "[data-testid*='modal']", "[data-aether-id*='modal']"
    ].join(",");
    const roots = overlayOnly
      ? Array.from(document.querySelectorAll(overlaySelector)).filter(visible)
      : [document];
    const candidates = roots.flatMap((root) => {
      const own = root instanceof Element && root.matches(targetSelector) ? [root] : [];
      return own.concat(Array.from(root.querySelectorAll(targetSelector)));
    });
    const matches = Array.from(new Set(candidates)).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
        testid: norm(el.getAttribute("data-testid")),
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        w: rect.width,
        h: rect.height
      };
    }).filter((item) => {
      if ((!item.text || !re.test(item.text)) && (!item.testid || !re.test(item.testid))) return false;
      if (maxX !== null && item.x > maxX) return false;
      if (minY !== null && item.y < minY) return false;
      if (maxY !== null && item.y > maxY) return false;
      return true;
    });
    matches.sort((a, b) => {
      const importButtonA = /sidebar-import-button|^导入(?:…|\.\.\.)?$|^Import(?:…|\.\.\.)?$/i.test(a.text + " " + a.testid) ? 0 : 1;
      const importButtonB = /sidebar-import-button|^导入(?:…|\.\.\.)?$|^Import(?:…|\.\.\.)?$/i.test(b.text + " " + b.testid) ? 0 : 1;
      return importButtonA - importButtonB || a.y - b.y || a.x - b.x;
    });
    return matches[0] || null;
  })()`;
}

function stateScript(mode = "full") {
  return String.raw`(() => {
    const MODE = "__MODE__";
    const ALLOWED_WORDS = new Set([
      "postman", "api", "apis", "url", "uri", "http", "https", "json", "xml", "html", "javascript", "graphql", "grpc", "websocket",
      "mqtt", "mcp", "curl", "grpcurl", "openapi", "swagger", "wsdl", "har", "yaml", "yml", "csv", "git", "github", "bitbucket", "gitlab",
      "schema", "oauth", "id", "uuid", "ctrl", "alt", "shift", "enter", "esc", "tab", "ai", "sdk", "post", "get", "put", "patch",
      "delete", "head", "options", "fern", "slack", "microsoft", "teams"
    ]);
    function norm(text) { return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
    }
    function allowedEnglish(text) {
      const normalized = norm(text);
      if (/头像$|团队标志$/.test(normalized)) return true;
      if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(normalized)) return true;
      if (!/[A-Za-z]{2,}/.test(normalized)) return true;
      if (/^https?:\/\//i.test(normalized)) return true;
      if (/^[A-Z0-9_./:-]+$/.test(normalized) && normalized.length <= 36) return true;
      const words = normalized.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
      return words.filter((word) => {
        const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (!lowered || lowered.length <= 1) return false;
        if (ALLOWED_WORDS.has(lowered)) return false;
        if (/^\d/.test(lowered)) return false;
        return true;
      }).length === 0;
    }
    function addHit(hits, text, kind, meta) {
      const value = norm(text);
      if (!value || allowedEnglish(value)) return;
      if (/^(Browse|Choose File|Choose Files|Select File|Select Files|Open File|Open Folder)$/i.test(value)) return;
      if (!hits.has(value)) hits.set(value, { text: value, count: 0, samples: [] });
      const hit = hits.get(value);
      hit.count += 1;
      if (hit.samples.length < 6) hit.samples.push(Object.assign({ kind }, meta || {}));
    }
    const roots = MODE === "overlay" ? Array.from(document.querySelectorAll([
      "[role='dialog']", "[aria-modal='true']", "[role='menu']", "[role='listbox']", "[role='tooltip']",
      ".ReactModal__Content", ".ReactModal__Overlay", "[data-testid*='modal']", "[data-testid*='popover']",
      "[data-testid='aether-button-tooltip']", "[data-aether-id*='popover']", "[data-aether-id*='modal']"
    ].join(","))).filter(visible) : [document.body || document.documentElement].filter(Boolean);
    const containers = roots.map((root) => ({
      role: norm(root.getAttribute && root.getAttribute("role")),
      ariaModal: norm(root.getAttribute && root.getAttribute("aria-modal")),
      testid: norm(root.getAttribute && root.getAttribute("data-testid")),
      aetherId: norm(root.getAttribute && root.getAttribute("data-aether-id")),
      className: norm(root.className),
      hasSidebarMenuImport: !!(root.querySelector && root.querySelector('[data-testid="sidebar-menu-import"]')),
      text: norm(root.innerText || root.textContent || "").slice(0, 1800)
    }));
    const hits = new Map();
    const textParts = [];
    for (const root of roots) {
      textParts.push(norm(root.innerText || root.textContent || ""));
      for (const line of String(root.innerText || "").split(/\n| {2,}/)) addHit(hits, line, MODE, { tag: root.tagName, role: root.getAttribute && root.getAttribute("role") || "" });
    }
    const attrNames = ["aria-label", "title", "placeholder", "alt"];
    const visibleElements = (MODE === "overlay" ? roots : [document.body || document.documentElement]).filter(Boolean).flatMap((root) => {
      if (!root.querySelectorAll) return [];
      return [root].concat(Array.from(root.querySelectorAll("*")));
    }).filter(visible);
    for (const el of visibleElements) {
      for (const attr of attrNames) {
        if (el.hasAttribute(attr)) addHit(hits, el.getAttribute(attr), "attr", Object.assign({ attr, tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
      }
    }
    const targetRoots = MODE === "overlay" ? roots : [document.body || document.documentElement].filter(Boolean);
    const targets = targetRoots.flatMap((root) => {
      if (!root.querySelectorAll) return [];
      return Array.from(root.querySelectorAll("button,a,[role='button'],[role='tab'],[role='menuitem'],[aria-label],[title],[tabindex]"));
    }).filter(visible).map((el) => {
      const text = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || el.getAttribute("data-testid") || "");
      return Object.assign({ text, tag: el.tagName, role: norm(el.getAttribute("role")) }, rectOf(el));
    }).filter((item) => item.text);
    return {
      title: document.title,
      url: location.href,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      text: norm(textParts.join("\n")).slice(0, 1800),
      containers,
      hits: Array.from(hits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      targets: targets.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 160)
    };
  })()`.replace("__MODE__", mode);
}

async function clickPattern(cdp, pattern, delayMs, options = {}) {
  const target = await evaluate(cdp, clickTargetScript(pattern, options));
  if (!target) return { ok: false, pattern, options };
  await clickAt(cdp, target.x, target.y);
  await sleep(delayMs);
  return { ok: true, pattern, target };
}

function importHandleInvokeScript() {
  return `(() => {
    try {
      let req = window.__POSTMAN_ZH_WEBPACK_REQUIRE__;
      if (!req && window.webpackChunk_postman_app_renderer && window.webpackChunk_postman_app_renderer.push) {
        window.webpackChunk_postman_app_renderer.push([[Math.floor(Math.random() * 1000000000)], {}, function (runtimeRequire) {
          req = runtimeRequire;
          window.__POSTMAN_ZH_WEBPACK_REQUIRE__ = runtimeRequire;
        }]);
      }
      if (!req) {
        return { ok: false, reason: "webpack-require-not-found" };
      }
      const mod = req(106526);
      const fn = mod && (mod.handleImport || (mod.default && mod.default.handleImport));
      if (typeof fn !== "function") {
        return { ok: false, reason: "handleImport-not-found", keys: mod && Object.keys(mod) };
      }
      Promise.resolve(fn({ origin: "global", referrer: "postman-zh-audit" })).catch(function () {});
      return { ok: true, via: "webpack-handleImport" };
    } catch (error) {
      return { ok: false, reason: "handleImport-error", error: String(error && error.message || error) };
    }
  })()`;
}

function isImportDialogState(state) {
  const containers = Array.isArray(state && state.containers) ? state.containers : [];
  const text = containers.filter((container) =>
    String(container && container.role || "").toLowerCase() === "dialog" ||
    String(container && container.ariaModal || "").toLowerCase() === "true" ||
    /modal/i.test(`${container && container.testid || ""} ${container && container.aetherId || ""} ${container && container.className || ""}`)
  ).map((container) => container && container.text || "").join("\n");
  if (!text) return false;
  return /(?:导入|Import)/i.test(text) &&
    /(?:文件|链接|原始文本|Raw|Paste|选择|拖放|OpenAPI|cURL|Postman Collection|集合|工作区|workspace)/i.test(text);
}

function isSidebarImportMenuState(state) {
  const containers = Array.isArray(state && state.containers) ? state.containers : [];
  return containers.some((container) =>
    String(container && container.role || "").toLowerCase() === "menu" &&
    container && container.hasSidebarMenuImport === true
  );
}

function hasAuditTemporaryUi(state) {
  return isImportDialogState(state) || isSidebarImportMenuState(state);
}

async function cleanupAuditUi(cdp, auditUi, options = {}) {
  if (!auditUi || !auditUi.cleanupRequired) {
    return { complete: true, attempted: false, escapeCount: 0 };
  }

  const maxEscapes = Math.max(1, Number(options.maxEscapes || 5));
  const wait = typeof options.wait === "function" ? options.wait : sleep;
  let lastState = null;

  for (let escapeCount = 1; escapeCount <= maxEscapes; escapeCount += 1) {
    await pressEsc(cdp);
    await wait(220);
    lastState = await evaluate(cdp, stateScript("overlay"));
    if (!hasAuditTemporaryUi(lastState)) {
      return { complete: true, attempted: true, escapeCount };
    }
  }

  return {
    complete: false,
    attempted: true,
    escapeCount: maxEscapes,
    importDialogRemaining: isImportDialogState(lastState),
    sidebarMenuRemaining: isSidebarImportMenuState(lastState)
  };
}

function completionExitCode(importDialogDetected) {
  return importDialogDetected ? 0 : 2;
}

function importAuditTabPatterns() {
  return [
    "^链接$|^Link$|^URL$",
    "^原始文本$|^Raw text$|^Raw Text$|^Raw$",
    "^代码仓库$|^Repository$|^Code repository$|^Git repository$"
  ];
}

async function waitForImportDialog(cdp, timeoutMs = 1800) {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let state = null;
  do {
    state = await evaluate(cdp, stateScript("overlay"));
    if (isImportDialogState(state)) return { detected: true, state };
    if (Date.now() >= deadline) break;
    await sleep(Math.min(180, Math.max(20, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { detected: false, state };
}

function summarizeOpenAction(action) {
  const source = action || {};
  return {
    invoked: !!source.ok,
    reason: source.reason || (source.ok ? "" : "open-action-failed"),
    label: source.label || source.target && source.target.text || ""
  };
}

async function openViaProjectSidebar(cdp, delayMs) {
  const projectTab = await clickPattern(
    cdp,
    "sidebar-tab-internal-dev-services|^项目$|^Projects?$|^Collections?$",
    Math.max(delayMs, 300),
    { maxY: 120 }
  );
  if (!projectTab.ok) return { ok: false, reason: "project-entry-not-found" };
  await sleep(120);
  const importButton = await clickPattern(
    cdp,
    "sidebar-import-button|^导入(?:…|\\.\\.\\.)?$|^Import(?:…|\\.\\.\\.)?$",
    Math.max(delayMs, 360),
    { maxX: 520, minY: 70 }
  );
  if (importButton.ok) {
    return { ok: true, label: importButton.target && importButton.target.text || "" };
  }

  const optionsMenu = await clickPattern(
    cdp,
    "sidebar-options-menu-button",
    Math.max(delayMs, 260),
    { maxX: 520, maxY: 140 }
  );
  if (!optionsMenu.ok) return { ok: false, reason: "sidebar-options-menu-not-found" };

  const menuImport = await clickPattern(
    cdp,
    "sidebar-menu-import",
    Math.max(delayMs, 360),
    { maxX: 520, minY: 70, maxY: 240 }
  );
  return menuImport.ok
    ? { ok: true, label: menuImport.target && menuImport.target.text || "" }
    : { ok: false, reason: "sidebar-menu-import-not-found" };
}

async function tryOpenImportDialog(cdp, delayMs, log, auditUi) {
  const attempts = [];
  const initial = await waitForImportDialog(cdp, 180);
  if (initial.detected) {
    attempts.push({ method: "already-open", invoked: true, detected: true, reason: "", label: "" });
    log.push({ step: "open-import-already-open", phase: "已检测到", hitCount: initial.state && initial.state.hits ? initial.state.hits.length : 0 });
    return { detected: true, via: "already-open", attempts, state: initial.state };
  }

  const methods = [
    ["project-sidebar", () => openViaProjectSidebar(cdp, delayMs)],
    ["sidebar", () => clickPattern(
      cdp,
      "sidebar-import-button|^导入(?:…|\\.\\.\\.)?$|^Import(?:…|\\.\\.\\.)?$",
      Math.max(delayMs, 360),
      { maxX: 520, minY: 70 }
    )],
    ["webpack-handleImport", () => evaluate(cdp, importHandleInvokeScript())]
  ];

  for (let i = 0; i < methods.length; i += 1) {
    const [method, invoke] = methods[i];
    if (i > 0) {
      await pressEsc(cdp);
      await sleep(120);
    }
    let action;
    try {
      auditUi.cleanupRequired = true;
      action = await invoke();
    } catch (error) {
      action = { ok: false, reason: "open-action-error", error: String(error && error.message || error) };
    }
    const probe = await waitForImportDialog(cdp, Math.max(delayMs + 1100, 1600));
    const summary = Object.assign({ method, detected: probe.detected }, summarizeOpenAction(action));
    attempts.push(summary);
    log.push({
      step: `open-import-${method}`,
      label: summary.label,
      phase: probe.detected ? "已检测到" : "未检测到",
      hitCount: probe.state && probe.state.hits ? probe.state.hits.length : 0,
      targetCount: probe.state && probe.state.targets ? probe.state.targets.length : 0
    });
    if (probe.detected) return { detected: true, via: method, attempts, state: probe.state };
  }

  return { detected: false, via: "", attempts, state: null };
}

function mergeHits(allHits, step, hits) {
  for (const hit of hits || []) {
    if (!allHits.has(hit.text)) allHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
    const current = allHits.get(hit.text);
    current.count += hit.count || 1;
    for (const sample of hit.samples || []) {
      if (current.samples.length < 10) current.samples.push(Object.assign({ step }, sample));
    }
  }
}

async function collect(cdp, step, allHits, log, mode = "overlay") {
  const state = await evaluate(cdp, stateScript(mode));
  mergeHits(allHits, step, state.hits);
  log.push({ step, state });
  return state;
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const delayMs = Number(argValue("--delay-ms", "300"));
  const hoverLimit = Number(argValue("--hover-limit", "10"));
  const outBase = resolveOutBase(argValue("--out", "postman-import-audit"));
  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) throw new Error("未找到 DevToolsActivePort 文件。请先启动 Postman。");

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const allHits = new Map();
  const log = [];
  const auditUi = { cleanupRequired: false };

  try {
    await cdp.send("Runtime.enable");
    if (SAVE_SCREENSHOT) await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(150);

    const opened = await tryOpenImportDialog(cdp, delayMs, log, auditUi);
    if (!opened.detected) {
      const output = {
        complete: false,
        target: { title: target.title, url: target.url },
        importDialogDetected: false,
        openMethod: null,
        openAttempts: opened.attempts,
        hitCount: 0,
        hits: [],
        log,
        screenshot: null
      };
      const reportPath = `${outBase}.json`;
      writeAuditReport(reportPath, output);
      console.error(`导入界面审计未完成：未能打开导入弹窗，报告已保存到 _generated/${path.basename(reportPath)}。`);
      if (SHOW_DETAILS) {
        console.error(JSON.stringify(sanitizeAuditReport({
          complete: false,
          importDialogDetected: false,
          out: reportPath,
          openAttempts: opened.attempts
        }), null, 2));
      }
      process.exitCode = completionExitCode(false);
      return;
    }

    const initialState = await collect(cdp, "import-initial", allHits, log, "overlay");
    const importDialogDetected = isImportDialogState(initialState);
    if (!importDialogDetected) {
      const output = {
        complete: false,
        target: { title: target.title, url: target.url },
        importDialogDetected: false,
        openMethod: opened.via,
        openAttempts: opened.attempts,
        hitCount: 0,
        hits: [],
        log,
        screenshot: null
      };
      const reportPath = `${outBase}.json`;
      writeAuditReport(reportPath, output);
      console.error(`导入界面审计未完成：导入弹窗在扫描前已关闭，报告已保存到 _generated/${path.basename(reportPath)}。`);
      if (SHOW_DETAILS) {
        console.error(JSON.stringify(sanitizeAuditReport({
          complete: false,
          importDialogDetected: false,
          out: reportPath,
          openMethod: opened.via,
          openAttempts: opened.attempts
        }), null, 2));
      }
      process.exitCode = completionExitCode(false);
      return;
    }

    const tabPatterns = importAuditTabPatterns();

    for (let i = 0; i < tabPatterns.length; i += 1) {
      const clicked = await clickPattern(cdp, tabPatterns[i], delayMs, { minY: 80, overlayOnly: true });
      log.push({ step: `import-tab-${i}`, clicked });
      await collect(cdp, `import-after-tab-${i}`, allHits, log, "overlay");
    }

    const hoverState = await evaluate(cdp, stateScript("overlay"));
    const hoverTargets = (hoverState.targets || [])
      .filter((item) => !/选择文件|浏览|上传|Choose File|Browse|Upload/i.test(item.text || ""))
      .slice(0, hoverLimit);
    for (let i = 0; i < hoverTargets.length; i += 1) {
      const item = hoverTargets[i];
      await hoverAt(cdp, item.cx, item.cy);
      await sleep(Math.max(delayMs, 260));
      await collect(cdp, `import-hover-${i}`, allHits, log, "overlay");
    }

    const finalProbe = await waitForImportDialog(cdp, 300);
    if (!finalProbe.detected) {
      const hits = Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
      const output = {
        complete: false,
        target: { title: target.title, url: target.url },
        importDialogDetected: false,
        openMethod: opened.via,
        openAttempts: opened.attempts,
        hitCount: hits.length,
        hits,
        log,
        screenshot: null
      };
      const reportPath = `${outBase}.json`;
      writeAuditReport(reportPath, output);
      console.error(`导入界面审计未完成：扫描过程中导入弹窗已关闭，报告已保存到 _generated/${path.basename(reportPath)}。`);
      if (SHOW_DETAILS) {
        console.error(JSON.stringify(sanitizeAuditReport({
          complete: false,
          importDialogDetected: false,
          out: reportPath,
          openMethod: opened.via,
          openAttempts: opened.attempts
        }), null, 2));
      }
      process.exitCode = completionExitCode(false);
      return;
    }

    if (SAVE_SCREENSHOT) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeAuditScreenshot(`${outBase}.png`, shot.data);
    }

    const hits = Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    const output = {
      complete: true,
      target: { title: target.title, url: target.url },
      importDialogDetected,
      openMethod: opened.via,
      openAttempts: opened.attempts,
      hitCount: hits.length,
      hits,
      log,
      screenshot: SAVE_SCREENSHOT ? `${outBase}.png` : null
    };
    writeAuditReport(`${outBase}.json`, output);
    const summary = {
      out: `${outBase}.json`,
      screenshot: SAVE_SCREENSHOT ? `${outBase}.png` : null,
      hitCount: hits.length,
      hits: hits.slice(0, 60).map((item) => item.text),
      importDialogDetected,
      complete: true,
      openMethod: opened.via,
      openAttempts: opened.attempts
    };
    console.log(`导入界面审计完成：发现 ${summary.hitCount} 条待复核文本，报告已保存到 _generated/${path.basename(summary.out)}。`);
    if (SHOW_DETAILS) {
      console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
    }
  } finally {
    try {
      const cleanup = await cleanupAuditUi(cdp, auditUi);
      if (!cleanup.complete) {
        throw new Error("审计结束后未能关闭 Postman 导入弹窗或临时菜单。");
      }
    } finally {
      cdp.close();
    }
  }
}

async function selfTest() {
  const generated = stateScript("full");
  const clickGenerated = clickTargetScript("sidebar-import-button|^导入$");
  const overlayClickGenerated = clickTargetScript("^链接$", { overlayOnly: true });
  const projectSource = openViaProjectSidebar.toString();
  const openSource = tryOpenImportDialog.toString();
  const mainSource = main.toString();
  const tabPatterns = importAuditTabPatterns();
  const dialogState = (text) => ({ containers: [{ role: "dialog", text }] });
  const menuState = { containers: [{ role: "menu", hasSidebarMenuImport: true, text: "导入 工作区概览" }] };
  const emptyState = { containers: [] };
  const catalogTarget = { type: "page", title: "API 目录", url: "https://desktop.postman.com/", webSocketDebuggerUrl: "ws://catalog" };
  const requestTarget = { type: "page", title: "未命名请求 - 我的工作区", url: "https://desktop.postman.com/", webSocketDebuggerUrl: "ws://request" };
  const createCleanupMock = (stateAfterEscape) => {
    const calls = [];
    let escapeCount = 0;
    return {
      calls,
      get escapeCount() { return escapeCount; },
      async send(method, params = {}) {
        calls.push({ method, type: params.type || "" });
        if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") escapeCount += 1;
        if (method === "Runtime.evaluate") {
          return { result: { value: stateAfterEscape(escapeCount) } };
        }
        return {};
      }
    };
  };
  const noCleanupMock = createCleanupMock(() => emptyState);
  const noCleanup = await cleanupAuditUi(noCleanupMock, { cleanupRequired: false }, { wait: async () => {} });
  const dialogCleanupMock = createCleanupMock(() => emptyState);
  const dialogCleanup = await cleanupAuditUi(dialogCleanupMock, { cleanupRequired: true }, { wait: async () => {} });
  const menuCleanupMock = createCleanupMock(() => emptyState);
  const menuCleanup = await cleanupAuditUi(menuCleanupMock, { cleanupRequired: true }, { wait: async () => {} });
  const persistentCleanupMock = createCleanupMock(() => dialogState("导入 文件 链接"));
  const persistentCleanup = await cleanupAuditUi(
    persistentCleanupMock,
    { cleanupRequired: true },
    { wait: async () => {}, maxEscapes: 2 }
  );
  new Function(`return (${generated});`);
  new Function(`return (${clickGenerated});`);
  new Function(`return (${overlayClickGenerated});`);
  const checks = [
    [generated.includes('"grpcurl"'), true],
    [clickGenerated.includes("item.testid"), true],
    [overlayClickGenerated.includes("const overlayOnly = true"), true],
    [projectSource.includes("sidebar-tab-internal-dev-services"), true],
    [projectSource.includes("sidebar-options-menu-button"), true],
    [projectSource.includes("sidebar-menu-import"), true],
    [(projectSource.match(/clickPattern\(\s*cdp,/g) || []).length, 4],
    [openSource.includes("application-menu") || openSource.includes("top-menu"), false],
    [openSource.includes("auditUi.cleanupRequired = true"), true],
    [mainSource.includes("await cleanupAuditUi(cdp, auditUi)"), true],
    [mainSource.indexOf("await cleanupAuditUi(cdp, auditUi)") < mainSource.indexOf("cdp.close()"), true],
    [tabPatterns.some((pattern) => /文件|File|文件夹|Folder/i.test(pattern)), false],
    [isImportDialogState(dialogState("导入 文件 文件夹 链接 原始文本")), true],
    [isImportDialogState(dialogState("Import File Folder Link Raw text")), true],
    [isImportDialogState(dialogState("导入")), false],
    [isImportDialogState({ containers: [{ role: "menu", text: "导入 工作区概览" }] }), false],
    [isSidebarImportMenuState(menuState), true],
    [hasAuditTemporaryUi(dialogState("导入 文件 链接")), true],
    [hasAuditTemporaryUi(menuState), true],
    [noCleanup.complete && !noCleanup.attempted && noCleanupMock.calls.length === 0, true],
    [dialogCleanup.complete && dialogCleanup.attempted && dialogCleanupMock.escapeCount === 1, true],
    [menuCleanup.complete && menuCleanup.attempted && menuCleanupMock.escapeCount === 1, true],
    [persistentCleanup.complete, false],
    [persistentCleanup.importDialogRemaining, true],
    [selectPostmanPageTarget([catalogTarget, requestTarget]), requestTarget],
    [selectPostmanPageTarget([catalogTarget]), catalogTarget],
    [selectPostmanPageTarget([]), null],
    [completionExitCode(true), 0],
    [completionExitCode(false), 2],
    [SAVE_SCREENSHOT, false]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  console.log(`导入界面审计脚本自检通过，共 ${checks.length} 项。`);
}

Promise.resolve().then(() => process.argv.includes("--self-test") ? selfTest() : main()).catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (SHOW_DETAILS) {
    console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
  } else {
    console.error("导入界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  }
  process.exit(1);
});
