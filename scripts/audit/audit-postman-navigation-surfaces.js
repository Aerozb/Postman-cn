#!/usr/bin/env node
"use strict";

// Broad, read-only Postman navigation audit.
//
// Safety invariants:
//   * Only a curated set of navigation controls and view-only openers is clicked.
//   * Menu items are collected but never selected, except known page navigation
//     entries and the App Settings entry.
//   * Checkboxes, radios, switches, editors, submit controls and destructive
//     controls are never activated.
//   * Dropdown options and context-menu commands are never selected.
//   * Escape is used to dismiss transient UI after every probe.
//
// Coverage:
//   * ordinary DOM, open shadow DOM and same-origin iframes;
//   * visible text nodes, 20 UI attributes and current input values;
//   * Accessibility tree names/descriptions/values (also useful for closed
//     component internals exposed through Chromium accessibility);
//   * requester tabs, top navigation, sidebar panels, workspace pages,
//     Apps/API/Performance/Runner surfaces and every Settings tab;
//   * scroll positions, hover tooltips, dropdowns, menus, dialogs and safe
//     context menus.

const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

function norm(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Postman CDP.")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Failed to connect to Postman CDP.")); }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else item.resolve(message.result);
  });

  return {
    send(method, params = {}, sessionId = null) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 60000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    close() {
      try { ws.close(); } catch (_) {}
    }
  };
}

async function connectTarget(port, browserPath, target) {
  if (browserPath) {
    const root = await connect(`ws://127.0.0.1:${port}${browserPath}`);
    const attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) {
      root.close();
      throw new Error("Target.attachToTarget did not return a session id.");
    }
    return {
      send(method, params = {}) {
        return root.send(method, params, sessionId);
      },
      close() {
        root.close();
      }
    };
  }
  return connect(target.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function mouse(cdp, type, x, y, button = "none", clickCount = 0) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount });
}

async function click(cdp, target, button = "left") {
  await mouse(cdp, "mouseMoved", target.x, target.y);
  await mouse(cdp, "mousePressed", target.x, target.y, button, 1);
  await mouse(cdp, "mouseReleased", target.x, target.y, button, 1);
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
  });
}

async function closeTransient(cdp, delay) {
  await pressEscape(cdp);
  await sleep(70);
  await pressEscape(cdp);
  await sleep(Math.max(100, Math.min(delay, 300)));
  await mouse(cdp, "mouseMoved", 620, 110);
}

async function dismissNestedOverlay(cdp, delay) {
  await pressEscape(cdp);
  await sleep(Math.max(90, Math.min(delay, 260)));
  await mouse(cdp, "mouseMoved", 620, 110);
}

const ATTRIBUTES = [
  "title", "aria-label", "aria-description", "aria-placeholder", "placeholder",
  "alt", "label", "value", "data-original-title", "data-tippy-content",
  "data-tooltip", "data-tooltip-content", "data-tooltip-title", "data-tooltip-text",
  "data-tooltip-label", "data-aether-tooltip", "data-tab-name",
  "aria-valuetext", "aria-roledescription"
];

const scanScript = (scope = "all") => String.raw`(() => {
  const SCOPE = ${JSON.stringify(scope)};
  const ATTRS = ${JSON.stringify(ATTRIBUTES)};
  const norm = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const roots = [];
  const seen = new Set();

  function visit(root, trail, offsetX, offsetY, viewportWidth, viewportHeight) {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push({ root, trail, offsetX, offsetY, viewportWidth, viewportHeight });
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot, trail + ">shadow(" + el.tagName.toLowerCase() + ")", offsetX, offsetY, viewportWidth, viewportHeight);
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) {
            const rect = el.getBoundingClientRect();
            visit(el.contentDocument, trail + ">iframe(" + (el.src || el.name || "inline") + ")", offsetX + rect.x, offsetY + rect.y, rect.width, rect.height);
          }
        } catch (_) {}
      }
    }
  }

  visit(document, "document", 0, 0, innerWidth, innerHeight);

  function localVisible(el, entry) {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= entry.viewportHeight || rect.left >= entry.viewportWidth) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView || window;
    const style = view.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function packedRect(el, entry) {
    const r = el.getBoundingClientRect();
    return {
      x: r.x + entry.offsetX,
      y: r.y + entry.offsetY,
      w: r.width,
      h: r.height,
      cx: r.x + entry.offsetX + r.width / 2,
      cy: r.y + entry.offsetY + r.height / 2
    };
  }

  const overlaySelector = [
    "[role=dialog]", "[aria-modal=true]", "[role=menu]", "[role=listbox]",
    "[role=tooltip]", "[role=alertdialog]",
    "[data-testid*=modal]", "[data-testid$='-menu']",
    "[data-testid*=menu-container]", "[data-testid*=menu-content]",
    "[data-aether-id*=modal]", "[id^=tippy]"
  ].join(",");

  const hits = [];
  const targets = [];
  const hoverTargets = [];
  const scrolls = [];
  const overlays = [];

  function addHit(value, kind, entry, el, attribute) {
    const text = norm(value);
    if (!text || text.length > 1600) return;
    const rect = el && el.getBoundingClientRect ? packedRect(el, entry) : null;
    hits.push({
      text, kind, attribute: attribute || null, trail: entry.trail,
      tag: el && el.tagName || "", role: el && norm(el.getAttribute("role")) || "",
      testid: el && norm(el.getAttribute("data-testid")) || "", rect
    });
  }

  for (const entry of roots) {
    const overlayRoots = [...entry.root.querySelectorAll(overlaySelector)].filter(el => localVisible(el, entry));
    for (const overlay of overlayRoots) {
      const rect = packedRect(overlay, entry);
      overlays.push({
        text: norm(overlay.innerText || overlay.textContent).slice(0, 600),
        role: norm(overlay.getAttribute("role")), testid: norm(overlay.getAttribute("data-testid")),
        trail: entry.trail, rect
      });
    }
    const insideOverlay = el => overlayRoots.some(root => root === el || root.contains(el));

    for (const el of entry.root.querySelectorAll("*")) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK)$/.test(el.tagName)) continue;
      if (SCOPE === "overlay" && !insideOverlay(el)) continue;
      const visible = localVisible(el, entry);
      const rect = visible ? packedRect(el, entry) : null;

      if (visible) {
        for (const node of el.childNodes || []) {
          if (node.nodeType === 3) addHit(node.nodeValue, "text", entry, el);
        }
      }

      for (const attribute of visible ? ATTRS : []) {
        if (!el.hasAttribute || !el.hasAttribute(attribute)) continue;
        if (attribute === "value" && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
        addHit(el.getAttribute(attribute), "attribute", entry, el, attribute);
      }

      if (visible && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && norm(el.value)) {
        addHit(el.value, "input-value", entry, el, "value");
      }

      if (!visible) continue;
      const role = norm(el.getAttribute("role"));
      const testid = norm(el.getAttribute("data-testid"));
      const text = norm(
        el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.getAttribute("placeholder") || el.innerText || el.textContent || testid
      ).slice(0, 260);
      const href = norm(el.getAttribute("href"));
      const hasPopup = norm(el.getAttribute("aria-haspopup"));
      const disabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");
      const testidInteractive = /(?:^|[-_])(?:button|tab|menu-item|nav-item|trigger|select|dropdown|link)(?:$|[-_])/i.test(testid);
      const view = el.ownerDocument && el.ownerDocument.defaultView || window;
      const interactive = el.matches([
        "button", "a", "input", "textarea", "select", "summary",
        "[role=button]", "[role=tab]", "[role=link]", "[role=menuitem]",
        "[role=option]", "[role=combobox]", "[role=checkbox]", "[role=radio]",
        "[role=switch]", "[role=textbox]", "[data-tab-id]", "[aria-haspopup]"
      ].join(",")) || testidInteractive || view.getComputedStyle(el).cursor === "pointer";

      const region = insideOverlay(el) ? "overlay" :
        rect.cy < 90 ? "top" : rect.cy > innerHeight - 48 ? "status" :
        rect.cx < 430 ? "sidebar" : "content";

      if (interactive) {
        targets.push({
          x: rect.cx, y: rect.cy, rect, text, tag: el.tagName, role, testid, href,
          hasPopup, disabled, region, trail: entry.trail,
          tabId: norm(el.getAttribute("data-tab-id")),
          tabName: norm(el.getAttribute("data-tab-name")),
          active: el.getAttribute("aria-selected") === "true" || el.getAttribute("data-tab-is-active") === "true"
        });
      }

      const hoverable = interactive || el.matches([
        "[aria-label]", "[title]", "[data-tooltip]", "[data-tooltip-content]",
        "[data-tippy-content]", "svg", "[role=img]", "label"
      ].join(","));
      if (hoverable) {
        hoverTargets.push({
          x: rect.cx, y: rect.cy, rect, text, tag: el.tagName, role, testid,
          disabled, region, trail: entry.trail,
          priority: Number(Boolean(el.hasAttribute("title") || el.hasAttribute("aria-label") || /tooltip|info|help/i.test(testid))) * 4 +
            Number(el.matches("button,[role=button],[role=img],svg")) * 2 + Number(disabled)
        });
      }

      if (el.scrollHeight > el.clientHeight + 24 && rect.h > 45 && rect.w > 70) {
        scrolls.push({ x: rect.cx, y: rect.cy, rect, text: text.slice(0, 120), trail: entry.trail, max: el.scrollHeight - el.clientHeight });
      }
    }
  }

  function unique(items, key) {
    const map = new Map();
    for (const item of items) {
      const value = key(item);
      if (!map.has(value)) map.set(value, item);
    }
    return [...map.values()];
  }

  return {
    url: location.href,
    title: document.title,
    rootCount: roots.length,
    hits: unique(hits, item => item.kind + "|" + item.attribute + "|" + item.text + "|" + item.trail),
    targets: unique(targets, item => Math.round(item.x / 2) + ":" + Math.round(item.y / 2) + ":" + item.text),
    hoverTargets: unique(hoverTargets, item => Math.round(item.x / 2) + ":" + Math.round(item.y / 2)),
    scrolls: unique(scrolls, item => Math.round(item.x / 3) + ":" + Math.round(item.y / 3)),
    overlays: unique(overlays, item => item.role + "|" + item.testid + "|" + item.text)
  };
})()`;

const scrollAtPointScript = (x, y, ratio) => String.raw`(() => {
  const x = ${Number(x)}, y = ${Number(y)}, ratio = ${Number(ratio)};
  let doc = document, localX = x, localY = y, el = null;
  for (let depth = 0; depth < 8; depth += 1) {
    el = doc.elementFromPoint(localX, localY);
    if (!el) break;
    if (el.tagName === "IFRAME") {
      try {
        if (el.contentDocument) {
          const rect = el.getBoundingClientRect();
          localX -= rect.x;
          localY -= rect.y;
          doc = el.contentDocument;
          continue;
        }
      } catch (_) {}
    }
    break;
  }
  while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) {
    const deeper = el.shadowRoot.elementFromPoint(localX, localY);
    if (!deeper || deeper === el) break;
    el = deeper;
  }
  const visited = new Set();
  while (el && !visited.has(el)) {
    visited.add(el);
    if (el.scrollHeight > el.clientHeight + 20) {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ratio);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { ok: true, tag: el.tagName, testid: el.getAttribute && el.getAttribute("data-testid"), scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    }
    const root = el.getRootNode && el.getRootNode();
    el = el.parentElement || (root && root.host) || null;
  }
  return { ok: false };
})()`;

const requesterTabsScript = String.raw`(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return [];
  const norm = value => String(value || "").replace(/\s+/g, " ").trim();
  const seen = new Set();
  return [...root.querySelectorAll('[data-tab-id]')].map((el, index) => {
    const tabId = el.getAttribute('data-tab-id');
    if (!tabId || seen.has(tabId)) return null;
    seen.add(tabId);
    return {
      index, tabId,
      tabName: norm(el.getAttribute('data-tab-name') || el.innerText || el.textContent),
      active: el.getAttribute('data-tab-is-active') === 'true'
    };
  }).filter(Boolean);
})()`;

const activateRequesterTabScript = (tabId) => String.raw`(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return null;
  const id = ${JSON.stringify(String(tabId))};
  const el = [...root.querySelectorAll('[data-tab-id]')].find(node => node.getAttribute('data-tab-id') === id);
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'center' });
  const rect = el.getBoundingClientRect();
  return {
    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    tabId: id,
    tabName: String(el.getAttribute('data-tab-name') || el.innerText || el.textContent || '').trim()
  };
})()`;

const activeRequesterTabScript = (tabId) => String.raw`(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  const el = root && [...root.querySelectorAll('[data-tab-id]')].find(node => node.getAttribute('data-tab-id') === ${JSON.stringify(String(tabId))});
  return Boolean(el && (el.getAttribute('data-tab-is-active') === 'true' || el.getAttribute('aria-selected') === 'true'));
})()`;

const settingsTabsScript = String.raw`(() => {
  const norm = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const visible = el => {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 3 && rect.height > 3 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
      style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  };
  const dialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-testid="settings-modal"]')]
    .filter(visible).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!dialog) return [];
  const known = [
    "通用", "常规", "主题", "外观", "快捷键", "AI", "数据", "附加组件", "插件", "证书", "代理", "更新", "关于",
    "General", "Themes", "Appearance", "Shortcuts", "AI", "Data", "Add-ons", "Plugins", "Certificates", "Proxy", "Update", "About"
  ];
  const result = [];
  for (const label of known) {
    const candidates = [...dialog.querySelectorAll('*')].filter(el => visible(el) && norm(el.innerText || el.textContent) === label);
    candidates.sort((a, b) => {
      const score = el => {
        const role = norm(el.getAttribute('role')).toLowerCase();
        const testid = norm(el.getAttribute('data-testid')).toLowerCase();
        if (role === 'tab' || /(?:^|[-_])tab(?:$|[-_])/.test(testid)) return 0;
        if (/^(BUTTON|A|LI)$/.test(el.tagName) || role === 'button' || role === 'link') return 1;
        return 2;
      };
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return score(a) - score(b) || ar.width * ar.height - br.width * br.height;
    });
    const el = candidates[0];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    result.push({
      label,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      tag: el.tagName,
      role: norm(el.getAttribute('role')),
      testid: norm(el.getAttribute('data-testid')),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    });
  }
  return [...new Map(result.map(item => [item.label.toLowerCase(), item])).values()];
})()`;

const DANGEROUS_RE = /(?:删除|移除|退出|注销|关闭窗口|关闭标签|全部关闭|强制关闭|清空|终止|停止运行|放弃|丢弃|重置|覆盖|卸载|取消订阅|付款|购买|升级|试用|邀请|连接 Git|运行|发送|保存|提交|创建|新建|添加|上传|导出|下载|delete|remove|sign\s*out|log\s*out|quit|exit|close\s*(?:window|tab|all|other)|force\s*close|clear|terminate|stop|discard|reset|overwrite|uninstall|unsubscribe|payment|purchase|upgrade|trial|invite|connect\s+git|run\b|send\b|save\b|submit|create|new\b|add\b|upload|export|download)/i;
const ALLOWED_EXACT = /^(?:API|APIs|URL|URI|HTTP|HTTPS|JSON|XML|HTML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|P90|P95|P99|CPU|RAM|Postman|JavaScript|TypeScript|OpenAPI|CLI|MCP)$/i;
const ALLOWED_WORDS = new Set([
  "api", "apis", "url", "uri", "http", "https", "json", "xml", "html", "oauth", "jwt", "aws",
  "graphql", "grpc", "websocket", "cookie", "cookies", "sdk", "ai", "git", "github", "get", "post",
  "put", "patch", "delete", "head", "options", "p90", "p95", "p99", "cpu", "ram", "postman",
  "javascript", "typescript", "openapi", "swagger", "cli", "mcp", "ssl", "tls", "csv", "pdf", "npm",
  "uuid", "id", "ids", "kb", "mb", "gb", "ms", "px", "req", "s", "ctrl", "alt", "shift", "tab", "del", "enter", "esc",
  "ci", "cd", "no", "proxy", "markdown", "chrome", "vs", "code", "cursor", "windsurf", "ca", "windows", "win32",
  "ibmplexmono", "courier", "monospace", "twitter", "slack", "teams", "auto", "system"
]);

function dangerous(value) {
  return DANGEROUS_RE.test(norm(value));
}

function englishCandidate(value) {
  const text = norm(value);
  if (!text || text.length < 2 || !/[A-Za-z]{2}/.test(text)) return false;
  if (ALLOWED_EXACT.test(text)) return false;
  if (/^(?:https?:\/\/|file:\/\/|mailto:)/i.test(text)) return false;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text)) return false;
  if (/^[A-Z]:\\/.test(text)) return false;
  if (/^\d+(?:\.\d+)+(?:-[A-Za-z0-9-]+)?$/.test(text)) return false;
  if (/的头像$|团队标志$/.test(text)) return false;
  if (/^(?:Microsoft Teams|Slack|GitHub|OpenAI|Datadog|Salesforce)\s+图标$/i.test(text)) return false;
  if (/^[a-z0-9_.-]+__(?:[a-z0-9_.-]+)(?:--[a-z0-9_.-]+)?$/i.test(text)) return false;
  if (/^[a-z0-9]+(?:-{1,2}[a-z0-9]+)+$/i.test(text)) return false;
  if (/^(?:aether|pm|postman)-[a-z0-9_-]+$/i.test(text)) return false;
  if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(text)) return false;
  if (/^[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(text)) return false;
  if (/^[a-z]+\d+$/.test(text)) return false;
  if (/\b(?:Ctrl|Alt|Shift|Cmd|Command)\s*\+/i.test(text) && !/[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(text.replace(/(?:Ctrl|Alt|Shift|Cmd|Command)\s*\+\s*\S+/ig, ""))) return false;

  const words = text.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
  const meaningful = words.filter((word) => {
    const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (!lowered || lowered.length <= 1 || ALLOWED_WORDS.has(lowered)) return false;
    if (lowered.includes("/") && lowered.split("/").every(part => ALLOWED_WORDS.has(part))) return false;
    if (/^[a-f0-9]{8,}$/i.test(lowered) || /^\d/.test(lowered)) return false;
    return true;
  });
  return meaningful.length > 0;
}

function axValue(node, key) {
  const value = node && node[key];
  return value && typeof value.value !== "undefined" ? norm(value.value) : "";
}

async function accessibilityFindings(cdp) {
  try {
    const result = await cdp.send("Accessibility.getFullAXTree");
    const findings = [];
    for (const node of result.nodes || []) {
      if (node.ignored) continue;
      const role = axValue(node, "role");
      for (const [kind, key] of [["ax-name", "name"], ["ax-description", "description"], ["ax-value", "value"]]) {
        const text = axValue(node, key);
        if (englishCandidate(text)) findings.push({ text, kind, role, backendDOMNodeId: node.backendDOMNodeId || null });
      }
      for (const property of node.properties || []) {
        if (!["placeholder", "roledescription", "valuetext"].includes(property.name)) continue;
        const text = property.value && typeof property.value.value !== "undefined" ? norm(property.value.value) : "";
        if (englishCandidate(text)) findings.push({ text, kind: `ax-${property.name}`, role, backendDOMNodeId: node.backendDOMNodeId || null });
      }
    }
    return [...new Map(findings.map(item => [`${item.kind}|${item.text}`, item])).values()];
  } catch (error) {
    return [{ text: "", kind: "ax-error", error: error.message }];
  }
}

function safeInteractive(target, options = {}) {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y) || target.disabled) return false;
  const combined = `${target.text || ""} ${target.testid || ""} ${target.role || ""}`;
  if (!options.allowDangerousLabel && dangerous(combined)) return false;
  if (/^(?:checkbox|radio|switch|option|textbox)$/i.test(target.role || "")) return false;
  if (/^(?:INPUT|TEXTAREA|SELECT)$/i.test(target.tag || "") && !options.allowCombobox) return false;
  if (target.href && /^https?:\/\//i.test(target.href) && !/^https:\/\/(?:desktop\.)?postman\.com/i.test(target.href)) return false;
  return true;
}

function matchesAny(target, patterns) {
  const values = [
    norm(target.text),
    norm(target.testid),
    norm(target.role),
    norm(`${target.text || ""} ${target.testid || ""} ${target.role || ""}`)
  ];
  return patterns.some((pattern) => values.some((value) => pattern.test(value)));
}

function pickTarget(state, spec, scope = "all") {
  const candidates = (state.targets || []).filter((target) => {
    if (scope === "overlay" && target.region !== "overlay") return false;
    if (spec.region && ![].concat(spec.region).includes(target.region)) return false;
    if (typeof spec.minX === "number" && target.x < spec.minX) return false;
    if (typeof spec.maxX === "number" && target.x > spec.maxX) return false;
    if (typeof spec.minY === "number" && target.y < spec.minY) return false;
    if (typeof spec.maxY === "number" && target.y > spec.maxY) return false;
    if (spec.roles && !spec.roles.includes(String(target.role || "").toLowerCase())) return false;
    if (!matchesAny(target, spec.patterns || [])) return false;
    return safeInteractive(target, { allowDangerousLabel: Boolean(spec.allowDangerousLabel), allowCombobox: Boolean(spec.allowCombobox) });
  });
  candidates.sort((a, b) => {
    const aExact = (spec.patterns || []).some(re => re.source.startsWith("^") && (re.test(norm(a.text)) || re.test(norm(a.testid)))) ? 0 : 1;
    const bExact = (spec.patterns || []).some(re => re.source.startsWith("^") && (re.test(norm(b.text)) || re.test(norm(b.testid)))) ? 0 : 1;
    return aExact - bExact || (a.rect.w * a.rect.h) - (b.rect.w * b.rect.h) || a.y - b.y || a.x - b.x;
  });
  return candidates[0] || null;
}

const SIDEBAR_SURFACES = [
  { name: "sidebar-projects", patterns: [/sidebar-tab-internal-dev-services/i, /^(?:项目|Projects?)$/i], region: ["top", "sidebar"], maxX: 430 },
  { name: "sidebar-services", patterns: [/sidebar-tab-cloud-services/i, /^(?:服务|Services?)$/i], region: ["top", "sidebar"], maxX: 430 },
  { name: "sidebar-history", patterns: [/sidebar-tab-history-modifications/i, /^(?:历史|History)$/i], region: ["top", "sidebar"], maxX: 430 },
  { name: "sidebar-local-files", patterns: [/sidebar-tab-file-system/i, /^(?:本地文件|Local Files?)$/i], region: ["top", "sidebar"], maxX: 430 },
  { name: "sidebar-collections", patterns: [/sidebar-panel-collections?/i, /^(?:集合|Collections?)$/i], region: "sidebar", maxX: 430 },
  { name: "sidebar-environments", patterns: [/sidebar-panel-environments?/i, /^(?:环境|Environments?)$/i], region: "sidebar", maxX: 430 },
  { name: "sidebar-specifications", patterns: [/sidebar-panel-specifications?/i, /^(?:规范|Specifications?|Specs?)$/i], region: "sidebar", maxX: 430 },
  { name: "sidebar-flows", patterns: [/sidebar-panel-flows?/i, /^(?:流程|Flows?)$/i], region: "sidebar", maxX: 430 }
];

const WORKSPACE_SURFACES = [
  { name: "workspace-overview", patterns: [/^(?:概览|Overview)$/i], region: "content", minX: 420, maxY: 190 },
  { name: "workspace-documentation", patterns: [/^(?:文档|Documentation)$/i], region: "content", minX: 420, maxY: 190 },
  { name: "workspace-updates", patterns: [/^(?:更新|Updates?|Activity)$/i], region: "content", minX: 420, maxY: 190 },
  { name: "workspace-apps", patterns: [/^(?:应用|Apps?|App catalog)$/i], region: "content", minX: 420, maxY: 190 },
  { name: "workspace-settings", patterns: [/^(?:设置|Settings)$/i], region: "content", minX: 420, maxY: 190 }
];

const HEADER_MENU_SURFACES = [
  { name: "home", patterns: [/^(?:首页|主页|Home)$/i] },
  { name: "workspaces", patterns: [/^(?:工作区|Workspaces?)$/i] },
  { name: "apps-catalog", patterns: [/^(?:应用|应用清单|Apps?|App catalog|Application inventory)$/i] },
  { name: "api-catalog", patterns: [/^(?:API 目录|API Catalog|Explore APIs)$/i] },
  { name: "private-api-network", patterns: [/^(?:私有 API 网络|Private API Network)$/i] },
  { name: "public-api-network", patterns: [/^(?:公开 API 网络|公共 API 网络|Public API Network)$/i] },
  { name: "integrations", patterns: [/^(?:集成|Integrations?)$/i] },
  { name: "reports", patterns: [/^(?:报告|Reports?)$/i] },
  { name: "team", patterns: [/^(?:团队|Team)$/i] },
  { name: "monitors", patterns: [/^(?:监控器|监控|Monitors?)$/i] },
  { name: "performance", patterns: [/^(?:性能|Performance|Performance tests?)$/i] },
  { name: "runner", patterns: [/^(?:运行器|Collection Runner|Runner)$/i], allowDangerousLabel: true }
];

const DEEP_PAGE_SURFACES = [
  { name: "deep-apps", patterns: [/^(?:应用|Apps?|App catalog)$/i], region: "content" },
  { name: "deep-apis", patterns: [/^(?:APIs?|API 目录|API Catalog|Explore APIs)$/i], region: "content" },
  { name: "deep-performance", patterns: [/^(?:性能|Performance|Performance tests?|Performance runs?)$/i], region: "content" },
  { name: "deep-runs", patterns: [/^(?:运行记录|Runs|Collection Runner|Runner)$/i, /(?:performance-runs|runner)-(?:tab|nav)/i], region: "content", roles: ["tab", "link"], allowDangerousLabel: true },
  { name: "deep-files", patterns: [/^(?:文件|Files?)$/i], region: "content" },
  { name: "deep-members", patterns: [/^(?:成员|Members?|People)$/i], region: "content" },
  { name: "deep-activity", patterns: [/^(?:活动|Activity|Updates?)$/i], region: "content" }
];

async function main() {
  const out = path.resolve(arg("--out", path.join(__dirname, "..", "..", "..", "_generated", "postman-navigation-surfaces.json")));
  const delay = Math.max(80, Number(arg("--delay-ms", "380")));
  const maxRequesterTabs = Math.max(0, Number(arg("--max-requester-tabs", "40")));
  const maxSurfaces = Math.max(1, Number(arg("--max-surfaces", "45")));
  const perSurface = {
    hovers: Math.max(0, Number(arg("--hovers-per-surface", "24"))),
    menus: Math.max(0, Number(arg("--menus-per-surface", "8"))),
    dropdowns: Math.max(0, Number(arg("--dropdowns-per-surface", "6"))),
    contexts: Math.max(0, Number(arg("--contexts-per-surface", "4"))),
    scrolls: Math.max(0, Number(arg("--scrolls-per-surface", "6")))
  };
  const budget = {
    hovers: Math.max(0, Number(arg("--max-hovers", "260"))),
    menus: Math.max(0, Number(arg("--max-menus", "80"))),
    dropdowns: Math.max(0, Number(arg("--max-dropdowns", "60"))),
    contexts: Math.max(0, Number(arg("--max-context", "40"))),
    scrolls: Math.max(0, Number(arg("--max-scrolls", "100")))
  };
  const used = { hovers: 0, menus: 0, dropdowns: 0, contexts: 0, scrolls: 0 };

  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) throw new Error("Postman DevToolsActivePort was not found. Start Postman with remote debugging enabled.");
  const portLines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
  const port = portLines[0].trim();
  const browserPath = norm(portLines[1]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(page => page.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(page.url || ""));
  if (!target) throw new Error("Postman page target was not found.");

  const cdp = await connectTarget(port, browserPath, target);
  const snapshots = [];
  const actions = [];
  const errors = [];
  const merged = new Map();
  let surfaceCount = 0;

  function mergeFindings(surface, phase, findings) {
    for (const finding of findings || []) {
      if (!finding.text) continue;
      const key = `${finding.kind}|${finding.attribute || ""}|${finding.text}`;
      const current = merged.get(key) || { ...finding, count: 0, surfaces: [], phases: [] };
      current.count += 1;
      if (!current.surfaces.includes(surface)) current.surfaces.push(surface);
      if (current.phases.length < 30 && !current.phases.includes(phase)) current.phases.push(phase);
      merged.set(key, current);
    }
  }

  async function scan(surface, phase, scope = "all", withAx = false) {
    const state = await evaluate(cdp, scanScript(scope));
    const domFindings = state.hits.filter(item => englishCandidate(item.text));
    const axFindings = withAx ? await accessibilityFindings(cdp) : [];
    mergeFindings(surface, phase, domFindings);
    mergeFindings(surface, phase, axFindings.filter(item => item.text));
    snapshots.push({
      surface, phase, scope, url: state.url, title: state.title,
      rootCount: state.rootCount, hitCount: state.hits.length,
      findingCount: domFindings.length + axFindings.filter(item => item.text).length,
      findings: [...domFindings, ...axFindings.filter(item => item.text)],
      overlayCount: state.overlays.length, overlays: state.overlays.slice(0, 30),
      targetCount: state.targets.length,
      targetPreview: state.targets.slice(0, 180),
      hoverTargetCount: state.hoverTargets.length,
      scrollCount: state.scrolls.length
    });
    const axError = axFindings.find(item => item.error);
    if (axError) errors.push({ surface, phase, type: "accessibility", error: axError.error });
    return state;
  }

  async function auditScrolls(surface, state, scope) {
    const limit = Math.min(perSurface.scrolls, budget.scrolls - used.scrolls);
    for (const [index, item] of (state.scrolls || []).slice(0, limit).entries()) {
      for (const ratio of [0, 0.5, 1]) {
        try {
          const result = await evaluate(cdp, scrollAtPointScript(item.x, item.y, ratio));
          await sleep(Math.max(100, Math.floor(delay / 2)));
          await scan(surface, `scroll:${index}:${ratio}`, scope, ratio === 1);
          actions.push({ surface, type: "scroll", ok: Boolean(result && result.ok), target: item, ratio, result });
        } catch (error) {
          errors.push({ surface, type: "scroll", target: item, ratio, error: error.message });
        }
      }
      used.scrolls += 1;
    }
  }

  async function auditHovers(surface, state) {
    const limit = Math.min(perSurface.hovers, budget.hovers - used.hovers);
    const candidates = (state.hoverTargets || [])
      .filter(target => !dangerous(`${target.text} ${target.testid}`))
      .sort((a, b) => b.priority - a.priority || a.y - b.y || a.x - b.x)
      .slice(0, limit);
    for (const [index, targetItem] of candidates.entries()) {
      try {
        await mouse(cdp, "mouseMoved", targetItem.x, targetItem.y);
        await sleep(Math.max(delay, 320));
        await scan(surface, `hover:${index}:${targetItem.text || targetItem.testid}`, "overlay", false);
        actions.push({ surface, type: "hover", ok: true, target: targetItem });
      } catch (error) {
        errors.push({ surface, type: "hover", target: targetItem, error: error.message });
      }
      used.hovers += 1;
      await mouse(cdp, "mouseMoved", 620, 110);
      await sleep(40);
    }
  }

  async function auditDropdowns(surface, state, preserveParent = false) {
    const limit = Math.min(perSurface.dropdowns, budget.dropdowns - used.dropdowns);
    const candidates = (state.targets || [])
      .filter(targetItem => /combobox/i.test(targetItem.role) || /dropdown|select/i.test(`${targetItem.testid} ${targetItem.hasPopup}`))
      .filter(targetItem => safeInteractive(targetItem, { allowCombobox: true }))
      .slice(0, limit);
    for (const [index, targetItem] of candidates.entries()) {
      let nestedOpened = false;
      try {
        if (!preserveParent) await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        const openedState = await scan(surface, `dropdown:${index}:${targetItem.text || targetItem.testid}`, "overlay", true);
        nestedOpened = (openedState.overlays || []).length > (state.overlays || []).length ||
          (openedState.overlays || []).some(item => /menu|listbox/i.test(item.role));
        actions.push({ surface, type: "dropdown-open", ok: true, target: targetItem });
      } catch (error) {
        errors.push({ surface, type: "dropdown-open", target: targetItem, error: error.message });
      }
      used.dropdowns += 1;
      if (preserveParent) {
        if (nestedOpened) await dismissNestedOverlay(cdp, delay);
      } else {
        await closeTransient(cdp, delay);
      }
    }
  }

  async function auditMenus(surface, state, preserveParent = false) {
    const limit = Math.min(perSurface.menus, budget.menus - used.menus);
    const candidates = (state.targets || [])
      .filter(targetItem => {
        const value = `${targetItem.text} ${targetItem.testid} ${targetItem.hasPopup}`;
        return /(?:menu|overflow|more-actions|more-options|options-menu|filter-menu|sort-menu|view-menu)/i.test(value) ||
          /^(?:更多|更多操作|选项|菜单|排序|筛选|视图|More|More actions|Options|Menu|Sort|Filter|View)$/i.test(targetItem.text || "");
      })
      .filter(targetItem => safeInteractive(targetItem))
      .slice(0, limit);
    for (const [index, targetItem] of candidates.entries()) {
      let nestedOpened = false;
      try {
        if (!preserveParent) await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        const openedState = await scan(surface, `menu:${index}:${targetItem.text || targetItem.testid}`, "overlay", true);
        nestedOpened = (openedState.overlays || []).length > (state.overlays || []).length ||
          (openedState.overlays || []).some(item => /menu|listbox/i.test(item.role));
        actions.push({ surface, type: "menu-open", ok: true, target: targetItem });
      } catch (error) {
        errors.push({ surface, type: "menu-open", target: targetItem, error: error.message });
      }
      used.menus += 1;
      if (preserveParent) {
        if (nestedOpened) await dismissNestedOverlay(cdp, delay);
      } else {
        await closeTransient(cdp, delay);
      }
    }
  }

  async function auditContexts(surface, state) {
    const limit = Math.min(perSurface.contexts, budget.contexts - used.contexts);
    const candidates = (state.targets || [])
      .filter(targetItem => /requester-tab|sidebar-panel|sidebar-tab/i.test(`${targetItem.testid} ${targetItem.tabId}`) || targetItem.role === "tab")
      .filter(targetItem => safeInteractive(targetItem, { allowDangerousLabel: true }))
      .slice(0, limit);
    for (const [index, targetItem] of candidates.entries()) {
      try {
        await closeTransient(cdp, delay);
        await click(cdp, targetItem, "right");
        await sleep(delay);
        await scan(surface, `context:${index}:${targetItem.text || targetItem.testid}`, "overlay", true);
        actions.push({ surface, type: "context-open", ok: true, target: targetItem });
      } catch (error) {
        errors.push({ surface, type: "context-open", target: targetItem, error: error.message });
      }
      used.contexts += 1;
      await closeTransient(cdp, delay);
    }
  }

  async function auditSafeDialogs(surface, state) {
    if (budget.menus - used.menus <= 0) return;
    const dialogRe = /^(?:导入|Import|关于|About|详细信息|Details|信息|Info|键盘快捷键|Keyboard shortcuts|管理 Cookie|Manage Cookies|管理证书|Manage Certificates)$/i;
    const candidates = (state.targets || [])
      .filter(targetItem => dialogRe.test(targetItem.text || ""))
      .filter(targetItem => safeInteractive(targetItem, { allowDangerousLabel: /^(?:导入|Import)$/i.test(targetItem.text || "") }))
      .slice(0, Math.min(3, budget.menus - used.menus));
    for (const [index, targetItem] of candidates.entries()) {
      try {
        await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        await scan(surface, `dialog:${index}:${targetItem.text}`, "overlay", true);
        actions.push({ surface, type: "dialog-open", ok: true, target: targetItem });
      } catch (error) {
        errors.push({ surface, type: "dialog-open", target: targetItem, error: error.message });
      }
      used.menus += 1;
      await closeTransient(cdp, delay);
    }
  }

  async function auditSurface(surface, options = {}) {
    if (surfaceCount >= maxSurfaces) return null;
    surfaceCount += 1;
    if (!options.preserveOverlay) await closeTransient(cdp, delay);
    let state = await scan(surface, "baseline", options.scope || "all", true);
    await auditScrolls(surface, state, options.scope || "all");
    state = await evaluate(cdp, scanScript(options.scope || "all"));
    await auditHovers(surface, state);
    state = await evaluate(cdp, scanScript(options.scope || "all"));
    await auditDropdowns(surface, state, Boolean(options.preserveOverlay));
    state = await evaluate(cdp, scanScript(options.scope || "all"));
    await auditMenus(surface, state, Boolean(options.preserveOverlay));
    if (!options.skipContexts) {
      state = await evaluate(cdp, scanScript(options.scope || "all"));
      await auditContexts(surface, state);
    }
    if (!options.skipDialogs) {
      state = await evaluate(cdp, scanScript(options.scope || "all"));
      await auditSafeDialogs(surface, state);
    }
    if (!options.preserveOverlay) await closeTransient(cdp, delay);
    return scan(surface, "final", options.scope || "all", true);
  }

  async function clickSpec(spec, source, scope = "all") {
    await closeTransient(cdp, delay);
    const state = await evaluate(cdp, scanScript(scope));
    const targetItem = pickTarget(state, spec, scope);
    if (!targetItem) {
      actions.push({ type: "navigate", source, name: spec.name, ok: false, reason: "target-not-found" });
      return false;
    }
    try {
      await click(cdp, targetItem);
      await sleep(Math.max(delay, 450));
      actions.push({ type: "navigate", source, name: spec.name, ok: true, target: targetItem });
      return true;
    } catch (error) {
      actions.push({ type: "navigate", source, name: spec.name, ok: false, target: targetItem, error: error.message });
      errors.push({ type: "navigate", source, name: spec.name, target: targetItem, error: error.message });
      return false;
    }
  }

  async function auditRequesterTabs() {
    const tabs = (await evaluate(cdp, requesterTabsScript)).slice(0, maxRequesterTabs);
    for (const tab of tabs) {
      if (surfaceCount >= maxSurfaces) break;
      try {
        await closeTransient(cdp, delay);
        const point = await evaluate(cdp, activateRequesterTabScript(tab.tabId));
        if (!point) throw new Error("requester tab disappeared");
        await click(cdp, point);
        const deadline = Date.now() + Math.max(1600, delay * 5);
        let active = false;
        while (!active && Date.now() < deadline) {
          await sleep(Math.max(90, Math.min(delay, 240)));
          active = await evaluate(cdp, activeRequesterTabScript(tab.tabId));
        }
        if (!active) throw new Error("requester tab did not become active");
        actions.push({ type: "requester-tab", ok: true, tabId: tab.tabId, tabName: point.tabName || tab.tabName });
        await auditSurface(`requester:${point.tabName || tab.tabName || tab.tabId}`);
      } catch (error) {
        actions.push({ type: "requester-tab", ok: false, tabId: tab.tabId, tabName: tab.tabName, error: error.message });
        errors.push({ type: "requester-tab", tabId: tab.tabId, tabName: tab.tabName, error: error.message });
      }
    }
  }

  async function auditHeaderMenuSurfaces() {
    for (const spec of HEADER_MENU_SURFACES) {
      if (surfaceCount >= maxSurfaces) break;
      let menuState = null;
      let targetItem = null;
      for (let attempt = 1; attempt <= 3 && !targetItem; attempt += 1) {
        await closeTransient(cdp, delay);
        const opened = await clickSpec({
          name: "header-navigation-menu",
          patterns: [/^header-nav-menu-button$/i, /^(?:导航菜单|Navigation menu)$/i],
          region: "top", maxY: 70
        }, `header:attempt-${attempt}`, "all");
        if (!opened) continue;
        menuState = await scan("header-navigation-menu", `menu-before:${spec.name}:attempt-${attempt}`, "overlay", true);
        targetItem = pickTarget(menuState, { ...spec, region: "overlay" }, "overlay");
        const hasNavigationMenu = (menuState.overlays || []).some(item => /header-nav|主页|工作区|API 目录|Reports?|Workspaces?/i.test(`${item.testid} ${item.text}`));
        if (hasNavigationMenu && !targetItem) break;
      }
      if (!targetItem) {
        actions.push({ type: "navigate", source: "header-menu", name: spec.name, ok: false, reason: "menu-item-not-found" });
        await closeTransient(cdp, delay);
        continue;
      }
      try {
        await click(cdp, targetItem);
        await sleep(Math.max(delay, 500));
        actions.push({ type: "navigate", source: "header-menu", name: spec.name, ok: true, target: targetItem });
        await auditSurface(`header:${spec.name}`);
      } catch (error) {
        errors.push({ type: "navigate", source: "header-menu", name: spec.name, target: targetItem, error: error.message });
      }
    }
  }

  async function auditSettings() {
    if (surfaceCount >= maxSurfaces) return;
    await closeTransient(cdp, delay);
    const opened = await clickSpec({
      name: "settings-button",
      patterns: [/^settings-button$/i, /^(?:设置|Settings)$/i],
      region: "top", minX: 900, maxY: 70
    }, "settings", "all");
    if (!opened) return;

    let overlay = await scan("settings-menu", "opened", "overlay", true);
    let dialogVisible = overlay.overlays.some(item => /dialog/i.test(item.role) || /modal/i.test(item.testid));
    if (!dialogVisible) {
      const appSettings = pickTarget(overlay, {
        name: "app-settings",
        patterns: [/^(?:应用设置|App Settings|Preferences|设置|Settings)$/i],
        region: "overlay"
      }, "overlay");
      if (!appSettings) {
        actions.push({ type: "settings", ok: false, reason: "app-settings-entry-not-found" });
        await closeTransient(cdp, delay);
        return;
      }
      await click(cdp, appSettings);
      await sleep(Math.max(delay, 650));
      actions.push({ type: "settings", ok: true, target: appSettings });
      overlay = await scan("settings-dialog", "initial", "overlay", true);
      dialogVisible = true;
    }

    if (!dialogVisible) return;
    const tabItems = (await evaluate(cdp, settingsTabsScript)).slice(0, 24);
    actions.push({ type: "settings-tab-inventory", ok: tabItems.length > 0, labels: tabItems.map(item => item.label) });

    for (const [index, item] of tabItems.entries()) {
      if (surfaceCount >= maxSurfaces) break;
      const label = item.label;
      const currentItems = await evaluate(cdp, settingsTabsScript);
      const targetItem = currentItems.find(candidate => candidate.label.toLowerCase() === label.toLowerCase());
      if (!targetItem) {
        errors.push({ type: "settings-tab", label, error: "tab-not-found" });
        continue;
      }
      try {
        await click(cdp, targetItem);
        await sleep(Math.max(delay, 420));
        actions.push({ type: "settings-tab", ok: true, label, target: targetItem });
        await auditSurface(`settings:${label}`, {
          scope: "overlay",
          preserveOverlay: true,
          skipContexts: true,
          skipDialogs: true
        });
      } catch (error) {
        errors.push({ type: "settings-tab", label, target: targetItem, error: error.message });
      }
    }
    await closeTransient(cdp, delay);
  }

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Accessibility.enable");
    await closeTransient(cdp, delay);
    await auditSurface("initial");

    if (!flag("--baseline-only")) {
      if (!flag("--skip-requester-tabs")) await auditRequesterTabs();

      if (!flag("--skip-sidebar")) {
        for (const spec of SIDEBAR_SURFACES) {
          if (surfaceCount >= maxSurfaces) break;
          if (await clickSpec(spec, "sidebar")) await auditSurface(spec.name);
        }
      }

      if (!flag("--skip-workspace")) {
        for (const spec of WORKSPACE_SURFACES) {
          if (surfaceCount >= maxSurfaces) break;
          if (await clickSpec(spec, "workspace")) await auditSurface(spec.name);
        }
      }

      if (!flag("--skip-header")) await auditHeaderMenuSurfaces();

      // Once catalog/workspace pages are open, these safe inner-page links may
      // expose Apps, API, Performance and Runner surfaces not present initially.
      if (!flag("--skip-deep")) {
        for (const spec of DEEP_PAGE_SURFACES) {
          if (surfaceCount >= maxSurfaces) break;
          if (await clickSpec(spec, "deep-page")) await auditSurface(spec.name);
        }
      }

      if (!flag("--skip-settings")) await auditSettings();
    }

    await closeTransient(cdp, delay);
    await scan("final", "final", "all", true);

    if (flag("--screenshot")) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const screenshot = out.replace(/\.json$/i, "") + ".png";
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
      actions.push({ type: "screenshot", ok: true, path: screenshot });
    }
  } finally {
    cdp.close();
  }

  const findings = [...merged.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const report = {
    generatedAt: new Date().toISOString(),
    target: { id: target.id, title: target.title, url: target.url },
    options: { delay, maxRequesterTabs, maxSurfaces, perSurface, budget },
    usage: used,
    summary: {
      surfaces: surfaceCount,
      snapshots: snapshots.length,
      actions: actions.length,
      successfulActions: actions.filter(item => item.ok).length,
      findings: findings.length,
      errors: errors.length
    },
    findings,
    actions,
    snapshots,
    errors
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    out,
    summary: report.summary,
    usage: used,
    top: findings.slice(0, 60).map(item => item.text)
  }, null, 2));
}

if (flag("--self-test")) {
  for (const [name, expression] of [
    ["scan-all", scanScript("all")],
    ["scan-overlay", scanScript("overlay")],
    ["scroll", scrollAtPointScript(100, 100, 0.5)],
    ["requester-tabs", requesterTabsScript],
    ["activate-requester-tab", activateRequesterTabScript("TAB_ID")],
    ["active-requester-tab", activeRequesterTabScript("TAB_ID")],
    ["settings-tabs", settingsTabsScript]
  ]) {
    try {
      // Parse only. The generated expressions depend on browser globals and
      // are intentionally not executed by the self-test.
      new Function(`return (${expression});`); // eslint-disable-line no-new-func
    } catch (error) {
      throw new Error(`Generated browser script failed to parse (${name}): ${error.message}`);
    }
  }
  const fakeState = {
    targets: [
      { x: 500, y: 100, rect: { w: 70, h: 24 }, text: "概览", testid: "", role: "tab", region: "content", tag: "BUTTON", disabled: false, href: "" },
      { x: 120, y: 40, rect: { w: 40, h: 24 }, text: "项目", testid: "sidebar-tab-internal-dev-services", role: "tab", region: "top", tag: "BUTTON", disabled: false, href: "" },
      { x: 800, y: 300, rect: { w: 60, h: 24 }, text: "删除", testid: "delete-button", role: "button", region: "content", tag: "BUTTON", disabled: false, href: "" }
    ]
  };
  if (!pickTarget(fakeState, WORKSPACE_SURFACES[0])) throw new Error("Self-test failed: exact text navigation target was not matched.");
  if (!pickTarget(fakeState, SIDEBAR_SURFACES[0])) throw new Error("Self-test failed: sidebar testid navigation target was not matched.");
  if (safeInteractive(fakeState.targets[2])) throw new Error("Self-test failed: destructive control passed the click guard.");
  console.log(JSON.stringify({ ok: true, generatedScripts: 7, navigationGuards: 3 }, null, 2));
} else {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
