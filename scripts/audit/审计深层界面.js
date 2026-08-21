#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  sanitizeAuditReport,
  resolveAuditOutputBase,
  writeAuditReport,
  writeAuditScreenshot
} = require("./审计安全.js");
const SHOW_DETAILS = process.argv.includes("--details");
const SAVE_SCREENSHOT = process.argv.includes("--screenshot");
const SELF_TEST = process.argv.includes("--self-test");
const THOROUGH = process.argv.includes("--thorough");
const MAX_AGGREGATE_HITS = 1000;
const LOG_HIT_LIMIT = 20;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function integerArg(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = argValue(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

function resolveOutBase(value) {
  return resolveAuditOutputBase(value, "postman-audit");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultAuditOptions(thorough = false) {
  return thorough ? {
    delayMs: 220,
    auditBudgetMs: 600000,
    overlayHover: 50,
    overlayRight: 25,
    createdHover: 28,
    createdRight: 14,
    settingsHover: 50,
    settingsRight: 18,
    controlHover: 18,
    controlRight: 10,
    newMenuItems: 24,
    importItems: 26,
    settingsTabs: 16,
    knownControls: 25
  } : {
    delayMs: 180,
    auditBudgetMs: 90000,
    overlayHover: 6,
    overlayRight: 2,
    createdHover: 4,
    createdRight: 1,
    settingsHover: 6,
    settingsRight: 2,
    controlHover: 3,
    controlRight: 1,
    newMenuItems: 4,
    importItems: 4,
    settingsTabs: 5,
    knownControls: 10
  };
}

function createAuditBudget(limitMs, startedAt = Date.now()) {
  return {
    limitMs,
    startedAt,
    deadline: startedAt + limitMs,
    exhaustedAt: null
  };
}

function budgetAllows(budget, log, step, reserveMs = 0, now = Date.now()) {
  if (!budget || now + reserveMs < budget.deadline) {
    return true;
  }
  if (!budget.exhaustedAt) {
    budget.exhaustedAt = step;
    log.push({ step: "audit-budget-exhausted", label: step, phase: "预算耗尽" });
  }
  return false;
}

function summarizeBudget(budget, now = Date.now()) {
  return {
    limitMs: budget.limitMs,
    elapsedMs: Math.max(0, now - budget.startedAt),
    exhausted: Boolean(budget.exhaustedAt),
    exhaustedAt: budget.exhaustedAt
  };
}

function isAuditTimeoutError(error) {
  return /(?:审计时间预算已耗尽|CDP 命令执行超时)/.test(String(error && error.message || error));
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

function resolvePortFile() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("未设置 APPDATA 环境变量，无法定位 Postman 的 DevToolsActivePort 文件。");
  }
  return path.join(appData, "Postman", "DevToolsActivePort");
}

async function connectCdp(wsUrl, deadline = null) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

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
    send(method, params = {}, timeoutMs = 15000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const remaining = deadline ? deadline - Date.now() : timeoutMs;
        if (remaining <= 0) {
          reject(new Error(`审计时间预算已耗尽：${method}`));
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
      rejectPending();
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

function targetSummary(target) {
  return target ? {
    id: target.id,
    title: target.title,
    type: target.type,
    url: target.url
  } : null;
}

function isDeepWorkbenchTarget(target) {
  const title = String(target && target.title || "");
  const url = String(target && target.url || "");
  return /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(url) &&
    /(?:未命名请求|新建请求|我的工作区|Untitled Request|New Request|HTTP Request|My Workspace|Runner|运行器)/i.test(title);
}

function isRequestWorkbenchTarget(target) {
  const title = String(target && target.title || "");
  const url = String(target && target.url || "");
  return /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(url) &&
    /(?:未命名请求|新建请求|Untitled Request|New Request|HTTP Request|MQTT 请求|MQTT Request)/i.test(title);
}

async function waitForPostmanTarget(port, timeoutMs, targetTitle) {
  const deadline = Date.now() + timeoutMs;
  const requested = targetTitle ? new RegExp(targetTitle, "i") : null;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(100, deadline - Date.now());
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`, Math.min(5000, remaining));
      lastTargets = targets;
      const pageTargets = targets.filter((item) => {
        return item.type === "page" &&
          item.webSocketDebuggerUrl &&
          !String(item.url || "").startsWith("devtools://");
      });

      if (requested) {
        const match = pageTargets.find((item) => requested.test(`${item.title}\n${item.url}\n${item.id}`));
        if (match) {
          return match;
        }
      }

      const request = pageTargets.find(isRequestWorkbenchTarget);
      if (request) {
        return request;
      }

      const deep = pageTargets.find(isDeepWorkbenchTarget);
      if (deep) {
        return deep;
      }

      const desktop = pageTargets.find((item) => /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(String(item.url || "")));
      if (desktop) {
        return desktop;
      }
    } catch (_) {}
    await sleep(800);
  }
  const details = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(sanitizeAuditReport(lastTargets))}` : "";
  throw new Error(`未找到 Postman 调试目标。${details}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.text || "页面脚本执行失败。";
    const details = SHOW_DETAILS ? ` 诊断：${JSON.stringify(sanitizeAuditReport(result.exceptionDetails))}` : "";
    throw new Error(`${message}${details}`);
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

async function capture(cdp, outPath) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeAuditScreenshot(outPath, shot.data);
}

function pageScript(options = {}) {
  const mode = options.mode || "full";
  return String.raw`(() => {
    const MODE = "__MODE__";
    const ALLOWED_WORDS = new Set([
      "postman", "getpostman", "api", "apis", "url", "uri", "http", "https", "websocket", "graphql", "grpc", "mqtt", "mqtts", "mcp", "socket", "socket.io", "io",
      "json", "xml", "html", "javascript", "oauth", "bearer", "jwt", "curl", "grpcurl", "wsdl", "openapi", "swagger", "csv", "asyncapi", "protobuf",
      "har", "pem", "ssl", "tls", "rbac", "sdk", "git", "github", "vscode", "vs", "code", "npm", "cookie", "cookies", "recaptcha", "qos", "cli", "ai",
      "ctrl", "alt", "shift", "tab", "enter", "esc", "cmd", "base64", "id", "ids", "uuid", "svg", "png", "jpg", "jpeg", "kb", "mb", "gb", "ms", "px", "llm",
      "aws", "ntlm", "hawk", "akamai", "edgegrid", "atlassian", "claude", "opus", "get", "post", "put", "patch", "delete", "del", "head", "options",
      "trace", "connect", "hashicorp", "vault", "secret", "secrets", "slack", "microsoft", "teams", "go", "x-www-form-urlencoded", "x-api-key", "raw", "none", "inherit", "smtp", "imap", "dns", "tcp", "udp", "icmp",
      "macos", "windows", "markdown", "rest", "rpc", "iot", "header", "headers", "am", "pm", "typescript", "fql", "schema", "fern"
    ]);
    const ALLOWED_PHRASES = new Set([
      "postman api platform",
      "postman code",
      "claude code",
      "claude opus",
      "claude opus 4.7",
      "public api network",
      "app builder"
    ]);
    const MAX_TEXT_LENGTH = 600;
    const MAX_TARGETS = 180;
    const MAX_HITS = 160;
    const MAX_TEXT_NODES = 2400;
    const MAX_ELEMENTS = 6000;
    const PRIVATE_SELECTOR = [
      "input", "textarea", "select", "pre", "code", "[contenteditable='true']",
      ".monaco-editor", ".CodeMirror", ".ace_editor", "[data-slate-editor='true']",
      "[data-testid*='request-body']", "[data-testid*='response-body']",
      "[data-testid*='raw-body']", "[data-testid*='response-view']",
      "[data-testid*='code-editor']", "[data-testid*='script-editor']"
    ].join(",");

    function norm(text) {
      return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100,
        cx: Math.round((rect.x + rect.width / 2) * 100) / 100,
        cy: Math.round((rect.y + rect.height / 2) * 100) / 100
      };
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    function privateElement(el) {
      if (!el || !el.closest) return false;
      return Boolean(el.closest(PRIVATE_SELECTOR));
    }
    function labelOf(el) {
      if (privateElement(el)) return "";
      const explicit = norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.getAttribute("data-testid")) ||
        norm(el.getAttribute("role"));
      if (explicit) return explicit.slice(0, MAX_TEXT_LENGTH);
      const raw = String(el.textContent || "");
      if (raw.length > MAX_TEXT_LENGTH * 2) return el.tagName.toLowerCase();
      return norm(el.innerText || raw).slice(0, MAX_TEXT_LENGTH) || el.tagName.toLowerCase();
    }
    function matchingElements(root, selector, limit, traversal = { visited: 0 }) {
      const result = [];
      if (!root || limit <= 0) return result;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = walker.nextNode()) && traversal.visited < MAX_ELEMENTS && result.length < limit) {
        traversal.visited += 1;
        if (el.matches && el.matches(selector)) result.push(el);
      }
      return result;
    }
    function overlayRoots() {
      const selector = [
        "[role='dialog']",
        "[aria-modal='true']",
        "[role='menu']",
        "[role='listbox']",
        "[role='tooltip']",
        "[data-testid*='modal']",
        "[data-testid*='popover']",
        "[data-aether-id*='popover']"
      ].join(",");
      const candidates = matchingElements(document, selector, 128).filter(visible);
      return candidates
        .filter((root, index) => !candidates.slice(0, index).some((parent) => parent.contains(root)))
        .slice(0, 12);
    }
    function inAnyRoot(el, roots) {
      return roots.some((root) => root === el || root.contains(el));
    }
    function isInteractive(el) {
      if (!visible(el) || privateElement(el)) return false;
      const tag = el.tagName.toLowerCase();
      const role = norm(el.getAttribute("role")).toLowerCase();
      const style = getComputedStyle(el);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (["button", "a", "input", "select", "textarea", "summary"].includes(tag)) return true;
      if (["button", "menuitem", "tab", "checkbox", "radio", "switch", "option", "combobox", "textbox", "link"].includes(role)) return true;
      if (el.hasAttribute("onclick")) return true;
      if (el.tabIndex >= 0 && (style.cursor === "pointer" || el.getAttribute("aria-label"))) return true;
      if (style.cursor === "pointer" && labelOf(el)) return true;
      return false;
    }
    function collectTargets() {
      const selector = [
        "button", "a", "input", "select", "textarea", "summary",
        "[role='button']", "[role='menuitem']", "[role='tab']", "[role='checkbox']", "[role='radio']",
        "[role='switch']", "[role='option']", "[role='combobox']", "[role='textbox']", "[role='link']",
        "[aria-label]", "[title]", "[placeholder]", "[onclick]", "[tabindex]", "[data-tab-id]"
      ].join(",");
      const roots = MODE === "overlay" ? overlayRoots() : [];
      const traversal = { visited: 0 };
      const source = [];
      const sourceRoots = MODE === "overlay" ? roots : [document];
      for (const root of sourceRoots) {
        const remaining = MAX_TARGETS * 8 - source.length;
        if (remaining <= 0 || traversal.visited >= MAX_ELEMENTS) break;
        source.push(...matchingElements(root, selector, remaining, traversal));
      }
      const targets = source
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .filter(isInteractive)
        .map((el, index) => Object.assign({
          index,
          tag: el.tagName,
          role: norm(el.getAttribute("role")),
          text: labelOf(el).slice(0, 600),
          inOverlay: roots.length ? inAnyRoot(el, roots) : false
        }, rectOf(el)))
        .filter((item) => item.cx >= 0 && item.cy >= 0 && item.cx <= innerWidth && item.cy <= innerHeight);
      const dedupe = new Map();
      for (const item of targets) {
        const key = Math.round(item.cx / 3) + ":" + Math.round(item.cy / 3) + ":" + item.text;
        const old = dedupe.get(key);
        if (!old || item.w * item.h > old.w * old.h) {
          dedupe.set(key, item);
        }
      }
      return Array.from(dedupe.values()).sort((a, b) => (a.y - b.y) || (a.x - b.x)).slice(0, MAX_TARGETS);
    }
    function allowedEnglish(text) {
      const normalized = norm(text);
      const loweredText = normalized.toLowerCase();
      if (/的头像$|团队标志$|（你）$/.test(normalized)) return true;
      if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(normalized)) return true;
      if (/^HTTP\/\d(?:\.\d|\.x)?$/i.test(normalized)) return true;
      if (/^checkbox-[A-Za-z0-9#+.-]+$/i.test(normalized)) return true;
      if (ALLOWED_PHRASES.has(loweredText)) return true;
      const words = normalized.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
      const meaningful = words.filter((word) => {
        const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (!lowered || lowered.length <= 1) return false;
        if (ALLOWED_WORDS.has(lowered)) return false;
        if (lowered.indexOf("/") >= 0 && lowered.split("/").every((part) => ALLOWED_WORDS.has(part))) return false;
        if (/^[a-f0-9]{6,}$/i.test(lowered)) return false;
        if (/^\d/.test(lowered)) return false;
        return true;
      });
      // Keep ordinary UI words such as Save/Import/Settings visible. Only
      // skip identifier-shaped values with an explicit separator or digit.
      if (/^(?=.*[_\d])[a-z][a-z0-9_]{2,31}$/i.test(normalized)) return true;
      return meaningful.length === 0;
    }
    function isEnglishLeak(text) {
      const value = norm(text).slice(0, MAX_TEXT_LENGTH);
      if (!value || value.length < 2) return false;
      if (!/[A-Za-z]{2,}/.test(value)) return false;
      if (/\b(Ctrl|Alt|Shift|Cmd|Command|Win)\s*\+/i.test(value)) return false;
      if (/[\u4e00-\u9fff]/.test(value) && /https?:\/\//i.test(value)) return false;
      if (/^https?:\/\//i.test(value)) return false;
      if (/^[\w.-]+@[\w.-]+$/.test(value)) return false;
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+){1,}$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}$/i.test(value)) return false;
      if (/^[a-z0-9_-]+__(?:[a-z0-9_-]+)(?:--[a-z0-9_-]+)?$/i.test(value)) return false;
      if (/[A-Z]:\\(?:Windows|Program Files|Users)\\/i.test(value)) return false;
      if (/^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(value)) return false;
      if (/^\d+\s+results?\s+available\.Use Up and Down to choose options,/i.test(value)) return false;
      if (/\b(Salesforce|Docusign|DocuSign|UPS|Zoho|Adyen|Datadog|HubSpot|Mastercard|Notion|OpenAI|PayPal|Pipedrive|Plaid|Razorpay|Tableau|WhatsApp|Box|Cisco|Meraki|PandaDoc|PingOne)\b/.test(value)) return false;
      if (/\b(Public Workspace|Developers|API Collection|APIs|REST API|Cloud API|Business Platform|Published Postman Templates|Documentation Checklist|Intro to writing tests|Learn by API|Postman DevRel|Postman Team|API Reference|Platform API|Dashboard API)\b/i.test(value)) return false;
      if (/^[A-Z][A-Za-z0-9 '&().-]*\s+API(?:\s|\b).*(?:\(v\d+\)|\(JP\)|集合|Collection|Endpoints|OAuthAuthCode|Shipping|Reference)$/i.test(value)) return false;
      return !allowedEnglish(value);
    }
    function addHit(hits, text) {
      const value = norm(text).slice(0, MAX_TEXT_LENGTH);
      if (!isEnglishLeak(value)) return;
      if (!hits.has(value) && hits.size >= MAX_HITS) return;
      if (!hits.has(value)) {
        hits.set(value, { text: value, count: 0 });
      }
      hits.get(value).count += 1;
    }
    function collectTextNodes(root, hits, traversal) {
      if (!root || privateElement(root)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && traversal.visited < MAX_TEXT_NODES) {
        traversal.visited += 1;
        const parent = node.parentElement;
        if (!parent || privateElement(parent) || !visible(parent)) continue;
        const raw = String(node.nodeValue || "");
        if (!raw || raw.length > MAX_TEXT_LENGTH * 2) continue;
        addHit(hits, raw);
      }
    }
    function collectEnglish(targets) {
      const hits = new Map();
      addHit(hits, document.title);
      const roots = MODE === "overlay" ? overlayRoots() : [document.body || document.documentElement].filter(Boolean);
      const textTraversal = { visited: 0 };
      for (const root of roots) {
        collectTextNodes(root, hits, textTraversal);
        if (textTraversal.visited >= MAX_TEXT_NODES) break;
      }
      const attributeElements = [];
      const seenElements = new Set();
      const attributeTraversal = { visited: 0 };
      for (const root of roots) {
        const remaining = MAX_TARGETS * 2 - attributeElements.length;
        if (remaining <= 0 || attributeTraversal.visited >= MAX_ELEMENTS) break;
        for (const el of matchingElements(root, "[aria-label],[title],[placeholder],[alt]", remaining, attributeTraversal)) {
          if (!seenElements.has(el)) {
            seenElements.add(el);
            attributeElements.push(el);
          }
        }
      }
      for (const el of attributeElements.filter((item) => visible(item) && !privateElement(item))) {
        for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
          if (el.hasAttribute(attr)) {
            addHit(hits, el.getAttribute(attr));
          }
        }
      }
      for (const item of targets) {
        addHit(hits, item.text);
      }
      return Array.from(hits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    }
    function collectOverlays() {
      return overlayRoots().map((root) => {
        const rect = rectOf(root);
        return Object.assign({
          tag: root.tagName,
          role: norm(root.getAttribute("role")),
          testid: norm(root.getAttribute("data-testid"))
        }, rect);
      });
    }
    const targets = collectTargets();
    return {
      url: location.href,
      title: document.title,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      size: { width: innerWidth, height: innerHeight },
      overlays: collectOverlays(),
      targets,
      hits: collectEnglish(targets)
    };
  })()`.replace("__MODE__", mode);
}

const visibleOverlayCountScript = String.raw`(() => {
  const selector = [
    "[role='dialog']", "[aria-modal='true']", "[role='menu']", "[role='listbox']",
    "[role='tooltip']", "[data-testid*='modal']", "[data-testid*='popover']",
    "[data-aether-id*='popover']"
  ].join(",");
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  let visited = 0;
  let el;
  while ((el = walker.nextNode()) && visited < 6000 && count < 24) {
    visited += 1;
    if (!el.matches(selector)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0) count += 1;
  }
  return count;
})()`;

function findTargetScript(patterns, options = {}) {
  const minY = typeof options.minY === "number" ? options.minY : null;
  const maxY = typeof options.maxY === "number" ? options.maxY : null;
  const maxX = typeof options.maxX === "number" ? options.maxX : null;
  const scope = options.scope || "full";
  return `(() => {
    const patterns = ${JSON.stringify(patterns)}.map((value) => new RegExp(value, "i"));
    const minY = ${JSON.stringify(minY)};
    const maxY = ${JSON.stringify(maxY)};
    const maxX = ${JSON.stringify(maxX)};
    const scope = ${JSON.stringify(scope)};
    const MAX_ELEMENTS = 6000;
    const MAX_MATCHES = 1440;
    const MAX_TEXT_LENGTH = 600;
    const PRIVATE_SELECTOR = [
      "input", "textarea", "select", "pre", "code", "[contenteditable='true']",
      ".monaco-editor", ".CodeMirror", ".ace_editor", "[data-slate-editor='true']",
      "[data-testid*='request-body']", "[data-testid*='response-body']",
      "[data-testid*='raw-body']", "[data-testid*='response-view']",
      "[data-testid*='code-editor']", "[data-testid*='script-editor']"
    ].join(",");
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      if (!el || el.closest(PRIVATE_SELECTOR)) return "";
      const explicit = norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.getAttribute("data-testid"));
      if (explicit) return explicit.slice(0, MAX_TEXT_LENGTH);
      const raw = String(el.textContent || "");
      if (raw.length > MAX_TEXT_LENGTH * 2) return "";
      return norm(el.innerText || raw).slice(0, MAX_TEXT_LENGTH);
    }
    function matchingElements(root, selector, limit, traversal) {
      const result = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = walker.nextNode()) && traversal.visited < MAX_ELEMENTS && result.length < limit) {
        traversal.visited += 1;
        if (el.matches(selector)) result.push(el);
      }
      return result;
    }
    const overlayTraversal = { visited: 0 };
    const roots = matchingElements(document, "[role='dialog'],[aria-modal='true'],[role='menu'],[role='listbox'],[data-testid*='modal'],[data-testid*='popover'],[data-aether-id*='popover']", 128, overlayTraversal).filter(visible).slice(0, 12);
    const selector = "button,a,input,textarea,select,[role='button'],[role='menuitem'],[role='tab'],[role='option'],[role='combobox'],[role='textbox'],[aria-label],[title],[placeholder],[tabindex]";
    const traversal = { visited: 0 };
    const source = [];
    for (const root of scope === "overlay" ? roots : [document]) {
      const remaining = MAX_MATCHES - source.length;
      if (remaining <= 0 || traversal.visited >= MAX_ELEMENTS) break;
      source.push(...matchingElements(root, selector, remaining, traversal));
    }
    const matches = source.filter((el, index, arr) => arr.indexOf(el) === index).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2
      };
    }).filter((item) => {
      if (!item.text || !patterns.some((pattern) => pattern.test(item.text))) return false;
      if (minY !== null && item.cy < minY) return false;
      if (maxY !== null && item.cy > maxY) return false;
      if (maxX !== null && item.cx > maxX) return false;
      return true;
    });
    matches.sort((a, b) => {
      const exactA = patterns.some((pattern) => pattern.source.startsWith("^") && pattern.test(a.text)) ? 0 : 1;
      const exactB = patterns.some((pattern) => pattern.source.startsWith("^") && pattern.test(b.text)) ? 0 : 1;
      return exactA - exactB || (a.y - b.y) || (a.x - b.x) || (a.w * a.h - b.w * b.h);
    });
    return matches[0] || null;
  })()`;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function safeTargetText(text) {
  const value = normText(text);
  if (!value || /^(button|div|span|svg|path|input)$/i.test(value)) {
    return false;
  }
  if (/Start Trial|Trial|Sign Out|Sign out|Log out|Delete account|Upgrade|Request a demo|Checkout|Billing|Payment|purchase|Pay annually|Pay monthly|Request an approver|Add subscription|Add billing information|Add payment method|Exit|Quit|Close window|Close Window|Minimize|Maximize|Restore down|Restore Down|升级|开始试用|试用|付费|付款|结账|账单|支付|订阅|套餐|计划|退出|关闭窗口|最小化|最大化|向下还原/i.test(value)) {
    return false;
  }
  if (/\b(Browse|Choose File|Choose Files|Select File|Select Files|Upload File|Upload Files|Open File|Open Folder|Import File)\b|浏览|选择文件|上传文件|打开文件|打开文件夹/i.test(value)) {
    return false;
  }
  return true;
}

function compactHit(hit) {
  return {
    text: normText(hit && hit.text).slice(0, 600),
    count: Number(hit && hit.count) || 1
  };
}

function mergeCompactHits(targetMap, hits, limit, step = null) {
  for (const hit of hits || []) {
    const compact = compactHit(hit);
    if (!compact.text) {
      continue;
    }
    if (!targetMap.has(compact.text)) {
      if (targetMap.size >= limit) {
        continue;
      }
      targetMap.set(compact.text, {
        text: compact.text,
        count: 0,
        ...(step ? { step } : {})
      });
    }
    targetMap.get(compact.text).count += compact.count;
  }
}

function summarizeState(state) {
  return {
    url: state && state.url,
    title: state && state.title,
    localized: state && state.localized,
    overlayCount: state && state.overlays ? state.overlays.length : 0,
    hitCount: state && state.hits ? state.hits.length : 0,
    hits: (state && state.hits || []).slice(0, LOG_HIT_LIMIT).map(compactHit),
    targetCount: state && state.targets ? state.targets.length : 0
  };
}

function mergeHits(allHits, step, hits) {
  mergeCompactHits(allHits, hits, MAX_AGGREGATE_HITS, step);
}

async function collect(cdp, mode, step, allHits, log) {
  const state = await evaluate(cdp, pageScript({ mode }));
  mergeHits(allHits, step, state.hits);
  log.push(Object.assign({ step, mode }, summarizeState(state)));
  return state;
}

async function clickFirst(cdp, patterns, delayMs, options = {}) {
  const target = await evaluate(cdp, findTargetScript(patterns, options));
  if (!target) {
    return { ok: false, patterns, options };
  }
  await clickAt(cdp, target.cx, target.cy);
  await sleep(delayMs);
  return { ok: true, patterns, options, target };
}

async function hoverTargets(cdp, targets, stepPrefix, allHits, log, delayMs, budget) {
  const phaseHits = new Map();
  let processed = 0;
  let errorCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (!budgetAllows(budget, log, `${stepPrefix}-hover-${i}`, Math.max(delayMs, 360) + 250)) {
      break;
    }
    const item = targets[i];
    processed += 1;
    try {
      await hoverAt(cdp, item.cx, item.cy);
      await sleep(Math.max(delayMs, 360));
      const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-hover-${i}`, state.hits);
      mergeCompactHits(phaseHits, state.hits, LOG_HIT_LIMIT);
    } catch (_) {
      errorCount += 1;
    }
  }
  log.push({
    step: `${stepPrefix}-hover`,
    phase: errorCount ? `完成，失败 ${errorCount} 项` : "完成",
    targetCount: processed,
    hitCount: phaseHits.size,
    hits: Array.from(phaseHits.values())
  });
}

async function rightClickTargets(cdp, targets, stepPrefix, allHits, log, delayMs, budget) {
  const phaseHits = new Map();
  let processed = 0;
  let errorCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (!budgetAllows(budget, log, `${stepPrefix}-right-${i}`, delayMs + 350)) {
      break;
    }
    const item = targets[i];
    processed += 1;
    try {
      await rightClickAt(cdp, item.cx, item.cy);
      await sleep(delayMs);
      const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-right-${i}`, state.hits);
      mergeCompactHits(phaseHits, state.hits, LOG_HIT_LIMIT);
    } catch (_) {
      errorCount += 1;
    }
    await pressEsc(cdp);
    await sleep(80);
  }
  log.push({
    step: `${stepPrefix}-right-click`,
    phase: errorCount ? `完成，失败 ${errorCount} 项` : "完成",
    targetCount: processed,
    hitCount: phaseHits.size,
    hits: Array.from(phaseHits.values())
  });
}

async function closeTransientUi(cdp, delayMs) {
  await pressEsc(cdp);
  await sleep(90);
  await pressEsc(cdp);
  await sleep(Math.max(140, delayMs));
}

async function scanVisibleTargets(cdp, area, allHits, log, delayMs, options = {}, budget = null) {
  if (!budgetAllows(budget, log, `${area}-state`, 750)) {
    return { targets: [], size: null, skipped: true };
  }
  const mode = options.mode || "full";
  const hoverLimit = Number.isFinite(options.hoverLimit) ? Math.max(0, options.hoverLimit) : 24;
  const rightLimit = Number.isFinite(options.rightLimit) ? Math.max(0, options.rightLimit) : 12;
  const state = await collect(cdp, mode, `${area}-state`, allHits, log);
  const targets = (state.targets || [])
    .filter((item) => safeTargetText(item.text))
    .filter((item) => !options.filter || options.filter(item, state));
  await hoverTargets(cdp, targets.slice(0, hoverLimit), area, allHits, log, delayMs, budget);
  await rightClickTargets(cdp, targets.slice(0, rightLimit), area, allHits, log, delayMs, budget);
  return {
    targets: state.targets || [],
    size: state.size || null,
    overlayCount: state.overlays ? state.overlays.length : 0
  };
}

function uniqueLabels(targets) {
  const labels = [];
  const seen = new Set();
  for (const item of targets || []) {
    const label = normText(item.text);
    const key = label.toLowerCase();
    if (!safeTargetText(label) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

async function auditNewMenu(cdp, allHits, log, delayMs, limits, budget) {
  if (!budgetAllows(budget, log, "new-menu-start", delayMs + 750)) {
    return;
  }
  await closeTransientUi(cdp, delayMs);
  const opened = await clickFirst(cdp, ["^新建$", "^New$", "^Create new request$", "^新建请求$"], delayMs, { maxX: 460 });
  log.push({ step: "new-menu-open", opened });
  if (!opened.ok) {
    return;
  }
  const menuState = await scanVisibleTargets(cdp, "new-menu", allHits, log, delayMs, { mode: "overlay", hoverLimit: limits.overlayHover, rightLimit: limits.overlayRight }, budget);
  const labels = uniqueLabels(menuState.targets)
    .filter((label) => !/^(关闭|取消|完成|确定|Close|Cancel|Done|OK)$/i.test(label))
    .slice(0, limits.newMenuItems);
  log.push({ step: "new-menu-labels", labels });

  for (let i = 0; i < labels.length; i += 1) {
    if (!budgetAllows(budget, log, `new-menu-click-${i}`, (delayMs * 2) + 1200)) {
      break;
    }
    const label = labels[i];
    await closeTransientUi(cdp, delayMs);
    const reopen = await clickFirst(cdp, ["^新建$", "^New$", "^Create new request$", "^新建请求$"], delayMs, { maxX: 460 });
    const clicked = reopen.ok ? await clickFirst(cdp, [`^${escapeRegExp(label)}$`], Math.max(delayMs + 450, 850), { scope: "overlay" }) : { ok: false, reason: "menu-not-opened", label };
    log.push({ step: `new-menu-click-${i}`, label, reopen, clicked });
    await scanVisibleTargets(cdp, `new-menu-created-${i}-${label.slice(0, 24)}`, allHits, log, delayMs, {
      mode: "full",
      hoverLimit: limits.createdHover,
      rightLimit: limits.createdRight,
      filter(item) {
        return item.cy > 35;
      }
    }, budget);
  }
}

async function auditSettings(cdp, allHits, log, delayMs, limits, budget) {
  if (!budgetAllows(budget, log, "settings-start", delayMs + 900)) {
    return;
  }
  await closeTransientUi(cdp, delayMs);
  const menu = await clickFirst(cdp, ["^设置$", "^Settings$"], delayMs, { minY: 0, maxY: 80 });
  log.push({ step: "settings-menu-open", menu });
  if (!menu.ok) {
    return;
  }
  await scanVisibleTargets(cdp, "settings-dropdown", allHits, log, delayMs, {
    mode: "overlay",
    hoverLimit: limits.overlayHover,
    rightLimit: limits.overlayRight
  }, budget);
  let appSettings = await clickFirst(cdp, ["应用设置", "App Settings", "^设置$", "^Settings$", "Preferences"], Math.max(delayMs + 600, 1000), { scope: "overlay" });
  if (!appSettings.ok) {
    const reopened = await clickFirst(cdp, ["^设置$", "^Settings$"], delayMs, { minY: 0, maxY: 80 });
    log.push({ step: "settings-menu-reopen", reopened });
    if (reopened.ok) {
      appSettings = await clickFirst(cdp, ["应用设置", "App Settings", "^设置$", "^Settings$", "Preferences"], Math.max(delayMs + 600, 1000), { scope: "overlay" });
    }
  }
  log.push({ step: "settings-dialog-open", appSettings });
  if (!appSettings.ok) {
    await closeTransientUi(cdp, delayMs);
    return;
  }

  const state = await scanVisibleTargets(cdp, "settings-dialog-initial", allHits, log, delayMs, { mode: "overlay", hoverLimit: limits.settingsHover, rightLimit: limits.settingsRight }, budget);
  const tabLabels = uniqueLabels((state.targets || []).filter((item) => item.role === "tab" || /^(通用|主题|快捷键|数据|证书|代理|更新|插件|General|Themes|Shortcuts|Data|Certificates|Proxy|Update|Add-ons|Add-ons?)$/i.test(item.text)))
    .slice(0, limits.settingsTabs);
  log.push({ step: "settings-tab-labels", labels: tabLabels });

  for (let i = 0; i < tabLabels.length; i += 1) {
    if (!budgetAllows(budget, log, `settings-tab-click-${i}`, delayMs + 1000)) {
      break;
    }
    const label = tabLabels[i];
    const clicked = await clickFirst(cdp, [`^${escapeRegExp(label)}$`], Math.max(delayMs + 280, 650), { scope: "overlay" });
    log.push({ step: `settings-tab-click-${i}`, label, clicked });
    await scanVisibleTargets(cdp, `settings-tab-${i}-${label.slice(0, 24)}`, allHits, log, delayMs, {
      mode: "overlay",
      hoverLimit: limits.settingsHover,
      rightLimit: limits.settingsRight
    }, budget);
  }
  await closeTransientUi(cdp, delayMs);
}

async function auditKnownControls(cdp, allHits, log, delayMs, limits, budget) {
  const controls = [
    { area: "top-workspace", patterns: ["^我的工作区$", "^My Workspace$"], options: { minY: 0, maxY: 80 } },
    // The global search panel is a heavyweight remote surface. Opening it in
    // the routine balanced pass can make the requester renderer allocate
    // hundreds of megabytes before CDP can inspect the resulting overlay.
    // Keep it for explicit --thorough release audits only.
    { area: "top-search", patterns: ["打开搜索", "^搜索$", "^Search$"], options: { minY: 0, maxY: 90 }, skipBalanced: true },
    { area: "notifications", patterns: ["^通知$", "^Notifications$"], options: { minY: 0, maxY: 90 } },
    { area: "account-menu", patterns: ["^管理账号$", "^账号$", "^Account$"], options: { minY: 0, maxY: 90 } },
    { area: "side-projects", patterns: ["^项目$", "^Projects$"], options: { maxX: 260 } },
    { area: "side-services", patterns: ["^服务$", "^Services$"], options: { maxX: 260 } },
    { area: "side-history", patterns: ["^历史$", "^History$"], options: { maxX: 520 } },
    { area: "side-local-files", patterns: ["^本地文件$", "^Local Files$"], options: { maxX: 320 } },
    { area: "side-collections", patterns: ["^集合$", "^Collections$"], options: { maxX: 330, minY: 90 } },
    { area: "side-environments", patterns: ["^环境$", "^Environments$"], options: { maxX: 330, minY: 600 } },
    { area: "side-specs", patterns: ["^规范$", "^Specs$"], options: { maxX: 330, minY: 600 } },
    { area: "side-flows", patterns: ["^流程$", "^Flows$"], options: { maxX: 330, minY: 600 } },
    { area: "request-type", patterns: ["切换请求类型", "^GET$", "^POST$"], options: { minY: 60, maxY: 120 } },
    { area: "request-send-options", patterns: ["发送选项", "Send options"], options: { minY: 90, maxY: 170 } },
    { area: "request-more-actions", patterns: ["查看更多操作", "More actions"], options: { minY: 180 } },
    { area: "request-cookie", patterns: ["^Cookie$"], options: { minY: 120 } },
    { area: "environment-selector", patterns: ["环境 无环境", "No Environment", "Select environment"], options: { minY: 20, maxY: 90 } },
    { area: "variable-editor", patterns: ["variable-editor-button", "^变量$"], options: { minY: 20, maxY: 90 } },
    { area: "ai-panel", patterns: ["^AI$"], options: { minY: 20, maxY: 90 } },
    { area: "code-panel", patterns: ["^代码$", "^Code$"], options: { minY: 20, maxY: 90 } },
    { area: "bottom-console", patterns: ["^控制台$", "^Console$"], options: { minY: 700 } },
    { area: "bottom-terminal", patterns: ["^终端$", "^Terminal$"], options: { minY: 700 } },
    { area: "bottom-globals", patterns: ["^全局变量$", "^Globals$"], options: { minY: 700 } },
    { area: "bottom-vault", patterns: ["^保险库$", "^Vault$"], options: { minY: 700 } },
    { area: "bottom-tools", patterns: ["^工具$", "^Tools$"], options: { minY: 700 } }
  ];

  const skipped = controls.filter((item) => item.skipBalanced && !THOROUGH).map((item) => item.area);
  if (skipped.length) {
    log.push({ step: "known-controls-skipped", phase: "平衡模式跳过重量级界面", areas: skipped });
  }
  const selectedControls = controls.filter((item) => THOROUGH || !item.skipBalanced).slice(0, limits.knownControls);
  for (let i = 0; i < selectedControls.length; i += 1) {
    if (!budgetAllows(budget, log, `known-control-${i}`, delayMs + 1000)) {
      break;
    }
    const item = selectedControls[i];
    await closeTransientUi(cdp, delayMs);
    const clicked = await clickFirst(cdp, item.patterns, Math.max(delayMs + 280, 620), item.options || {});
    log.push({ step: `known-control-click-${item.area}`, clicked, control: item });
    const overlayCount = clicked.ok ? await evaluate(cdp, visibleOverlayCountScript) : 0;
    const mode = overlayCount > 0 ? "overlay" : "full";
    await scanVisibleTargets(cdp, `known-control-${item.area}`, allHits, log, delayMs, {
      mode,
      hoverLimit: limits.controlHover,
      rightLimit: limits.controlRight
    }, budget);
  }
}

async function ensureRequestWorkbench(cdp, allHits, log, delayMs, budget) {
  if (!budgetAllows(budget, log, "ensure-request-start", 2500)) return false;
  const before = await evaluate(cdp, pageScript({ mode: "full" }));
  mergeHits(allHits, "ensure-request-before", before.hits);
  const hasRequestControls = (before.targets || []).some((item) => /sidebar-import-button|^导入$|^Import$/i.test(item.text || "")) &&
    (before.targets || []).some((item) => /^(参数|Params|授权|Authorization|Auth|请求头|Headers?|正文|Body|脚本|Scripts?|设置|Settings)$/i.test(item.text || ""));
  if (hasRequestControls) {
    log.push({ step: "ensure-request-workbench", ok: true, reason: "request-controls-visible" });
    return true;
  }

  const tabClick = await clickFirst(cdp, [
    "新建请求",
    "未命名请求",
    "HTTP 请求",
    "Untitled Request",
    "New Request",
    "HTTP Request"
  ], Math.max(delayMs + 650, 1000), { minY: 35, maxY: 85 });
  log.push({ step: "ensure-request-workbench-click-tab", tabClick });

  if (!budgetAllows(budget, log, "ensure-request-after-tab", 1500)) return false;
  const afterTab = await evaluate(cdp, pageScript({ mode: "full" }));
  mergeHits(allHits, "ensure-request-after-tab", afterTab.hits);
  const tabOk = (afterTab.targets || []).some((item) => /sidebar-import-button|^导入$|^Import$/i.test(item.text || "")) &&
    (afterTab.targets || []).some((item) => /^(参数|Params|授权|Authorization|Auth|请求头|Headers?|正文|Body|脚本|Scripts?|设置|Settings)$/i.test(item.text || ""));
  if (tabOk) {
    log.push({ step: "ensure-request-workbench", ok: true, reason: "request-tab-clicked" });
    return true;
  }

  if (!budgetAllows(budget, log, "ensure-request-new-menu", 1800)) return false;
  const newMenu = await clickFirst(cdp, ["^新建$", "^New$"], delayMs, { maxX: 470 });
  const httpClick = newMenu.ok ? await clickFirst(cdp, ["^HTTP 请求$", "^HTTP Request$", "^请求$", "^Request$"], Math.max(delayMs + 650, 1000), { scope: "overlay" }) : { ok: false, reason: "new-menu-not-opened" };
  log.push({ step: "ensure-request-workbench-new-http", newMenu, httpClick });
  return Boolean(httpClick.ok);
}

async function main() {
  const defaults = defaultAuditOptions(THOROUGH);
  const timeoutMs = integerArg("--timeout-ms", 30000, 1000, 600000);
  const delayMs = integerArg("--delay-ms", defaults.delayMs, 0, 10000);
  const auditBudgetMs = integerArg(
    "--audit-budget-ms",
    defaults.auditBudgetMs,
    5000,
    THOROUGH ? 3600000 : defaults.auditBudgetMs
  );
  const outBase = resolveOutBase(argValue("--out", "postman-deep-areas-audit"));
  const targetTitle = argValue("--target-title", "未命名请求|新建请求|Untitled|New Request|HTTP Request|MQTT 请求|MQTT Request");
  const limits = {
    overlayHover: integerArg("--overlay-hover", defaults.overlayHover, 0, THOROUGH ? 500 : defaults.overlayHover),
    overlayRight: integerArg("--overlay-right", defaults.overlayRight, 0, THOROUGH ? 500 : defaults.overlayRight),
    createdHover: integerArg("--created-hover", defaults.createdHover, 0, THOROUGH ? 500 : defaults.createdHover),
    createdRight: integerArg("--created-right", defaults.createdRight, 0, THOROUGH ? 500 : defaults.createdRight),
    settingsHover: integerArg("--settings-hover", defaults.settingsHover, 0, THOROUGH ? 500 : defaults.settingsHover),
    settingsRight: integerArg("--settings-right", defaults.settingsRight, 0, THOROUGH ? 500 : defaults.settingsRight),
    controlHover: integerArg("--control-hover", defaults.controlHover, 0, THOROUGH ? 500 : defaults.controlHover),
    controlRight: integerArg("--control-right", defaults.controlRight, 0, THOROUGH ? 500 : defaults.controlRight),
    newMenuItems: integerArg("--new-menu-items", defaults.newMenuItems, 0, THOROUGH ? 100 : defaults.newMenuItems),
    importItems: integerArg("--import-items", defaults.importItems, 0, THOROUGH ? 100 : defaults.importItems),
    settingsTabs: integerArg("--settings-tabs", defaults.settingsTabs, 0, THOROUGH ? 100 : defaults.settingsTabs),
    knownControls: integerArg("--known-controls", defaults.knownControls, 0, THOROUGH ? 100 : defaults.knownControls)
  };

  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) {
    throw new Error("未找到 DevToolsActivePort 文件。请先以 --remote-debugging-port=0 启动 Postman。");
  }

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs, targetTitle);
  const budget = createAuditBudget(auditBudgetMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl, budget.deadline);
  const allHits = new Map();
  const log = [];

  try {
    let finalState = null;
    let screenshotSaved = false;
    try {
      if (SAVE_SCREENSHOT) {
        await cdp.send("Page.enable");
      }
      await closeTransientUi(cdp, delayMs);
      await collect(cdp, "full", "initial", allHits, log);
      await ensureRequestWorkbench(cdp, allHits, log, delayMs, budget);
      if (budgetAllows(budget, log, "after-ensure-request-workbench", 750)) {
        await collect(cdp, "full", "after-ensure-request-workbench", allHits, log);
      }

      if (budgetAllows(budget, log, "new-menu", delayMs + 900)) {
        await auditNewMenu(cdp, allHits, log, delayMs, limits, budget);
      }
      if (budgetAllows(budget, log, "settings", delayMs + 900)) {
        await auditSettings(cdp, allHits, log, delayMs, limits, budget);
      }
      if (budgetAllows(budget, log, "known-controls", delayMs + 900)) {
        await auditKnownControls(cdp, allHits, log, delayMs, limits, budget);
      }

      if (budgetAllows(budget, log, "close-transient", delayMs + 250)) {
        await closeTransientUi(cdp, delayMs);
      }
      finalState = budgetAllows(budget, log, "final-state", 750)
        ? await collect(cdp, "full", "final", allHits, log)
        : null;
      screenshotSaved = SAVE_SCREENSHOT && budgetAllows(budget, log, "screenshot", 1500);
      if (screenshotSaved) await capture(cdp, `${outBase}.png`);
    } catch (error) {
      if (!isAuditTimeoutError(error)) throw error;
      if (!budget.exhaustedAt) budget.exhaustedAt = "cdp-timeout";
      log.push({
        step: "audit-timeout",
        phase: "预算耗尽",
        error: String(error && error.message || error).slice(0, 300)
      });
    }

    const hits = Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    const output = {
      target: targetSummary(target),
      mode: THOROUGH ? "thorough" : "balanced",
      complete: !budget.exhaustedAt,
      limits,
      budget: summarizeBudget(budget),
      log,
      hits,
      final: summarizeState(finalState)
    };
    writeAuditReport(`${outBase}.json`, output);
    const summary = {
      out: `${outBase}.json`,
      screenshot: screenshotSaved ? `${outBase}.png` : null,
      target: targetSummary(target),
      steps: log.length,
      mode: output.mode,
      budget: output.budget,
      hitCount: hits.length,
      hits: hits.slice(0, 80).map((item) => item.text)
    };
    if (output.complete) {
      console.log(`深层界面审计完成：发现 ${summary.hitCount} 条待复核文本，报告已保存到 _generated/${path.basename(summary.out)}。`);
    } else {
      console.log(`深层界面审计已达到时间上限，已保存部分结果到 _generated/${path.basename(summary.out)}。`);
      process.exitCode = 2;
    }
    if (SHOW_DETAILS) {
      console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
    }
  } finally {
    cdp.close();
  }
}

function selfTest() {
  const balanced = defaultAuditOptions(false);
  const thorough = defaultAuditOptions(true);
  new Function(`return (${pageScript({ mode: "full" })});`);
  new Function(`return (${findTargetScript(["^测试$"], { minY: 0, maxY: 100 })});`);

  const compact = summarizeState({
    url: "https://desktop.postman.com/?token=hidden",
    title: "Postman",
    localized: "true",
    overlays: [{ text: "很长的弹窗内容" }],
    targets: Array.from({ length: 120 }, (_, index) => ({ text: `目标 ${index}` })),
    hits: Array.from({ length: 30 }, (_, index) => ({ text: `English ${index}`, count: index + 1 }))
  });
  const aggregate = new Map();
  mergeHits(aggregate, "self-test", [{ text: "English finding", count: 2, samples: [{ text: "不应保留" }] }]);
  const budgetLog = [];
  const expiredBudget = createAuditBudget(1000, 0);
  const firstBudgetCheck = budgetAllows(expiredBudget, budgetLog, "self-test", 0, 1000);
  const secondBudgetCheck = budgetAllows(expiredBudget, budgetLog, "self-test-again", 0, 1001);
  const mainSource = main.toString();
  const knownControlsSource = auditKnownControls.toString();
  const pageSource = pageScript({ mode: "full" });
  const checks = [
    [balanced.auditBudgetMs < thorough.auditBudgetMs, true],
    [balanced.overlayHover < thorough.overlayHover, true],
    [balanced.newMenuItems < thorough.newMenuItems, true],
    [balanced.knownControls < thorough.knownControls, true],
    [balanced.knownControls, 10],
    [compact.hits.length, LOG_HIT_LIMIT],
    ["targets" in compact, false],
    ["overlays" in compact, false],
    ["samples" in aggregate.get("English finding"), false],
    [firstBudgetCheck, false],
    [secondBudgetCheck, false],
    [budgetLog.length, 1],
    [isAuditTimeoutError(new Error("审计时间预算已耗尽：Runtime.evaluate")), true],
    [isAuditTimeoutError(new Error("普通连接错误")), false],
    [mainSource.includes("Runtime.enable"), false],
    [/if \(SAVE_SCREENSHOT\)[\s\S]*Page\.enable/.test(mainSource), true],
    [/const targets = collectTargets\(\);/.test(pageSource), true],
    [/collectEnglish\(targets\)/.test(pageSource), true],
    [/const MAX_ELEMENTS = 6000/.test(pageSource), true],
    [/matchingElements\(/.test(pageSource), true],
    [/textTraversal\.visited >= MAX_TEXT_NODES/.test(pageSource), true],
    [/querySelectorAll\(/.test(pageSource), false],
    [/privateElement\(el\)\) return ""/.test(pageSource), true],
    [/skipBalanced: true/.test(knownControlsSource), true],
    [mainSource.includes("isAuditTimeoutError(error)"), true]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) {
    throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  }
  if (SHOW_DETAILS) {
    console.log(JSON.stringify(sanitizeAuditReport({ ok: true, checks: checks.length }), null, 2));
  } else {
    console.log(`深层界面审计脚本自检通过，共 ${checks.length} 项。`);
  }
}

Promise.resolve().then(() => SELF_TEST ? selfTest() : main()).catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (SHOW_DETAILS) {
    console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
  } else if (SELF_TEST) {
    console.error("深层界面审计脚本自检失败；可使用 --details 查看详细信息。");
  } else {
    console.error("深层界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  }
  process.exit(1);
});
