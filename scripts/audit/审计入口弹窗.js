#!/usr/bin/env node
"use strict";

// Read-only audit of entry points that are easy to miss in a normal page sweep.
// It opens menus/dialogs/popovers, records DOM/attributes/accessibility text,
// then dismisses them with Escape.  It never chooses a menu option, submits a
// form, toggles a setting, or activates a destructive control.

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, resolveAuditOutputPath, writeAuditReport } = require("./审计安全.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = name => argv.includes(name);
const norm = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

function boundedNumberArg(name, fallback, ceiling, minimum = 0) {
  const parsed = Number(arg(name, String(fallback)));
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.floor(Math.max(minimum, Math.min(value, ceiling)));
}

function defaultEntryAuditOptions(thorough = false) {
  return thorough ? {
    delay: 320,
    auditBudgetMs: 300000,
    maxAx: 8,
    maxEntries: 11,
    maxGeneric: 30,
    budget: { scans: 110, snapshots: 110, mergedFindings: 3000 },
    scanLimits: {
      roots: 24, discoveryElements: 9000, elements: 7000, textNodes: 1200,
      attributes: 1600, hits: 1200, targets: 500, overlays: 80,
      snapshotFindings: 100, maxTextLength: 600, axDepth: 3,
      axNodes: 600, axFindings: 180
    }
  } : {
    delay: 220,
    auditBudgetMs: 60000,
    maxAx: 3,
    maxEntries: 8,
    maxGeneric: 0,
    budget: { scans: 40, snapshots: 40, mergedFindings: 800 },
    scanLimits: {
      roots: 12, discoveryElements: 3500, elements: 3000, textNodes: 500,
      attributes: 800, hits: 450, targets: 220, overlays: 30,
      snapshotFindings: 40, maxTextLength: 600, axDepth: 2,
      axNodes: 240, axFindings: 80
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

function assertAuditTime(budget, step, reserveMs = 0) {
  if (!auditTimeAllows(budget, step, reserveMs)) {
    throw new Error(`入口弹窗审计时间预算已耗尽：${step}`);
  }
}

function isEntryTimeoutError(error) {
  return /(?:入口弹窗审计(?:时间|扫描)预算已耗尽|CDP 命令执行超时|连接 CDP 超时|读取 Postman 调试目标超时)/.test(String(error && error.message || error));
}

function resolveOutPath(requested, fallback) {
  return resolveAuditOutputPath(requested, fallback);
}

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP 请求失败：状态码 ${response.status}。`);
    return response.json();
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error("读取 Postman 调试目标超时。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function connect(wsUrl, deadline = null) {
  if (deadline && deadline <= Date.now()) throw new Error("入口弹窗审计时间预算已耗尽：连接 CDP");
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); let id = 0;
  const clearPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); if (error) item.reject(error); }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const limitedByAudit = Boolean(deadline && remaining <= 10000);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error(limitedByAudit ? "入口弹窗审计时间预算已耗尽：连接 CDP" : "连接 CDP 超时。"));
    }, Math.min(10000, remaining));
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(new Error("连接 CDP 失败。")); }, { once: true });
  });
  ws.addEventListener("message", event => {
    let msg; try { msg = JSON.parse(event.data); } catch (_) { return; } if (!msg.id || !pending.has(msg.id)) return;
    const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(msg.error.message || "CDP 返回未知错误。")); else item.resolve(msg.result);
  });
  ws.addEventListener("close", () => clearPending(new Error("CDP WebSocket 已关闭。")), { once: true });
  ws.addEventListener("error", () => clearPending(new Error("CDP WebSocket 连接出错。")));
  return { send(method, params = {}, sessionId = null, timeout = 10000) {
    const callId = ++id;
    return new Promise((resolve, reject) => {
      const remaining = deadline ? deadline - Date.now() : timeout;
      if (remaining <= 0) { reject(new Error(`入口弹窗审计时间预算已耗尽：${method}`)); return; }
      const timer = setTimeout(() => {
        if (!pending.has(callId)) return;
        pending.delete(callId);
        try { ws.close(); } catch (_) {}
        reject(new Error(`CDP 命令执行超时：${method}`));
      }, Math.max(100, Math.min(timeout, remaining)));
      pending.set(callId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? {sessionId} : {}) }));
      } catch (error) {
        clearTimeout(timer); pending.delete(callId); reject(error);
      }
    });
  }, close() { clearPending(new Error("CDP 连接已关闭。")); try { ws.close(); } catch (_) {} } };
}

async function connectTarget(port, browserPath, target, deadline = null) {
  if (browserPath) {
    const root = await connect(`ws://127.0.0.1:${port}${browserPath}`, deadline);
    try {
      const attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true });
      if (!attached || !attached.sessionId) throw new Error("Target.attachToTarget 未返回会话 ID");
      const sessionId = attached.sessionId;
      return {
        send(method, params = {}, timeout = 10000) { return root.send(method, params, sessionId, timeout); },
        close() { root.close(); }
      };
    } catch (error) {
      root.close();
      throw error;
    }
  }
  const direct = await connect(target.webSocketDebuggerUrl, deadline);
  return {
    send(method, params = {}, timeout = 10000) { return direct.send(method, params, null, timeout); },
    close() { direct.close(); }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate 执行失败");
  return result.result && result.result.value;
}
async function mouse(cdp, type, x, y, button = "none", clickCount = 0) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount });
}
async function click(cdp, target, button = "left") {
  await mouse(cdp, "mouseMoved", target.x, target.y);
  await mouse(cdp, "mousePressed", target.x, target.y, button, 1);
  await mouse(cdp, "mouseReleased", target.x, target.y, button, 1);
}
async function escape(cdp) {
  for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
const overlayCloseScript = String.raw`(() => {
  const visible = el => { const r=el.getBoundingClientRect(); if(r.width<2||r.height<2)return false; const s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0; };
  const overlays=[...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],[data-testid*=modal],[data-aether-id*=modal]')].slice(0,30).filter(visible);
  for(const overlay of overlays.reverse()){
    const controls=[...overlay.querySelectorAll('button,[role=button]')].slice(0,80).filter(visible);
    const close=controls.find(el=>/^(?:close|dismiss|cancel|关闭|关闭弹窗|取消)$/i.test(String(el.getAttribute('aria-label')||el.getAttribute('title')||'').trim()) || /close|dismiss/i.test(el.getAttribute('data-testid')||''));
    if(close){const r=close.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,text:String(close.getAttribute('aria-label')||close.getAttribute('title')||'').trim().slice(0,120)};}
  }
  return null;
})()`;
async function dismiss(cdp, delay) {
  await escape(cdp); await sleep(80); await escape(cdp); await sleep(Math.min(220, Math.max(80, delay)));
  for(let i=0;i<2;i++){
    const closeTarget=await evaluate(cdp,overlayCloseScript).catch(()=>null);
    if(!closeTarget)break;
    await click(cdp,closeTarget); await sleep(Math.min(260,Math.max(100,delay)));
  }
  await mouse(cdp, "mouseMoved", 620, 110);
}

function scanScript(limits = defaultEntryAuditOptions(false).scanLimits) {
  const safeLimits = {
    roots: Math.max(1, Number(limits.roots) || 12),
    discoveryElements: Math.max(100, Number(limits.discoveryElements) || 3500),
    elements: Math.max(100, Number(limits.elements) || 3000),
    textNodes: Math.max(50, Number(limits.textNodes) || 500),
    attributes: Math.max(50, Number(limits.attributes) || 800),
    hits: Math.max(50, Number(limits.hits) || 450),
    targets: Math.max(20, Number(limits.targets) || 220),
    overlays: Math.max(10, Number(limits.overlays) || 30),
    maxTextLength: Math.max(80, Number(limits.maxTextLength) || 600)
  };
  return String.raw`(() => {
  const L=${JSON.stringify(safeLimits)};
  const norm = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const attrs = ['title','aria-label','aria-description','aria-placeholder','placeholder','alt','label',
    'data-original-title','data-tippy-content','data-tooltip','data-tooltip-content','data-tooltip-title',
    'data-tooltip-text','data-tooltip-label','data-aether-tooltip','data-tab-name','aria-valuetext','aria-roledescription'];
  // Never inspect values or body/editor descendants: these may contain credentials,
  // request payloads, response payloads, or arbitrary user text.
  const PRIVATE_RE = /(?:monaco|codemirror|cm-editor|code-editor|request[-_ ]?(?:body|editor|payload)|response[-_ ]?(?:body|editor|payload)|raw[-_ ]?body|requester[-_ ]?body|response[-_ ]?body|console[-_ ]?(?:output|log)|payload)/i;
  const PRIVATE_SELECTOR = 'input,textarea,select,[contenteditable],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"],[role="slider"],.monaco-editor,.CodeMirror,.cm-editor';
  const privateElement = el => {
    let node=el, hops=0;
    while(node && hops++<16){
      try {
        if(node.nodeType===1 && node.matches && node.matches(PRIVATE_SELECTOR)) return true;
        const marker=[node.id,node.className,node.getAttribute&&node.getAttribute('data-testid'),node.getAttribute&&node.getAttribute('data-test-id'),node.getAttribute&&node.getAttribute('data-aether-id'),node.getAttribute&&node.getAttribute('aria-label')].join(' ');
        if(PRIVATE_RE.test(String(marker||''))) return true;
      } catch (_) {}
      const root=node.getRootNode&&node.getRootNode(); node=node.parentElement||(root&&root.host)||null;
    }
    return false;
  };
  const roots=[]; const visited=new Set(); let discovered=0;
  function visit(root, trail) {
    if(!root||visited.has(root)||roots.length>=L.roots||discovered>=L.discoveryElements)return;
    visited.add(root); roots.push({root,trail});
    const doc=root.ownerDocument||document; const walker=doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT); let el;
    while(discovered<L.discoveryElements&&(el=walker.nextNode())){
      discovered++;
      if(el.shadowRoot) visit(el.shadowRoot,trail+'>shadow('+(el.tagName||'').toLowerCase()+')');
      if(el.tagName==='IFRAME'){try{if(el.contentDocument)visit(el.contentDocument,trail+'>iframe');}catch(_){} }
      if(roots.length>=L.roots)break;
    }
  }
  visit(document,'document');
  const visible = el => { if(!el||el.nodeType!==1||privateElement(el))return false; const r=el.getBoundingClientRect(); if(r.width<2||r.height<2||r.bottom<0||r.right<0||r.top>innerHeight||r.left>innerWidth)return false; const s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0; };
  const rect = el => { const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; };
  const hits=[],targets=[],overlays=[],seenHit=new Set(),seenTarget=new Set(); let scanned=0,textReads=0,attributeReads=0;
  const addHit = (text,kind,attr,trail) => { text=norm(text); if(!text||text.length>L.maxTextLength||hits.length>=L.hits)return; const key=kind+'|'+(attr||'')+'|'+text; if(seenHit.has(key))return; seenHit.add(key); hits.push({text,kind,attribute:attr||null,trail}); };
  const shortText = el => {
    if(!el||privateElement(el)||textReads>=L.textNodes)return '';
    const doc=el.ownerDocument||document, walker=doc.createTreeWalker(el,NodeFilter.SHOW_TEXT); let node,parts='',local=0;
    while(textReads<L.textNodes&&local++<16&&(node=walker.nextNode())){
      if(privateElement(node.parentElement))continue;
      textReads++; parts+=' '+String(node.nodeValue||''); if(parts.length>=L.maxTextLength*2)break;
    }
    return norm(parts).slice(0,L.maxTextLength);
  };
  outer: for(const {root,trail} of roots){
    const doc=root.ownerDocument||document; const walker=doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT); let el;
    while(scanned<L.elements&&(el=walker.nextNode())){
      scanned++; if(!visible(el))continue;
      const role=el.getAttribute('role')||'', testid=el.getAttribute('data-testid')||el.getAttribute('data-test-id')||'', popup=el.getAttribute('aria-haspopup')||'';
      const interactive=Boolean(role||testid||popup||/^(BUTTON|A|SUMMARY|LABEL)$/i.test(el.tagName));
      const txt=el.children.length===0?shortText(el):(interactive?shortText(el):'');
      const targetText=norm(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||txt).slice(0,300);
      if(txt&&(el.children.length===0||role||testid||/^(BUTTON|A|SUMMARY|LABEL)$/i.test(el.tagName)))addHit(txt,'text',null,trail);
      if(attributeReads<L.attributes){ for(const attr of attrs){ if(attributeReads++>=L.attributes)break; const value=el.getAttribute(attr); if(value)addHit(value,'attr',attr,trail); } }
      if((role||testid||popup||/^(BUTTON|A|SUMMARY|LABEL)$/i.test(el.tagName))&&targets.length<L.targets){
        const r=rect(el),key=[testid,role,targetText,Math.round(r.x),Math.round(r.y)].join('|');
        if(!seenTarget.has(key)&&r.x>-10&&r.y>-10){seenTarget.add(key);targets.push({x:r.x,y:r.y,w:r.w,h:r.h,text:targetText,tag:el.tagName,role,testid,hasPopup:popup,disabled:el.disabled||el.getAttribute('aria-disabled')==='true',title:String(el.getAttribute('title')||'').slice(0,180),aria:String(el.getAttribute('aria-label')||'').slice(0,180)});}
      }
      if(overlays.length<L.overlays&&(/dialog|menu|listbox|tooltip|alertdialog/i.test(role)||el.getAttribute('aria-modal')==='true'||/modal|popover|menu|dialog/i.test(testid)))overlays.push({role,testid,text:txt.slice(0,240)});
    }
    if(scanned>=L.elements)break outer;
  }
  return {url:location.href,title:document.title,rootCount:roots.length,discoveredElements:discovered,scannedElements:scanned,textReads,attributeReads,hits,targets,overlays};
})()`;
}

const ALLOWED = /^(?:API|APIs|URL|URI|HTTP|HTTPS|JSON|XML|HTML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|CPU|RAM|P95|P99|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Basic|Bearer|HMAC|SHA(?:-256)?|CSV|PDF|HTML|CSS|JavaScript|TypeScript|Node\.js|Electron|Windows|macOS|Linux|TCP|UDP|SSL|TLS|MCP|CLI|ID|IDs|IP|DNS|SQL|NoSQL|REST|OpenAPI|Swagger|OAuth2|OIDC|SAML|SSO|RBAC|ENTERPRISE|Pro|Team|Free|Postman)$/i;
function candidate(value) {
  const text = norm(value); if (!text || text.length < 2 || text.length > 600) return false;
  if (/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(text)) return false;
  if (/^(?:https?:\/\/|file:\/\/|mailto:)/i.test(text) || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text)) return false;
  if (/^[A-Z]:\\|^\\\\/.test(text)) return false;
  if (/^[\d\W_]+$/.test(text) || /^aether[-_]|^(?:icon|path|circle|polygon|svg|g|use)$/i.test(text)) return false;
  if (ALLOWED.test(text)) return false;
  if (!/[A-Za-z]{3,}/.test(text)) return false;
  if (/^(?:true|false|null|undefined|none|default|normal|small|large|medium)$/i.test(text)) return false;
  return /(?:\s|[.!?,:;()\[\]{}'"/\\_-])/.test(text) || /[\u4e00-\u9fff]/.test(text);
}

function axValue(node,key){const value=node&&node[key];return norm(value&&typeof value==='object'&&'value'in value?value.value:value);}
async function accessibilityFindings(cdp, limits = {}) {
  let enabled = false;
  const depth = Math.max(0, Number(limits.depth ?? 2));
  const maxNodes = Math.max(0, Number(limits.nodes ?? 240));
  const maxFindings = Math.max(0, Number(limits.findings ?? 80));
  try {
    await cdp.send("Accessibility.enable", {}, 5000); enabled = true;
    const tree = await cdp.send("Accessibility.getFullAXTree", { depth }, 8000);
    const out = []; const seen = new Set();
    const safeRole = /^(?:button|link|menu|menuitem|dialog|alertdialog|tab|tabpanel|tooltip|heading|navigation|toolbar|status|alert|listbox|option|treeitem|gridcell)$/i;
    for (const node of (tree.nodes || []).slice(0, maxNodes)) {
      if (node.ignored) continue;
      const role = axValue(node, "role");
      // Static text can be request/response content. DOM scanning already covers
      // visible copy, so AX is restricted to UI roles and never input roles.
      if (!safeRole.test(role) || /^(?:textbox|searchbox|combobox|spinbutton|slider|code)$/i.test(role)) continue;
      for(const [kind,key] of [['ax-name','name'],['ax-description','description']]){
        const value=axValue(node,key); if(!value||!candidate(value))continue; const id=kind+'|'+value; if(seen.has(id))continue; seen.add(id); out.push({text:value,kind,attribute:null,trail:'accessibility',role}); if(out.length>=maxFindings)return out;
      }
    }
    return out;
  } catch(error) { return [{error:error.message}]; }
  finally { if (enabled) { try { await cdp.send("Accessibility.disable", {}, 3000); } catch (_) {} } }
}
function dangerous(target) {
  const text = `${target.text||''} ${target.testid||''} ${target.title||''} ${target.aria||''}`;
  return /delete|remove|logout|sign\s*out|disconnect|revoke|reset|clear|discard|send|submit|save|publish|upgrade|buy|install|uninstall|rename|leave|close\s+account|confirm|import|upload|browse|choose\s+files?|select\s+files?|open\s+(?:files?|folders?)|选择|删除|移除|退出|撤销|重置|清空|发送|保存|发布|升级|购买|安装|卸载|离开|导入|上传|浏览|选择文件|打开文件|打开文件夹/i.test(text);
}
function pick(state, patterns, opts = {}) {
  const list = (state && state.targets || []).filter(item => {
    if (item.disabled || dangerous(item) && !opts.allowDangerous) return false;
    if (/^(?:checkbox|radio|switch|option|textbox|searchbox|combobox|slider)$/i.test(item.role || "")) return false;
    if (/^(?:INPUT|TEXTAREA|SELECT)$/i.test(item.tag || "")) return false;
    if (opts.top && item.y > opts.maxY) return false;
    if (opts.minX != null && item.x < opts.minX) return false;
    if (opts.testid && !opts.testid.test(item.testid||'')) return false;
    if (opts.popup && !opts.popup.test(item.hasPopup||'')) return false;
    return patterns.some(re => re.test(item.text||'') || re.test(item.testid||'') || re.test(item.title||'') || re.test(item.aria||''));
  });
  return list.sort((a,b) => (a.w*a.h)-(b.w*b.h))[0] || null;
}

function selectEntrySpecs(entries, thorough, maxEntries) {
  const skipped = entries.filter(spec => spec.heavy && !thorough).map(spec => spec.name);
  const selected = entries.filter(spec => thorough || !spec.heavy).slice(0, maxEntries);
  return { selected, skipped };
}

// Bounded entry-point audit used by the public command.
async function main() {
  const thorough = flag("--thorough");
  const profile = defaultEntryAuditOptions(thorough);
  const out = resolveOutPath(arg("--out", null), "postman-entry-modals.json");
  const delay = boundedNumberArg("--delay-ms", profile.delay, thorough ? 1000 : 320, 80);
  const auditBudgetMs = boundedNumberArg("--budget-ms", profile.auditBudgetMs, thorough ? 600000 : profile.auditBudgetMs, 5000);
  const maxAx = boundedNumberArg("--max-ax", profile.maxAx, thorough ? 16 : profile.maxAx);
  const maxEntries = boundedNumberArg("--max-entries", profile.maxEntries, thorough ? 20 : profile.maxEntries, 1);
  const maxGeneric = boundedNumberArg("--max-generic", profile.maxGeneric, thorough ? 50 : profile.maxGeneric);
  const timeBudget = createAuditTimeBudget(auditBudgetMs);
  const browserScanScript = scanScript(profile.scanLimits);
  const actions = [], errors = [], snapshots = [], merged = new Map();
  const usage = { scans: 0, axScans: 0, droppedFindings: 0, droppedSnapshots: 0 };
  let axUsed = 0;
  let target = null;
  let cdp = null;
  let entrySelection = { selected: [], skipped: [] };

  const pushError = entry => { if (errors.length < 200) errors.push(entry); };
  const waitDelay = async step => {
    assertAuditTime(timeBudget, step, Math.min(500, delay + 120));
    await sleep(Math.min(delay, Math.max(0, timeBudget.deadline - Date.now() - 40)));
  };

  async function scan(label, phase) {
    assertAuditTime(timeBudget, `扫描:${label}:${phase}`, Math.min(500, delay + 180));
    if (usage.scans >= profile.budget.scans) {
      timeBudget.exhaustedAt ||= `扫描次数上限:${label}`;
      throw new Error(`入口弹窗审计扫描预算已耗尽：${label}`);
    }
    usage.scans += 1;
    const state = await evaluate(cdp, browserScanScript);
    const wantsAx = axUsed < maxAx && /^(?:initial|global-search|notifications|settings-menu|account-menu|import-dialog|help-menu|theme-entry)$/i.test(label) && /baseline|opened|inventory/i.test(phase);
    const ax = wantsAx ? await accessibilityFindings(cdp, {
      depth: profile.scanLimits.axDepth,
      nodes: profile.scanLimits.axNodes,
      findings: profile.scanLimits.axFindings
    }) : [];
    if (wantsAx) { axUsed += 1; usage.axScans += 1; }
    const findings = [...(state.hits || []).filter(h => candidate(h.text)), ...ax.filter(h => !h.error)].slice(0, profile.scanLimits.snapshotFindings);
    for (const f of findings) {
      const key = `${f.kind}|${f.attribute || ""}|${f.text}`;
      let old = merged.get(key);
      if (!old) {
        if (merged.size >= profile.budget.mergedFindings) { usage.droppedFindings += 1; continue; }
        old = { ...f, count: 0, surfaces: [], phases: [] };
        merged.set(key, old);
      }
      old.count += 1;
      if (!old.surfaces.includes(label)) old.surfaces.push(label);
      if (!old.phases.includes(phase)) old.phases.push(phase);
    }
    if (snapshots.length < profile.budget.snapshots) {
      snapshots.push({ label, phase, url: state.url, title: state.title, rootCount: state.rootCount,
        discoveredElements: state.discoveredElements, scannedElements: state.scannedElements,
        hitCount: (state.hits || []).length, axFindingCount: ax.filter(h => !h.error).length,
        targetCount: (state.targets || []).length, overlayCount: (state.overlays || []).length,
        findings, overlays: (state.overlays || []).slice(0, profile.scanLimits.overlays),
        targets: (state.targets || []).slice(0, profile.scanLimits.targets) });
    } else usage.droppedSnapshots += 1;
    const axError = ax.find(h => h.error);
    if (axError) pushError({ label, phase, type: "accessibility", error: axError.error });
    return state;
  }

  async function open(label, spec) {
    try {
      assertAuditTime(timeBudget, `打开:${label}`, delay + 500);
      await dismiss(cdp, delay);
      const state = await scan(label, "before");
      const item = pick(state, spec.patterns || [], { testid: spec.testid, popup: spec.popup, top: spec.top, maxY: spec.maxY, minX: spec.minX });
      if (!item) { actions.push({ label, type: "open", ok: false, reason: "target-not-found", spec: spec.name }); return; }
      await click(cdp, item); await waitDelay(`等待:${label}`);
      const after = await scan(label, "opened");
      actions.push({ label, type: "open", ok: true, spec: spec.name, target: item, overlayCount: after.overlays.length });
      await dismiss(cdp, delay);
      if (thorough) await scan(label, "closed");
    } catch (error) {
      if (isEntryTimeoutError(error)) throw error;
      pushError({ label, spec: spec.name, error: error.message });
      if (auditTimeAllows(timeBudget, `收尾:${label}`, 100)) { try { await dismiss(cdp, delay); } catch (_) {} }
    }
  }

  async function openNested(label, parentSpec, childPatterns) {
    try {
      assertAuditTime(timeBudget, `打开嵌套:${label}`, delay + 500);
      await dismiss(cdp, delay);
      let state = await scan(label, "before");
      const parent = pick(state, parentSpec.patterns || [], { testid: parentSpec.testid, popup: parentSpec.popup, top: parentSpec.top, maxY: parentSpec.maxY });
      if (!parent) { actions.push({ label, type: "nested-open", ok: false, reason: "parent-not-found" }); return; }
      await click(cdp, parent); await waitDelay(`等待父菜单:${label}`);
      state = await scan(label, "parent-opened");
      const child = pick(state, childPatterns);
      if (!child) { actions.push({ label, type: "nested-open", ok: false, reason: "child-not-found", parent }); await dismiss(cdp, delay); return; }
      await click(cdp, child); await waitDelay(`等待子菜单:${label}`);
      const opened = await scan(label, "opened");
      actions.push({ label, type: "nested-open", ok: true, parent, target: child, overlayCount: opened.overlays.length });
      await dismiss(cdp, delay);
      if (thorough) await scan(label, "closed");
    } catch (error) {
      if (isEntryTimeoutError(error)) throw error;
      pushError({ label, type: "nested-open", error: error.message });
      if (auditTimeAllows(timeBudget, `收尾:${label}`, 100)) { try { await dismiss(cdp, delay); } catch (_) {} }
    }
  }

  try {
    const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) throw new Error("未找到 Postman 的 DevToolsActivePort 文件");
    const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
    const port = lines[0].trim(); const browserPath = norm(lines[1]);
    if (!/^\d+$/.test(port)) throw new Error("Postman 调试端口无效");
    assertAuditTime(timeBudget, "读取调试目标", 500);
    const pages = await getJson(`http://127.0.0.1:${port}/json/list`, Math.min(5000, Math.max(100, timeBudget.deadline - Date.now())));
    target = pages.find(p => p.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(p.url || ""));
    if (!target) throw new Error("未找到 Postman 页面调试目标");
    cdp = await connectTarget(port, browserPath, target, timeBudget.deadline);
    // Runtime/Page/Accessibility.enable are deliberately omitted: they add
    // event traffic and memory without helping this read-only probe.
    await dismiss(cdp, delay); await scan("initial", "baseline");
    const entries = [
      { name: "top-left-menu", patterns: [/^菜单$/i, /^menu$/i], top: true, maxY: 55 },
      { name: "header-navigation-menu", patterns: [/^导航菜单$/i, /^navigation menu$/i], testid: /^header-nav-menu-button$/i, popup: /menu/i },
      { name: "workspace-picker", patterns: [/^团队工作区$/i, /^workspace$/i, /^workspaces?$/i], popup: /listbox/i, top: true, maxY: 55 },
      // The global search renderer can allocate a large result index even when
      // no query is entered. Keep it out of the everyday bounded audit; the
      // maintainer-only thorough profile explicitly opts into this surface.
      { name: "global-search", heavy: true, patterns: [/^打开搜索$/i, /^open search$/i, /^搜索 \( Ctrl\+K \)$/i, /^search/i], testid: /^search-container$|^search-bar-content$/i, popup: /dialog/i },
      { name: "invite-members", patterns: [/^邀请$/i, /^invite(?: members?)?$/i], testid: /workspace-invite-button/i, top: true, maxY: 60 },
      { name: "notifications", patterns: [/^通知$/i, /^notifications?$/i, /notification/i], top: true, maxY: 60 },
      { name: "settings-menu", patterns: [/^设置$/i, /^settings?$/i], testid: /^settings-button$/i, top: true, maxY: 60 },
      { name: "account-menu", patterns: [/^管理账号$/i, /^manage account$/i, /^account$/i], testid: /^user-info-button$/i, top: true, maxY: 60 },
      { name: "requester-create", patterns: [/^新建请求$/i, /^new request$/i], testid: /^requester-tab-create$/i },
      { name: "environment-picker", patterns: [/^选择环境$/i, /^environment$/i, /^无环境$/i, /^no environment$/i], popup: /listbox/i, top: true, maxY: 80 },
      { name: "request-method-picker", patterns: [/^打开下拉菜单$/i, /^open dropdown menu$/i], testid: /^base-button$/i },
      { name: "send-options", patterns: [/^发送选项$/i, /^send options$/i], popup: /menu/i }
    ];
    entrySelection = selectEntrySpecs(entries, thorough, maxEntries);
    for (const spec of entrySelection.selected) await open(spec.name, spec);
    const topMenu = { patterns: [/^菜单$/i, /^menu$/i], top: true, maxY: 55 };
    await openNested("help-menu", topMenu, [/^帮助$/i, /^help(?: and support)?$/i, /^support$/i]);
    const settingsParent = { patterns: [/^设置$/i, /^settings?$/i], testid: /^settings-button$/i, top: true, maxY: 60 };
    await openNested("theme-entry", settingsParent, [/^主题$/i, /^theme$/i, /appearance/i]);
    await dismiss(cdp, delay);
    const state = await scan("generic-entry-triggers", "inventory");
    const generic = (state.targets || []).filter(t => /(?:menu|dialog|listbox)/i.test(t.hasPopup || "") && !dangerous(t) && !/^requester-tab-create$/i.test(t.testid || "")).slice(0, maxGeneric);
    for (let i = 0; i < generic.length; i += 1) {
      assertAuditTime(timeBudget, `通用入口:${i}`, delay + 400);
      const t = generic[i];
      try {
        await dismiss(cdp, delay); await click(cdp, t); await waitDelay(`等待通用入口:${i}`);
        await scan("generic-entry-triggers", `open:${i}:${t.testid || t.text}`);
        actions.push({ label: "generic-entry-triggers", type: "open", ok: true, target: t });
        await dismiss(cdp, delay);
      } catch (error) {
        if (isEntryTimeoutError(error)) throw error;
        pushError({ label: "generic-entry-triggers", target: t, error: error.message });
      }
    }
    await dismiss(cdp, delay);
    if (auditTimeAllows(timeBudget, "最终扫描", Math.min(500, delay + 180))) await scan("final", "final");
  } catch (error) {
    if (!isEntryTimeoutError(error)) throw error;
    timeBudget.exhaustedAt ||= "cdp-timeout";
    pushError({ type: "audit-timeout", error: String(error && error.message || error).slice(0, 300) });
  } finally {
    if (cdp) cdp.close();
  }

  const findings = [...merged.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const complete = !timeBudget.exhaustedAt;
  const report = {
    generatedAt: new Date().toISOString(),
    target: target ? { id: target.id, title: target.title, url: target.url } : null,
    complete,
    options: { thorough, delay, auditBudgetMs, maxAx, maxEntries, maxGeneric, budget: profile.budget, scanLimits: profile.scanLimits },
    timeBudget: { limitMs: timeBudget.limitMs, elapsedMs: Math.max(0, Date.now() - timeBudget.startedAt), exhausted: !complete, exhaustedAt: timeBudget.exhaustedAt },
    coverage: { axScans: axUsed, skippedEntries: entrySelection ? entrySelection.skipped : [] }, usage,
    summary: { snapshots: snapshots.length, actions: actions.length, successfulActions: actions.filter(a => a.ok).length, findings: findings.length, errors: errors.length },
    findings, actions, snapshots, errors
  };
  const written = writeAuditReport(out, report);
  // 计数取脱敏后真正写进报告的那份 summary，否则终端会报出被身份噪声过滤剔掉的误报。
  const reported = written.summary || report.summary;
  const summary = { out, complete, summary: reported, timeBudget: report.timeBudget, usage, top: findings.slice(0, 60).map(f => f.text) };
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  else if (complete) console.log(`入口弹窗审计完成：执行 ${reported.actions} 次探测，发现 ${reported.findings} 条候选，报告已写入 _generated/${path.basename(out)}`);
  else console.log(`入口弹窗审计已达到时间或扫描上限，部分报告已写入 _generated/${path.basename(out)}`);
  if (!complete) process.exitCode = 2;
}

function selfTest() {
  const balanced = defaultEntryAuditOptions(false);
  const thorough = defaultEntryAuditOptions(true);
  const generated = scanScript(balanced.scanLimits);
  try { new Function(`return (${generated});`); } catch (error) { throw new Error(`自检失败：浏览器扫描脚本解析失败：${error.message}`); }
  const fake = { targets: [
    { text: "设置", testid: "settings-button", hasPopup: "menu", role: "button", tag: "BUTTON", x: 10, y: 10, w: 20, h: 20, disabled: false },
    { text: "删除", testid: "delete-button", hasPopup: "menu", role: "button", tag: "BUTTON", x: 10, y: 10, w: 20, h: 20, disabled: false },
    { text: "输入内容", testid: "editor", role: "textbox", tag: "TEXTAREA", x: 10, y: 10, w: 20, h: 20, disabled: false }
  ] };
  const scanSource = String(generated);
  const axSource = String(accessibilityFindings);
  const cdpSource = String(connect);
  const mainSource = String(main);
  const entrySelection = selectEntrySpecs([{ name: "light" }, { name: "heavy", heavy: true }], false, 8);
  const checks = [
    [Boolean(pick(fake, [/^设置$/], { top: true, maxY: 60 })), true],
    [pick(fake, [/^删除$/]), null],
    [pick(fake, [/^输入内容$/]), null],
    [balanced.auditBudgetMs < thorough.auditBudgetMs, true],
    [balanced.auditBudgetMs, 60000],
    [balanced.maxGeneric < thorough.maxGeneric, true],
    [balanced.maxEntries < thorough.maxEntries, true],
    [balanced.maxAx < thorough.maxAx, true],
    [balanced.scanLimits.elements < thorough.scanLimits.elements, true],
    [balanced.budget.scans < thorough.budget.scans, true],
    [/createTreeWalker/.test(scanSource), true],
    [/L\.elements/.test(scanSource) && /L\.hits/.test(scanSource) && /L\.targets/.test(scanSource), true],
    [/PRIVATE_SELECTOR/.test(scanSource) && /monaco|codemirror/.test(scanSource), true],
    [/request[-_ ]?\(\?:body|editor|payload\)/.test(scanSource), true],
    [/\bel\.value\b/.test(scanSource), false],
    [/querySelectorAll\('\*'\)/.test(scanSource), false],
    [/getFullAXTree.*\{ depth \}/.test(axSource), true],
    [/slice\(0, maxNodes\)/.test(axSource), true],
    [/safeRole/.test(axSource) && /textbox\|searchbox\|combobox/.test(axSource), true],
    [/Accessibility\.disable/.test(axSource), true],
    [/AbortController/.test(String(getJson)), true],
    [/ws\.close\(\)/.test(cdpSource), true],
    [/root\.close\(\)/.test(String(connectTarget)), true],
    [/writeAuditReport/.test(mainSource) && /process\.exitCode = 2/.test(mainSource), true],
    [/timeBudget/.test(mainSource) && /complete/.test(mainSource), true],
    [/await cdp\.send\(['"]Runtime\.enable/.test(mainSource), false],
    [entrySelection.skipped.join(","), "heavy"],
    [entrySelection.selected.map(item => item.name).join(","), "light"],
    [resolveOutPath("自检报告", "unused.json"), path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告.json")]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  const summary = { ok: true, generatedScripts: 1, checks: checks.length, profile: { auditBudgetMs: balanced.auditBudgetMs, maxEntries: balanced.maxEntries, maxGeneric: balanced.maxGeneric, maxAx: balanced.maxAx } };
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  else console.log(`入口弹窗审计脚本自检通过，共 ${checks.length} 项防护。`);
}

Promise.resolve().then(() => flag('--self-test') ? selfTest() : main()).catch(error=>{
  const message = String(error && error.message || error).replace(/\s+/g, ' ').trim();
  if(flag('--details'))console.error(JSON.stringify(sanitizeAuditReport({ok:false,error:message}),null,2));
  else console.error('入口弹窗审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。');
  process.exitCode=1;
});
