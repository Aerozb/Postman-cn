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
  const resolved = hasDirectory ? requested : path.resolve(__dirname, "..", "..", "..", "_generated", requested);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

function resolvePortFile() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate Postman DevToolsActivePort.");
  }
  return path.join(appData, "Postman", "DevToolsActivePort");
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket.")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to CDP websocket."));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      callbacks.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP command timed out: ${method}`));
          }
        }, 45000);
      });
    },
    close() {
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

function targetMatchesPattern(target, pattern) {
  if (!pattern) {
    return false;
  }
  const value = [
    target && target.title,
    target && target.url,
    target && target.id
  ].map((item) => String(item || "")).join("\n");
  return pattern.test(value);
}

function isDeepWorkbenchTarget(target) {
  const title = String(target && target.title || "");
  const url = String(target && target.url || "");
  return /(?:未命名请求|新建请求|我的工作区|Untitled Request|New Request|HTTP Request|My Workspace|Runner|运行器|导入|Import|Create|创建|Settings|设置)/i.test(title) &&
    /^https:\/\/desktop\.postman\.com\b/i.test(url);
}

function isRequestWorkbenchTarget(target) {
  const title = String(target && target.title || "");
  const url = String(target && target.url || "");
  return /(?:未命名请求|新建请求|Untitled Request|New Request|HTTP Request|MQTT 请求|MQTT Request)/i.test(title) &&
    /^https:\/\/desktop\.postman\.com\b/i.test(url);
}

async function waitForPostmanTarget(port, timeoutMs, options = {}) {
  const targetTitle = options.targetTitle || null;
  const targetPattern = targetTitle ? new RegExp(targetTitle, "i") : null;
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
      const requestedTarget = targetPattern ? pageTargets.find((item) => targetMatchesPattern(item, targetPattern)) : null;
      if (requestedTarget) {
        return requestedTarget;
      }
      const requestTarget = pageTargets.find(isRequestWorkbenchTarget);
      if (requestTarget) {
        return requestTarget;
      }
      const deepTarget = pageTargets.find(isDeepWorkbenchTarget);
      if (deepTarget) {
        return deepTarget;
      }
      const target = pageTargets.find((item) => {
        return /^https:\/\/desktop\.postman\.com\b/i.test(String(item.url || ""));
      }) || pageTargets.find((item) => {
        return !/^https:\/\/www\.postman\.com\/complete-checkout\b/i.test(String(item.url || ""));
      });
      if (target) {
        return target;
      }
    } catch (_) {}
    await sleep(1000);
  }
  throw new Error(`Cannot find a Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
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

async function pressAltLeft(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 18,
    nativeVirtualKeyCode: 18,
    key: "Alt",
    code: "AltLeft",
    altKey: true
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
    key: "ArrowLeft",
    code: "ArrowLeft",
    altKey: true
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
    key: "ArrowLeft",
    code: "ArrowLeft",
    altKey: true
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 18,
    nativeVirtualKeyCode: 18,
    key: "Alt",
    code: "AltLeft"
  });
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function capture(cdp, outPath) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
}

function pageScript(options = {}) {
  const includeClickables = options.includeClickables !== false;
  const fullText = options.fullText !== false;
  const clickableScope = options.clickableScope || "full";
  const includeContent = options.includeContent === true;
  return String.raw`(() => {
    const INCLUDE_CLICKABLES = __INCLUDE_CLICKABLES__;
    const FULL_TEXT = __FULL_TEXT__;
    const CLICKABLE_SCOPE = "__CLICKABLE_SCOPE__";
    const INCLUDE_CONTENT = __INCLUDE_CONTENT__;
    const SKIP_TEXT = /\b(Start Trial|Continue with Team Plan|Sign Out|Sign out|Log out|Delete account|Upgrade plan|Request a demo|Checkout|Billing|Payment|purchase|Pay annually|Pay monthly|Request an approver|Exit|Quit|Close window|Close Window|Minimize|Maximize|Restore down|Restore Down)\b/i;
    const SAFE_TEXT = /^(Close|Cancel|Done|Back|Go back|Dismiss|Got it|OK|Okay|No|Show|Hide|Expand|Collapse|More|Menu|Import|New|Create|Settings|History|Collections|Environments|Home|Workspaces|Search|Save|Share|View|Open|Select|Add|Edit|Manage|Filter|Sort|Refresh|Retry|Reset|Apply|Copy|Duplicate|Rename|Send|Connect|Disconnect|Choose|Browse)/i;
    const ALLOWED_WORDS = new Set([
      "postman", "getpostman", "api", "apis", "url", "uri", "http", "https", "websocket", "graphql", "grpc", "mqtt", "mqtts", "mcp", "socket", "socket.io", "io",
      "json", "xml", "html", "javascript", "oauth", "bearer", "jwt", "curl", "grpcurl", "wsdl", "openapi", "swagger",
      "csv", "asyncapi", "protobuf", "smithy", "proto", "x-api-key",
      "har", "pem", "ssl", "tls", "rbac", "sdk", "git", "github", "vscode", "vs", "code", "npm", "cursor", "windsurf",
      "markdown", "button", "input", "slack",
      "cookie", "cookies", "recaptcha", "qos", "cmd", "ui", "cli", "ai", "us", "eu", "ca", "ctrl", "alt", "shift", "tab", "enter", "esc", "f1",
      "am", "pm", "id", "ids", "uuid", "svg", "png", "jpg", "jpeg", "gif", "kb", "mb", "gb", "ms", "px", "v12", "sdk", "sdks", "vault"
    ]);
    const ALLOWED_PHRASES = new Set([
      "app builder",
      "bill",
      "claude code",
      "cloud cost management",
      "datadog",
      "postman agent",
      "private api network",
      "get",
      "postman",
      "postman code",
      "postman api platform",
      "postman api network"
    ]);

    function norm(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100
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

    function visibleLabelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        "";
    }

    function isClickable(el) {
      if (!visible(el)) return false;
      const tag = el.tagName.toLowerCase();
      const role = norm(el.getAttribute("role")).toLowerCase();
      const style = getComputedStyle(el);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (["button", "a", "input", "select", "textarea", "summary"].includes(tag)) return true;
      if (["button", "menuitem", "tab", "checkbox", "radio", "switch", "option", "link"].includes(role)) return true;
      if (el.hasAttribute("onclick")) return true;
      if (el.tabIndex >= 0 && (style.cursor === "pointer" || el.getAttribute("aria-label"))) return true;
      if (style.cursor === "pointer" && labelOf(el)) return true;
      return false;
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

    function collectClickables() {
      const selector = [
        "button",
        "a",
        "input",
        "select",
        "textarea",
        "summary",
        "[role='button']",
        "[role='menuitem']",
        "[role='tab']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='switch']",
        "[role='option']",
        "[role='link']",
        "[onclick]",
        "[tabindex]"
      ].join(",");
      const roots = CLICKABLE_SCOPE === "overlay" ? overlayRoots() : [];
      const source = CLICKABLE_SCOPE === "overlay"
        ? roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))
        : Array.from(document.querySelectorAll(selector));
      const candidates = source.filter((el, index, arr) => arr.indexOf(el) === index).filter(isClickable).map((el, index) => {
        const rect = rectOf(el);
        return {
          index,
          tag: el.tagName,
          role: norm(el.getAttribute("role")),
          text: labelOf(el),
          inOverlay: roots.length ? inAnyRoot(el, roots) : false,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          cx: Math.round((rect.x + rect.w / 2) * 100) / 100,
          cy: Math.round((rect.y + rect.h / 2) * 100) / 100
        };
      }).filter((item) => item.cx >= 0 && item.cy >= 0 && item.cx <= innerWidth && item.cy <= innerHeight);

      const byPoint = new Map();
      for (const item of candidates) {
        const key = Math.round(item.cx / 4) + ":" + Math.round(item.cy / 4) + ":" + item.text;
        const old = byPoint.get(key);
        if (!old || item.w * item.h > old.w * old.h) {
          byPoint.set(key, item);
        }
      }

      return Array.from(byPoint.values())
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
        .slice(0, 260);
    }

    function allowedEnglish(text) {
      const normalized = norm(text);
      const loweredText = normalized.toLowerCase();
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
      if (/^Selected:\s*\d+$/i.test(value)) return false;
      if (/\bprofile picture\b/i.test(value)) return false;
      if (/^[a-z][a-z0-9_.-]{2,}\s+\u7684\u5934\u50cf$/i.test(value)) return false;
      if (/\bEnterprise Trial\b/i.test(value)) return false;
      if (/^[\u4e00-\u9fff\s]+Postman Agent$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}\s+\|\s+Private API Network$/i.test(value)) return false;
      if (/^[\u4e00-\u9fff\w\s]+aerozb[\u4e00-\u9fff\w\s·:.-]*$/i.test(value)) return false;
      if (/^[\u4e00-\u9fff\s·/]+aerozb[\u4e00-\u9fff\s·/.\da-z-]*$/i.test(value)) return false;
      if (/^[a-z][a-z0-9_.-]{2,}$/i.test(value)) return false;
      if (/邀请成员加入“[a-z]+-[a-z0-9-]+-\d{4,}”团队/i.test(value)) return false;
      if (/^\.\s*\d+\s+items?\s+hidden due to space constraints$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}\s+team logo$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}\s+\u56e2\u961f\u6807\u5fd7$/i.test(value)) return false;
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+){1,}$/i.test(value)) return false;
      if (/^[a-z]+-[a-z0-9-]+-\d{4,}$/i.test(value)) return false;
      return !allowedEnglish(value);
    }

    function collectEnglish() {
      const hits = new Map();
      function add(text, kind, meta) {
        const value = norm(text);
        if (!isEnglishLeak(value)) return;
        if (!hits.has(value)) {
          hits.set(value, { text: value, count: 0, samples: [] });
        }
        const hit = hits.get(value);
        hit.count += 1;
        if (hit.samples.length < 5) {
          hit.samples.push(Object.assign({ kind }, meta || {}));
        }
      }

      add(document.title, "title", { tag: "TITLE", role: "" });

      let roots = [];
      if (FULL_TEXT && INCLUDE_CONTENT) {
        roots = [document.body || document.documentElement].filter(Boolean);
      } else {
        roots = overlayRoots();
      }
      for (const root of roots) {
        const lines = String(root.innerText || "").replace(/\u00a0/g, " ").split(/\n| {2,}/);
        for (const line of lines) {
          add(line, FULL_TEXT ? "body" : "overlay", { tag: root.tagName, role: root.getAttribute && root.getAttribute("role") || "" });
        }
      }

      const attrSelector = "[aria-label],[title],[placeholder],[alt],input[type='button'],input[type='submit'],input[type='reset']";
      for (const el of Array.from(document.querySelectorAll(attrSelector)).filter(visible)) {
        for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
          if (el.hasAttribute(attr)) {
            add(el.getAttribute(attr), "attr", Object.assign({ attr, tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
          }
        }
        if (el.matches("input[type='button'], input[type='submit'], input[type='reset']")) {
          add(el.getAttribute("value"), "attr", Object.assign({ attr: "value", tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
        }
      }

      if (!INCLUDE_CONTENT) {
        for (const el of Array.from(document.querySelectorAll([
          "button",
          "a",
          "[role='button']",
          "[role='menuitem']",
          "[role='tab']",
          "[role='option']",
          "[role='checkbox']",
          "[role='radio']",
          "[role='switch']"
        ].join(","))).filter(visible)) {
          add(visibleLabelOf(el), "control", Object.assign({ tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
        }
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
      clickables: INCLUDE_CLICKABLES ? collectClickables() : [],
      overlays: collectOverlays(),
      hits: collectEnglish(),
      skipTextPattern: String(SKIP_TEXT),
      safeTextPattern: String(SAFE_TEXT)
    };
  })()`
    .replace("__INCLUDE_CLICKABLES__", includeClickables ? "true" : "false")
    .replace("__FULL_TEXT__", fullText ? "true" : "false")
    .replace("__CLICKABLE_SCOPE__", clickableScope)
    .replace("__INCLUDE_CONTENT__", includeContent ? "true" : "false");
}

function normText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function targetKey(scope, state, item) {
  const url = String(state && state.url || "").replace(/[?#].*$/, "");
  return [
    scope,
    url,
    normText(item.text).slice(0, 100),
    normText(item.role),
    item.tag,
    Math.round((item.x || 0) / 8),
    Math.round((item.y || 0) / 8),
    Math.round((item.w || 0) / 8),
    Math.round((item.h || 0) / 8)
  ].join("|");
}

function summarizeState(state, includeClickables = false) {
  const summary = {
    url: state && state.url,
    title: state && state.title,
    localized: state && state.localized,
    size: state && state.size,
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
    hits: state && state.hits || []
  };
  if (includeClickables) {
    summary.clickableCount = state && state.clickables ? state.clickables.length : 0;
    summary.clickables = (state && state.clickables || []).slice(0, 80);
  }
  return summary;
}

function isContentPageState(state) {
  const title = normText(state && state.title);
  const url = normText(state && state.url);
  return /API Network|MCP Servers|MCP Generator|Postman Code|Generate MCP Servers|Public API Network|Postman API 网络|MCP 服务器|MCP 生成器|生成 MCP 服务器/i.test(title) ||
    /\/explore\b|\/network\b|\/mcp\b/i.test(url);
}

function skipReasonForTarget(item, state, skippedLabels, includeRisky, includeContent) {
  const text = normText(item && item.text);
  const width = state && state.size && state.size.width || 0;
  const windowControl = item && item.cy < 36 && item.cx > (width - 145);
  if (windowControl) {
    return "window-control";
  }
  if (!includeContent && /^(Explore|探索|Public API Network|公开 API 网络|API Network|API 网络|Postman API Network|Postman API 网络|MCP Servers|MCP 服务器|MCP Generator|MCP 生成器|Postman Code|Generate MCP Servers|生成 MCP 服务器)$/i.test(text)) {
    return "content-page-entry";
  }
  if (!includeContent && isContentPageState(state)) {
    return "content-page-target";
  }
  if (!includeRisky && skippedLabels.test(text)) {
    return "risky-account-billing-or-window-action";
  }
  if (!includeRisky && /\b(Browse|Choose File|Choose Files|Select File|Select Files|Upload File|Upload Files|Open File|Open Folder|Import File)\b|浏览|选择文件|上传文件|打开文件|打开文件夹/i.test(text)) {
    return "external-file-picker";
  }
  return null;
}

function cleanupBlockingUiScript() {
  return String.raw`(() => {
    const removed = [];
    function norm(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }
    function describe(el) {
      return {
        tag: el.tagName,
        id: el.id || "",
        role: norm(el.getAttribute && el.getAttribute("role")),
        testid: norm(el.getAttribute && el.getAttribute("data-testid")),
        text: norm(el.innerText || el.textContent || "").slice(0, 160)
      };
    }
    function removeNode(el, reason) {
      if (!el || !el.parentNode) return false;
      removed.push(Object.assign({ reason }, describe(el)));
      el.parentNode.removeChild(el);
      return true;
    }

    const upgradeRoots = Array.from(document.querySelectorAll([
      "#upgrade_modal",
      "[data-testid='embedded-upgrade-modal-container']",
      "[data-testid='monetize-button-upgrade-button']"
    ].join(",")));

    for (const el of upgradeRoots) {
      const modal = el.closest(".ReactModal__Content, .ReactModal__Overlay, [role='dialog'], [data-testid='aether-modal']") || el;
      const text = norm(modal.innerText || modal.textContent || "");
      const hasEmbeddedPayment = Boolean(modal.querySelector("[data-testid='embedded-upgrade-modal-container'], #upgrade_modal"));
      if (hasEmbeddedPayment && text.length < 40) {
        removeNode(modal.closest(".ReactModal__Overlay") || modal, "stale-empty-upgrade-modal");
      }
    }

    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], [data-testid='aether-modal']")).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < innerWidth * 0.35 || rect.height < innerHeight * 0.35) return false;
      const text = norm(el.innerText || el.textContent || "");
      return text.length === 0 && Boolean(el.querySelector("[data-testid='embedded-upgrade-modal-container'], #upgrade_modal"));
    });
    for (const dialog of dialogs) {
      removeNode(dialog.closest(".ReactModal__Overlay") || dialog, "empty-upgrade-dialog");
    }

    return removed;
  })()`;
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const maxClicks = Number(argValue("--max-clicks", "180"));
  const maxOverlayClicks = Number(argValue("--max-overlay-clicks", "80"));
  const maxIterations = Number(argValue("--max-iterations", String(maxClicks * 4)));
  const delayMs = Number(argValue("--delay-ms", "350"));
  const outBase = resolveOutBase(argValue("--out", "postman-click-scan"));
  const includeRisky = hasFlag("--include-risky");
  const includeContent = hasFlag("--include-content");
  const targetTitle = argValue("--target-title", null);
  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) {
    throw new Error("DevToolsActivePort not found. Start Postman with --remote-debugging-port=0 first.");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs, { targetTitle });
  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  const skippedLabels = /Start Trial|Start trial|Trial|Continue with Team Plan|Sign Out|Sign out|Log out|Delete account|Upgrade|Upgrade plan|Request a demo|Checkout|Billing|Payment|purchase|Pay annually|Pay monthly|Request an approver|Add subscription|Add billing information|Add payment method|Exit|Quit|Close window|Close Window|Minimize|Maximize|Restore down|Restore Down|升级|开始试用|试用|付费|付款|结账|账单|支付|订阅|套餐|计划|退出|关闭窗口|最小化|最大化|向下还原/i;
  const log = [];
  const allHits = new Map();

  function mergeHits(step, hits) {
    for (const hit of hits || []) {
      if (!allHits.has(hit.text)) {
        allHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
      }
      const current = allHits.get(hit.text);
      current.count += hit.count || 1;
      for (const sample of hit.samples || []) {
        if (current.samples.length < 8) {
          current.samples.push(Object.assign({ step }, sample));
        }
      }
    }
  }

  async function collect(scope, fullText = false) {
    return evaluate(cdp, pageScript({
      includeClickables: true,
      fullText,
      clickableScope: scope,
      includeContent
    }));
  }

  async function closeTransientUi() {
    await pressEsc(cdp);
    await sleep(90);
    await pressEsc(cdp);
    await sleep(90);
    const overlayState = await collect("overlay", false);
    const closeTarget = (overlayState.clickables || []).find((item) => {
      return /^(关闭|取消|完成|确定|Close|Cancel|Done|OK|Okay|Dismiss)$/i.test(normText(item.text));
    });
    if (closeTarget) {
      try {
        await clickAt(cdp, closeTarget.cx, closeTarget.cy);
        await sleep(120);
      } catch (_) {}
    }
    return evaluate(cdp, cleanupBlockingUiScript());
  }

  function sortedTargets(state) {
    return (state.clickables || [])
      .filter((item) => item && item.w >= 4 && item.h >= 4)
      .sort((a, b) => {
        const aText = normText(a.text);
        const bText = normText(b.text);
        const aNamed = aText && !/^(button|div|span|svg|path)$/i.test(aText) ? 0 : 1;
        const bNamed = bText && !/^(button|div|span|svg|path)$/i.test(bText) ? 0 : 1;
        return aNamed - bNamed || (a.y - b.y) || (a.x - b.x);
      });
  }

  async function clickOneTarget(scope, item, state, index, parentStep) {
    const skipReason = skipReasonForTarget(item, state, skippedLabels, includeRisky, includeContent);
    const entry = {
      step: index,
      parentStep,
      scope,
      skipped: Boolean(skipReason),
      skipReason,
      target: item,
      before: summarizeState(state, false),
      afterOverlay: null,
      afterFull: null,
      childClickLog: []
    };

    if (!entry.skipped) {
      try {
        await clickAt(cdp, item.cx, item.cy);
        await sleep(delayMs);
        const overlay = await collect("overlay", false);
        mergeHits(`${scope}-${index}-overlay`, overlay.hits);
        entry.afterOverlay = summarizeState(overlay, true);

        const full = await collect("full", true);
        mergeHits(`${scope}-${index}-full`, full.hits);
        entry.afterFull = summarizeState(full, false);
      } catch (error) {
        entry.error = error && error.message || String(error);
      }
    }

    return entry;
  }

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(500);

    const initial = await collect("full", true);
    mergeHits("initial", initial.hits);
    const initialClickables = (initial.clickables || []).slice(0, maxClicks);
    const seen = new Set();
    let clickedCount = 0;
    let skippedCount = 0;
    let overlayClickedCount = 0;
    let iterations = 0;

    while (clickedCount + skippedCount < maxClicks && iterations < maxIterations) {
      iterations += 1;
      const cleanup = await closeTransientUi();
      if (cleanup && cleanup.length) {
        log.push({ step: `cleanup-${iterations}`, scope: "cleanup", removed: cleanup });
      }
      const state = await collect("full", true);
      mergeHits(`dynamic-${iterations}-state`, state.hits);
      if (!includeContent && isContentPageState(state)) {
        log.push({
          step: `content-page-back-${iterations}`,
          scope: "navigation",
          reason: "content-page-state",
          state: summarizeState(state, false)
        });
        await pressAltLeft(cdp);
        await sleep(Math.max(delayMs, 500));
        continue;
      }
      const candidates = sortedTargets(state);
      const item = candidates.find((candidate) => {
        const key = targetKey("full", state, candidate);
        return !seen.has(key);
      });

      if (!item) {
        break;
      }

      seen.add(targetKey("full", state, item));
      const step = log.length;
      const entry = await clickOneTarget("full", item, state, step, null);
      if (entry.skipped) {
        skippedCount += 1;
        log.push(entry);
        continue;
      }

      clickedCount += 1;

      let overlayState = await collect("overlay", false);
      const overlayTargets = sortedTargets(overlayState)
        .filter((candidate) => !skipReasonForTarget(candidate, overlayState, skippedLabels, includeRisky, includeContent))
        .filter((candidate) => {
          const key = targetKey("overlay", overlayState, candidate);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, Math.max(0, maxOverlayClicks - overlayClickedCount));

      for (let childIndex = 0; childIndex < overlayTargets.length; childIndex += 1) {
        if (overlayClickedCount >= maxOverlayClicks) {
          break;
        }
        const child = overlayTargets[childIndex];
        const childEntry = await clickOneTarget("overlay", child, overlayState, `${step}.${childIndex}`, step);
        overlayClickedCount += childEntry.skipped ? 0 : 1;
        entry.childClickLog.push(childEntry);
        overlayState = await collect("overlay", false);
        mergeHits(`overlay-${step}-${childIndex}-state`, overlayState.hits);
        if (!overlayState.overlays || overlayState.overlays.length === 0) {
          break;
        }
      }

      log.push(entry);
      await closeTransientUi();
    }

    const finalState = await evaluate(cdp, pageScript({ includeClickables: false, fullText: true, includeContent }));
    mergeHits("final", finalState.hits);
    await capture(cdp, `${outBase}.png`);

    const output = {
      target: { title: target.title, url: target.url },
      initial: {
        url: initial.url,
        title: initial.title,
        localized: initial.localized,
        size: initial.size,
        clickableCount: initial.clickables.length,
        clickables: initialClickables
      },
      clicked: log.filter((item) => !item.skipped).length,
      skipped: log.filter((item) => item.skipped).length,
      overlayClicked: log.reduce((sum, item) => sum + (item.childClickLog || []).filter((child) => !child.skipped).length, 0),
      iterations,
      includeContent,
      clickLog: log,
      hits: Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      final: {
        url: finalState.url,
        title: finalState.title,
        localized: finalState.localized,
        hits: finalState.hits
      }
    };
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    console.log(JSON.stringify({
      out: `${outBase}.json`,
      screenshot: `${outBase}.png`,
      clickableCount: initial.clickables.length,
      clicked: output.clicked,
      skipped: output.skipped,
      overlayClicked: output.overlayClicked,
      iterations,
      includeContent,
      hitCount: output.hits.length,
      hits: output.hits.slice(0, 30).map((item) => item.text)
    }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
