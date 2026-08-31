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
//   * visible text nodes and non-sensitive UI attributes;
//   * Accessibility tree names/descriptions (also useful for closed
//     component internals exposed through Chromium accessibility);
//   * requester tabs, top navigation, sidebar panels, workspace pages,
//     Apps/API/Performance/Runner surfaces and every Settings tab;
//   * scroll positions, hover tooltips, dropdowns, menus, dialogs and safe
//     context menus.
//
// The default profile is intentionally bounded for routine TUI use. Use
// --thorough only for release-time coverage that needs the former high probe
// counts. Both profiles cap returned CDP collections and retained snapshots.

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputPath, writeAuditReport, writeAuditScreenshot } = require("./审计安全.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

function boundedNumberArg(name, fallback, ceiling, minimum = 0) {
  const parsed = Number(arg(name, String(fallback)));
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.floor(Math.max(minimum, Math.min(value, ceiling)));
}

function defaultNavigationAuditOptions(thorough = false) {
  return thorough ? {
    delay: 380,
    auditBudgetMs: 900000,
    maxRequesterTabs: 12,
    maxSurfaces: 30,
    categoryLimits: { sidebar: 8, workspace: 5, header: 8, deep: 5, settings: 12 },
    perSurface: { hovers: 12, menus: 5, dropdowns: 4, contexts: 3, scrolls: 4 },
    budget: {
      hovers: 120, menus: 45, dropdowns: 36, contexts: 24, scrolls: 48,
      scans: 320, inventoryScans: 160, axScans: 48, snapshots: 320,
      mergedFindings: 6000
    },
    scanLimits: {
      hits: 1800, targets: 800, hoverTargets: 800, scrolls: 180,
      overlays: 120, snapshotFindings: 120, elements: 9000,
      textNodes: 1400, attributes: 2200, candidates: 2000, roots: 24,
      maxTextLength: 600, axDepth: 3, axNodes: 800
    }
  } : {
    delay: 320,
    auditBudgetMs: 180000,
    maxRequesterTabs: 3,
    maxSurfaces: 24,
    categoryLimits: { sidebar: 5, workspace: 3, header: 4, deep: 2, settings: 6 },
    perSurface: { hovers: 4, menus: 2, dropdowns: 2, contexts: 1, scrolls: 1 },
    budget: {
      hovers: 48, menus: 18, dropdowns: 14, contexts: 8, scrolls: 10,
      scans: 120, inventoryScans: 60, axScans: 8, snapshots: 120,
      mergedFindings: 1200
    },
    scanLimits: {
      hits: 800, targets: 350, hoverTargets: 350, scrolls: 80,
      overlays: 40, snapshotFindings: 40, elements: 5000,
      textNodes: 800, attributes: 1200, candidates: 900, roots: 16,
      maxTextLength: 600, axDepth: 2, axNodes: 400
    }
  };
}

function createAuditTimeBudget(limitMs, startedAt = Date.now()) {
  return { limitMs, startedAt, deadline: startedAt + limitMs, exhaustedAt: null };
}

function auditTimeAllows(budget, step, reserveMs = 0, now = Date.now()) {
  if (now + reserveMs < budget.deadline) return true;
  if (!budget.exhaustedAt) budget.exhaustedAt = step;
  return false;
}

function isNavigationTimeoutError(error) {
  return /(?:导航审计时间预算已耗尽|CDP 命令执行超时)/.test(String(error && error.message || error));
}

function resolveOutPath(requested, fallback) {
  return resolveAuditOutputPath(requested, fallback);
}

function norm(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function getJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}。`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function connect(wsUrl, deadline = null) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const clearPending = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      if (error) item.reject(error);
    }
    pending.clear();
  };

  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("连接 Postman CDP 超时。")); }, Math.min(10000, remaining));
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      reject(new Error("连接 Postman CDP 失败。"));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || "CDP 返回未知错误。"));
    else item.resolve(message.result);
  });
  ws.addEventListener("close", () => clearPending(new Error("CDP WebSocket 已关闭。")), { once: true });

  return {
    send(method, params = {}, sessionId = null) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const remaining = deadline ? deadline - Date.now() : 15000;
        if (remaining <= 0) {
          reject(new Error(`导航审计时间预算已耗尽：${method}`));
          return;
        }
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          try { ws.close(); } catch (_) {}
          reject(new Error(`CDP 命令执行超时：${method}`));
        }, Math.max(100, Math.min(15000, remaining)));
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      clearPending(new Error("CDP 连接已关闭。"));
      try { ws.close(); } catch (_) {}
    }
  };
}

async function connectTarget(port, browserPath, target, deadline = null) {
  if (browserPath) {
    const root = await connect(`ws://127.0.0.1:${port}${browserPath}`, deadline);
    let attached;
    try {
      attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true });
    } catch (error) {
      // A failed attach happens before the caller owns the session. Close the
      // browser-level socket here or the rejected command can keep Node alive.
      root.close();
      throw error;
    }
    const sessionId = attached && attached.sessionId;
    if (!sessionId) {
      root.close();
      throw new Error("Target.attachToTarget 未返回会话 ID。");
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
  return connect(target.webSocketDebuggerUrl, deadline);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate 执行失败");
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
  "alt", "label", "data-original-title", "data-tippy-content",
  "data-tooltip", "data-tooltip-content", "data-tooltip-title", "data-tooltip-text",
  "data-tooltip-label", "data-aether-tooltip", "data-tab-name",
  "aria-valuetext", "aria-roledescription"
];

const scanScript = (scope = "all", options = {}) => {
  const limits = {
    collectHits: options.collectHits !== false,
    collectInventory: options.collectInventory !== false,
    hits: Math.max(0, Number(options.hits ?? 10000)),
    targets: Math.max(0, Number(options.targets ?? 3000)),
    hoverTargets: Math.max(0, Number(options.hoverTargets ?? 3000)),
    scrolls: Math.max(0, Number(options.scrolls ?? 500)),
    overlays: Math.max(0, Number(options.overlays ?? 300)),
    elements: Math.max(1, Number(options.elements ?? 8000)),
    textNodes: Math.max(0, Number(options.textNodes ?? 1200)),
    attributes: Math.max(0, Number(options.attributes ?? 1800)),
    candidates: Math.max(0, Number(options.candidates ?? 1600)),
    roots: Math.max(1, Number(options.roots ?? 20)),
    maxTextLength: Math.max(32, Number(options.maxTextLength ?? 600))
  };
  return String.raw`(() => {
  const SCOPE = ${JSON.stringify(scope)};
  const ATTRS = ${JSON.stringify(ATTRIBUTES)};
  const LIMITS = ${JSON.stringify(limits)};
  const norm = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const boundedText = value => {
    const raw = String(value == null ? "" : value);
    if (!raw || raw.length > LIMITS.maxTextLength) return "";
    return norm(raw).slice(0, LIMITS.maxTextLength);
  };
  const roots = [];
  const seen = new Set();
  let discoveryElements = 0;
  let processedElements = 0;
  let textNodeCount = 0;
  let attributeCount = 0;
  let candidateCount = 0;
  let truncated = false;

  const SENSITIVE_SELECTOR = [
    "[contenteditable='true']", "pre", "code", ".monaco-editor", ".monaco-editor-container",
    ".CodeMirror", ".CodeMirror-code", "[class*='monaco-']", "[class*='codemirror']",
    "[data-testid*='request-body']", "[data-testid*='response-body']",
    "[data-testid*='request-editor']", "[data-testid*='response-editor']",
    "[data-testid*='request-payload']", "[data-testid*='response-payload']",
    "[data-testid*='request-content']", "[data-testid*='response-content']",
    "[class*='request-body']", "[class*='response-body']",
    "[class*='request-editor']", "[class*='response-editor']",
    "[class*='request-payload']", "[class*='response-payload']",
    "[aria-label*='request body' i]", "[aria-label*='response body' i]",
    "[aria-label*='request payload' i]", "[aria-label*='response payload' i]"
  ].join(",");

  function elementWalker(root) {
    const owner = root && root.ownerDocument || document;
    return owner.createTreeWalker(root, 1);
  }

  function isSensitive(el) {
    let current = el;
    for (let depth = 0; current && depth < LIMITS.roots; depth += 1) {
      if (current.matches && current.closest(SENSITIVE_SELECTOR)) return true;
      const root = current.getRootNode && current.getRootNode();
      current = root && root.host;
    }
    return false;
  }

  function compactElementText(el, maxNodes = 32) {
    if (!el || isSensitive(el)) return "";
    const explicit = boundedText(
      el.getAttribute && (
        el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.getAttribute("placeholder") || el.getAttribute("data-testid")
      )
    );
    if (explicit) return explicit;
    const walker = (el.ownerDocument || document).createTreeWalker(el, 4);
    const parts = [];
    let totalLength = 0;
    let visited = 0;
    let node;
    while ((node = walker.nextNode()) && visited < maxNodes && totalLength <= LIMITS.maxTextLength) {
      visited += 1;
      if (!node.parentElement || isSensitive(node.parentElement)) continue;
      const text = norm(node.nodeValue);
      if (!text) continue;
      totalLength += text.length + 1;
      if (totalLength <= LIMITS.maxTextLength) parts.push(text);
    }
    return boundedText(parts.join(" "));
  }

  function visit(root, trail, offsetX, offsetY, viewportWidth, viewportHeight) {
    if (!root || seen.has(root) || roots.length >= LIMITS.roots || discoveryElements >= LIMITS.elements) {
      truncated = true;
      return;
    }
    seen.add(root);
    roots.push({ root, trail, offsetX, offsetY, viewportWidth, viewportHeight });
    const walker = elementWalker(root);
    let el;
    while ((el = walker.nextNode())) {
      if (++discoveryElements > LIMITS.elements) {
        truncated = true;
        break;
      }
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
    if (!LIMITS.collectHits || hits.length >= LIMITS.hits) return;
    if (kind === "text") {
      if (textNodeCount >= LIMITS.textNodes) {
        truncated = true;
        return;
      }
      textNodeCount += 1;
    } else {
      if (attributeCount >= LIMITS.attributes) {
        truncated = true;
        return;
      }
      attributeCount += 1;
    }
    const text = boundedText(value);
    if (!text) return;
    const rect = el && el.getBoundingClientRect ? packedRect(el, entry) : null;
    hits.push({
      text, kind, attribute: attribute || null, trail: entry.trail,
      tag: el && el.tagName || "", role: el && norm(el.getAttribute("role")) || "",
      testid: el && norm(el.getAttribute("data-testid")) || "", rect
    });
  }

  outerElements: for (const entry of roots) {
    const overlayRoots = [];
    const overlayWalker = elementWalker(entry.root);
    let overlayVisited = 0;
    let overlayElement;
    while ((overlayElement = overlayWalker.nextNode())) {
      if (++overlayVisited > LIMITS.elements) {
        truncated = true;
        break;
      }
      if (overlayElement.matches && overlayElement.matches(overlaySelector) && localVisible(overlayElement, entry)) {
        overlayRoots.push(overlayElement);
        if (overlayRoots.length >= LIMITS.overlays) break;
      }
    }
    for (const overlay of overlayRoots) {
      const rect = packedRect(overlay, entry);
      overlays.push({
        text: compactElementText(overlay),
        role: boundedText(overlay.getAttribute("role")), testid: boundedText(overlay.getAttribute("data-testid")),
        trail: entry.trail, rect
      });
    }
    const insideOverlay = el => overlayRoots.some(root => root === el || root.contains(el));
    const walker = elementWalker(entry.root);
    let el;

    while ((el = walker.nextNode())) {
      if (++processedElements > LIMITS.elements || candidateCount >= LIMITS.candidates) {
        truncated = true;
        break outerElements;
      }
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK)$/.test(el.tagName)) continue;
      if (SCOPE === "overlay" && !insideOverlay(el)) continue;
      if (isSensitive(el)) continue;
      const visible = localVisible(el, entry);
      const rect = visible ? packedRect(el, entry) : null;
      const privateControl = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

      if (visible && !privateControl) {
        for (const node of el.childNodes || []) {
          if (node.nodeType === 3) addHit(node.nodeValue, "text", entry, el);
        }
      }

      for (const attribute of visible ? ATTRS : []) {
        if (attributeCount >= LIMITS.attributes) {
          truncated = true;
          break;
        }
        if (!el.hasAttribute || !el.hasAttribute(attribute)) continue;
        addHit(el.getAttribute(attribute), "attribute", entry, el, attribute);
      }

      if (!visible) continue;
      if (!LIMITS.collectInventory) continue;
      const role = norm(el.getAttribute("role"));
      const testid = norm(el.getAttribute("data-testid"));
      const text = boundedText(
        el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.getAttribute("placeholder") || (privateControl ? "" : compactElementText(el)) || testid
      ) || boundedText(testid);
      const href = boundedText(el.getAttribute("href"));
      const hasPopup = boundedText(el.getAttribute("aria-haspopup"));
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

      if (interactive && targets.length < LIMITS.targets) {
        candidateCount += 1;
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
      if (hoverable && hoverTargets.length < LIMITS.hoverTargets && candidateCount < LIMITS.candidates) {
        candidateCount += 1;
        hoverTargets.push({
          x: rect.cx, y: rect.cy, rect, text, tag: el.tagName, role, testid,
          disabled, region, trail: entry.trail,
          priority: Number(Boolean(el.hasAttribute("title") || el.hasAttribute("aria-label") || /tooltip|info|help/i.test(testid))) * 4 +
            Number(el.matches("button,[role=button],[role=img],svg")) * 2 + Number(disabled)
        });
      }

      if (scrolls.length < LIMITS.scrolls && candidateCount < LIMITS.candidates && el.scrollHeight > el.clientHeight + 24 && rect.h > 45 && rect.w > 70) {
        candidateCount += 1;
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
    truncated,
    hits: unique(hits, item => item.kind + "|" + item.attribute + "|" + item.text + "|" + item.trail),
    targets: unique(targets, item => Math.round(item.x / 2) + ":" + Math.round(item.y / 2) + ":" + item.text),
    hoverTargets: unique(hoverTargets, item => Math.round(item.x / 2) + ":" + Math.round(item.y / 2)),
    scrolls: unique(scrolls, item => Math.round(item.x / 3) + ":" + Math.round(item.y / 3)),
    overlays: unique(overlays, item => item.role + "|" + item.testid + "|" + item.text)
  };
})()`;
};

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
  const tabs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode()) && tabs.length < 64) {
    if (el.hasAttribute('data-tab-id')) tabs.push(el);
  }
  return tabs.map((el, index) => {
    const tabId = el.getAttribute('data-tab-id');
    if (!tabId || seen.has(tabId)) return null;
    seen.add(tabId);
    const raw = String(el.textContent || '');
    return {
      index, tabId,
      tabName: norm(el.getAttribute('data-tab-name') || (raw.length <= 300 ? el.innerText || raw : '')),
      active: el.getAttribute('data-tab-is-active') === 'true'
    };
  }).filter(Boolean);
})()`;

const activateRequesterTabScript = (tabId) => String.raw`(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return null;
  const id = ${JSON.stringify(String(tabId))};
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el = null, candidate, visited = 0;
  while ((candidate = walker.nextNode()) && visited++ < 128) {
    if (candidate.getAttribute('data-tab-id') === id) { el = candidate; break; }
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const raw = String(el.textContent || '');
  return {
    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    tabId: id,
    tabName: String(el.getAttribute('data-tab-name') || (raw.length <= 300 ? el.innerText || raw : '')).trim()
  };
})()`;

const activeRequesterTabScript = (tabId) => String.raw`(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return false;
  const id = ${JSON.stringify(String(tabId))};
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el = null, candidate, visited = 0;
  while ((candidate = walker.nextNode()) && visited++ < 128) {
    if (candidate.getAttribute('data-tab-id') === id) { el = candidate; break; }
  }
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
  const dialogs = [];
  const dialogWalker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let dialogNode, dialogVisited = 0;
  while ((dialogNode = dialogWalker.nextNode()) && dialogVisited++ < 6000 && dialogs.length < 24) {
    if (dialogNode.matches('[role="dialog"],[aria-modal="true"],[data-testid="settings-modal"]') && visible(dialogNode)) dialogs.push(dialogNode);
  }
  const dialog = dialogs.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!dialog) return [];
  const known = [
    "通用", "常规", "主题", "外观", "快捷键", "AI", "数据", "附加组件", "插件", "证书", "代理", "更新", "关于",
    "General", "Themes", "Appearance", "Shortcuts", "AI", "Data", "Add-ons", "Plugins", "Certificates", "Proxy", "Update", "About"
  ];
  const knownSet = new Set(known.map(label => label.toLowerCase()));
  const candidatesByLabel = new Map();
  const candidateWalker = document.createTreeWalker(dialog, NodeFilter.SHOW_ELEMENT);
  let candidate, candidateVisited = 0;
  while ((candidate = candidateWalker.nextNode()) && candidateVisited++ < 4000) {
    if (!visible(candidate)) continue;
    const raw = String(candidate.textContent || '');
    if (!raw || raw.length > 160) continue;
    const label = norm(candidate.innerText || raw);
    const key = label.toLowerCase();
    if (!knownSet.has(key)) continue;
    const list = candidatesByLabel.get(key) || [];
    if (list.length < 16) list.push(candidate);
    candidatesByLabel.set(key, list);
  }
  const result = [];
  for (const label of known) {
    const candidates = candidatesByLabel.get(label.toLowerCase()) || [];
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

const DANGEROUS_RE = /(?:删除|移除|退出|注销|关闭窗口|关闭标签|全部关闭|强制关闭|清空|终止|停止运行|放弃|丢弃|重置|覆盖|卸载|取消订阅|付款|购买|升级|试用|邀请|连接 Git|运行|发送|保存|提交|创建|新建|添加|导入|上传|导出|下载|浏览|选择文件|打开文件|打开文件夹|delete|remove|sign\s*out|log\s*out|quit|exit|close\s*(?:window|tab|all|other)|force\s*close|clear|terminate|stop|discard|reset|overwrite|uninstall|unsubscribe|payment|purchase|upgrade|trial|invite|connect\s+git|run\b|send\b|save\b|submit|create|new\b|add\b|import|upload|export|download|browse|choose\s+files?|select\s+files?|open\s+(?:files?|folders?))/i;
const ALLOWED_EXACT = /^(?:API|APIs|URL|URI|HTTP|HTTPS|JSON|XML|HTML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|P90|P95|P99|CPU|RAM|Postman|JavaScript|TypeScript|OpenAPI|CLI|MCP)$/i;
const ALLOWED_WORDS = new Set([
  "api", "apis", "url", "uri", "http", "https", "json", "xml", "html", "oauth", "jwt", "aws",
  "graphql", "grpc", "websocket", "cookie", "cookies", "sdk", "ai", "git", "github", "get", "post",
  "put", "patch", "delete", "head", "options", "p90", "p95", "p99", "cpu", "ram", "postman",
  "javascript", "typescript", "openapi", "swagger", "cli", "mcp", "ssl", "tls", "csv", "pdf", "npm",
  "uuid", "id", "ids", "kb", "mb", "gb", "ms", "px", "req", "s", "ctrl", "alt", "shift", "tab", "del", "enter", "esc",
  "ci", "cd", "no", "proxy", "markdown", "chrome", "vs", "code", "cursor", "windsurf", "ca", "windows", "win32",
  "ibmplexmono", "courier", "monospace", "twitter", "slack", "teams", "auto", "system", "rbac"
]);

function dangerous(value) {
  return DANGEROUS_RE.test(norm(value));
}

function englishCandidate(value) {
  const text = norm(value);
  if (!text || text.length < 2 || !/[A-Za-z]{2}/.test(text)) return false;
  if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(text)) return false;
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

async function accessibilityFindings(cdp, limits = {}) {
  let enabled = false;
  try {
    await cdp.send("Accessibility.enable");
    enabled = true;
    const depth = Math.max(0, Number(limits.depth ?? 2));
    const maxNodes = Math.max(0, Number(limits.nodes ?? 400));
    const result = await cdp.send("Accessibility.getFullAXTree", { depth });
    const findings = [];
    for (const node of (result.nodes || []).slice(0, maxNodes)) {
      if (node.ignored) continue;
      const role = axValue(node, "role");
      if (/^(?:textbox|searchbox|combobox|spinbutton|slider|code)$/i.test(role)) continue;
      for (const [kind, key] of [["ax-name", "name"], ["ax-description", "description"]]) {
        const text = axValue(node, key);
        if (englishCandidate(text)) findings.push({ text, kind, role });
      }
      for (const property of node.properties || []) {
        if (!["placeholder", "roledescription", "valuetext"].includes(property.name)) continue;
        const text = property.value && typeof property.value.value !== "undefined" ? norm(property.value.value) : "";
        if (englishCandidate(text)) findings.push({ text, kind: `ax-${property.name}`, role });
      }
    }
    return [...new Map(findings.map(item => [`${item.kind}|${item.text}`, item])).values()];
  } catch (error) {
    return [{ text: "", kind: "ax-error", error: error.message }];
  } finally {
    if (enabled) {
      try { await cdp.send("Accessibility.disable"); } catch (_) {}
    }
  }
}

function compactFinding(finding) {
  const result = {};
  for (const key of ["text", "kind", "attribute", "tag", "role"]) {
    if (finding && finding[key] != null) result[key] = finding[key];
  }
  return result;
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
  const out = resolveOutPath(arg("--out", null), "postman-navigation-surfaces.json");
  const thorough = flag("--thorough");
  const defaults = defaultNavigationAuditOptions(thorough);
  const delay = boundedNumberArg("--delay-ms", defaults.delay, 5000, 80);
  const auditBudgetMs = boundedNumberArg(
    "--audit-budget-ms",
    defaults.auditBudgetMs,
    thorough ? 3600000 : defaults.auditBudgetMs,
    5000
  );
  const maxRequesterTabs = boundedNumberArg("--max-requester-tabs", defaults.maxRequesterTabs, defaults.maxRequesterTabs);
  const maxSurfaces = boundedNumberArg("--max-surfaces", defaults.maxSurfaces, defaults.maxSurfaces, 1);
  const categoryLimits = {
    sidebar: boundedNumberArg("--max-sidebar-surfaces", defaults.categoryLimits.sidebar, defaults.categoryLimits.sidebar),
    workspace: boundedNumberArg("--max-workspace-surfaces", defaults.categoryLimits.workspace, defaults.categoryLimits.workspace),
    header: boundedNumberArg("--max-header-surfaces", defaults.categoryLimits.header, defaults.categoryLimits.header),
    deep: boundedNumberArg("--max-deep-surfaces", defaults.categoryLimits.deep, defaults.categoryLimits.deep),
    settings: boundedNumberArg("--max-settings-tabs", defaults.categoryLimits.settings, defaults.categoryLimits.settings)
  };
  const perSurface = {
    hovers: boundedNumberArg("--hovers-per-surface", defaults.perSurface.hovers, defaults.perSurface.hovers),
    menus: boundedNumberArg("--menus-per-surface", defaults.perSurface.menus, defaults.perSurface.menus),
    dropdowns: boundedNumberArg("--dropdowns-per-surface", defaults.perSurface.dropdowns, defaults.perSurface.dropdowns),
    contexts: boundedNumberArg("--contexts-per-surface", defaults.perSurface.contexts, defaults.perSurface.contexts),
    scrolls: boundedNumberArg("--scrolls-per-surface", defaults.perSurface.scrolls, defaults.perSurface.scrolls)
  };
  const budget = {
    hovers: boundedNumberArg("--max-hovers", defaults.budget.hovers, defaults.budget.hovers),
    menus: boundedNumberArg("--max-menus", defaults.budget.menus, defaults.budget.menus),
    dropdowns: boundedNumberArg("--max-dropdowns", defaults.budget.dropdowns, defaults.budget.dropdowns),
    contexts: boundedNumberArg("--max-context", defaults.budget.contexts, defaults.budget.contexts),
    scrolls: boundedNumberArg("--max-scrolls", defaults.budget.scrolls, defaults.budget.scrolls),
    scans: defaults.budget.scans,
    inventoryScans: defaults.budget.inventoryScans,
    axScans: defaults.budget.axScans,
    snapshots: defaults.budget.snapshots,
    mergedFindings: defaults.budget.mergedFindings
  };
  const scanLimits = defaults.scanLimits;
  const used = {
    hovers: 0, menus: 0, dropdowns: 0, contexts: 0, scrolls: 0,
    scans: 0, inventoryScans: 0, axScans: 0, skippedScans: 0, skippedSnapshots: 0
  };

  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) throw new Error("未找到 Postman 的 DevToolsActivePort 文件。请先启用远程调试并启动 Postman。");
  const portLines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
  const port = portLines[0].trim();
  const browserPath = norm(portLines[1]);
  const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find(page => page.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(page.url || ""));
  if (!target) throw new Error("未找到 Postman 页面调试目标。");

  const timeBudget = createAuditTimeBudget(auditBudgetMs);
  const cdp = await connectTarget(port, browserPath, target, timeBudget.deadline);
  const snapshots = [];
  const actions = [];
  const errors = [];
  const merged = new Map();
  let surfaceCount = 0;

  const emptyState = () => ({
    url: "", title: "", rootCount: 0, hits: [], targets: [],
    hoverTargets: [], scrolls: [], overlays: []
  });
  const hasScanBudget = (required = 1) => auditTimeAllows(timeBudget, "scan", 1000) && used.scans + required <= budget.scans;
  const canAuditSurface = () => surfaceCount < maxSurfaces && hasScanBudget(3);

  function recordAction(action) {
    const compact = {};
    for (const key of [
      "name", "label", "type", "surface", "phase", "spec", "reason", "source",
      "ok", "successful", "tabId", "tabName", "ratio", "labels", "path"
    ]) {
      if (action && action[key] !== undefined) compact[key] = action[key];
    }
    actions.push(compact);
  }

  function recordError(error) {
    const compact = {};
    for (const key of ["surface", "phase", "type", "source", "name", "label", "tabId", "tabName", "ratio", "error"]) {
      if (error && error[key] !== undefined) compact[key] = error[key];
    }
    errors.push(compact);
  }

  function mergeFindings(surface, phase, findings) {
    for (const finding of findings || []) {
      if (!finding.text) continue;
      const key = `${finding.kind}|${finding.attribute || ""}|${finding.text}`;
      if (!merged.has(key) && merged.size >= budget.mergedFindings) continue;
      const current = merged.get(key) || { ...compactFinding(finding), count: 0, surfaces: [], phases: [] };
      current.count += 1;
      if (!current.surfaces.includes(surface)) current.surfaces.push(surface);
      if (current.phases.length < 30 && !current.phases.includes(phase)) current.phases.push(phase);
      merged.set(key, current);
    }
  }

  async function inventoryState(scope = "all") {
    if (used.inventoryScans >= budget.inventoryScans) return emptyState();
    used.inventoryScans += 1;
    return evaluate(cdp, scanScript(scope, {
      ...scanLimits,
      collectHits: false,
      collectInventory: true
    }));
  }

  async function scan(surface, phase, scope = "all", options = {}) {
    if (!hasScanBudget()) {
      used.skippedScans += 1;
      return emptyState();
    }
    used.scans += 1;
    const state = await evaluate(cdp, scanScript(scope, {
      ...scanLimits,
      collectHits: true,
      collectInventory: Boolean(options.inventory)
    }));
    const domFindings = (state.hits || []).filter(item => englishCandidate(item.text)).map(compactFinding);
    const collectAx = Boolean(options.withAx) && used.axScans < budget.axScans &&
      (thorough || phase === "baseline" || (surface === "final" && phase === "final"));
    const axFindings = collectAx ? await accessibilityFindings(cdp, {
      depth: scanLimits.axDepth,
      nodes: scanLimits.axNodes
    }) : [];
    if (collectAx) used.axScans += 1;
    const validAxFindings = axFindings.filter(item => item.text).map(compactFinding);
    mergeFindings(surface, phase, domFindings);
    mergeFindings(surface, phase, validAxFindings);
    if (snapshots.length < budget.snapshots) {
      snapshots.push({
        surface, phase, scope,
        rootCount: state.rootCount,
        hitCount: (state.hits || []).length,
        findingCount: domFindings.length + validAxFindings.length,
        findings: [...domFindings, ...validAxFindings].slice(0, scanLimits.snapshotFindings),
        overlayCount: (state.overlays || []).length,
        targetCount: (state.targets || []).length,
        hoverTargetCount: (state.hoverTargets || []).length,
        scrollCount: (state.scrolls || []).length
      });
    } else {
      used.skippedSnapshots += 1;
    }
    const axError = axFindings.find(item => item.error);
    if (axError) recordError({ surface, phase, type: "accessibility", error: axError.error });
    state.hits = [];
    return state;
  }

  async function auditScrolls(surface, state, scope) {
    const limit = Math.min(perSurface.scrolls, budget.scrolls - used.scrolls);
    for (const [index, item] of (state.scrolls || []).slice(0, limit).entries()) {
      if (!hasScanBudget(5)) break;
      for (const ratio of [0, 0.5, 1]) {
        try {
          const result = await evaluate(cdp, scrollAtPointScript(item.x, item.y, ratio));
          await sleep(Math.max(100, Math.floor(delay / 2)));
          await scan(surface, `scroll:${index}:${ratio}`, scope, { withAx: ratio === 1 });
          recordAction({ surface, type: "scroll", ok: Boolean(result && result.ok), ratio });
        } catch (error) {
          recordError({ surface, type: "scroll", ratio, error: error.message });
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
      if (!hasScanBudget(3)) break;
      try {
        await mouse(cdp, "mouseMoved", targetItem.x, targetItem.y);
        await sleep(Math.max(delay, 320));
        await scan(surface, `hover:${index}:${targetItem.text || targetItem.testid}`, "overlay");
        recordAction({ surface, type: "hover", ok: true });
      } catch (error) {
        recordError({ surface, type: "hover", error: error.message });
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
      if (!hasScanBudget(3)) break;
      let nestedOpened = false;
      try {
        if (!preserveParent) await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        const openedState = await scan(surface, `dropdown:${index}:${targetItem.text || targetItem.testid}`, "overlay", { withAx: true });
        nestedOpened = (openedState.overlays || []).length > (state.overlays || []).length ||
          (openedState.overlays || []).some(item => /menu|listbox/i.test(item.role));
        recordAction({ surface, type: "dropdown-open", ok: true });
      } catch (error) {
        recordError({ surface, type: "dropdown-open", error: error.message });
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
      if (!hasScanBudget(3)) break;
      let nestedOpened = false;
      try {
        if (!preserveParent) await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        const openedState = await scan(surface, `menu:${index}:${targetItem.text || targetItem.testid}`, "overlay", { withAx: true });
        nestedOpened = (openedState.overlays || []).length > (state.overlays || []).length ||
          (openedState.overlays || []).some(item => /menu|listbox/i.test(item.role));
        recordAction({ surface, type: "menu-open", ok: true });
      } catch (error) {
        recordError({ surface, type: "menu-open", error: error.message });
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
      if (!hasScanBudget(3)) break;
      try {
        await closeTransient(cdp, delay);
        await click(cdp, targetItem, "right");
        await sleep(delay);
        await scan(surface, `context:${index}:${targetItem.text || targetItem.testid}`, "overlay", { withAx: true });
        recordAction({ surface, type: "context-open", ok: true });
      } catch (error) {
        recordError({ surface, type: "context-open", error: error.message });
      }
      used.contexts += 1;
      await closeTransient(cdp, delay);
    }
  }

  async function auditSafeDialogs(surface, state) {
    if (budget.menus - used.menus <= 0) return;
    const dialogRe = /^(?:关于|About|详细信息|Details|信息|Info|键盘快捷键|Keyboard shortcuts|管理 Cookie|Manage Cookies|管理证书|Manage Certificates)$/i;
    const candidates = (state.targets || [])
      .filter(targetItem => dialogRe.test(targetItem.text || ""))
      .filter(targetItem => safeInteractive(targetItem))
      .slice(0, Math.min(3, budget.menus - used.menus));
    for (const [index, targetItem] of candidates.entries()) {
      if (!hasScanBudget(3)) break;
      try {
        await closeTransient(cdp, delay);
        await click(cdp, targetItem);
        await sleep(delay);
        await scan(surface, `dialog:${index}:${targetItem.text}`, "overlay", { withAx: true });
        recordAction({ surface, type: "dialog-open", ok: true });
      } catch (error) {
        recordError({ surface, type: "dialog-open", error: error.message });
      }
      used.menus += 1;
      await closeTransient(cdp, delay);
    }
  }

  async function auditSurface(surface, options = {}) {
    if (!canAuditSurface()) return null;
    surfaceCount += 1;
    if (!options.preserveOverlay) await closeTransient(cdp, delay);
    let state = await scan(surface, "baseline", options.scope || "all", { withAx: true, inventory: true });
    const scrollsBefore = used.scrolls;
    await auditScrolls(surface, state, options.scope || "all");
    if (used.scrolls > scrollsBefore) state = await inventoryState(options.scope || "all");
    await auditHovers(surface, state);
    await auditDropdowns(surface, state, Boolean(options.preserveOverlay));
    await auditMenus(surface, state, Boolean(options.preserveOverlay));
    if (!options.skipContexts) {
      await auditContexts(surface, state);
    }
    if (!options.skipDialogs) {
      await auditSafeDialogs(surface, state);
    }
    if (!options.preserveOverlay) await closeTransient(cdp, delay);
    return scan(surface, "final", options.scope || "all", { withAx: true });
  }

  async function clickSpec(spec, source, scope = "all") {
    await closeTransient(cdp, delay);
    const state = await inventoryState(scope);
    const targetItem = pickTarget(state, spec, scope);
    if (!targetItem) {
      recordAction({ type: "navigate", source, name: spec.name, ok: false, reason: "target-not-found" });
      return false;
    }
    try {
      await click(cdp, targetItem);
      await sleep(Math.max(delay, 450));
      recordAction({ type: "navigate", source, name: spec.name, ok: true });
      return true;
    } catch (error) {
      recordAction({ type: "navigate", source, name: spec.name, ok: false });
      recordError({ type: "navigate", source, name: spec.name, error: error.message });
      return false;
    }
  }

  async function auditRequesterTabs() {
    const tabs = (await evaluate(cdp, requesterTabsScript)).slice(0, maxRequesterTabs);
    for (const tab of tabs) {
      if (!canAuditSurface()) break;
      try {
        await closeTransient(cdp, delay);
        const point = await evaluate(cdp, activateRequesterTabScript(tab.tabId));
        if (!point) throw new Error("请求编辑器标签页已消失");
        await click(cdp, point);
        const deadline = Date.now() + Math.max(1600, delay * 5);
        let active = false;
        while (!active && Date.now() < deadline) {
          await sleep(Math.max(90, Math.min(delay, 240)));
          active = await evaluate(cdp, activeRequesterTabScript(tab.tabId));
        }
        if (!active) throw new Error("请求编辑器标签页未能激活");
        recordAction({ type: "requester-tab", ok: true, tabId: tab.tabId, tabName: point.tabName || tab.tabName });
        await auditSurface(`requester:${point.tabName || tab.tabName || tab.tabId}`);
      } catch (error) {
        recordAction({ type: "requester-tab", ok: false, tabId: tab.tabId, tabName: tab.tabName });
        recordError({ type: "requester-tab", tabId: tab.tabId, tabName: tab.tabName, error: error.message });
      }
    }
  }

  async function auditHeaderMenuSurfaces() {
    for (const spec of HEADER_MENU_SURFACES.slice(0, categoryLimits.header)) {
      if (!canAuditSurface() || !hasScanBudget(4)) break;
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
        menuState = await scan("header-navigation-menu", `menu-before:${spec.name}:attempt-${attempt}`, "overlay", { withAx: true, inventory: true });
        targetItem = pickTarget(menuState, { ...spec, region: "overlay" }, "overlay");
        const hasNavigationMenu = (menuState.overlays || []).some(item => /header-nav|主页|工作区|API 目录|Reports?|Workspaces?/i.test(`${item.testid} ${item.text}`));
        if (hasNavigationMenu && !targetItem) break;
      }
      if (!targetItem) {
        recordAction({ type: "navigate", source: "header-menu", name: spec.name, ok: false, reason: "menu-item-not-found" });
        await closeTransient(cdp, delay);
        continue;
      }
      try {
        await click(cdp, targetItem);
        await sleep(Math.max(delay, 500));
        recordAction({ type: "navigate", source: "header-menu", name: spec.name, ok: true });
        await auditSurface(`header:${spec.name}`);
      } catch (error) {
        recordError({ type: "navigate", source: "header-menu", name: spec.name, error: error.message });
      }
    }
  }

  async function auditSettings() {
    if (!canAuditSurface() || !hasScanBudget(5)) return;
    await closeTransient(cdp, delay);
    const opened = await clickSpec({
      name: "settings-button",
      patterns: [/^settings-button$/i, /^(?:设置|Settings)$/i],
      region: "top", minX: 900, maxY: 70
    }, "settings", "all");
    if (!opened) return;

    let overlay = await scan("settings-menu", "opened", "overlay", { withAx: true, inventory: true });
    let dialogVisible = overlay.overlays.some(item => /dialog/i.test(item.role) || /modal/i.test(item.testid));
    if (!dialogVisible) {
      const appSettings = pickTarget(overlay, {
        name: "app-settings",
        patterns: [/^(?:应用设置|App Settings|Preferences|设置|Settings)$/i],
        region: "overlay"
      }, "overlay");
      if (!appSettings) {
        recordAction({ type: "settings", ok: false, reason: "app-settings-entry-not-found" });
        await closeTransient(cdp, delay);
        return;
      }
      await click(cdp, appSettings);
      await sleep(Math.max(delay, 650));
      recordAction({ type: "settings", ok: true });
      overlay = await scan("settings-dialog", "initial", "overlay", { withAx: true, inventory: true });
      dialogVisible = true;
    }

    if (!dialogVisible) return;
    const tabItems = (await evaluate(cdp, settingsTabsScript)).slice(0, categoryLimits.settings);
    recordAction({ type: "settings-tab-inventory", ok: tabItems.length > 0, labels: tabItems.map(item => item.label) });

    for (const [index, item] of tabItems.entries()) {
      if (!canAuditSurface()) break;
      const label = item.label;
      const currentItems = await evaluate(cdp, settingsTabsScript);
      const targetItem = currentItems.find(candidate => candidate.label.toLowerCase() === label.toLowerCase());
      if (!targetItem) {
        recordError({ type: "settings-tab", label, error: "tab-not-found" });
        continue;
      }
      try {
        await click(cdp, targetItem);
        await sleep(Math.max(delay, 420));
        recordAction({ type: "settings-tab", ok: true, label });
        await auditSurface(`settings:${label}`, {
          scope: "overlay",
          preserveOverlay: true,
          skipContexts: true,
          skipDialogs: true
        });
      } catch (error) {
        recordError({ type: "settings-tab", label, error: error.message });
      }
    }
    await closeTransient(cdp, delay);
  }

  try {
    try {
      if (flag("--screenshot")) await cdp.send("Page.enable");
      await closeTransient(cdp, delay);
      await auditSurface("initial");

      if (!flag("--baseline-only")) {
        if (!flag("--skip-requester-tabs")) await auditRequesterTabs();

        if (!flag("--skip-sidebar")) {
          for (const spec of SIDEBAR_SURFACES.slice(0, categoryLimits.sidebar)) {
            if (!canAuditSurface()) break;
            if (await clickSpec(spec, "sidebar")) await auditSurface(spec.name);
          }
        }

        if (!flag("--skip-workspace")) {
          for (const spec of WORKSPACE_SURFACES.slice(0, categoryLimits.workspace)) {
            if (!canAuditSurface()) break;
            if (await clickSpec(spec, "workspace")) await auditSurface(spec.name);
          }
        }

        if (!flag("--skip-header")) await auditHeaderMenuSurfaces();

        // Once catalog/workspace pages are open, these safe inner-page links may
        // expose Apps, API, Performance and Runner surfaces not present initially.
        if (!flag("--skip-deep")) {
          for (const spec of DEEP_PAGE_SURFACES.slice(0, categoryLimits.deep)) {
            if (!canAuditSurface()) break;
            if (await clickSpec(spec, "deep-page")) await auditSurface(spec.name);
          }
        }

        if (!flag("--skip-settings")) await auditSettings();
      }

      if (auditTimeAllows(timeBudget, "final-close", delay + 500)) await closeTransient(cdp, delay);
      if (hasScanBudget()) await scan("final", "final", "all", { withAx: true });

      if (flag("--screenshot") && auditTimeAllows(timeBudget, "screenshot", 1500)) {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
        const screenshot = out.replace(/\.json$/i, "") + ".png";
        writeAuditScreenshot(screenshot, shot.data);
        recordAction({ type: "screenshot", ok: true, path: screenshot });
      }
    } catch (error) {
      if (!isNavigationTimeoutError(error)) throw error;
      if (!timeBudget.exhaustedAt) timeBudget.exhaustedAt = "cdp-timeout";
      recordError({ type: "audit-timeout", error: String(error && error.message || error).slice(0, 300) });
    }
  } finally {
    cdp.close();
  }

  const findings = [...merged.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const report = {
    generatedAt: new Date().toISOString(),
    target: { id: target.id, title: target.title, url: target.url },
    complete: !timeBudget.exhaustedAt,
    options: { thorough, delay, auditBudgetMs, maxRequesterTabs, maxSurfaces, categoryLimits, perSurface, budget, scanLimits },
    timeBudget: {
      limitMs: timeBudget.limitMs,
      elapsedMs: Math.max(0, Date.now() - timeBudget.startedAt),
      exhausted: Boolean(timeBudget.exhaustedAt),
      exhaustedAt: timeBudget.exhaustedAt
    },
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
  const written = writeAuditReport(out, report);
  // 计数取脱敏后真正写进报告的那份 summary，否则终端会报出被身份噪声过滤剔掉的误报。
  const reported = written.summary || report.summary;
  const summary = {
    out,
    summary: reported,
    usage: used,
    top: findings.slice(0, 60).map(item => item.text)
  };
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  else if (report.complete) console.log(`导航界面审计完成：覆盖 ${reported.surfaces} 个界面，发现 ${reported.findings} 条候选，报告已写入 _generated/${path.basename(out)}`);
  else console.log(`导航界面审计已达到时间上限，部分报告已写入 _generated/${path.basename(out)}`);
  if (!report.complete) process.exitCode = 2;
}

function selfTest() {
  const leanScan = scanScript("all", {
    collectHits: false,
    collectInventory: true,
    hits: 12,
    targets: 8,
    hoverTargets: 8,
    scrolls: 4,
    overlays: 4
  });
  for (const [name, expression] of [
    ["scan-all", scanScript("all")],
    ["scan-overlay", scanScript("overlay")],
    ["scan-inventory-only", leanScan],
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
      throw new Error(`生成的浏览器脚本解析失败（${name}）：${error.message}`);
    }
  }
  const fakeState = {
    targets: [
      { x: 500, y: 100, rect: { w: 70, h: 24 }, text: "概览", testid: "", role: "tab", region: "content", tag: "BUTTON", disabled: false, href: "" },
      { x: 120, y: 40, rect: { w: 40, h: 24 }, text: "项目", testid: "sidebar-tab-internal-dev-services", role: "tab", region: "top", tag: "BUTTON", disabled: false, href: "" },
      { x: 800, y: 300, rect: { w: 60, h: 24 }, text: "删除", testid: "delete-button", role: "button", region: "content", tag: "BUTTON", disabled: false, href: "" }
    ]
  };
  const balanced = defaultNavigationAuditOptions(false);
  const thorough = defaultNavigationAuditOptions(true);
  const compact = compactFinding({ text: "English", kind: "text", role: "button", rect: { x: 1 }, backendDOMNodeId: 2 });
  const axSource = String(accessibilityFindings);
  const mainSource = String(main);
  const expiredTimeBudget = createAuditTimeBudget(1000, 0);
  const checks = [
    [Boolean(pickTarget(fakeState, WORKSPACE_SURFACES[0])), true],
    [Boolean(pickTarget(fakeState, SIDEBAR_SURFACES[0])), true],
    [safeInteractive(fakeState.targets[2]), false],
    [/\bel\.value\b/.test(scanScript("all")), false],
    [/textbox\|searchbox\|combobox/.test(axSource), true],
    [/Accessibility\.disable/.test(axSource), true],
    [/getFullAXTree", \{ depth \}/.test(axSource), true],
    [/slice\(0, maxNodes\)/.test(axSource), true],
    [resolveOutPath("自检报告", "unused.json"), path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告.json")],
    [balanced.maxSurfaces < thorough.maxSurfaces, true],
    [balanced.auditBudgetMs < thorough.auditBudgetMs, true],
    [balanced.perSurface.hovers < thorough.perSurface.hovers, true],
    [balanced.budget.scans < thorough.budget.scans, true],
    [balanced.budget.axScans < thorough.budget.axScans, true],
    [1 + balanced.maxRequesterTabs + Object.values(balanced.categoryLimits).reduce((sum, value) => sum + value, 0), balanced.maxSurfaces],
    [balanced.categoryLimits.settings > 0, true],
    [thorough.budget.hovers, 120],
    [balanced.budget.mergedFindings < thorough.budget.mergedFindings, true],
    [mainSource.includes("merged.size >= budget.mergedFindings"), true],
    [mainSource.includes('cdp.send("Runtime.enable")'), false],
    [/if \(flag\("--screenshot"\)\) await cdp\.send\("Page\.enable"\)/.test(mainSource), true],
    [auditTimeAllows(expiredTimeBudget, "self-test", 0, 1000), false],
    [expiredTimeBudget.exhaustedAt, "self-test"],
    [isNavigationTimeoutError(new Error("导航审计时间预算已耗尽：Runtime.evaluate")), true],
    [isNavigationTimeoutError(new Error("普通连接错误")), false],
    [mainSource.includes("isNavigationTimeoutError(error)"), true],
    [mainSource.includes("process.exitCode = 2"), true],
    [/"collectHits":false/.test(leanScan), true],
    [/sensitiveRoots\(/.test(leanScan), false],
    [/overlay\.innerText|overlay\.textContent/.test(leanScan), false],
    [Object.prototype.hasOwnProperty.call(compact, "rect"), false],
    [Object.prototype.hasOwnProperty.call(compact, "backendDOMNodeId"), false]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  const summary = { ok: true, generatedScripts: 8, checks: checks.length };
if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  else console.log(`导航界面审计脚本自检通过，共 ${checks.length} 项。`);
}

Promise.resolve().then(() => flag("--self-test") ? selfTest() : main()).catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (flag("--details")) console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
  else console.error("导航界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  process.exitCode = 1;
});
