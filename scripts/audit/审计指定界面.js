#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputBase, writeAuditReport, writeAuditScreenshot } = require("./审计安全.js");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const SHOW_DETAILS = hasFlag("--details");
const SAVE_SCREENSHOT = hasFlag("--screenshot");
const THOROUGH = hasFlag("--thorough");
const DEFAULT_AUDIT_BUDGET_MS = THOROUGH ? 300000 : 90000;
const MAX_TEXT_NODES = THOROUGH ? 4800 : 2400;
const MAX_ELEMENTS = THOROUGH ? 10000 : 5000;
const MAX_ATTRIBUTES = THOROUGH ? 600 : 240;
const MAX_HITS_PER_STATE = 80;

function resolveOutBase(value) {
  return resolveAuditOutputBase(value, "postman-audit");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function integerArg(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(argValue(name, String(fallback)));
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

function budgetAllows(budget, step, reserveMs = 0) {
  if (Date.now() + reserveMs < budget.deadline) return true;
  if (!budget.exhaustedAt) budget.exhaustedAt = step;
  return false;
}

function budgetError(step) {
  const error = new Error(`审计时间预算已耗尽：${step}`);
  error.code = "AUDIT_BUDGET";
  return error;
}

function resolvePortFile() {
  if (!process.env.APPDATA) {
    throw new Error("未设置 APPDATA 环境变量，无法定位 Postman 的 DevToolsActivePort 文件。");
  }
  return path.join(process.env.APPDATA, "Postman", "DevToolsActivePort");
}

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) {
    throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
  }
  return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function connectCdp(wsUrl, deadline = null) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  function rejectPending(error) {
    for (const callbacks of pending.values()) {
      clearTimeout(callbacks.timer);
      callbacks.reject(error);
    }
    pending.clear();
  }

  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("连接 CDP WebSocket 超时。"));
    }, Math.min(10000, remaining));
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      reject(new Error("连接 CDP WebSocket 失败。"));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(callbacks.timer);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || JSON.stringify(sanitizeAuditReport(message.error))));
    } else {
      callbacks.resolve(message.result);
    }
  });

  ws.addEventListener("close", () => {
    rejectPending(new Error("CDP WebSocket 已关闭。"));
  });

  return {
    send(method, params = {}, timeoutMs = 15000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("CDP WebSocket 未连接。"));
          return;
        }
        const remaining = deadline ? deadline - Date.now() : timeoutMs;
        if (remaining <= 0) {
          reject(budgetError(method));
          return;
        }
        const commandTimeout = Math.max(100, Math.min(timeoutMs, remaining));
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            try { ws.close(); } catch (_) {}
            reject(new Error(`CDP 命令执行超时：${method}`));
          }
        }, commandTimeout);
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
      rejectPending(new Error("CDP 连接已关闭。"));
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

function norm(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

const ALLOWED_WORDS = new Set(
  "postman api apis url uri http https get post put patch delete head options cookie cookies json xml html javascript oauth jwt bearer websocket graphql grpc mcp socket io ctrl alt shift tab enter esc ai postbot vault llm curl ssl tls tcp udp git sdk rbac"
    .concat(" f x ms rest mqtt none params raw binary urlencoded www form content type tiny validator getpostman interceptor x-www-form-urlencoded content-type")
    .split(/\s+/)
);

const ALLOWED_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Cookie|Postman|API|HTTP|URL|Ctrl|Alt|Shift|Tab|Enter|Esc|JSON|XML|HTML|JavaScript|GraphQL|gRPC|WebSocket|MCP|Postbot|Vault|AI|LLM|cURL|SSL|TLS)$/i;
const SHORTCUT_CHORD = /(?:Ctrl|Alt|Shift|Cmd|Command|Win)(?:\s*\+\s*(?:Ctrl|Alt|Shift|Cmd|Command|Win|Del|Esc|Enter|Tab|Space|F\d{1,2}|[A-Z0-9`\\]))+/gi;

function englishHits(sources, step) {
  const hits = [];
  const seen = new Set();

  for (const source of sources) {
    const fragments = String(source.text || "")
      .split(/(?<=[。！？.!?])\s+/)
      .map(norm)
      .filter(Boolean);

    for (const line of fragments) {
      if (!/[A-Za-z]{2,}/.test(line) || ALLOWED_LINE.test(line)) {
        continue;
      }
      if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(line)) {
        continue;
      }
      if (source.kind === "attribute" && source.attribute === "aria-label" && /(?:的头像|团队标志)$/.test(line)) {
        continue;
      }
      const textWithoutShortcuts = line.replace(SHORTCUT_CHORD, " ");
      const words = (textWithoutShortcuts.match(/[A-Za-z][A-Za-z'’-]*/g) || []).map((word) => word.toLowerCase());
      const unknown = words.filter((word) => !ALLOWED_WORDS.has(word));
      if (!unknown.length) {
        continue;
      }
      const key = `${source.kind}|${source.attribute || ""}|${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const hit = { text: line, step, kind: source.kind };
      if (source.attribute) {
        hit.attribute = source.attribute;
      }
      if (source.tag) {
        hit.tag = source.tag;
      }
      if (Number.isInteger(source.index)) {
        hit.index = source.index;
      }
      hits.push(hit);
      if (hits.length >= 30) {
        return hits;
      }
    }
  }

  return hits;
}

async function mouse(cdp, type, x, y, button = "left") {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
}

async function clickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
  await mouse(cdp, "mousePressed", x, y);
  await mouse(cdp, "mouseReleased", x, y);
}

async function rightClickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y, "right");
  await mouse(cdp, "mousePressed", x, y, "right");
  await mouse(cdp, "mouseReleased", x, y, "right");
}

async function hoverAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
}

async function pressEsc(cdp) {
  for (let i = 0; i < 2; i += 1) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await sleep(80);
  }
}

async function collectState(cdp, step) {
  const expression = String.raw`(() => {
    const MAX_TEXT_NODES = ${MAX_TEXT_NODES};
    const MAX_ELEMENTS = ${MAX_ELEMENTS};
    const MAX_ATTRIBUTES = ${MAX_ATTRIBUTES};
    const MAX_TEXT_LENGTH = 600;
    const norm = (text) => String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const view = el.ownerDocument.defaultView || window;
      const style = view.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && el.getClientRects().length > 0;
    };
    const isPrivateText = (el) => {
      if (!el || !el.closest) return true;
      if (el.closest("input,textarea,select,[contenteditable='true'],[role='textbox'],.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,.ProseMirror,.pm-response-body,.response-body,[data-testid*='request-body'],[data-testid*='response-body'],[data-testid*='code-editor']")) {
        return true;
      }
      const keyValue = el.closest(".key-value-form-row,.key-value-cell,.key-value-form-column,.key-value-form-editor-sortable,.auto-suggest-group");
      return !!(keyValue && !el.closest(".header-row,.key-value-form-header-row,.key-value-cell__placeholder,.goto-bulk-editor,.bulk-editor-preset__controls"));
    };
    const sources = [];
    const overlaySelector = '[role="tooltip"],[role="menu"],[role="dialog"],.ReactModal__Overlay,[data-testid*="menu"],[data-testid*="modal"]';
    const body = document.body || document.documentElement;
    const walker = body && document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let textIndex = 0;
    let textVisited = 0;
    let node;
    while (walker && (node = walker.nextNode()) && textVisited < MAX_TEXT_NODES && textIndex < 1200) {
      textVisited += 1;
      const parent = node.parentElement;
      const text = norm(node.nodeValue);
      if (!text || text.length > MAX_TEXT_LENGTH * 2 || !isVisible(parent) || isPrivateText(parent)) continue;
      const overlay = parent.closest(overlaySelector);
      sources.push({ text: text.slice(0, MAX_TEXT_LENGTH), kind: overlay ? "overlay" : "body", tag: overlay ? overlay.tagName : parent.tagName, index: textIndex });
      textIndex += 1;
    }
    if (norm(document.title)) {
      sources.unshift({ text: norm(document.title), kind: "title", index: 0 });
    }
    let attributeCount = 0;
    let elementVisited = 0;
    const elementWalker = body && document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
    let element;
    while (elementWalker && (element = elementWalker.nextNode()) && elementVisited < MAX_ELEMENTS && attributeCount < MAX_ATTRIBUTES) {
        elementVisited += 1;
        const el = element;
        if (!isVisible(el) || isPrivateText(el)) continue;
        const explicit = norm(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || "");
        if (explicit) {
          const attribute = el.getAttribute("aria-label") ? "aria-label" : el.getAttribute("placeholder") ? "placeholder" : "title";
          sources.push({ text: explicit.slice(0, MAX_TEXT_LENGTH), kind: "attribute", attribute, tag: el.tagName, index: elementVisited });
          attributeCount += 1;
        }
    }
    return {
      title: document.title,
      url: location.href,
      sources,
      textNodeCount: textIndex,
      textVisited,
      attributeCount,
      elementVisited
    };
  })()`;
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  const value = result.result.value;
  return {
    step,
    title: value.title,
    url: value.url,
    hits: englishHits(value.sources || [], step),
    textNodeCount: value.textNodeCount,
    textVisited: value.textVisited,
    attributeCount: value.attributeCount,
    elementVisited: value.elementVisited
  };
}

async function waitForTarget(port, timeoutMs, targetTitle, budget) {
  const deadline = Date.now() + timeoutMs;
  const requested = targetTitle ? new RegExp(targetTitle, "i") : null;
  let lastTargets = [];

  while (Date.now() < deadline) {
    if (!budgetAllows(budget, "等待页面目标", 200)) break;
    const remaining = Math.max(100, Math.min(5000, deadline - Date.now(), budget.deadline - Date.now()));
    let targets;
    try {
      targets = await getJson(`http://127.0.0.1:${port}/json/list`, remaining);
    } catch (error) {
      if (Date.now() >= deadline || Date.now() >= budget.deadline) break;
      await sleep(Math.min(800, Math.max(100, remaining / 4)));
      continue;
    }
    lastTargets = targets;
    const pages = targets.filter((target) => {
      return target.type === "page" &&
        target.webSocketDebuggerUrl &&
        !String(target.url || "").startsWith("devtools://");
    });

    if (requested) {
      const match = pages.find((target) => requested.test(`${target.title}\n${target.url}\n${target.id}`));
      if (match) {
        return match;
      }
    }

    const scratchpad = pages.find((target) => /scratchpad\.html/i.test(String(target.url || "")));
    if (scratchpad) {
      return scratchpad;
    }

    const desktop = pages.find((target) => /desktop\.postman\.com/i.test(String(target.url || "")));
    if (desktop) {
      return desktop;
    }

    await sleep(800);
  }

  const error = new Error(`未找到 Postman 页面调试目标。当前目标：${JSON.stringify(sanitizeAuditReport(lastTargets))}`);
  if (Date.now() >= budget.deadline) error.code = "AUDIT_BUDGET";
  throw error;
}

const ACTIONS = [
  ["hover-new", "hover", 311, 109],
  ["click-new-menu", "click", 311, 109],
  ["hover-new-menu", "hover", 330, 150],
  ["close-new-menu", "esc", 0, 0],
  ["hover-tab", "hover", 468, 110],
  ["right-tab", "right", 468, 110],
  ["close-tab-menu", "esc", 0, 0],
  ["click-plus-tab", "click", 856, 164],
  ["close-plus", "esc", 0, 0],
  ["click-tab-more", "click", 913, 164],
  ["close-tab-more", "esc", 0, 0],
  ["click-method-menu", "click", 440, 199],
  ["hover-method-menu", "hover", 430, 270],
  ["close-method", "esc", 0, 0],
  ["click-auth-tab", "click", 458, 243],
  ["click-headers-tab", "click", 520, 243],
  ["click-body-tab", "click", 588, 243],
  ["click-scripts-tab", "click", 668, 243],
  ["click-tests-tab", "click", 724, 243],
  ["click-settings-tab", "click", 768, 243],
  ["click-params-tab", "click", 410, 243],
  ["hover-save", "hover", 1201, 150],
  ["right-save", "right", 1201, 150],
  ["close-save-menu", "esc", 0, 0],
  ["hover-send", "hover", 1172, 199],
  ["right-send", "right", 1172, 199],
  ["close-send-menu", "esc", 0, 0],
  ["click-send-dropdown", "click", 1222, 199],
  ["hover-send-dropdown", "hover", 1210, 235],
  ["close-send-dropdown", "esc", 0, 0],
  ["click-cookie", "click", 1206, 243],
  ["close-cookie", "esc", 0, 0],
  ["click-top-settings", "click", 984, 24],
  ["hover-top-settings-menu", "hover", 1010, 65],
  ["close-top-settings", "esc", 0, 0],
  ["hover-bottom-console", "hover", 77, 756],
  ["hover-bottom-account", "hover", 190, 756],
  ["hover-help", "hover", 1280, 756]
];

async function main() {
  const timeoutMs = integerArg("--timeout-ms", THOROUGH ? 120000 : 60000, 1000, THOROUGH ? 600000 : 120000);
  const delayMs = integerArg("--delay-ms", THOROUGH ? 500 : 800, 0, THOROUGH ? 10000 : 3000);
  const auditBudgetMs = integerArg("--audit-budget-ms", DEFAULT_AUDIT_BUDGET_MS, 5000, THOROUGH ? 600000 : DEFAULT_AUDIT_BUDGET_MS);
  const maxActions = integerArg("--max-actions", ACTIONS.length, 1, ACTIONS.length);
  const outBase = resolveOutBase(argValue("--out", "postman-targeted-audit"));
  const targetTitle = argValue("--target-title", "未命名请求|新建请求|HTTP Request|Untitled Request|Postman");
  const portFile = resolvePortFile();
  const budget = { limitMs: auditBudgetMs, startedAt: Date.now(), deadline: Date.now() + auditBudgetMs, exhaustedAt: null };
  const log = [];
  let target = null;
  let cdp = null;
  let fatalError = null;

  if (!fs.existsSync(portFile)) {
    throw new Error("未找到 DevToolsActivePort 文件。请先启动 Postman。");
  }

  try {
    const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(port)) throw new Error("DevToolsActivePort 文件中的端口无效。");
    target = await waitForTarget(port, Math.min(timeoutMs, auditBudgetMs), targetTitle, budget);
    cdp = await connectCdp(target.webSocketDebuggerUrl, budget.deadline);
    if (!budgetAllows(budget, "initial", delayMs + 1200)) throw budgetError("initial");
    await pressEsc(cdp);
    log.push(await collectState(cdp, "initial"));

    for (const [name, type, x, y] of ACTIONS.slice(0, maxActions)) {
      if (!budgetAllows(budget, name, delayMs + 1200)) break;
      try {
        if (type === "click") {
          await clickAt(cdp, x, y);
        } else if (type === "right") {
          await rightClickAt(cdp, x, y);
        } else if (type === "hover") {
          await hoverAt(cdp, x, y);
        } else if (type === "esc") {
          await pressEsc(cdp);
        }
        await sleep(type === "click" || type === "right" ? Math.max(delayMs, 420) : delayMs);
        log.push(await collectState(cdp, name));
      } catch (error) {
        log.push({ step: name, error: error.message });
        if (error.code === "AUDIT_BUDGET" || /CDP (?:命令执行超时|WebSocket)/.test(error.message)) {
          budget.exhaustedAt ||= name;
          break;
        }
      }
    }

    if (SAVE_SCREENSHOT && budgetAllows(budget, "screenshot", 1500)) {
      await cdp.send("Page.enable", {}, 10000);
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeAuditScreenshot(`${outBase}.png`, screenshot.data);
    }
  } catch (error) {
    fatalError = error;
    if (error.code === "AUDIT_BUDGET" || /(?:审计时间预算已耗尽|CDP 命令执行超时|CDP WebSocket)/.test(String(error.message || error))) {
      budget.exhaustedAt ||= "fatal";
    }
    log.push({ step: "fatal", error: String(error.message || error) });
  } finally {
    if (cdp) cdp.close();
  }

  const hits = [];
  const seenHits = new Set();
  for (const hit of log.flatMap((entry) => entry.hits || [])) {
    const key = `${hit.step}|${hit.kind}|${hit.attribute || ""}|${hit.text}`;
    if (!seenHits.has(key)) {
      seenHits.add(key);
      hits.push(hit);
    }
  }
  const output = {
    complete: !fatalError && !budget.exhaustedAt,
    budget: {
      limitMs: budget.limitMs,
      elapsedMs: Date.now() - budget.startedAt,
      exhausted: Boolean(budget.exhaustedAt),
      exhaustedAt: budget.exhaustedAt
    },
    target: target ? { title: target.title, url: target.url } : null,
    hitCount: hits.length,
    hits,
    log
  };
    const written = writeAuditReport(`${outBase}.json`, output);
  // 计数取脱敏后真正写进报告的条目数，否则终端会报出被身份噪声过滤剔掉的误报。
  const writtenHits = Array.isArray(written.hits) ? written.hits : [];
  const summary = {
    out: `${outBase}.json`,
    screenshot: SAVE_SCREENSHOT ? `${outBase}.png` : null,
    complete: output.complete,
    budget: output.budget,
    hitCount: writtenHits.length,
    hits: writtenHits.slice(0, 80)
  };
  console.log(`指定界面审计${summary.complete ? "完成" : "已保存部分结果"}：发现 ${summary.hitCount} 条待复核文本，报告已保存到 _generated/${path.basename(summary.out)}。`);
  if (SHOW_DETAILS) {
    console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  }
  if (!summary.complete) process.exitCode = fatalError && !budget.exhaustedAt ? 1 : 2;
}

function selfTest() {
  const generatedScan = String(collectState);
  const expectedOut = path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告");
  const checks = [
    [/\bel\.value\b/.test(generatedScan), false],
    [/input-value/.test(generatedScan), false],
    [/document\.body\s*(?:&&|\?)\s*document\.body\.innerText/.test(generatedScan), false],
    [/bodyPreview|bodyLines/.test(generatedScan), false],
    [/contenteditable='true'/.test(generatedScan), true],
    [/key-value-form-row/.test(generatedScan), true],
    [resolveOutBase("自检报告"), expectedOut],
    [englishHits([{ text: "Ctrl+K", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "询问 AICtrl+Alt+P", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "连接 Git", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "SDK 生成", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "基础版基于角色的访问控制（RBAC）", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "aerozb 的头像", kind: "attribute", attribute: "aria-label" }], "self-test").length, 0],
    [englishHits([{ text: "Press Ctrl+K to search", kind: "body" }], "self-test").length, 1],
    [englishHits([{ text: "Description", kind: "body" }], "self-test").length, 1],
    [Number(argValue("--delay-ms", "800")) >= 800, true],
    [/MAX_TEXT_NODES/.test(generatedScan), true],
    [/MAX_ELEMENTS/.test(generatedScan), true],
    [/AbortController/.test(String(getJson)), true],
    [DEFAULT_AUDIT_BUDGET_MS >= 90000, true]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) {
    throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  }
  const summary = { ok: true, checks: checks.length };
  if (SHOW_DETAILS) {
    console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  } else {
    console.log(`指定界面审计脚本自检通过，共 ${checks.length} 项。`);
  }
}

Promise.resolve().then(() => hasFlag("--self-test") ? selfTest() : main()).catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (SHOW_DETAILS) {
    console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
  } else {
    console.error("指定界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  }
  process.exitCode = 1;
});
