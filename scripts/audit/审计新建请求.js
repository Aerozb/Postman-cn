#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

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

function hasFlag(name) {
  return process.argv.includes(name);
}

const SHOW_DETAILS = hasFlag("--details");

function argList(name, fallback = null) {
  const value = argValue(name, null);
  if (!value) {
    return fallback;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function argNumberList(name, fallback) {
  return argList(name, fallback).map((item) => Number(item)).filter((item) => Number.isFinite(item));
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
        }, 30000);
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

function isRequestEditorTarget(item) {
  const title = String(item && item.title || "");
  return /(?:未命名请求|新建请求|Untitled Request|New Request|HTTP Request)/i.test(title);
}

async function waitForPostmanTarget(port, timeoutMs, options = {}) {
  const preferRequestEditor = options.preferRequestEditor !== false;
  const requireRequestEditor = options.requireRequestEditor === true;
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
      const requestTarget = preferRequestEditor ? pageTargets.find(isRequestEditorTarget) : null;
      if (requestTarget) {
        return requestTarget;
      }
      if (requireRequestEditor) {
        await sleep(800);
        continue;
      }
      const target = pageTargets.find((item) => {
        return /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(String(item.url || ""));
      }) || pageTargets.find((item) => {
        return !/^https:\/\/www\.postman\.com\/complete-checkout\b/i.test(String(item.url || ""));
      });
      if (target) {
        return target;
      }
    } catch (_) {}
    await sleep(800);
  }
  const details = SHOW_DETAILS ? ` 当前目标：${JSON.stringify(lastTargets)}` : "";
  throw new Error(`未找到${requireRequestEditor ? "请求编辑器" : "Postman 页面"}调试目标。${details}`);
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
      "postman", "getpostman", "api", "apis", "url", "uri", "http", "https", "websocket", "graphql", "grpc", "mqtt", "mqtts", "mcp", "socket", "socket.io",
      "json", "xml", "html", "javascript", "oauth", "bearer", "jwt", "curl", "grpcurl", "wsdl", "openapi", "swagger", "csv", "asyncapi", "protobuf",
      "har", "pem", "ssl", "tls", "sdk", "git", "github", "cookie", "cookies", "qos", "cli", "ai", "ctrl", "alt", "shift", "tab", "enter", "esc", "base64",
      "id", "uuid", "svg", "png", "jpg", "jpeg", "kb", "mb", "gb", "ms", "px", "llm", "aws", "ntlm", "hawk", "akamai", "edgegrid", "atlassian", "sdks",
      "claude", "opus", "hashicorp", "vault", "secret", "secrets", "slack", "microsoft", "teams", "go", "get", "post", "put", "patch", "delete", "del", "head", "options", "trace", "connect", "x-www-form-urlencoded"
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
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      return true;
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

    function allowedEnglish(text) {
      const normalized = norm(text);
      if (/的头像$|团队标志$|（你）$/.test(normalized)) return true;
      if (/^HTTP\/\d(?:\.\d|\.x)?$/i.test(normalized)) return true;
      if (/^checkbox-[A-Za-z0-9#+.-]+$/i.test(normalized)) return true;
      const words = normalized.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
      const meaningful = words.filter((word) => {
        const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (!lowered || lowered.length <= 1) return false;
        if (ALLOWED_WORDS.has(lowered)) return false;
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
      if (/^https?:\/\//i.test(value)) return false;
      if (/^[\w.-]+@[\w.-]+$/.test(value)) return false;
      if (/\bprofile picture\b/i.test(value)) return false;
      if (/\bEnterprise Trial\b/i.test(value)) return false;
      if (/^\.\s*\d+\s+items?\s+hidden due to space constraints$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}\s+team logo$/i.test(value)) return false;
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
      if (hit.samples.length < 6) {
        hit.samples.push(Object.assign({ kind }, meta || {}));
      }
    }

    function collectEnglish() {
      const hits = new Map();
      addHit(hits, document.title, "title", { tag: "TITLE" });

      const roots = MODE === "overlay" ? Array.from(document.querySelectorAll([
        "[role='dialog']",
        "[aria-modal='true']",
        "[role='menu']",
        "[role='listbox']",
        "[role='tooltip']",
        "[data-testid*='modal']",
        "[data-testid*='popover']",
        "[data-aether-id*='popover']"
      ].join(","))).filter(visible) : [document.body || document.documentElement].filter(Boolean);

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

      return Array.from(hits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
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
        "[aria-label]", "[title]", "[placeholder]", "[onclick]", "[tabindex]"
      ].join(",");
      const targets = Array.from(document.querySelectorAll(selector)).filter(isInteractive).map((el, index) => {
        const rect = rectOf(el);
        return Object.assign({
          index,
          tag: el.tagName,
          role: norm(el.getAttribute("role")),
          text: labelOf(el)
        }, rect);
      }).filter((item) => item.cx >= 0 && item.cy >= 0 && item.cx <= innerWidth && item.cy <= innerHeight);

      const dedupe = new Map();
      for (const item of targets) {
        const key = Math.round(item.cx / 3) + ":" + Math.round(item.cy / 3) + ":" + item.text;
        const old = dedupe.get(key);
        if (!old || item.w * item.h > old.w * old.h) {
          dedupe.set(key, item);
        }
      }
      return Array.from(dedupe.values()).sort((a, b) => (a.y - b.y) || (a.x - b.x)).slice(0, 260);
    }

    return {
      url: location.href,
      title: document.title,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      size: { width: innerWidth, height: innerHeight },
      hits: collectEnglish(),
      targets: collectTargets()
    };
  })()`.replace("__MODE__", mode);
}

function findTargetScript(patterns, options = {}) {
  const minY = typeof options.minY === "number" ? options.minY : null;
  const maxY = typeof options.maxY === "number" ? options.maxY : null;
  return `(() => {
    const patterns = ${JSON.stringify(patterns)}.map((value) => new RegExp(value, "i"));
    const minY = ${JSON.stringify(minY)};
    const maxY = ${JSON.stringify(maxY)};
    function norm(text) {
      return String(text || "").replace(/\\s+/g, " ").trim();
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
    const selector = "button,a,input,textarea,[role='button'],[role='tab'],[role='combobox'],[role='textbox'],[aria-label],[title],[placeholder],[tabindex]";
    const matches = Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
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
      return true;
    });
    matches.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return matches[0] || null;
  })()`;
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

function applicationMenuInvokeScript(menuId) {
  return `(() => {
    try {
      const remote = require("@electron/remote");
      const menu = remote.Menu && remote.Menu.getApplicationMenu && remote.Menu.getApplicationMenu();
      const item = menu && menu.getMenuItemById && menu.getMenuItemById(${JSON.stringify(menuId)});
      if (!item) {
        return { ok: false, reason: "menu-item-not-found", menuId: ${JSON.stringify(menuId)} };
      }
      const win = remote.getCurrentWindow && remote.getCurrentWindow();
      item.click(item, win, { triggeredByAccelerator: false });
      return {
        ok: true,
        menuId: ${JSON.stringify(menuId)},
        label: item.label || "",
        enabled: item.enabled,
        windowId: win && win.id
      };
    } catch (error) {
      return { ok: false, menuId: ${JSON.stringify(menuId)}, error: String(error && error.stack || error) };
    }
  })()`;
}

function targetSummary(target) {
  return target ? {
    id: target.id,
    title: target.title,
    type: target.type,
    url: target.url
  } : null;
}

async function resolveRequestEditorTarget(port, timeoutMs, log) {
  try {
    const existing = await waitForPostmanTarget(port, Math.min(timeoutMs, 3500), { requireRequestEditor: true });
    log.push({ step: "request-editor-target-existing", target: targetSummary(existing) });
    return existing;
  } catch (error) {
    log.push({ step: "request-editor-target-existing-miss", error: error.message });
  }

  const fallback = await waitForPostmanTarget(port, timeoutMs, { preferRequestEditor: false });
  log.push({ step: "request-editor-target-fallback", target: targetSummary(fallback) });
  const fallbackCdp = await connectCdp(fallback.webSocketDebuggerUrl);
  try {
    await fallbackCdp.send("Runtime.enable");

    const openWindow = await evaluate(fallbackCdp, applicationMenuInvokeScript("newRequesterWindow"));
    log.push({ step: "request-editor-open-window", result: openWindow });
    await sleep(2200);

    let target = null;
    try {
      target = await waitForPostmanTarget(port, 5000, { requireRequestEditor: true });
    } catch (_) {}
    if (target) {
      log.push({ step: "request-editor-target-after-window", target: targetSummary(target) });
      return target;
    }

    const openTab = await evaluate(fallbackCdp, applicationMenuInvokeScript("openNewTab"));
    log.push({ step: "request-editor-open-tab", result: openTab });
    await sleep(2200);
  } finally {
    fallbackCdp.close();
  }

  const resolved = await waitForPostmanTarget(port, timeoutMs, { requireRequestEditor: true });
  log.push({ step: "request-editor-target-resolved", target: targetSummary(resolved) });
  return resolved;
}

function requestEditorProbeScript() {
  return String.raw`(() => {
    function norm(text) {
      return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
    function rectTarget(el) {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100,
        cx: Math.round((rect.x + rect.width / 2) * 100) / 100,
        cy: Math.round((rect.y + rect.height / 2) * 100) / 100
      };
    }

    const selector = [
      "button", "a", "input", "textarea", "[role='button']", "[role='tab']",
      "[role='combobox']", "[role='textbox']", "[aria-label]", "[title]",
      "[placeholder]", "[tabindex]", "[data-tab-id]"
    ].join(",");
    const targets = Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => {
      return Object.assign({
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        tabId: norm(el.getAttribute("data-tab-id"))
      }, rectTarget(el));
    });
    const labels = targets.map((item) => item.text).filter(Boolean);
    const has = (patterns) => labels.some((label) => patterns.some((pattern) => pattern.test(label)));
    const requestTab = targets
      .filter((item) => item.tabId || item.cy < 80)
      .filter((item) => /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*(?:\n|\s)*(?:新建请求|未命名请求|Untitled Request|HTTP Request)|(?:新建请求|未命名请求|Untitled Request|HTTP Request|MQTT 请求|MQTT Request)/i.test(item.text))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] || null;
    const newButton = targets
      .filter((item) => /^(新建|New|\+)$/.test(item.text))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] || null;
    const editorSignals = {
      params: has([/^参数$/i, /^Params$/i]),
      auth: has([/^授权$/i, /^Authorization$/i, /^Auth$/i]),
      headers: has([/^请求头/i, /^Headers?/i]),
      body: has([/^正文$/i, /^Body$/i]),
      scripts: has([/^脚本$/i, /^Scripts?$/i, /Pre-request/i]),
      settings: targets.some((item) => /^(设置|Settings)$/i.test(item.text) && item.cy > 80)
    };
    const editorSignalCount = Object.keys(editorSignals).filter((key) => editorSignals[key]).length;
    const mqttSignals = {
      docs: has([/^文档$/i, /^Docs?$/i]),
      message: has([/^消息$/i, /^Message$/i]),
      topics: has([/^主题$/i, /^Topics?$/i]),
      auth: editorSignals.auth,
      properties: has([/^属性$/i, /^Properties$/i]),
      lastWill: has([/^遗嘱消息$/i, /^Last Will$/i]),
      settings: editorSignals.settings
    };
    const mqttSignalCount = Object.keys(mqttSignals).filter((key) => mqttSignals[key]).length;
    const socketIoSignals = {
      docs: has([/^文档$/i, /^Docs?$/i]),
      message: has([/^消息$/i, /^Message$/i]),
      events: has([/^事件$/i, /^Events?$/i]),
      params: editorSignals.params,
      headers: editorSignals.headers,
      settings: editorSignals.settings,
      connect: has([/^连接$/i, /^Connect$/i])
    };
    const socketIoSignalCount = Object.keys(socketIoSignals).filter((key) => socketIoSignals[key]).length;
    let requestType = "unknown";
    if (labels.some((label) => /(?:MQTT 请求|MQTT Request)/i.test(label)) || mqttSignalCount >= 5) {
      requestType = "mqtt";
    } else if (labels.some((label) => /Socket\\.IO/i.test(label)) || socketIoSignalCount >= 5) {
      requestType = "socketio";
    } else if (editorSignalCount >= 4) {
      requestType = "http";
    }
    return {
      url: location.href,
      title: document.title,
      editorSignals,
      editorSignalCount,
      mqttSignals,
      mqttSignalCount,
      socketIoSignals,
      socketIoSignalCount,
      requestType,
      isRequestEditor: editorSignalCount >= 4 || mqttSignalCount >= 5 || socketIoSignalCount >= 5,
      requestTab,
      newButton,
      labels: labels.slice(0, 80)
    };
  })()`;
}

async function ensureRequestEditor(cdp, delayMs, log, allHits) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const probe = await evaluate(cdp, requestEditorProbeScript());
    log.push({ step: `ensure-request-editor-${attempt}`, probe });
    mergeHits(allHits, `ensure-request-editor-${attempt}`, (await evaluate(cdp, pageScript({ mode: "full" }))).hits);
    if (probe.isRequestEditor) {
      return { ok: true, reason: "request-editor-visible", probe };
    }
    if (probe.requestTab) {
      await clickAt(cdp, probe.requestTab.cx, probe.requestTab.cy);
      await sleep(Math.max(delayMs + 250, 650));
      continue;
    }
    if (probe.newButton) {
      await clickAt(cdp, probe.newButton.cx, probe.newButton.cy);
      await sleep(Math.max(delayMs + 250, 650));
      const created = await clickFirst(cdp, ["^HTTP 请求$", "^HTTP Request$", "^请求$", "^Request$"], Math.max(delayMs, 220));
      log.push({ step: `ensure-request-editor-new-${attempt}`, clicked: created });
      await sleep(Math.max(delayMs + 350, 800));
      continue;
    }
    await pressEsc(cdp);
    await sleep(150);
  }

  const finalProbe = await evaluate(cdp, requestEditorProbeScript());
  log.push({ step: "ensure-request-editor-final", probe: finalProbe });
  return { ok: false, reason: "request-editor-not-visible", probe: finalProbe };
}

function responseHistoryTargetsScript() {
  return String.raw`(() => {
    const labelPatterns = [/^\u5386\u53f2$/i, /^History$/i];
    function norm(text) {
      return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        "";
    }
    function ancestryOf(el) {
      const ancestry = [];
      let node = el;
      for (let i = 0; i < 5 && node && node instanceof Element; i += 1, node = node.parentElement) {
        ancestry.push({
          tag: node.tagName,
          role: norm(node.getAttribute("role")),
          testid: norm(node.getAttribute("data-testid")),
          className: String(node.className || "").slice(0, 100)
        });
      }
      return ancestry;
    }

    const selector = [
      "button", "a", "[role='button']", "[role='tab']", "[aria-label]", "[title]", "[tabindex]"
    ].join(",");
    const allMatches = Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => {
      const text = labelOf(el);
      if (!text || !labelPatterns.some((pattern) => pattern.test(text))) return null;
      const rect = el.getBoundingClientRect();
      const item = {
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        text,
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100,
        cx: Math.round((rect.x + rect.width / 2) * 100) / 100,
        cy: Math.round((rect.y + rect.height / 2) * 100) / 100,
        ancestry: ancestryOf(el)
      };
      item.responsePanelCandidate =
        item.cy >= innerHeight * 0.45 &&
        item.cx >= 220 &&
        item.cx <= innerWidth - 80 &&
        item.w <= 240 &&
        item.h <= 90;
      item.score =
        (item.responsePanelCandidate ? 0 : 1000) +
        Math.abs(item.cy - innerHeight * 0.68) +
        Math.abs(item.cx - innerWidth * 0.38) / 4 +
        (item.w > 140 ? 80 : 0);
      return item;
    }).filter(Boolean);

    const candidates = allMatches
      .filter((item) => item.responsePanelCandidate)
      .sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      candidates,
      allMatches: allMatches.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x)
    };
  })()`;
}

function overlaySnapshotScript() {
  return String.raw`(() => {
    function norm(text) {
      return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    const roots = Array.from(document.querySelectorAll([
      "[role='dialog']",
      "[aria-modal='true']",
      "[role='menu']",
      "[role='listbox']",
      "[role='tooltip']",
      "[data-testid*='modal']",
      "[data-testid*='popover']",
      "[data-aether-id*='popover']"
    ].join(","))).filter(visible);

    const overlays = roots.map((root) => {
      const rect = root.getBoundingClientRect();
      return {
        tag: root.tagName,
        role: norm(root.getAttribute("role")),
        testid: norm(root.getAttribute("data-testid")),
        text: norm(root.innerText || root.textContent || ""),
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100
      };
    });
    return {
      overlayCount: overlays.length,
      combinedText: norm(overlays.map((item) => item.text).join("\n")),
      overlays
    };
  })()`;
}

function responseHistorySnapshotVerified(snapshot) {
  const text = String(snapshot && snapshot.combinedText || "");
  return /(?:\u6ca1\u6709\u8bf7\u6c42\u5386\u53f2|\u53d1\u9001\u8bf7\u6c42\u540e\u5373\u53ef\u6d4f\u89c8)/.test(text) ||
    /(?:No request history|Send (?:a|the) request.*history|Browse.*request history)/i.test(text);
}

async function openResponseHistoryPopover(cdp, delayMs, allHits, log) {
  const found = await evaluate(cdp, responseHistoryTargetsScript());
  const candidates = (found.candidates || []).slice(0, 4);
  const attempts = [];

  if (candidates.length === 0) {
    const result = {
      ok: false,
      reason: "response-history-target-not-found",
      found
    };
    log.push({ step: "response-history-popover", result });
    return result;
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const target = candidates[i];
    await pressEsc(cdp);
    await sleep(100);
    await clickAt(cdp, target.cx, target.cy);
    await sleep(Math.max(delayMs + 260, 650));

    const snapshot = await evaluate(cdp, overlaySnapshotScript());
    const overlayState = await evaluate(cdp, pageScript({ mode: "overlay" }));
    mergeHits(allHits, `response-history-popover-${i}`, overlayState.hits);

    const verified = responseHistorySnapshotVerified(snapshot);
    const attempt = {
      target,
      verified,
      snapshot,
      hits: overlayState.hits
    };
    attempts.push(attempt);
    log.push({ step: `response-history-popover-${i}`, attempt });

    if (verified) {
      return {
        ok: true,
        reason: "response-history-popover-verified",
        target,
        attempts
      };
    }
  }

  return {
    ok: false,
    reason: "response-history-popover-not-verified",
    found,
    attempts
  };
}

function findTextAnchorScript(patterns) {
  return `(() => {
    const patterns = ${JSON.stringify(patterns)}.map((value) => new RegExp(value, "i"));
    function norm(text) {
      return String(text || "").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    const matches = Array.from(document.querySelectorAll("body *")).filter(visible).map((el) => {
      const text = norm(el.innerText || el.textContent || "");
      if (!text || !patterns.some((pattern) => pattern.test(text))) return null;
      const rect = el.getBoundingClientRect();
      return {
        text,
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        cx: Math.min(innerWidth - 8, rect.right + 8),
        cy: rect.y + rect.height / 2
      };
    }).filter(Boolean);
    matches.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.w - b.w));
    return matches[0] || null;
  })()`;
}

async function hoverTextAnchor(cdp, patterns, delayMs) {
  const target = await evaluate(cdp, findTextAnchorScript(patterns));
  if (!target) {
    return { ok: false, patterns };
  }
  await hoverAt(cdp, target.cx, target.cy);
  await sleep(Math.max(delayMs, 420));
  return { ok: true, patterns, target };
}

function mergeHits(allHits, step, hits) {
  for (const hit of hits || []) {
    if (!allHits.has(hit.text)) {
      allHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
    }
    const current = allHits.get(hit.text);
    current.count += hit.count || 1;
    for (const sample of hit.samples || []) {
      if (current.samples.length < 10) {
        current.samples.push(Object.assign({ step }, sample));
      }
    }
  }
}

async function collectState(cdp, step, allHits, mode = "full") {
  const state = await evaluate(cdp, pageScript({ mode }));
  mergeHits(allHits, step, state.hits);
  return { step, state };
}

function scrollScrollableAreasScript(ratio) {
  return `(() => {
    const ratio = ${JSON.stringify(ratio)};
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    const candidates = [document.scrollingElement, document.documentElement, document.body]
      .concat(Array.from(document.querySelectorAll("*")))
      .filter(Boolean)
      .filter((el, index, arr) => arr.indexOf(el) === index)
      .filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 30);

    const scrolled = [];
    for (const el of candidates) {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (!max) continue;
      const top = Math.round(max * ratio);
      try {
        el.scrollTop = top;
        scrolled.push({
          tag: el.tagName,
          role: el.getAttribute && el.getAttribute("role") || "",
          className: String(el.className || "").slice(0, 80),
          top,
          max
        });
      } catch (_) {}
    }
    try {
      window.scrollTo(0, Math.round(Math.max(0, document.documentElement.scrollHeight - innerHeight) * ratio));
    } catch (_) {}
    return scrolled.slice(0, 20);
  })()`;
}

async function scanCurrentViewport(cdp, stepPrefix, allHits, log, delayMs, skipped, hoverLimit, rightClickLimit, targetFilter) {
  const state = await evaluate(cdp, pageScript({ mode: "full" }));
  mergeHits(allHits, `${stepPrefix}-state`, state.hits);
  log.push({
    step: `${stepPrefix}-state`,
    url: state.url,
    title: state.title,
    hits: state.hits
  });

  const targets = (state.targets || [])
    .filter((item) => !skipped.test(item.text || ""))
    .filter((item) => !targetFilter || targetFilter(item, state));

  await hoverTargets(cdp, targets.slice(0, hoverLimit), `${stepPrefix}-hover`, allHits, log, delayMs);

  const rightTargets = targets.slice(0, rightClickLimit);
  for (let i = 0; i < rightTargets.length; i += 1) {
    const item = rightTargets[i];
    try {
      await rightClickAt(cdp, item.cx, item.cy);
      await sleep(delayMs);
      const overlayState = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-right-${i}`, overlayState.hits);
      log.push({ step: `${stepPrefix}-right-${i}`, target: item, hits: overlayState.hits });
    } catch (error) {
      log.push({ step: `${stepPrefix}-right-${i}`, target: item, error: error.message });
    }
    await pressEsc(cdp);
    await sleep(80);
  }

  return { state, scannedTargets: targets.length };
}

async function hoverTargets(cdp, targets, stepPrefix, allHits, log, delayMs) {
  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    try {
      await hoverAt(cdp, item.cx, item.cy);
      await sleep(Math.max(delayMs, 360));
      const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
      mergeHits(allHits, `${stepPrefix}-${i}`, state.hits);
      log.push({ step: `${stepPrefix}-${i}`, target: item, hits: state.hits });
    } catch (error) {
      log.push({ step: `${stepPrefix}-${i}`, target: item, error: error.message });
    }
  }
}

function requestTabsForType(requestType) {
  if (requestType === "mqtt") {
    return [
      { name: "docs", patterns: ["^文档$", "^Docs?$", "Document"] },
      { name: "message", patterns: ["^消息$", "^Message$"] },
      { name: "topics", patterns: ["^主题$", "^Topics?$"] },
      { name: "auth", patterns: ["^授权$", "^Authorization$", "^Auth$"] },
      { name: "properties", patterns: ["^属性$", "^Properties$"] },
      { name: "last-will", patterns: ["^遗嘱消息$", "^Last Will$"] },
      { name: "settings", patterns: ["^设置$", "^Settings$"] }
    ];
  }
  if (requestType === "socketio") {
    return [
      { name: "docs", patterns: ["^文档$", "^Docs?$", "Document"] },
      { name: "message", patterns: ["^消息$", "^Message$"] },
      { name: "events", patterns: ["^事件$", "^Events?$"] },
      { name: "params", patterns: ["^参数$", "^Params?$"] },
      { name: "headers", patterns: ["^请求头", "^Headers?"] },
      { name: "settings", patterns: ["^设置$", "^Settings$"] }
    ];
  }

  return [
    { name: "docs", patterns: ["^文档$", "^Docs?$", "Document"] },
    { name: "params", patterns: ["^参数$", "^Params?$"] },
    { name: "auth", patterns: ["^授权$", "^Authorization$", "^Auth$"] },
    { name: "headers", patterns: ["^请求头", "^Headers?"] },
    { name: "body", patterns: ["^正文$", "^Body$"] },
    { name: "scripts", patterns: ["^脚本$", "^Scripts?$", "Pre-request"] },
    { name: "settings", patterns: ["^设置$", "^Settings$"] }
  ];
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const delayMs = Number(argValue("--delay-ms", "220"));
  const maxHover = Number(argValue("--max-hover", "150"));
  const maxBodyHover = Number(argValue("--max-body-hover", "70"));
  const maxBodyRightClick = Number(argValue("--max-body-right-click", "35"));
  const maxSettingsHover = Number(argValue("--max-settings-hover", "80"));
  const maxSettingsRightClick = Number(argValue("--max-settings-right-click", "35"));
  const maxScriptsHover = Number(argValue("--max-scripts-hover", "80"));
  const maxScriptsRightClick = Number(argValue("--max-scripts-right-click", "35"));
  const maxRightClick = Number(argValue("--max-right-click", "90"));
  const requestedTabs = argList("--tabs", null);
  const requestedBodyModes = argList("--body-modes", null);
  const requestedSettingsPositions = argNumberList("--settings-positions", [0, 0.2, 0.4, 0.6, 0.8, 1]);
  const skipFinalSweep = hasFlag("--skip-final-sweep");
  const skipResponseHistory = hasFlag("--skip-response-history");
  const outBase = resolveOutBase(argValue("--out", "postman-new-request-audit"));
  const portFile = resolvePortFile();

  if (!fs.existsSync(portFile)) {
    throw new Error("未找到 DevToolsActivePort 文件。请先以 --remote-debugging-port=0 启动 Postman。");
  }

  const allHits = new Map();
  const log = [];
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await resolveRequestEditorTarget(port, timeoutMs, log);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const verificationFailures = [];
  const skipped = /Start Trial|Sign Out|Log out|Delete account|Upgrade plan|Request a demo|Checkout|Billing|Payment|Exit|Quit|Close window|Minimize|Maximize|Restore Down|退出|关闭窗口|最小化|最大化|付款|结账|账单|支付/i;

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(400);

    log.push(await collectState(cdp, "initial", allHits, "full"));
    const editorReady = await ensureRequestEditor(cdp, delayMs, log, allHits);
    log.push({ step: "request-editor-ready", result: editorReady });
    if (!editorReady.ok) {
      verificationFailures.push({
        step: "request-editor-ready",
        reason: editorReady.reason,
        detail: "开始审计前必须先显示请求编辑器，之后才能检查请求标签页、设置、悬停提示、右键菜单和响应历史记录。"
      });
    }
    log.push(await collectState(cdp, "after-ensure-request-editor", allHits, "full"));

    const requestProbe = await evaluate(cdp, requestEditorProbeScript());
    const requestType = requestProbe.requestType || "unknown";
    log.push({ step: "request-type-detected", requestType, probe: requestProbe });
    const requestTabs = requestTabsForType(requestType);
    const selectedRequestTabs = requestedTabs ?
      requestTabs.filter((tab) => requestedTabs.includes(tab.name)) :
      requestTabs;

    for (const tab of selectedRequestTabs) {
      const clicked = await clickFirst(cdp, tab.patterns, delayMs, { minY: 80 });
      log.push({ step: `click-tab-${tab.name}`, clicked });
      if (!clicked.ok) {
        verificationFailures.push({
          step: `click-tab-${tab.name}`,
          reason: "request-tab-not-found",
          detail: `无法点击请求编辑器标签页：${tab.name}`
        });
      }
      log.push(await collectState(cdp, `tab-${tab.name}`, allHits, "full"));

      if (tab.name === "params") {
        const bulk = await clickFirst(cdp, ["批量编辑", "Bulk Edit"], delayMs, { minY: 80 });
        log.push({ step: "params-bulk-edit", clicked: bulk });
        log.push(await collectState(cdp, "params-bulk-edit", allHits, "full"));
        const keyValue = await clickFirst(cdp, ["键值编辑", "Key-Value Edit"], delayMs, { minY: 80 });
        log.push({ step: "params-key-value-edit", clicked: keyValue });
      }

      if (tab.name === "auth") {
        const combo = await clickFirst(cdp, ["从父级继承授权", "Inherit auth from parent", "授权类型", "Auth Type", "Auth type"], delayMs, { minY: 80 });
        log.push({ step: "auth-type-dropdown", clicked: combo });
        log.push(await collectState(cdp, "auth-type-dropdown", allHits, "overlay"));
        await pressEsc(cdp);
        await sleep(120);
      }

      if (requestType === "mqtt") {
        if (tab.name === "message") {
          for (const action of [
            { name: "message-type", patterns: ["^文本$", "^Text$"] },
            { name: "message-properties", patterns: ["mqtt-message-properties-btn", "属性", "Properties"] },
            { name: "message-qos", patterns: ["^0$", "^1$", "^2$", "QoS"] }
          ]) {
            const actionClick = await clickFirst(cdp, action.patterns, delayMs, { minY: 160 });
            log.push({ step: `mqtt-${action.name}`, clicked: actionClick });
            log.push(await collectState(cdp, `mqtt-${action.name}`, allHits, "overlay"));
            await pressEsc(cdp);
            await sleep(100);
          }
        }

        if (tab.name === "topics") {
          const addTopic = await clickFirst(cdp, ["添加主题", "Add Topic"], delayMs, { minY: 140 });
          log.push({ step: "mqtt-add-topic", clicked: addTopic });
          log.push(await collectState(cdp, "mqtt-add-topic", allHits, "full"));
        }

        await scanCurrentViewport(
          cdp,
          `mqtt-tab-${tab.name}`,
          allHits,
          log,
          delayMs,
          skipped,
          Math.min(maxHover, 60),
          Math.min(maxRightClick, 35),
          (item, state) => item.cy > 90 && item.cy < (state.size.height - 55) && item.cx < (state.size.width - 80)
        );
      }

      if (tab.name === "body") {
        let bodyModes = [
          { name: "none", patterns: ["^无$", "^none$"] },
          { name: "form-data", patterns: ["^表单数据$", "^form-data$"] },
          { name: "urlencoded", patterns: ["^x-www-form-urlencoded$"] },
          { name: "raw", patterns: ["^原始数据$", "^raw$"] },
          { name: "binary", patterns: ["^二进制$", "^binary$"] },
          { name: "graphql", patterns: ["^GraphQL$"] }
        ];
        if (requestedBodyModes) {
          bodyModes = bodyModes.filter((mode) => requestedBodyModes.includes(mode.name));
        }

        for (const mode of bodyModes) {
          const modeClick = await clickFirst(cdp, mode.patterns, delayMs, { minY: 80 });
          log.push({ step: `body-mode-${mode.name}`, clicked: modeClick });
          log.push(await collectState(cdp, `body-mode-${mode.name}`, allHits, "full"));

          const modeState = await evaluate(cdp, pageScript({ mode: "full" }));
          const modeHoverTargets = (modeState.targets || [])
            .filter((item) => !skipped.test(item.text || ""))
            .filter((item) => item.cy > 95 && item.cy < (modeState.size.height - 80) && item.cx < (modeState.size.width - 220))
            .slice(0, maxBodyHover);
          await hoverTargets(cdp, modeHoverTargets, `body-${mode.name}-hover`, allHits, log, delayMs);

          const modeRightTargets = (modeState.targets || [])
            .filter((item) => !skipped.test(item.text || ""))
            .filter((item) => item.cy > 95 && item.cy < (modeState.size.height - 80) && item.cx < (modeState.size.width - 220))
            .slice(0, maxBodyRightClick);
          for (let i = 0; i < modeRightTargets.length; i += 1) {
            const item = modeRightTargets[i];
            try {
              await rightClickAt(cdp, item.cx, item.cy);
              await sleep(delayMs);
              const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
              mergeHits(allHits, `body-${mode.name}-right-${i}`, state.hits);
              log.push({ step: `body-${mode.name}-right-${i}`, target: item, hits: state.hits });
            } catch (error) {
              log.push({ step: `body-${mode.name}-right-${i}`, target: item, error: error.message });
            }
            await pressEsc(cdp);
            await sleep(80);
          }

          if (mode.name === "graphql") {
            const graphQlAnchors = [
              ["GraphQL 变量", "GRAPHQL VARIABLES", "GraphQL Variables"],
              ["查询", "^QUERY$"]
            ];
            for (let i = 0; i < graphQlAnchors.length; i += 1) {
              const anchor = await hoverTextAnchor(cdp, graphQlAnchors[i], delayMs);
              log.push({ step: `body-graphql-anchor-hover-${i}`, hovered: anchor });
              log.push(await collectState(cdp, `body-graphql-anchor-hover-${i}`, allHits, "overlay"));
              await pressEsc(cdp);
              await sleep(80);
            }
          }
        }
      }

      if (tab.name === "scripts") {
        const scriptSections = [
          { name: "pre-request", patterns: ["^请求前$", "^Pre-request$", "^Pre-req$"] },
          { name: "post-response", patterns: ["^响应后$", "^Post-response$", "^Post-res$"] }
        ];

        for (const section of scriptSections) {
          const sectionClick = await clickFirst(cdp, section.patterns, delayMs, { minY: 80 });
          log.push({ step: `scripts-section-${section.name}`, clicked: sectionClick });
          await sleep(delayMs);
          await scanCurrentViewport(
            cdp,
            `scripts-section-${section.name}`,
            allHits,
            log,
            delayMs,
            skipped,
            maxScriptsHover,
            maxScriptsRightClick,
            (item, state) => item.cy > 95 && item.cy < (state.size.height - 60) && item.cx < (state.size.width - 120)
          );
        }
      }

      if (tab.name === "settings") {
        const scrollPositions = requestedSettingsPositions;
        for (let i = 0; i < scrollPositions.length; i += 1) {
          const ratio = scrollPositions[i];
          const scrolled = await evaluate(cdp, scrollScrollableAreasScript(ratio));
          log.push({ step: `settings-scroll-${i}`, ratio, scrolled });
          await sleep(delayMs + 120);
          await scanCurrentViewport(
            cdp,
            `settings-scroll-${i}`,
            allHits,
            log,
            delayMs,
            skipped,
            maxSettingsHover,
            maxSettingsRightClick,
            (item, state) => item.cy > 95 && item.cy < (state.size.height - 60) && item.cx < (state.size.width - 120)
          );
        }
      }
    }

    const responseHistory = skipResponseHistory ?
      { ok: true, skipped: true, reason: "skip-response-history" } :
      requestType === "http" ?
      await openResponseHistoryPopover(cdp, delayMs, allHits, log) :
      { ok: true, skipped: true, reason: `response-history-not-required-for-${requestType}` };
    log.push({ step: "response-history-popover-result", result: responseHistory });
    if (requestType === "http" && !responseHistory.ok) {
      verificationFailures.push({
        step: "response-history-popover",
        reason: responseHistory.reason,
        detail: "响应历史记录必须能打开弹出层，并显示空状态文本。"
      });
    }
    await pressEsc(cdp);
    await sleep(120);

    const base = await evaluate(cdp, pageScript({ mode: "full" }));
    const hoverTargetsList = skipFinalSweep ?
      [] :
      (base.targets || []).filter((item) => !skipped.test(item.text || "")).slice(0, maxHover);
    if (!skipFinalSweep) {
      await hoverTargets(cdp, hoverTargetsList, "hover", allHits, log, delayMs);
    }

    await pressEsc(cdp);
    await sleep(120);

    const rightTargets = skipFinalSweep ?
      [] :
      (base.targets || [])
        .filter((item) => !skipped.test(item.text || ""))
        .filter((item) => item.cy > 35 && item.cx < (base.size.width - 120))
        .slice(0, maxRightClick);

    for (let i = 0; i < rightTargets.length; i += 1) {
      const item = rightTargets[i];
      try {
        await rightClickAt(cdp, item.cx, item.cy);
        await sleep(delayMs);
        const state = await evaluate(cdp, pageScript({ mode: "overlay" }));
        mergeHits(allHits, `right-${i}`, state.hits);
        log.push({ step: `right-${i}`, target: item, hits: state.hits });
      } catch (error) {
        log.push({ step: `right-${i}`, target: item, error: error.message });
      }
      await pressEsc(cdp);
      await sleep(90);
    }

    const finalState = await collectState(cdp, "final", allHits, "full");
    log.push(finalState);
    const output = {
      target: { title: target.title, url: target.url },
      audited: {
        requestType,
        tabs: selectedRequestTabs.map((item) => item.name),
        hoverCount: hoverTargetsList.length,
        bodyHoverLimitPerMode: maxBodyHover,
        bodyRightClickLimitPerMode: maxBodyRightClick,
        settingsHoverLimitPerScroll: maxSettingsHover,
        settingsRightClickLimitPerScroll: maxSettingsRightClick,
        scriptsHoverLimitPerSection: maxScriptsHover,
        scriptsRightClickLimitPerSection: maxScriptsRightClick,
        rightClickCount: rightTargets.length,
        responseHistoryPopoverVerified: responseHistory.ok
      },
      verificationFailures,
      hits: Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      log,
      screenshot: `${outBase}.png`,
      screenshotError: null
    };

    fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    try {
      await capture(cdp, `${outBase}.png`);
    } catch (error) {
      output.screenshotError = error && error.message || String(error);
      fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    }

    const summary = {
      out: `${outBase}.json`,
      screenshot: `${outBase}.png`,
      screenshotError: output.screenshotError,
      requestType,
      hoverCount: hoverTargetsList.length,
      bodyHoverLimitPerMode: maxBodyHover,
      bodyRightClickLimitPerMode: maxBodyRightClick,
      settingsHoverLimitPerScroll: maxSettingsHover,
      settingsRightClickLimitPerScroll: maxSettingsRightClick,
      scriptsHoverLimitPerSection: maxScriptsHover,
      scriptsRightClickLimitPerSection: maxScriptsRightClick,
      rightClickCount: rightTargets.length,
      responseHistoryPopoverVerified: responseHistory.ok,
      verificationFailures,
      hitCount: output.hits.length,
      hits: output.hits.slice(0, 40).map((item) => item.text)
    };
    console.log(`新建请求界面审计完成：发现 ${summary.hitCount} 条待复核文本，报告已保存到 ${summary.out}。`);
    if (SHOW_DETAILS) {
      console.log(JSON.stringify(summary, null, 2));
    }
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  console.error(`新建请求界面审计失败：${message}`);
  if (SHOW_DETAILS && error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
