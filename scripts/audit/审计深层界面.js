#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const SHOW_DETAILS = process.argv.includes("--details");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function resolveOutBase(value) {
  const requested = value || "postman-audit";
  const hasDirectory = path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\");
  let resolved = hasDirectory ? requested : path.resolve(__dirname, "..", "..", "..", "_generated", requested);
  if ([".json", ".png"].includes(path.extname(resolved).toLowerCase())) {
    resolved = resolved.slice(0, -path.extname(resolved).length);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
  }
  return response.json();
}

function resolvePortFile() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("未设置 APPDATA 环境变量，无法定位 Postman 的 DevToolsActivePort 文件。");
  }
  return path.join(appData, "Postman", "DevToolsActivePort");
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
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(callbacks.timer);
    if (message.error) {
      const details = SHOW_DETAILS ? ` 诊断：${JSON.stringify(message.error)}` : "";
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
        }, 45000);
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
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
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
  const details = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(lastTargets)}` : "";
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
    const details = SHOW_DETAILS ? ` 诊断：${JSON.stringify(result.exceptionDetails)}` : "";
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
  fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
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
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        norm(el.getAttribute("role")) ||
        el.tagName.toLowerCase();
    }
    function overlayRoots() {
      return Array.from(document.querySelectorAll([
        "[role='dialog']",
        "[aria-modal='true']",
        "[role='menu']",
        "[role='listbox']",
        "[role='tooltip']",
        "[data-testid*='modal']",
        "[data-testid*='popover']",
        "[data-aether-id*='popover']"
      ].join(","))).filter(visible);
    }
    function inAnyRoot(el, roots) {
      return roots.some((root) => root === el || root.contains(el));
    }
    function isInteractive(el) {
      if (!visible(el)) return false;
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
      const source = MODE === "overlay"
        ? roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))
        : Array.from(document.querySelectorAll(selector));
      const targets = source
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .filter(isInteractive)
        .map((el, index) => Object.assign({
          index,
          tag: el.tagName,
          role: norm(el.getAttribute("role")),
          text: labelOf(el),
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
      return Array.from(dedupe.values()).sort((a, b) => (a.y - b.y) || (a.x - b.x)).slice(0, 320);
    }
    function allowedEnglish(text) {
      const normalized = norm(text);
      const loweredText = normalized.toLowerCase();
      if (/的头像$|团队标志$|（你）$/.test(normalized)) return true;
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
      return meaningful.length === 0;
    }
    function isEnglishLeak(text) {
      const value = norm(text);
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
      if (/^[a-z0-9_]{3,16}$/i.test(value)) return false;
      return !allowedEnglish(value);
    }
    function addHit(hits, text, kind, meta) {
      const value = norm(text);
      if (!isEnglishLeak(value)) return;
      if (!hits.has(value)) {
        hits.set(value, { text: value, count: 0, samples: [] });
      }
      const hit = hits.get(value);
      hit.count += 1;
      if (hit.samples.length < 8) {
        hit.samples.push(Object.assign({ kind }, meta || {}));
      }
    }
    function collectEnglish() {
      const hits = new Map();
      addHit(hits, document.title, "title", { tag: "TITLE" });
      const roots = MODE === "overlay" ? overlayRoots() : [document.body || document.documentElement].filter(Boolean);
      for (const root of roots) {
        const lines = String(root.innerText || "").replace(/\u00a0/g, " ").split(/\n| {2,}/);
        for (const line of lines) {
          addHit(hits, line, MODE === "overlay" ? "overlay" : "body", {
            tag: root.tagName,
            role: root.getAttribute && root.getAttribute("role") || ""
          });
        }
      }
      for (const el of Array.from(document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")).filter(visible)) {
        for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
          if (el.hasAttribute(attr)) {
            addHit(hits, el.getAttribute(attr), "attr", Object.assign({ attr, tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
          }
        }
      }
      for (const item of collectTargets()) {
        addHit(hits, item.text, "control", item);
      }
      return Array.from(hits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    }
    function collectOverlays() {
      return overlayRoots().map((root) => {
        const rect = rectOf(root);
        return Object.assign({
          tag: root.tagName,
          role: norm(root.getAttribute("role")),
          testid: norm(root.getAttribute("data-testid")),
          text: norm(root.innerText || root.textContent || "")
        }, rect);
      });
    }
    return {
      url: location.href,
      title: document.title,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      size: { width: innerWidth, height: innerHeight },
      overlays: collectOverlays(),
      targets: collectTargets(),
      hits: collectEnglish()
    };
  })()`.replace("__MODE__", mode);
}

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
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        "";
    }
    const roots = Array.from(document.querySelectorAll("[role='dialog'],[aria-modal='true'],[role='menu'],[role='listbox'],[data-testid*='modal'],[data-testid*='popover'],[data-aether-id*='popover']")).filter(visible);
    const selector = "button,a,input,textarea,select,[role='button'],[role='menuitem'],[role='tab'],[role='option'],[role='combobox'],[role='textbox'],[aria-label],[title],[placeholder],[tabindex]";
    const source = scope === "overlay"
      ? roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))
      : Array.from(document.querySelectorAll(selector));
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

function summarizeState(state) {
  return {
    url: state && state.url,
    title: state && state.title,
    localized: state && state.localized,
    overlayCount: state && state.overlays ? state.overlays.length : 0,
    overlays: (state && state.overlays || []).map((item) => ({
      tag: item.tag,
      role: item.role,
      testid: item.testid,
      text: item.text,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    })),
    hitCount: state && state.hits ? state.hits.length : 0,
    hits: state && state.hits || [],
    targetCount: state && state.targets ? state.targets.length : 0,
    targets: (state && state.targets || []).slice(0, 100)
  };
}

function mergeHits(allHits, step, hits) {
  for (const hit of hits || []) {
    if (!allHits.has(hit.text)) {
      allHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
    }
    const current = allHits.get(hit.text);
    current.count += hit.count || 1;
    for (const sample of hit.samples || []) {
      if (current.samples.length < 12) {
        current.samples.push(Object.assign({ step }, sample));
      }
    }
  }
}

async function collect(cdp, mode, step, allHits, log) {
  const state = await evaluate(cdp, pageScript({ mode }));
  mergeHits(allHits, step, state.hits);
  log.push({ step, mode, state: summarizeState(state) });
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

async function hoverTargets(cdp, targets, stepPrefix, allHits, log, delayMs) {
  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    try {
      await hoverAt(cdp, item.cx, item.cy);
      await sleep(Math.max(delayMs, 360));
      const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-hover-${i}`, state.hits);
      results.push({ index: i, target: item, hits: state.hits });
    } catch (error) {
      results.push({ index: i, target: item, error: error.message });
    }
  }
  log.push({ step: `${stepPrefix}-hover`, results });
}

async function rightClickTargets(cdp, targets, stepPrefix, allHits, log, delayMs) {
  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    try {
      await rightClickAt(cdp, item.cx, item.cy);
      await sleep(delayMs);
      const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-right-${i}`, state.hits);
      results.push({ index: i, target: item, hits: state.hits });
    } catch (error) {
      results.push({ index: i, target: item, error: error.message });
    }
    await pressEsc(cdp);
    await sleep(80);
  }
  log.push({ step: `${stepPrefix}-right-click`, results });
}

async function closeTransientUi(cdp, delayMs) {
  await pressEsc(cdp);
  await sleep(90);
  await pressEsc(cdp);
  await sleep(Math.max(140, delayMs));
}

async function scanVisibleTargets(cdp, area, allHits, log, delayMs, options = {}) {
  const mode = options.mode || "full";
  const hoverLimit = options.hoverLimit || 24;
  const rightLimit = options.rightLimit || 12;
  const state = await collect(cdp, mode, `${area}-state`, allHits, log);
  const targets = (state.targets || [])
    .filter((item) => safeTargetText(item.text))
    .filter((item) => !options.filter || options.filter(item, state));
  await hoverTargets(cdp, targets.slice(0, hoverLimit), area, allHits, log, delayMs);
  await rightClickTargets(cdp, targets.slice(0, rightLimit), area, allHits, log, delayMs);
  return state;
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

async function auditNewMenu(cdp, allHits, log, delayMs, limits) {
  await closeTransientUi(cdp, delayMs);
  const opened = await clickFirst(cdp, ["^新建$", "^New$", "^Create new request$", "^新建请求$"], delayMs, { maxX: 460 });
  log.push({ step: "new-menu-open", opened });
  const menuState = await scanVisibleTargets(cdp, "new-menu", allHits, log, delayMs, { mode: "overlay", hoverLimit: limits.overlayHover, rightLimit: limits.overlayRight });
  const labels = uniqueLabels(menuState.targets)
    .filter((label) => !/^(关闭|取消|完成|确定|Close|Cancel|Done|OK)$/i.test(label))
    .slice(0, limits.newMenuItems);
  log.push({ step: "new-menu-labels", labels });

  for (let i = 0; i < labels.length; i += 1) {
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
    });
  }
}

async function auditImport(cdp, allHits, log, delayMs, limits) {
  await closeTransientUi(cdp, delayMs);
  const opened = await clickFirst(cdp, ["^导入$", "^Import$", "sidebar-import-button"], Math.max(delayMs + 350, 700), { maxX: 470 });
  log.push({ step: "import-open", opened });
  if (!opened.ok) {
    return;
  }

  const initial = await scanVisibleTargets(cdp, "import-modal-initial", allHits, log, delayMs, { mode: "overlay", hoverLimit: limits.overlayHover, rightLimit: limits.overlayRight });
  const labels = uniqueLabels(initial.targets)
    .filter((label) => !/^(关闭|取消|完成|确定|导入|Close|Cancel|Done|OK|Import)$/i.test(label))
    .slice(0, limits.importItems);
  log.push({ step: "import-modal-labels", labels });

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    let overlay = await evaluate(cdp, pageScript({ mode: "overlay" }));
    if (!overlay.overlays || overlay.overlays.length === 0) {
      await clickFirst(cdp, ["^导入$", "^Import$", "sidebar-import-button"], Math.max(delayMs + 350, 700), { maxX: 470 });
    }
    const clicked = await clickFirst(cdp, [`^${escapeRegExp(label)}$`], Math.max(delayMs + 260, 620), { scope: "overlay" });
    log.push({ step: `import-modal-click-${i}`, label, clicked });
    await scanVisibleTargets(cdp, `import-modal-after-${i}-${label.slice(0, 24)}`, allHits, log, delayMs, { mode: "overlay", hoverLimit: 12, rightLimit: 6 });
  }
  await closeTransientUi(cdp, delayMs);
}

async function auditSettings(cdp, allHits, log, delayMs, limits) {
  await closeTransientUi(cdp, delayMs);
  const menu = await clickFirst(cdp, ["^设置$", "^Settings$"], delayMs, { minY: 0, maxY: 80 });
  log.push({ step: "settings-menu-open", menu });
  if (!menu.ok) {
    return;
  }
  await scanVisibleTargets(cdp, "settings-dropdown", allHits, log, delayMs, { mode: "overlay", hoverLimit: 12, rightLimit: 6 });
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

  const state = await scanVisibleTargets(cdp, "settings-dialog-initial", allHits, log, delayMs, { mode: "overlay", hoverLimit: limits.settingsHover, rightLimit: limits.settingsRight });
  const tabLabels = uniqueLabels((state.targets || []).filter((item) => item.role === "tab" || /^(通用|主题|快捷键|数据|证书|代理|更新|插件|General|Themes|Shortcuts|Data|Certificates|Proxy|Update|Add-ons|Add-ons?)$/i.test(item.text)))
    .slice(0, limits.settingsTabs);
  log.push({ step: "settings-tab-labels", labels: tabLabels });

  for (let i = 0; i < tabLabels.length; i += 1) {
    const label = tabLabels[i];
    const clicked = await clickFirst(cdp, [`^${escapeRegExp(label)}$`], Math.max(delayMs + 280, 650), { scope: "overlay" });
    log.push({ step: `settings-tab-click-${i}`, label, clicked });
    await scanVisibleTargets(cdp, `settings-tab-${i}-${label.slice(0, 24)}`, allHits, log, delayMs, { mode: "overlay", hoverLimit: 18, rightLimit: 8 });
  }
  await closeTransientUi(cdp, delayMs);
}

async function auditKnownControls(cdp, allHits, log, delayMs, limits) {
  const controls = [
    { area: "top-workspace", patterns: ["^我的工作区$", "^My Workspace$"], options: { minY: 0, maxY: 80 } },
    { area: "top-search", patterns: ["打开搜索", "^搜索$", "^Search$"], options: { minY: 0, maxY: 90 } },
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

  for (let i = 0; i < controls.length; i += 1) {
    const item = controls[i];
    await closeTransientUi(cdp, delayMs);
    const clicked = await clickFirst(cdp, item.patterns, Math.max(delayMs + 280, 620), item.options || {});
    log.push({ step: `known-control-click-${item.area}`, clicked, control: item });
    const mode = clicked.ok ? "overlay" : "full";
    await scanVisibleTargets(cdp, `known-control-${item.area}`, allHits, log, delayMs, {
      mode,
      hoverLimit: limits.controlHover,
      rightLimit: limits.controlRight
    });
  }
}

async function ensureRequestWorkbench(cdp, allHits, log, delayMs) {
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

  const afterTab = await evaluate(cdp, pageScript({ mode: "full" }));
  mergeHits(allHits, "ensure-request-after-tab", afterTab.hits);
  const tabOk = (afterTab.targets || []).some((item) => /sidebar-import-button|^导入$|^Import$/i.test(item.text || "")) &&
    (afterTab.targets || []).some((item) => /^(参数|Params|授权|Authorization|Auth|请求头|Headers?|正文|Body|脚本|Scripts?|设置|Settings)$/i.test(item.text || ""));
  if (tabOk) {
    log.push({ step: "ensure-request-workbench", ok: true, reason: "request-tab-clicked" });
    return true;
  }

  const newMenu = await clickFirst(cdp, ["^新建$", "^New$"], delayMs, { maxX: 470 });
  const httpClick = newMenu.ok ? await clickFirst(cdp, ["^HTTP 请求$", "^HTTP Request$", "^请求$", "^Request$"], Math.max(delayMs + 650, 1000), { scope: "overlay" }) : { ok: false, reason: "new-menu-not-opened" };
  log.push({ step: "ensure-request-workbench-new-http", newMenu, httpClick });
  return Boolean(httpClick.ok);
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const delayMs = Number(argValue("--delay-ms", "220"));
  const outBase = resolveOutBase(argValue("--out", "postman-deep-areas-audit"));
  const targetTitle = argValue("--target-title", "未命名请求|新建请求|Untitled|New Request|HTTP Request|MQTT 请求|MQTT Request");
  const limits = {
    overlayHover: Number(argValue("--overlay-hover", "50")),
    overlayRight: Number(argValue("--overlay-right", "25")),
    createdHover: Number(argValue("--created-hover", "28")),
    createdRight: Number(argValue("--created-right", "14")),
    settingsHover: Number(argValue("--settings-hover", "50")),
    settingsRight: Number(argValue("--settings-right", "18")),
    controlHover: Number(argValue("--control-hover", "18")),
    controlRight: Number(argValue("--control-right", "10")),
    newMenuItems: Number(argValue("--new-menu-items", "24")),
    importItems: Number(argValue("--import-items", "26")),
    settingsTabs: Number(argValue("--settings-tabs", "16"))
  };

  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) {
    throw new Error("未找到 DevToolsActivePort 文件。请先以 --remote-debugging-port=0 启动 Postman。");
  }

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs, targetTitle);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const allHits = new Map();
  const log = [];

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await closeTransientUi(cdp, delayMs);
    await collect(cdp, "full", "initial", allHits, log);
    await ensureRequestWorkbench(cdp, allHits, log, delayMs);
    await collect(cdp, "full", "after-ensure-request-workbench", allHits, log);

    await auditImport(cdp, allHits, log, delayMs, limits);
    await auditNewMenu(cdp, allHits, log, delayMs, limits);
    await auditSettings(cdp, allHits, log, delayMs, limits);
    await auditKnownControls(cdp, allHits, log, delayMs, limits);

    await closeTransientUi(cdp, delayMs);
    const finalState = await collect(cdp, "full", "final", allHits, log);
    await capture(cdp, `${outBase}.png`);

    const hits = Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    const output = {
      target: targetSummary(target),
      limits,
      log,
      hits,
      final: summarizeState(finalState)
    };
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    const summary = {
      out: `${outBase}.json`,
      screenshot: `${outBase}.png`,
      target: targetSummary(target),
      steps: log.length,
      hitCount: hits.length,
      hits: hits.slice(0, 80).map((item) => item.text)
    };
    console.log(`深层界面审计完成：发现 ${summary.hitCount} 条待复核文本，报告已保存到 ${summary.out}。`);
    if (SHOW_DETAILS) {
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  console.error(`深层界面审计失败：${message}`);
  if (SHOW_DETAILS && error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
