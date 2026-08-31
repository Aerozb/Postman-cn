#!/usr/bin/env node
"use strict";

// Phased, state-preserving Postman UI localization audit.
// It recursively scans ordinary DOM, open shadow roots and same-origin frames,
// then probes scroll surfaces, dropdowns, hover tooltips, context menus and dialogs.

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputPath, writeAuditReport } = require("./审计安全.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);
const THOROUGH = flag("--thorough");
const DEFAULT_BUDGET_MS = THOROUGH ? 600000 : 90000;
const MAX_ROOTS = THOROUGH ? 24 : 12;
const MAX_ELEMENTS = THOROUGH ? 12000 : 6000;
const MAX_HITS = THOROUGH ? 1400 : 600;
const MAX_TARGETS = THOROUGH ? 360 : 160;
const MAX_SCROLLS = THOROUGH ? 100 : 24;
const MAX_SNAPSHOTS = THOROUGH ? 240 : 90;

function integerArg(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(arg(name, String(fallback)));
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

async function connect(url, deadline = null) {
  const ws = new WebSocket(url); let id = 1; const pending = new Map();
  const clearPending = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); if (error) item.reject(error); }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("连接 CDP WebSocket 超时。")); }, Math.min(10000, remaining));
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(new Error("连接 CDP WebSocket 失败。")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch (_) { return; } if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  ws.addEventListener("close", () => clearPending(new Error("CDP WebSocket 已关闭。")), { once: true });
  return { send(method, params = {}, timeoutMs = 15000) { const callId = id++; return new Promise((resolve, reject) => { if (ws.readyState !== WebSocket.OPEN) { reject(new Error("CDP WebSocket 未连接。")); return; } const remaining = deadline ? deadline - Date.now() : timeoutMs; if (remaining <= 0) { reject(budgetError(method)); return; } const commandTimeout = Math.max(100, Math.min(timeoutMs, remaining)); const timer = setTimeout(() => { if (!pending.has(callId)) return; pending.delete(callId); try { ws.close(); } catch (_) {} reject(new Error(`CDP 命令执行超时：${method}`)); }, commandTimeout); pending.set(callId, { resolve, reject, timer }); try { ws.send(JSON.stringify({ id: callId, method, params })); } catch (error) { clearTimeout(timer); pending.delete(callId); reject(error); } }); }, close() { clearPending(new Error("CDP 连接已关闭。")); try { ws.close(); } catch (_) {} } };
}

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
    return response.json();
  } finally { clearTimeout(timer); }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Runtime.evaluate 执行失败");
  return r.result.value;
}
async function mouse(cdp, type, x, y, button = "none", clickCount = 0) { await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount }); }
async function click(cdp, p, button = "left") { await mouse(cdp, "mouseMoved", p.x, p.y); await mouse(cdp, "mousePressed", p.x, p.y, button, 1); await mouse(cdp, "mouseReleased", p.x, p.y, button, 1); }
async function esc(cdp) { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); }

// Requester tabs are rendered as draggable divs rather than ARIA tabs.  Keep
// their stable data-tab-id/name values so an all-tabs run can revisit the same
// tab after the horizontal tab strip scrolls.
const requesterTabsScript = `(() => {
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return [];
  const norm = s => String(s || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const seen = new Set();
  const nodes = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let node;
  while ((node = walker.nextNode()) && nodes.length < 120) if (node.matches('[data-tab-id][data-tab-name]')) nodes.push(node);
  return nodes.map((el, index) => {
    const id = el.getAttribute('data-tab-id');
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const r = el.getBoundingClientRect();
    return {
      index,
      tabId: id,
      tabName: norm(el.getAttribute('data-tab-name')).slice(0, 180),
      active: el.getAttribute('data-tab-is-active') === 'true',
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }
    };
  }).filter(Boolean);
})()`;

const requesterTabActivateScript = (tabId) => `(() => {
  const id = ${JSON.stringify(String(tabId))};
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let el = null, node, count = 0;
  while ((node = walker.nextNode()) && count < 120) { count += 1; if (node.matches('[data-tab-id][data-tab-name]') && node.getAttribute('data-tab-id') === id) { el = node; break; } }
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    tabId: id,
    tabName: String(el.getAttribute('data-tab-name') || '').trim().slice(0, 180),
    active: el.getAttribute('data-tab-is-active') === 'true',
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }
  };
})()`;

const requesterTabActiveScript = (tabId) => `(() => {
  const id = ${JSON.stringify(String(tabId))};
  const root = document.querySelector('[data-testid="requester-tabs"]');
  const walker = root && document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let el = null, node, count = 0;
  while (walker && (node = walker.nextNode()) && count < 120) { count += 1; if (node.matches('[data-tab-id][data-tab-name]') && node.getAttribute('data-tab-id') === id) { el = node; break; } }
  return !!(el && (el.getAttribute('data-tab-is-active') === 'true' ||
    el.classList.contains('active') || el.classList.contains('is-active')));
})()`;

// Hovering or opening a destructive control can mutate the user's workspace.
// These controls are intentionally excluded from all-tabs probes.  The filter
// is label-based and applies to both translated and original UI text.
function dangerousControl(text) {
  return /(?:关闭|退出|删除|移除|注销|清除|放弃|终止|停止|销毁|保存|发送|创建|新建|添加|应用|重置|重试|运行|连接|断开连接|发布|提交|确认|确定|重命名|导入|上传|浏览|选择文件|打开文件|打开文件夹|close|exit|delete|remove|quit|discard|terminate|shutdown|sign\s*out|save|send|create|add|apply|reset|retry|run|connect|disconnect|publish|submit|confirm|rename|import|upload|browse|choose\s+files?|select\s+files?|open\s+(?:files?|folders?))/i.test(String(text || ""));
}

const scanScript = (scope = "all") => `(() => {
  const SCOPE=${JSON.stringify(scope)}, ATTRS=["title","aria-label","aria-description","aria-placeholder","placeholder","alt","label","data-original-title","data-tippy-content","data-tooltip","data-tooltip-content","data-tooltip-title","data-tooltip-text","data-tooltip-label","data-aether-tooltip","data-tab-name"];
  const MAX_ROOTS=${MAX_ROOTS},MAX_ELEMENTS=${MAX_ELEMENTS},MAX_HITS=${MAX_HITS},MAX_TARGETS=${MAX_TARGETS},MAX_SCROLLS=${MAX_SCROLLS},MAX_TEXT=600;
  const PRIVATE="input,textarea,select,pre,code,[contenteditable='true'],.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,.ProseMirror,[data-testid*='request-body'],[data-testid*='response-body'],[data-testid*='code-editor'],[data-testid*='script-editor']";
  const norm=s=>String(s||"").replace(/\\u00a0/g," ").replace(/\\s+/g," ").trim(),privateEl=e=>Boolean(e&&e.closest&&e.closest(PRIVATE));
  const visible=el=>{if(!(el instanceof Element))return false;const r=el.getBoundingClientRect(),view=el.ownerDocument.defaultView||window,s=view.getComputedStyle(el);return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.top<view.innerHeight&&r.left<view.innerWidth&&s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0};
  const label=el=>{if(!el||privateEl(el))return"";const explicit=norm(el.getAttribute("aria-label")||el.getAttribute("title")||el.getAttribute("placeholder")||el.getAttribute("data-testid"));if(explicit)return explicit.slice(0,180);const doc=el.ownerDocument||document,walker=doc.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n,text="",count=0;while((n=walker.nextNode())&&count<10&&text.length<220){count++;const p=norm(n.nodeValue);if(p)text+=(text?" ":"")+p.slice(0,220-text.length)}return norm(text).slice(0,180)};
  const roots=[],queue=[{root:document,trail:"document"}],seen=new Set([document]);let visited=0;
  for(let ri=0;ri<queue.length&&ri<MAX_ROOTS;ri++){const item=queue[ri],root=item.root,elements=[];roots.push({root,trail:item.trail,elements});const doc=root.nodeType===9?root:root.ownerDocument,walker=doc&&doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);if(root.nodeType===1)elements.push(root);let el;while(walker&&(el=walker.nextNode())&&visited<MAX_ELEMENTS){visited++;elements.push(el);if(el.shadowRoot&&!seen.has(el.shadowRoot)&&queue.length<MAX_ROOTS){seen.add(el.shadowRoot);queue.push({root:el.shadowRoot,trail:item.trail+">shadow("+String(el.tagName||"").toLowerCase()+")"})}if(el.tagName==="IFRAME")try{if(el.contentDocument&&!seen.has(el.contentDocument)&&queue.length<MAX_ROOTS){seen.add(el.contentDocument);queue.push({root:el.contentDocument,trail:item.trail+">iframe("+(el.src||el.name||"inline")+")"})}}catch(_) {}}}
  const hits=[],targets=[],scrolls=[],overlaySel="[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[role=tooltip],[role=alertdialog],[data-testid*=modal],[data-testid*=popover],[data-testid*=menu],[id^=tippy]";
  const add=(text,kind,trail,el,extra={})=>{text=norm(text);if(!text||text.length>MAX_TEXT*2||hits.length>=MAX_HITS)return;const r=el&&el.getBoundingClientRect?el.getBoundingClientRect():null;hits.push({text:text.slice(0,MAX_TEXT),kind,trail,tag:el&&el.tagName||"",rect:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null,...extra})};
  for(const item of roots){const overlayRoots=item.elements.filter(e=>e.matches&&e.matches(overlaySel)&&visible(e)),inOverlay=e=>overlayRoots.some(o=>o===e||o.contains(e));for(const el of item.elements){if(hits.length>=MAX_HITS||/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)||SCOPE==="overlay"&&!inOverlay(el)||privateEl(el))continue;if(!visible(el))continue;const r=el.getBoundingClientRect(),role=norm(el.getAttribute("role")),style=(el.ownerDocument.defaultView||window).getComputedStyle(el),safeText=label(el);for(const n of el.childNodes||[])if(n.nodeType===3)add(n.nodeValue,"text",item.trail,el);for(const a of ATTRS)if(el.hasAttribute&&el.hasAttribute(a))add(el.getAttribute(a),"attribute",item.trail,el,{attribute:a});if(targets.length<MAX_TARGETS&&(el.matches("button,a,input,textarea,select,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=combobox],[aria-label],[title]")||style.cursor==="pointer"))targets.push({x:r.x+r.width/2,y:r.y+r.height/2,text:safeText,tag:el.tagName,role,trail:item.trail});if(scrolls.length<MAX_SCROLLS&&el.scrollHeight>el.clientHeight+24&&r.height>40&&r.width>60)scrolls.push({x:r.x+r.width/2,y:r.y+r.height/2,max:Math.min(el.scrollHeight-el.clientHeight,200000),text:safeText.slice(0,100),trail:item.trail})}}
  const uniq=(a,key)=>[...new Map(a.map(x=>[key(x),x])).values()];return {rootCount:roots.length,elementCount:visited,truncated:visited>=MAX_ELEMENTS||queue.length>=MAX_ROOTS,hits:uniq(hits,x=>x.kind+"|"+x.attribute+"|"+x.text+"|"+x.trail).slice(0,MAX_HITS),targets:uniq(targets,x=>Math.round(x.x)+":"+Math.round(x.y)).slice(0,MAX_TARGETS),scrolls:uniq(scrolls,x=>Math.round(x.x)+":"+Math.round(x.y)).slice(0,MAX_SCROLLS)};
})()`;

function english(text) {
  const s = String(text || "").trim(); if (!s || !/[A-Za-z]{2}/.test(s)) return false;
  if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(s)) return false;
  const allowed = /^(API|URL|URI|HTTP|HTTPS|JSON|XML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|GET|POST|PUT|PATCH|DELETE|HTML|JavaScript|Postman)$/i;
  return !allowed.test(s) && (/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s) || /^[A-Za-z][A-Za-z '-]{3,}$/.test(s));
}

async function main() {
  const out = resolveOutPath(arg("--out", null), "postman-phased-audit.json");
  const delay = integerArg("--delay-ms", THOROUGH ? 240 : 350, 0, THOROUGH ? 10000 : 3000);
  const auditBudgetMs = integerArg("--audit-budget-ms", DEFAULT_BUDGET_MS, 5000, THOROUGH ? 600000 : DEFAULT_BUDGET_MS);
  const hoverLimit = integerArg("--max-hovers", THOROUGH ? 30 : 4, 0, THOROUGH ? 120 : 24);
  const clickLimit = integerArg("--max-dropdowns", THOROUGH ? 24 : 5, 0, THOROUGH ? 80 : 20);
  const contextLimit = integerArg("--max-context", THOROUGH ? 20 : 3, 0, THOROUGH ? 60 : 16);
  const allTabs = flag("--all-tabs");
  const maxTabs = integerArg("--max-tabs", THOROUGH ? 40 : 6, 0, THOROUGH ? 100 : 20);
  const tabDelay = integerArg("--tab-delay-ms", delay, 0, THOROUGH ? 10000 : 3000);
  const maxScrolls = integerArg("--max-scrolls", THOROUGH ? 30 : 6, 0, THOROUGH ? 100 : 24);
  const maxSnapshots = integerArg("--max-snapshots", MAX_SNAPSHOTS, 1, THOROUGH ? 500 : MAX_SNAPSHOTS);
  const phaseOnly = arg("--phase", "all"); const enabled = (p) => phaseOnly === "all" || phaseOnly.split(",").includes(p);
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  const budget = { limitMs: auditBudgetMs, startedAt: Date.now(), deadline: Date.now() + auditBudgetMs, exhaustedAt: null };
  const snapshots = [], errors = [], auditedTabs = [];
  let target = null, cdp = null, fatalError = null, usage = { scans: 0, scrolls: 0, hovers: 0, dropdowns: 0, contexts: 0 };
  const maxScans = THOROUGH ? 420 : 120;
  const isBudgetFailure = error => error && (error.code === "AUDIT_BUDGET" || /(?:审计时间预算已耗尽|CDP 命令执行超时|CDP WebSocket)/.test(error.message || ""));
  const capture = (phase, error, extra = {}) => { errors.push({ phase, ...extra, error: String(error && error.message || error) }); if (isBudgetFailure(error)) budget.exhaustedAt ||= phase; };
  try {
    if (!fs.existsSync(portFile)) throw new Error("未找到 Postman 的 DevToolsActivePort 文件。请先启动 Postman。");
    const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(port)) throw new Error("DevToolsActivePort 文件中的端口无效。");
    const pages = await getJson(`http://127.0.0.1:${port}/json/list`, Math.min(5000, auditBudgetMs));
    target = pages.find(p => p.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(p.url || ""));
    if (!target) throw new Error("未找到 Postman 页面调试目标");
    cdp = await connect(target.webSocketDebuggerUrl, budget.deadline);
    const snap = async (phase, scope = "all", tab = null) => {
      if (!budgetAllows(budget, phase, delay + 700)) throw budgetError(phase);
      if (usage.scans >= maxScans) throw budgetError("扫描次数上限");
      usage.scans += 1;
      const state = await evaluate(cdp, scanScript(scope));
      if (snapshots.length < maxSnapshots) snapshots.push({ phase, tabId: tab && tab.tabId || null, tabName: tab && tab.tabName || null, rootCount: state.rootCount, elementCount: state.elementCount, truncated: state.truncated, hitCount: state.hits.length, findings: state.hits.filter(x => english(x.text)).slice(0, MAX_HITS), targets: state.targets.length, scrolls: state.scrolls.length });
      return state;
    };
    const safeWait = async ms => { if (!budgetAllows(budget, "等待", ms + 100)) throw budgetError("等待"); await sleep(ms); };
    await esc(cdp); await safeWait(delay);
    if (allTabs) {
      const requesterTabs = (await evaluate(cdp, requesterTabsScript) || []).slice(0, maxTabs);
      for (const tab of requesterTabs) {
        if (!budgetAllows(budget, `tab:${tab.tabId}`, tabDelay + 900)) break;
        try {
          await esc(cdp); const point = await evaluate(cdp, requesterTabActivateScript(tab.tabId));
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("请求编辑器标签页已不可用");
          await click(cdp, point); const waitUntil = Math.min(budget.deadline, Date.now() + Math.max(1000, tabDelay * 4)); let active = false;
          do { await safeWait(Math.max(80, Math.min(250, tabDelay || 80))); active = await evaluate(cdp, requesterTabActiveScript(tab.tabId)); } while (!active && Date.now() < waitUntil);
          if (!active) throw new Error("请求编辑器标签页未能激活");
          if (tabDelay > 0) await safeWait(tabDelay);
          const tabContext = { tabId: tab.tabId, tabName: point.tabName || tab.tabName }; auditedTabs.push({ ...tabContext, active: true });
          let state = await snap("tab:baseline", "all", tabContext);
          if (enabled("hover")) for (const [i, t] of state.targets.filter(t => !dangerousControl(t.text)).slice(0, Math.min(hoverLimit, MAX_TARGETS)).entries()) {
            if (usage.hovers >= (THOROUGH ? 120 : 12) || !budgetAllows(budget, `tab:hover:${i}`, delay + 500)) break;
            try { await mouse(cdp, "mouseMoved", t.x, t.y); await safeWait(delay); await snap(`tab:hover:${i}:${t.text}`, "overlay", tabContext); usage.hovers++; } catch (e) { capture("tab:hover", e, { tabId: tabContext.tabId, target: t }); if (isBudgetFailure(e)) throw e; }
          }
          if (enabled("dropdown")) {
            state = await snap("tab:dropdown-scan", "all", tabContext);
            for (const [i, t] of state.targets.filter(t => !dangerousControl(t.text) && (/combobox|option/i.test(t.role) || /select|dropdown|options|environment|method/i.test(t.text))).slice(0, clickLimit).entries()) {
              if (usage.dropdowns >= (THOROUGH ? 50 : 6) || !budgetAllows(budget, `tab:dropdown:${i}`, delay + 500)) break;
              try { await click(cdp, t); await safeWait(delay); await snap(`tab:dropdown:${i}:${t.text}`, "overlay", tabContext); await esc(cdp); usage.dropdowns++; } catch (e) { capture("tab:dropdown", e, { tabId: tabContext.tabId, target: t }); if (isBudgetFailure(e)) throw e; }
            }
          }
          await snap("tab:final", "all", tabContext);
        } catch (e) { capture("tab", e, { tabId: tab.tabId, tabName: tab.tabName }); if (isBudgetFailure(e)) break; }
      }
    } else {
      let state = await snap("baseline");
      if (enabled("scroll")) {
        const ratios = THOROUGH ? [0, .25, .5, .75, 1] : [0, 1];
        for (const sc of state.scrolls.slice(0, maxScrolls)) for (const ratio of ratios) {
          if (usage.scrolls >= (THOROUGH ? MAX_SCROLLS : Math.min(MAX_SCROLLS, maxScrolls * 2)) || !budgetAllows(budget, `scroll:${sc.text}`, delay + 500)) break;
          await mouse(cdp, "mouseMoved", sc.x, sc.y); await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: sc.x, y: sc.y, deltaX: 0, deltaY: ratio === 0 ? -100000 : 100000 }); usage.scrolls++; await safeWait(Math.max(120, delay / 2)); await snap(`scroll:${sc.text}:${ratio}`);
        }
      }
      state = await snap("post-scroll-scan"); const safeTargets = state.targets.filter(t => !dangerousControl(t.text));
      if (enabled("hover")) for (const [i, t] of safeTargets.slice(0, hoverLimit).entries()) { if (usage.hovers >= (THOROUGH ? 120 : 12) || !budgetAllows(budget, `hover:${i}`, delay + 500)) break; try { await mouse(cdp, "mouseMoved", t.x, t.y); await safeWait(delay); await snap(`hover:${i}:${t.text}`, "overlay"); usage.hovers++; } catch (e) { capture("hover", e, { target: t }); if (isBudgetFailure(e)) throw e; } }
      const dropdowns = safeTargets.filter(t => /combobox|option/i.test(t.role) || /select|dropdown|options|environment|method/i.test(t.text));
      if (enabled("dropdown")) for (const [i, t] of dropdowns.slice(0, clickLimit).entries()) { if (usage.dropdowns >= (THOROUGH ? 50 : 6) || !budgetAllows(budget, `dropdown:${i}`, delay + 500)) break; try { await click(cdp, t); await safeWait(delay); await snap(`dropdown:${i}:${t.text}`, "overlay"); await esc(cdp); usage.dropdowns++; } catch (e) { capture("dropdown", e, { target: t }); if (isBudgetFailure(e)) throw e; } }
      if (enabled("context")) for (const [i, t] of safeTargets.slice(0, contextLimit).entries()) { if (usage.contexts >= (THOROUGH ? 40 : 4) || !budgetAllows(budget, `context:${i}`, delay + 500)) break; try { await click(cdp, t, "right"); await safeWait(delay); await snap(`context:${i}:${t.text}`, "overlay"); await esc(cdp); usage.contexts++; } catch (e) { capture("context", e, { target: t }); if (isBudgetFailure(e)) throw e; } }
      if (enabled("dialogs")) { state = await snap("dialog-scan"); const openers = state.targets.filter(t => !dangerousControl(t.text) && /settings|more|manage|edit|view|help|info|certificate|proxy|cookie/i.test(t.text)); for (const [i, t] of openers.slice(0, clickLimit).entries()) { if (!budgetAllows(budget, `dialog:${i}`, delay + 500)) break; try { await click(cdp, t); await safeWait(delay); await snap(`dialog:${i}:${t.text}`, "overlay"); await esc(cdp); } catch (e) { capture("dialogs", e, { target: t }); if (isBudgetFailure(e)) throw e; } } }
      if (budgetAllows(budget, "final", 700)) await snap("final");
    }
  } catch (error) { fatalError = error; capture("fatal", error); }
  finally { if (cdp) cdp.close(); }
  const findings = new Map();
  for (const s of snapshots) for (const h of s.findings || []) { const k = `${h.kind}|${h.attribute}|${h.text}`; if (!findings.has(k) && findings.size >= (THOROUGH ? 1800 : 800)) continue; const v = findings.get(k) || { ...h, count: 0, phases: [], tabs: [] }; v.count++; if (v.phases.length < 20) v.phases.push(s.phase); if (s.tabId && !v.tabs.some(t => t.tabId === s.tabId) && v.tabs.length < 20) v.tabs.push({ tabId: s.tabId, tabName: s.tabName }); findings.set(k, v); }
  const budgetInfo = { limitMs: budget.limitMs, elapsedMs: Date.now() - budget.startedAt, exhausted: Boolean(budget.exhaustedAt), exhaustedAt: budget.exhaustedAt };
  const complete = !fatalError && !budget.exhaustedAt;
  const report = { generatedAt: new Date().toISOString(), complete, budget: budgetInfo, target: target ? { title: target.title, url: target.url } : null, options: { thorough: THOROUGH, phaseOnly, delay, hoverLimit, clickLimit, contextLimit, allTabs, maxTabs, tabDelay, maxScrolls, maxSnapshots, usage }, tabs: auditedTabs, summary: { snapshots: snapshots.length, tabs: auditedTabs.length, findings: findings.size, errors: errors.length }, findings: [...findings.values()].sort((a, b) => b.count - a.count), snapshots, errors };
  const written = writeAuditReport(out, report);
  // 计数取脱敏后真正写进报告的那份 summary，否则终端会报出被身份噪声过滤剔掉的误报。
  const reported = written.summary || report.summary;
  const summary = { out, complete, budget: budgetInfo, summary: reported, top: report.findings.slice(0, 30).map(x => x.text) };
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2)); else console.log(`分阶段流程审计${complete ? "完成" : "已保存部分结果"}：生成 ${reported.snapshots} 个快照，发现 ${reported.findings} 条候选，报告已写入 _generated/${path.basename(out)}`);
  if (!complete) process.exitCode = fatalError && !budget.exhaustedAt ? 1 : 2;
}
function selfTest(){
  const generated=scanScript("all");
  new Function(`return (${generated});`); // generated browser expression parse check
  const checks=[
    [/\bel\.value\b/.test(generated),false],
    [resolveOutPath("自检报告","unused.json"),path.resolve(__dirname,"..","..","..","_generated","自检报告.json")],
    [dangerousControl("删除"),true],
    [dangerousControl("发送"),true],
    [dangerousControl("保存"),true],
    [dangerousControl("打开文件夹"),true],
    [dangerousControl("Choose File"),true],
    [dangerousControl("查看"),false]
  ];
  const failed=checks.filter(([actual,expected])=>actual!==expected);
  if(failed.length)throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  if(flag("--details"))console.log(JSON.stringify(sanitizeAuditReport({ok:true,checks:checks.length}),null,2));
  else console.log(`分阶段流程审计脚本自检通过，共 ${checks.length} 项。`);
}

Promise.resolve().then(()=>flag("--self-test")?selfTest():main()).catch(e=>{
  const message=String(e&&e.message||e).replace(/\s+/g," ").trim();
  if(flag("--details"))console.error(JSON.stringify(sanitizeAuditReport({ok:false,error:message}),null,2));
  else console.error("分阶段流程审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  process.exitCode=1;
});
