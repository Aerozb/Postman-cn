#!/usr/bin/env node
"use strict";

// Read-only localization audit across every attachable Postman CDP target.
// It deliberately treats out-of-process/cross-origin iframes as first-class
// targets instead of relying on the desktop page's same-origin DOM walk.

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const ATTRS = [
  "title", "aria-label", "aria-description", "aria-placeholder", "placeholder",
  "alt", "label", "data-original-title", "data-tippy-content", "data-tooltip",
  "data-tooltip-content", "data-tooltip-title", "data-tooltip-text",
  "data-tooltip-label", "data-aether-tooltip", "data-tab-name", "aria-valuetext",
  "aria-roledescription"
];

const ALLOWED = new Set((
  "API URL URI HTTP HTTPS JSON XML HTML CSS JavaScript OAuth JWT AWS EdgeGrid Akamai " +
  "Hawk HMAC SHA SHA-256 GraphQL gRPC WebSocket Cookie SDK AI Git GitHub Postman CPU P90 P95 P99"
).toLowerCase().split(/\s+/));

function englishFinding(text) {
  const s = norm(text);
  if (!s || s.length > 1600 || !/[A-Za-z]/.test(s)) return false;
  if (/^(?:https?|wss?|file|blob|data):/i.test(s) || /^[\w.-]+@[\w.-]+$/.test(s)) return false;
  if (/^[A-Z0-9_.:/+@#-]{1,32}$/.test(s) && !/\s/.test(s)) return false;
  const words = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).map((x) => x.toLowerCase());
  if (!words.length || words.every((x) => ALLOWED.has(x))) return false;
  const hasChinese = /[\u3400-\u9fff]/.test(s);
  const commonUi = /\b(?:add|back|cancel|close|connect|continue|create|delete|details|disable|done|download|edit|enable|error|export|filter|import|learn|manage|menu|more|next|open|options|remove|rename|retry|save|search|select|settings|share|sign|sort|start|stop|test|update|upload|view|workspace|your|you|this|the|and|from|with)\b/i.test(s);
  return hasChinese ? words.some((x) => !ALLOWED.has(x) && x.length > 1) : words.length >= 2 || commonUi;
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

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket connection timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket connection failed")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message.id || !pending.has(message.id)) return;
    const p = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else p.resolve(message.result || {});
  });
  return {
    send(method, params = {}, sessionId = null, timeout = 45000) {
      const callId = id++;
      ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
        pending.set(callId, { resolve, reject, timer });
      });
    },
    close() { try { ws.close(); } catch (_) {} }
  };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result && result.result.value;
}

const scanExpression = (overlayOnly = false) => String.raw`(() => {
  const ATTRS = ${JSON.stringify(ATTRS)};
  const overlayOnly = ${JSON.stringify(overlayOnly)};
  const norm = s => String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (typeof document === "undefined") return { document: false, entries: [], hovers: [], menus: [] };
  const roots = [], seen = new Set();
  function visit(root, trail) {
    if (!root || seen.has(root)) return;
    seen.add(root); roots.push({ root, trail });
    for (const el of root.querySelectorAll ? root.querySelectorAll("*") : []) {
      if (el.shadowRoot) visit(el.shadowRoot, trail + ">shadow(" + el.tagName.toLowerCase() + ")");
      if (el.tagName === "IFRAME") {
        try { if (el.contentDocument) visit(el.contentDocument, trail + ">iframe(" + (el.src || "inline") + ")"); } catch (_) {}
      }
    }
  }
  visit(document, "document");
  const entries = [], hovers = [], menus = [];
  const overlays = "[role=tooltip],[role=menu],[role=listbox],[role=dialog],[role=alertdialog],[aria-modal=true],[data-testid*=menu],[data-testid*=modal],[id^=tippy]";
  const visible = el => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const s = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0;
  };
  const add = (text, kind, trail, el, attribute) => {
    text = norm(text); if (!text || text.length > 1600) return;
    entries.push({ text, kind, trail, attribute: attribute || null, tag: el && el.tagName ? el.tagName.toLowerCase() : null });
  };
  for (const item of roots) {
    const scope = overlayOnly ? Array.from(item.root.querySelectorAll(overlays)) : [item.root];
    for (const container of scope) {
      const elements = container.nodeType === 1 ? [container, ...container.querySelectorAll("*")] : Array.from(container.querySelectorAll("*"));
      for (const el of elements) {
        if (!visible(el)) continue;
        for (const node of el.childNodes) if (node.nodeType === 3) add(node.nodeValue, "text", item.trail, el);
        for (const attr of ATTRS) if (el.hasAttribute && el.hasAttribute(attr)) add(el.getAttribute(attr), "attr", item.trail, el, attr);
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.value) add(el.value, "input-value", item.trail, el, "value");
        if (!overlayOnly) {
          const r = el.getBoundingClientRect();
          const packed = { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(),
            label: norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent).slice(0, 180) };
          if (el.matches("button,[role=button],[role=tab],[role=img],[title],[aria-label],[data-tooltip],[data-tippy-content]") && r.width <= 500 && r.height <= 180) hovers.push(packed);
          if (el.matches("button[aria-haspopup=menu],button[aria-haspopup=listbox],[role=button][aria-haspopup=menu],[role=button][aria-haspopup=listbox]") && !el.disabled && el.getAttribute("aria-disabled") !== "true") menus.push(packed);
        }
      }
    }
  }
  return { document: true, title: document.title, url: location.href, entries, hovers, menus };
})()`;

function dedupeEntries(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const text = norm(e.text);
    if (!text) continue;
    const key = `${e.kind}\u0000${e.attribute || ""}\u0000${text}`;
    if (!map.has(key)) map.set(key, { ...e, text });
  }
  return [...map.values()];
}

async function axScan(send) {
  try {
    const tree = await send("Accessibility.getFullAXTree", { depth: 60 }, 15000);
    const out = [];
    for (const node of tree.nodes || []) {
      for (const field of ["name", "description", "value", "roleDescription"]) {
        const text = norm(node[field] && node[field].value);
        if (text) out.push({ text, kind: `ax-${field}`, role: node.role && node.role.value || null });
      }
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
  // Workers have no renderable localization surface. Keep them in the report so
  // coverage is explicit, but avoid expensive DOM/AX commands that Chromium may
  // leave unanswered for idle extension workers.
  if (/worker/i.test(target.type || "")) {
    result.workerDisposition = "metadata-only: no renderable localization surface";
    result.durationMs = Date.now() - started;
    result.findings = [];
    return result;
  }
  try { await send("Runtime.enable", {}, 10000); } catch (e) { result.errors.push(`Runtime.enable: ${e.message}`); }
  try { await send("Accessibility.enable"); } catch (e) { result.errors.push(`Accessibility.enable: ${e.message}`); }
  let base;
  try {
    base = await evaluate(send, scanExpression(false));
    result.document = !!(base && base.document);
    result.runtime = base ? { title: base.title || "", url: base.url || "" } : null;
    result.entries.push(...(base && base.entries || []));
  } catch (e) {
    result.errors.push(`DOM scan: ${e.message}`);
  }
  const ax = await axScan(send);
  if (Array.isArray(ax)) result.axEntries = ax;
  else result.errors.push(`AX scan: ${ax.error}`);

  if (result.document && !options.skipInteractions && /^(page|iframe|webview)$/.test(target.type || "")) {
    const hovers = (base.hovers || []).slice(0, options.maxHovers);
    for (const item of hovers) {
      try {
        await move(send, item.x, item.y); await sleep(options.delay);
        const overlay = await evaluate(send, scanExpression(true));
        result.entries.push(...(overlay.entries || []).map((e) => ({ ...e, probe: "hover", opener: item.label })));
        result.interactions.hovers++;
      } catch (e) { result.errors.push(`hover ${item.label || item.tag}: ${e.message}`); }
    }
    try { await move(send, 2, 2); } catch (_) {}
    const menus = (base.menus || []).slice(0, options.maxMenus);
    for (const item of menus) {
      try {
        await leftClick(send, item.x, item.y); await sleep(options.delay);
        const overlay = await evaluate(send, scanExpression(true));
        result.entries.push(...(overlay.entries || []).map((e) => ({ ...e, probe: "menu", opener: item.label })));
        result.interactions.menus++;
      } catch (e) { result.errors.push(`menu ${item.label || item.tag}: ${e.message}`); }
      try { await escape(send); await sleep(Math.min(options.delay, 200)); } catch (_) {}
    }
  }
  result.entries = dedupeEntries(result.entries);
  result.findings = dedupeEntries([...result.entries, ...result.axEntries].filter((e) => englishFinding(e.text)));
  result.durationMs = Date.now() - started;
  return result;
}

async function selfTest() {
  const checks = [
    [norm("  A\u00a0 B "), "A B"],
    [englishFinding("API"), false],
    [englishFinding("Connect your account"), true],
    [englishFinding("连接 your account"), true],
    [targetPriority({ type: "iframe", url: "https://connect.us.integrations.postmancloud.com/ui" }), 0],
    [parseTypes("page,iframe").has("iframe"), true],
    [dedupeEntries([{ text: "A", kind: "text" }, { text: "A", kind: "text" }]).length, 1]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) throw new Error(`self-test failed: ${JSON.stringify(failed)}`);
  process.stdout.write(JSON.stringify({ ok: true, checks: checks.length }, null, 2) + "\n");
}

async function main() {
  if (flag("--self-test")) return selfTest();
  const portFile = value("--port-file", path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort"));
  if (!fs.existsSync(portFile)) throw new Error(`DevToolsActivePort not found: ${portFile}`);
  const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const port = Number(value("--port", lines[0]));
  const browserPath = lines[1];
  const types = parseTypes(value("--types", null));
  const options = {
    skipInteractions: flag("--skip-interactions"),
    maxHovers: Number(value("--max-hovers", 50)),
    maxMenus: Number(value("--max-menus", 20)),
    delay: Number(value("--delay-ms", 250))
  };
  const listed = await json(`http://127.0.0.1:${port}/json/list`);
  const root = await connect(`ws://127.0.0.1:${port}${browserPath}`);
  let infos = [];
  try {
    const all = await root.send("Target.getTargets");
    infos = all.targetInfos || [];
  } catch (_) {}
  const byId = new Map();
  for (const t of [...listed, ...infos]) {
    const id = t.id || t.targetId;
    if (!id) continue;
    const merged = { ...(byId.get(id) || {}), ...t, id, type: t.type || "unknown" };
    byId.set(id, merged);
  }
  const targets = [...byId.values()]
    .filter((t) => types.has(t.type) && t.type !== "browser" && !String(t.url || "").startsWith("devtools://"))
    .sort((a, b) => targetPriority(a) - targetPriority(b) || String(a.url || "").localeCompare(String(b.url || "")));
  const results = [];
  for (const target of targets) {
    let sessionId = null;
    try {
      const attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true });
      sessionId = attached.sessionId;
      const send = (method, params = {}, timeout) => root.send(method, params, sessionId, timeout);
      results.push(await auditTarget(send, {
        id: target.id, type: target.type, title: target.title || "", url: target.url || "",
        parentId: target.parentId || target.openerId || null,
        crossOriginIntegration: /connect\.[^.]*\.integrations\.postmancloud\.com/i.test(target.url || "")
      }, options));
    } catch (error) {
      results.push({ target: { id: target.id, type: target.type, title: target.title || "", url: target.url || "" }, errors: [error.message], findings: [], entries: [], axEntries: [] });
    } finally {
      if (sessionId) try { await root.send("Target.detachFromTarget", { sessionId }, null, 5000); } catch (_) {}
    }
  }
  root.close();
  const findings = [];
  for (const r of results) for (const f of r.findings || []) findings.push({ targetId: r.target.id, targetType: r.target.type, targetUrl: r.target.url, ...f });
  const report = {
    generatedAt: new Date().toISOString(),
    source: { port, portFile, requestedTypes: [...types] },
    options,
    summary: {
      discovered: byId.size, selected: targets.length, audited: results.length,
      documentTargets: results.filter((x) => x.document).length,
      integrationTargets: results.filter((x) => x.target.crossOriginIntegration).length,
      entries: results.reduce((n, x) => n + (x.entries || []).length, 0),
      axEntries: results.reduce((n, x) => n + (x.axEntries || []).length, 0),
      findings: findings.length,
      errors: results.reduce((n, x) => n + (x.errors || []).length, 0)
    },
    targets: results,
    findings
  };
  const out = path.resolve(value("--out", path.join(__dirname, "..", "..", "_generated", "all-cdp-targets-audit.json")));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ out, summary: report.summary }, null, 2) + "\n");
  if (flag("--fail-on-errors") && report.summary.errors) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
