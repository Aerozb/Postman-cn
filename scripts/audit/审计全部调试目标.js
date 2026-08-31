#!/usr/bin/env node
"use strict";

// Read-only localization audit across every attachable Postman CDP target.
// It deliberately treats out-of-process/cross-origin iframes as first-class
// targets instead of relying on the desktop page's same-origin DOM walk.

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputPath, writeAuditReport } = require("./审计安全.js");

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const THOROUGH = flag("--thorough");
const DEFAULT_BUDGET_MS = THOROUGH ? 600000 : 90000;
const MAX_TARGETS = THOROUGH ? 80 : 20;
const MAX_ROOTS = THOROUGH ? 24 : 12;
const MAX_ELEMENTS = THOROUGH ? 12000 : 6000;
const MAX_ENTRIES = THOROUGH ? 1800 : 700;
const MAX_AX_NODES = THOROUGH ? 1800 : 700;
const MAX_AX_ENTRIES = THOROUGH ? 600 : 220;
const MAX_HOVERS = THOROUGH ? 120 : 12;
const MAX_MENUS = THOROUGH ? 50 : 6;

function integerArg(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = value(name, String(fallback));
  const number = Number(raw);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return number;
}

function budgetAllows(budget, step, reserveMs = 0) {
  if (Date.now() + reserveMs < budget.deadline) return true;
  budget.exhaustedAt ||= step;
  return false;
}

function budgetError(step) {
  const error = new Error(`审计时间预算已耗尽：${step}`);
  error.code = "AUDIT_BUDGET";
  return error;
}

function resolveOutPath(requested, fallback) {
  return resolveAuditOutputPath(requested, fallback);
}

const ATTRS = [
  "title", "aria-label", "aria-description", "aria-placeholder", "placeholder",
  "alt", "label", "data-original-title", "data-tippy-content", "data-tooltip",
  "data-tooltip-content", "data-tooltip-title", "data-tooltip-text",
  "data-tooltip-label", "data-aether-tooltip", "data-tab-name", "aria-valuetext",
  "aria-roledescription"
];

const ALLOWED = new Set((
  "API URL URI HTTP HTTPS JSON XML HTML CSS JavaScript OAuth JWT AWS EdgeGrid Akamai " +
  "Hawk HMAC SHA SHA-256 GraphQL gRPC WebSocket Cookie SDK AI Git GitHub Postman CPU P90 P95 P99 RBAC"
).toLowerCase().split(/\s+/));

function englishFinding(text) {
  const s = norm(text);
  if (!s || s.length > 1600 || !/[A-Za-z]/.test(s)) return false;
  if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(s)) return false;
  if (/^(?:https?|wss?|file|blob|data):/i.test(s) || /^[\w.-]+@[\w.-]+$/.test(s)) return false;
  if (/^[A-Z0-9_.:/+@#-]{1,32}$/.test(s) && !/\s/.test(s)) return false;
  const words = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).map((x) => x.toLowerCase());
  if (!words.length || words.every((x) => ALLOWED.has(x))) return false;
  const hasChinese = /[\u3400-\u9fff]/.test(s);
  const commonUi = /\b(?:add|back|cancel|close|connect|continue|create|delete|details|disable|done|download|edit|enable|error|export|filter|import|learn|manage|menu|more|next|open|options|remove|rename|retry|save|search|select|settings|share|sign|sort|start|stop|test|update|upload|view|workspace|your|you|this|the|and|from|with)\b/i.test(s);
  return hasChinese ? words.some((x) => !ALLOWED.has(x) && x.length > 1) : words.length >= 2 || commonUi;
}

function unsafeInteractionLabel(value) {
  const text = norm(value);
  return /^(?:Import|Upload|导入|上传)$/i.test(text) ||
    /\b(?:Browse|Choose Files?|Select Files?|Upload Files?|Open Files?|Open Folders?|Import Files?)\b|浏览|选择文件|上传文件|打开文件|打开文件夹/i.test(text);
}

function targetPriority(t) {
  const u = String(t.url || "");
  if (/connect\.[^.]*\.integrations\.postmancloud\.com/i.test(u)) return 0;
  if (t.type === "iframe" || t.type === "webview") return 1;
  if (t.type === "page") return 2;
  if (/worker/i.test(t.type || "")) return 3;
  return 4;
}

function parseTypes(raw) {
  return new Set(String(raw || "page,iframe,webview,worker,service_worker,shared_worker")
    .split(",").map((x) => x.trim()).filter(Boolean));
}

async function json(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function connect(wsUrl, deadline = null) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 1;
  const clearPending = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      if (error) item.reject(error);
    }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("连接 CDP WebSocket 超时。"));
    }, Math.min(10000, remaining));
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(new Error("连接 CDP WebSocket 失败。")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message.id || !pending.has(message.id)) return;
    const p = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message || "CDP 返回未知错误。"));
    else p.resolve(message.result || {});
  });
  ws.addEventListener("close", () => clearPending(new Error("CDP WebSocket 已关闭。")), { once: true });
  return {
    send(method, params = {}, sessionId = null, timeout = 15000) {
      const callId = id++;
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("CDP WebSocket 未连接。")); return; }
        const remaining = deadline ? deadline - Date.now() : timeout;
        if (remaining <= 0) { reject(budgetError(method)); return; }
        const commandTimeout = Math.max(100, Math.min(timeout, remaining));
        const timer = setTimeout(() => {
          if (!pending.has(callId)) return;
          pending.delete(callId);
          try { ws.close(); } catch (_) {}
          reject(new Error(`CDP 命令执行超时：${method}`));
        }, commandTimeout);
        pending.set(callId, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer); pending.delete(callId); reject(error);
        }
      });
    },
    close() {
      clearPending(new Error("CDP 连接已关闭。"));
      try { ws.close(); } catch (_) {}
    }
  };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate 执行失败");
  return result.result && result.result.value;
}

const scanExpression = (overlayOnly = false) => String.raw`(() => {
  const ATTRS = ${JSON.stringify(ATTRS)};
  const onlyOverlay = ${JSON.stringify(overlayOnly)};
  const MAX_ROOTS = ${MAX_ROOTS}, MAX_ELEMENTS = ${MAX_ELEMENTS}, MAX_ENTRIES = ${MAX_ENTRIES};
  const MAX_HOVERS = ${MAX_HOVERS}, MAX_MENUS = ${MAX_MENUS}, MAX_TEXT = 600;
  const PRIVATE = "input,textarea,select,pre,code,[contenteditable='true'],.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,.ProseMirror,[data-testid*='request-body'],[data-testid*='response-body'],[data-testid*='code-editor'],[data-testid*='script-editor']";
  const norm = s => String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (typeof document === "undefined") return { document: false, entries: [], hovers: [], menus: [] };
  const roots = [], queue = [{ root: document, trail: "document" }], seen = new Set([document]);
  let visited = 0;
  const privateElement = el => Boolean(el && el.closest && el.closest(PRIVATE));
  const visible = el => {
    if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect(), view = el.ownerDocument.defaultView || window;
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= view.innerHeight || r.left >= view.innerWidth) return false;
    const s = view.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0;
  };
  const label = el => {
    if (!el || privateElement(el)) return "";
    const explicit = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("data-testid"));
    if (explicit) return explicit.slice(0, 180);
    const doc = el.ownerDocument || document, walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, text = "", count = 0;
    while ((node = walker.nextNode()) && count < 10 && text.length < 220) { count++; const part = norm(node.nodeValue); if (part) text += (text ? " " : "") + part.slice(0, 220 - text.length); }
    return norm(text).slice(0, 180);
  };
  for (let ri = 0; ri < queue.length && ri < MAX_ROOTS; ri++) {
    const item = queue[ri], root = item.root, elements = []; roots.push({ root, trail: item.trail, elements });
    const doc = root.nodeType === 9 ? root : root.ownerDocument, walker = doc && doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    if (root.nodeType === 1) elements.push(root);
    let el;
    while (walker && (el = walker.nextNode()) && visited < MAX_ELEMENTS) {
      visited++; elements.push(el);
      if (el.shadowRoot && !seen.has(el.shadowRoot) && queue.length < MAX_ROOTS) { seen.add(el.shadowRoot); queue.push({ root: el.shadowRoot, trail: item.trail + ">shadow(" + String(el.tagName || "").toLowerCase() + ")" }); }
      if (el.tagName === "IFRAME") try { if (el.contentDocument && !seen.has(el.contentDocument) && queue.length < MAX_ROOTS) { seen.add(el.contentDocument); queue.push({ root: el.contentDocument, trail: item.trail + ">iframe(" + (el.src || "inline") + ")" }); } } catch (_) {}
    }
  }
  const entries = [], hovers = [], menus = [], overlaySelector = "[role=tooltip],[role=menu],[role=listbox],[role=dialog],[role=alertdialog],[aria-modal=true],[data-testid*=menu],[data-testid*=modal],[id^=tippy]";
  const add = (text, kind, trail, el, attribute) => { text = norm(text); if (!text || text.length > MAX_TEXT * 2 || entries.length >= MAX_ENTRIES) return; entries.push({ text: text.slice(0, MAX_TEXT), kind, trail, attribute: attribute || null, tag: el && el.tagName ? el.tagName.toLowerCase() : null }); };
  for (const item of roots) {
    const overlays = item.elements.filter(el => el.matches && el.matches(overlaySelector) && visible(el));
    const inside = el => overlays.some(root => root === el || root.contains(el));
    for (const el of item.elements) {
      if (entries.length >= MAX_ENTRIES || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || (onlyOverlay && !inside(el)) || privateElement(el)) continue;
      const r = el.getBoundingClientRect(); if (!visible(el)) continue;
      for (const node of el.childNodes || []) if (node.nodeType === 3) add(node.nodeValue, "text", item.trail, el);
      for (const attr of ATTRS) if (el.hasAttribute && el.hasAttribute(attr)) add(el.getAttribute(attr), "attr", item.trail, el, attr);
      if (!onlyOverlay) {
        const packed = { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), label: label(el) };
        if (hovers.length < MAX_HOVERS && el.matches("button,[role=button],[role=tab],[role=img],[title],[aria-label],[data-tooltip],[data-tippy-content]") && r.width <= 500 && r.height <= 180) hovers.push(packed);
        if (menus.length < MAX_MENUS && el.matches("button[aria-haspopup=menu],button[aria-haspopup=listbox],[role=button][aria-haspopup=menu],[role=button][aria-haspopup=listbox]") && !el.disabled && el.getAttribute("aria-disabled") !== "true") menus.push(packed);
      }
    }
  }
  return { document: true, title: document.title, url: location.href, rootCount: roots.length, elementCount: visited, truncated: visited >= MAX_ELEMENTS || queue.length >= MAX_ROOTS, entries, hovers, menus };
})()`;

function dedupeEntries(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const text = norm(e.text);
    if (!text) continue;
    const key = `${e.kind}\u0000${e.attribute || ""}\u0000${text}`;
    if (!map.has(key) && map.size < MAX_ENTRIES) map.set(key, { ...e, text: text.slice(0, 600) });
  }
  return [...map.values()];
}

async function axScan(send) {
  try {
    const tree = await send("Accessibility.getFullAXTree", { depth: THOROUGH ? 18 : 12 }, THOROUGH ? 20000 : 10000);
    const out = [];
    for (const node of (tree.nodes || []).slice(0, MAX_AX_NODES)) {
      const role = norm(node.role && node.role.value);
      if (/^(?:textbox|searchbox|combobox|spinbutton|slider)$/i.test(role)) continue;
      for (const field of ["name", "description", "roleDescription"]) {
        const text = norm(node[field] && node[field].value);
        if (text && out.length < MAX_AX_ENTRIES) out.push({ text: text.slice(0, 600), kind: `ax-${field}`, role: role || null });
      }
      if (out.length >= MAX_AX_ENTRIES) break;
    }
    return dedupeEntries(out);
  } catch (error) {
    return { error: error.message, entries: [] };
  }
}

async function move(send, x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
}

async function leftClick(send, x, y) {
  await move(send, x, y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function escape(send) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

async function auditTarget(send, target, options) {
  const started = Date.now();
  const result = { target, document: false, entries: [], axEntries: [], interactions: { hovers: 0, menus: 0 }, errors: [] };
  const budget = options.budget;
  const usage = options.usage;
  const exhausted = (step) => {
    budget.exhaustedAt ||= step;
    result.complete = false;
    return true;
  };
  const noteError = (prefix, error) => {
    result.errors.push(`${prefix}: ${error.message}`);
    if (error.code === "AUDIT_BUDGET" || /(?:CDP 命令执行超时|CDP WebSocket)/.test(error.message || "")) exhausted(`${target.id}:${prefix}`);
  };
  // Workers have no renderable localization surface. Keep them in the report so
  // coverage is explicit, but avoid expensive DOM/AX commands that Chromium may
  // leave unanswered for idle extension workers.
  if (/worker/i.test(target.type || "")) {
    result.workerDisposition = "metadata-only: no renderable localization surface";
    result.durationMs = Date.now() - started;
    result.findings = [];
    return result;
  }
  if (!budgetAllows(budget, `target:${target.id}:start`, 750)) {
    exhausted(`target:${target.id}:start`);
    result.durationMs = Date.now() - started;
    result.findings = [];
    return result;
  }
  if (!options.skipAx && usage.axScans < options.maxAxScans) {
    try { await send("Accessibility.enable", {}, null, 8000); } catch (e) { noteError("Accessibility.enable", e); }
  }
  let base;
  try {
    base = await evaluate(send, scanExpression(false));
    result.document = !!(base && base.document);
    result.runtime = base ? { title: base.title || "", url: base.url || "" } : null;
    result.entries.push(...(base && base.entries || []));
  } catch (e) {
    noteError("DOM scan", e);
  }
  if (!options.skipAx && usage.axScans < options.maxAxScans && budgetAllows(budget, `target:${target.id}:ax`, 500)) {
    usage.axScans += 1;
    const ax = await axScan(send);
    if (Array.isArray(ax)) result.axEntries = ax;
    else { result.errors.push(`AX scan: ${ax.error}`); if (/(?:CDP 命令执行超时|CDP WebSocket)/.test(ax.error || "")) exhausted(`${target.id}:ax`); }
  }

  if (result.document && !options.skipInteractions && /^(page|iframe|webview)$/.test(target.type || "")) {
    const hovers = (base && base.hovers || []).slice(0, Math.min(options.maxHovers, Math.max(0, options.maxHoversTotal - usage.hovers)));
    for (const item of hovers) {
      if (!budgetAllows(budget, `target:${target.id}:hover`, options.delay + 500)) { exhausted(`target:${target.id}:hover`); break; }
      try {
        await move(send, item.x, item.y); await sleep(options.delay);
        const overlay = await evaluate(send, scanExpression(true));
        result.entries.push(...(overlay.entries || []).slice(0, MAX_ENTRIES - result.entries.length).map((e) => ({ ...e, probe: "hover", opener: item.label })));
        result.interactions.hovers++;
        usage.hovers++;
      } catch (e) { noteError(`hover ${item.label || item.tag}`, e); if (budget.exhaustedAt) break; }
    }
    try { await move(send, 2, 2); } catch (_) {}
    const menus = (base && base.menus || [])
      .filter((item) => !unsafeInteractionLabel(item.label))
      .slice(0, Math.min(options.maxMenus, Math.max(0, options.maxMenusTotal - usage.menus)));
    for (const item of menus) {
      if (!budgetAllows(budget, `target:${target.id}:menu`, options.delay + 500)) { exhausted(`target:${target.id}:menu`); break; }
      try {
        await leftClick(send, item.x, item.y); await sleep(options.delay);
        const overlay = await evaluate(send, scanExpression(true));
        result.entries.push(...(overlay.entries || []).slice(0, MAX_ENTRIES - result.entries.length).map((e) => ({ ...e, probe: "menu", opener: item.label })));
        result.interactions.menus++;
        usage.menus++;
      } catch (e) { noteError(`menu ${item.label || item.tag}`, e); if (budget.exhaustedAt) break; }
      try { await escape(send); await sleep(Math.min(options.delay, 200)); } catch (_) {}
    }
  }
  result.entries = dedupeEntries(result.entries).slice(0, MAX_ENTRIES);
  result.findings = dedupeEntries([...result.entries, ...result.axEntries].filter((e) => englishFinding(e.text)));
  result.durationMs = Date.now() - started;
  return result;
}

async function selfTest() {
  const generatedScan = scanExpression(false);
  const checks = [
    [norm("  A\u00a0 B "), "A B"],
    [englishFinding("API"), false],
    [englishFinding("Connect your account"), true],
    [englishFinding("连接 your account"), true],
    [unsafeInteractionLabel("Import"), true],
    [unsafeInteractionLabel("打开文件夹"), true],
    [unsafeInteractionLabel("Settings"), false],
    [targetPriority({ type: "iframe", url: "https://connect.us.integrations.postmancloud.com/ui" }), 0],
    [parseTypes("page,iframe").has("iframe"), true],
    [dedupeEntries([{ text: "A", kind: "text" }, { text: "A", kind: "text" }]).length, 1],
    [/\bel\.value\b/.test(generatedScan), false],
    [/\["name", "description", "roleDescription"\]/.test(String(axScan)), true],
    [/textbox\|searchbox\|combobox/.test(String(axScan)), true],
    [/MAX_ELEMENTS/.test(generatedScan), true],
    [/MAX_ENTRIES/.test(generatedScan), true],
    [/depth: THOROUGH \? 18 : 12/.test(String(axScan)), true],
    [/AbortController/.test(String(json)), true],
    [/deadline/.test(String(connect)), true],
    [resolveOutPath("自检报告", "unused.json"), path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告.json")]
  ];
  const failed = checks.map((check, index) => ({ check, index })).filter(({ check: [actual, expected] }) => actual !== expected);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期：${failed.map(({ check: [actual, expected], index }) => `${index}:${String(actual)}≠${String(expected)}`).join("；")}`);
  const summary = { ok: true, checks: checks.length };
  if (flag("--details")) process.stdout.write(JSON.stringify(sanitizeAuditReport(summary), null, 2) + "\n");
  else process.stdout.write(`全部调试目标审计脚本自检通过，共 ${checks.length} 项。\n`);
}

async function main() {
  if (flag("--self-test")) return selfTest();
  const thorough = THOROUGH;
  const auditBudgetMs = integerArg("--audit-budget-ms", DEFAULT_BUDGET_MS, 5000, thorough ? 600000 : DEFAULT_BUDGET_MS);
  const delay = integerArg("--delay-ms", thorough ? 220 : 250, 0, thorough ? 10000 : 3000);
  const options = {
    skipInteractions: flag("--skip-interactions"),
    skipAx: flag("--skip-ax"),
    maxHovers: integerArg("--max-hovers", thorough ? 24 : 4, 0, thorough ? 120 : 24),
    maxMenus: integerArg("--max-menus", thorough ? 12 : 2, 0, thorough ? 50 : 12),
    maxHoversTotal: integerArg("--max-total-hovers", thorough ? 120 : 12, 0, thorough ? 240 : 40),
    maxMenusTotal: integerArg("--max-total-menus", thorough ? 50 : 6, 0, thorough ? 100 : 20),
    maxAxScans: integerArg("--max-ax-scans", thorough ? 40 : 8, 0, thorough ? 100 : 20),
    maxTargets: integerArg("--max-targets", thorough ? 80 : 20, 1, thorough ? 160 : 40),
    delay,
    budget: null,
    usage: { hovers: 0, menus: 0, axScans: 0 }
  };
  const out = resolveOutPath(value("--out", null), "all-cdp-targets-audit.json");
  const budget = { limitMs: auditBudgetMs, startedAt: Date.now(), deadline: Date.now() + auditBudgetMs, exhaustedAt: null };
  options.budget = budget;
  const portFile = value("--port-file", path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort"));
  const results = [];
  const byId = new Map();
  let root = null, port = null, fatalError = null, targets = [], types = parseTypes(value("--types", null));
  try {
    if (!fs.existsSync(portFile)) throw new Error(`未找到 DevToolsActivePort 文件：${portFile}`);
    const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    port = Number(value("--port", lines[0]));
    const browserPath = lines[1];
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DevToolsActivePort 文件中的端口无效。");
    if (!browserPath || !/^\/devtools\/browser\//.test(browserPath)) throw new Error("DevToolsActivePort 文件中的浏览器调试路径无效。");
    const listed = (await json(`http://127.0.0.1:${port}/json/list`, Math.min(5000, auditBudgetMs))).slice(0, 400);
    root = await connect(`ws://127.0.0.1:${port}${browserPath}`, budget.deadline);
    let infos = [];
    try { const all = await root.send("Target.getTargets", {}, null, 10000); infos = (all.targetInfos || []).slice(0, 400); } catch (error) {
      if (error.code === "AUDIT_BUDGET" || /(?:CDP 命令执行超时|CDP WebSocket)/.test(error.message || "")) budget.exhaustedAt ||= "Target.getTargets";
    }
    for (const t of [...listed, ...infos]) {
      const id = t.id || t.targetId; if (!id) continue;
      byId.set(id, { ...(byId.get(id) || {}), ...t, id, type: t.type || "unknown" });
    }
    targets = [...byId.values()]
      .filter((t) => types.has(t.type) && t.type !== "browser" && !String(t.url || "").startsWith("devtools://"))
      .sort((a, b) => targetPriority(a) - targetPriority(b) || String(a.url || "").localeCompare(String(b.url || "")))
      .slice(0, options.maxTargets);
    for (const target of targets) {
      if (!budgetAllows(budget, `target:${target.id}`, 1000)) break;
      let sessionId = null;
      try {
        const attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true }, null, 10000);
        sessionId = attached.sessionId;
        const send = (method, params = {}, timeout) => root.send(method, params, sessionId, timeout || 15000);
        results.push(await auditTarget(send, {
          id: target.id, type: target.type, title: target.title || "", url: target.url || "",
          parentId: target.parentId || target.openerId || null,
          crossOriginIntegration: /connect\.[^.]*\.integrations\.postmancloud\.com/i.test(target.url || "")
        }, options));
      } catch (error) {
        const partial = { target: { id: target.id, type: target.type, title: target.title || "", url: target.url || "" }, errors: [error.message], findings: [], entries: [], axEntries: [], complete: false };
        results.push(partial);
        if (error.code === "AUDIT_BUDGET" || /(?:CDP 命令执行超时|CDP WebSocket)/.test(error.message || "")) { budget.exhaustedAt ||= `target:${target.id}`; break; }
      } finally {
        if (sessionId && root) try { await root.send("Target.detachFromTarget", { sessionId }, null, 5000); } catch (_) {}
      }
    }
  } catch (error) {
    fatalError = error;
    if (error.code === "AUDIT_BUDGET" || /(?:审计时间预算已耗尽|CDP 命令执行超时|CDP WebSocket)/.test(String(error.message || error))) budget.exhaustedAt ||= "fatal";
  } finally { if (root) root.close(); }
  const findings = [];
  for (const r of results) for (const f of r.findings || []) {
    if (findings.length >= (thorough ? 6000 : 1200)) break;
    findings.push({ targetId: r.target.id, targetType: r.target.type, targetUrl: r.target.url, ...f });
  }
  const budgetInfo = { limitMs: budget.limitMs, elapsedMs: Date.now() - budget.startedAt, exhausted: Boolean(budget.exhaustedAt), exhaustedAt: budget.exhaustedAt };
  const complete = !fatalError && !budget.exhaustedAt;
  const report = {
    generatedAt: new Date().toISOString(), complete, budget: budgetInfo,
    source: { port, portFile, requestedTypes: [...types] }, options: { ...options, budget: budgetInfo, usage: options.usage },
    summary: {
      discovered: byId.size, selected: targets.length, audited: results.length,
      documentTargets: results.filter((x) => x.document).length,
      integrationTargets: results.filter((x) => x.target && x.target.crossOriginIntegration).length,
      entries: results.reduce((n, x) => n + (x.entries || []).length, 0),
      axEntries: results.reduce((n, x) => n + (x.axEntries || []).length, 0),
      findings: findings.length, errors: results.reduce((n, x) => n + (x.errors || []).length, 0) + (fatalError ? 1 : 0)
    },
    targets: results, findings
  };
  const written = writeAuditReport(out, report);
  // 计数取脱敏后真正写进报告的那份 summary，否则终端会报出被身份噪声过滤剔掉的误报。
  const reported = written.summary || report.summary;
  const summary = { out, complete, budget: budgetInfo, summary: reported };
  if (flag("--details")) process.stdout.write(JSON.stringify(sanitizeAuditReport(summary), null, 2) + "\n");
  else process.stdout.write(`全部调试目标审计${complete ? "完成" : "已保存部分结果"}：审计 ${reported.audited} 个目标，发现 ${reported.findings} 条候选，报告已写入 _generated/${path.basename(out)}\n`);
  if (!complete) process.exitCode = fatalError && !budget.exhaustedAt ? 1 : 2;
  if (flag("--fail-on-errors") && reported.errors) process.exitCode = 2;
}

main().catch((error) => {
  const message = String(error && error.message || error).replace(/\s+/g, " ").trim();
  if (flag("--details")) console.error(JSON.stringify(sanitizeAuditReport({ ok: false, error: message }), null, 2));
  else console.error("全部调试目标审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  process.exitCode = 1;
});
