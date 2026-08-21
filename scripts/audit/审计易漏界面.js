#!/usr/bin/env node
"use strict";

// Targeted audit for UI surfaces frequently missed by broad DOM sweeps:
// run/flow overflow menus, workspace switcher/list, integrations catalog and
// API catalog. Import is covered only by the dedicated import audit because
// the native Import menu can open a blocking Windows file picker. It avoids
// destructive menu entries; Escape is used only to dismiss transient overlays.

const fs = require("fs");
const path = require("path");
const { sanitizeAuditReport, sanitizeUrl, resolveAuditOutputPath, writeAuditReport } = require("./审计安全.js");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const THOROUGH = flag("--thorough");
const DEFAULT_BUDGET_MS = THOROUGH ? 600000 : 90000;
const MAX_ROOTS = THOROUGH ? 24 : 12;
const MAX_ELEMENTS = THOROUGH ? 12000 : 6000;
const MAX_HITS = THOROUGH ? 1400 : 600;
const MAX_TARGETS = THOROUGH ? 360 : 160;
const MAX_SCROLLS = THOROUGH ? 80 : 24;
const MAX_SNAPSHOTS = THOROUGH ? 180 : 80;

function integerArg(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
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

function resolveOutPath(value) {
  return resolveAuditOutputPath(value, "postman-targeted-surfaces.json");
}

async function connect(url, deadline = null) {
  const ws = new WebSocket(url), pending = new Map(); let next = 1;
  const rejectPending = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.t);
      item.reject(error);
    }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const remaining = deadline ? Math.max(100, deadline - Date.now()) : 10000;
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("连接 CDP WebSocket 超时。")); }, Math.min(10000, remaining));
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(new Error("连接 CDP WebSocket 失败。")); }, { once: true });
  });
  ws.addEventListener("message", e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
    m.error ? p.reject(new Error(m.error.message || "CDP 返回错误。")) : p.resolve(m.result);
  });
  ws.addEventListener("close", () => rejectPending(new Error("CDP WebSocket 已关闭。")));
  return {
    send(method, params = {}, timeoutMs = 15000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("CDP WebSocket 未连接。")); return; }
        const remaining = deadline ? deadline - Date.now() : timeoutMs;
        if (remaining <= 0) { reject(budgetError(method)); return; }
        const commandTimeout = Math.max(100, Math.min(timeoutMs, remaining));
        const t = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          try { ws.close(); } catch (_) {}
          reject(new Error(`CDP 命令执行超时：${method}`));
        }, commandTimeout);
        pending.set(id, { resolve, reject, t });
        try { ws.send(JSON.stringify({ id, method, params })); } catch (error) {
          clearTimeout(t); pending.delete(id); reject(error);
        }
      });
    },
    close() {
      rejectPending(new Error("CDP 连接已关闭。"));
      try { ws.close(); } catch (_) {}
    }
  };
}
function runtimeExceptionMessage(details) {
  const description = String(details && details.exception && details.exception.description || details && details.text || "Runtime.evaluate 执行失败")
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const line = Number.isInteger(details && details.lineNumber) ? details.lineNumber + 1 : null;
  const column = Number.isInteger(details && details.columnNumber) ? details.columnNumber + 1 : null;
  return line && column ? `${description}（第 ${line} 行，第 ${column} 列）` : description;
}

async function evalv(cdp, expression, phase = "Runtime.evaluate") {
  try {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const error = new Error(runtimeExceptionMessage(result.exceptionDetails));
      error.code = "RUNTIME_EXPRESSION";
      throw error;
    }
    return result.result.value;
  } catch (error) {
    error.auditPhase ||= phase;
    throw error;
  }
}

function diagnosticOf(item) {
  const message = String(item && item.error || "未知错误")
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return {
    phase: String(item && item.phase || "fatal").slice(0, 120),
    code: String(item && item.code || "AUDIT_ERROR").slice(0, 80),
    message
  };
}
async function mouse(cdp, type, x, y, button = "none", clickCount = 0) { await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount }); }
async function click(cdp, p) { await mouse(cdp, "mouseMoved", p.x, p.y); await mouse(cdp, "mousePressed", p.x, p.y, "left", 1); await mouse(cdp, "mouseReleased", p.x, p.y, "left", 1); }
async function esc(cdp) { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); }

const domScript = (scope = "all") => `(() => {
 const S=${JSON.stringify(scope)}, A=["title","aria-label","aria-description","aria-placeholder","placeholder","alt","label","data-original-title","data-tippy-content","data-tooltip","data-tooltip-content","data-tooltip-title","data-tooltip-text","data-tooltip-label","data-aether-tooltip","data-tab-name"];
 const MAX_ROOTS=${MAX_ROOTS},MAX_ELEMENTS=${MAX_ELEMENTS},MAX_HITS=${MAX_HITS},MAX_TARGETS=${MAX_TARGETS},MAX_SCROLLS=${MAX_SCROLLS},MAX_TEXT=600;
 const PRIVATE="input,textarea,select,pre,code,[contenteditable='true'],.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,.ProseMirror,[data-testid*='request-body'],[data-testid*='response-body'],[data-testid*='code-editor'],[data-testid*='script-editor']";
 const n=s=>String(s||"").replace(/\\u00a0/g," ").replace(/\\s+/g," ").trim();
 const v=e=>{if(!(e instanceof Element))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0};
 const privateEl=e=>Boolean(e&&e.closest&&e.closest(PRIVATE));
 const boundedText=e=>{if(!e||privateEl(e))return "";const doc=e.ownerDocument||document,walker=doc.createTreeWalker(e,NodeFilter.SHOW_TEXT);let node,out="",count=0;while((node=walker.nextNode())&&count<12&&out.length<240){count++;const piece=n(node.nodeValue);if(piece)out+=(out?" ":"")+piece.slice(0,240-out.length)}return n(out).slice(0,240)};
 const roots=[],queue=[{r:document,t:"document"}],seen=new Set([document]);let visited=0;
 for(let ri=0;ri<queue.length&&ri<MAX_ROOTS;ri++){
   const item=queue[ri],r=item.r,t=item.t,elements=[];roots.push(item);
   const doc=r.nodeType===9?r:r.ownerDocument;const walker=doc&&doc.createTreeWalker(r,NodeFilter.SHOW_ELEMENT);let e;
   if(r.nodeType===1)elements.push(r);
   while(walker&&(e=walker.nextNode())&&visited<MAX_ELEMENTS){visited++;elements.push(e);
     if(e.shadowRoot&&!seen.has(e.shadowRoot)&&queue.length<MAX_ROOTS){seen.add(e.shadowRoot);queue.push({r:e.shadowRoot,t:t+">shadow:"+String(e.tagName||"").toLowerCase()})}
     if(e.tagName==="IFRAME")try{if(e.contentDocument&&!seen.has(e.contentDocument)&&queue.length<MAX_ROOTS){seen.add(e.contentDocument);queue.push({r:e.contentDocument,t:t+">iframe:"+(e.src||"inline")})}}catch(_){}}
   item.elements=elements;
 }
 const hits=[],targets=[],scrolls=[],overlaySel="[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[role=tooltip],[role=alertdialog],[data-testid*=modal],[data-testid*=popover],[data-testid*=menu],[id^=tippy]";
 const add=(e,text,kind,attr,q,t)=>{if(hits.length>=MAX_HITS)return;text=n(text);if(!text||text.length>MAX_TEXT*2)return;hits.push({text:text.slice(0,MAX_TEXT),kind,attribute:attr||null,trail:t,tag:e&&e.tagName||"",rect:q?{x:q.x,y:q.y,w:q.width,h:q.height}:null})};
 for(const {r,t,elements=[]} of roots){const overlays=elements.filter(e=>e.matches&&e.matches(overlaySel)&&v(e)),inside=e=>overlays.some(o=>o===e||o.contains(e));for(const e of elements){if(hits.length>=MAX_HITS&&targets.length>=MAX_TARGETS&&scrolls.length>=MAX_SCROLLS)break;if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)||S==="overlay"&&!inside(e)||privateEl(e))continue;const q=e.getBoundingClientRect?e.getBoundingClientRect():null;if(v(e))for(const x of e.childNodes||[])if(x.nodeType===3)add(e,x.nodeValue,"text",null,q,t);for(const a of A)if(e.hasAttribute&&e.hasAttribute(a))add(e,e.getAttribute(a),"attribute",a,q,t);
   if(v(e)&&q){const role=n(e.getAttribute("role")),text=n(e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("placeholder")||e.getAttribute("data-testid")||boundedText(e)),view=e.ownerDocument.defaultView||window;if((e.matches("button,a,input,select,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=combobox],[aria-label],[title]")||view.getComputedStyle(e).cursor==="pointer")&&targets.length<MAX_TARGETS)targets.push({x:q.x+q.width/2,y:q.y+q.height/2,text:text.slice(0,220),tag:e.tagName,role,testid:n(e.getAttribute("data-testid")),rect:{x:q.x,y:q.y,w:q.width,h:q.height},trail:t});if(e.scrollHeight>e.clientHeight+20&&q.height>40&&q.width>80&&scrolls.length<MAX_SCROLLS)scrolls.push({x:q.x+q.width/2,y:q.y+q.height/2,text:text.slice(0,120),trail:t})}}}
 const u=(xs,k)=>[...new Map(xs.map(x=>[k(x),x])).values()];return {roots:roots.length,elements:visited,truncated:visited>=MAX_ELEMENTS||queue.length>=MAX_ROOTS,hits:u(hits,x=>x.kind+"|"+x.attribute+"|"+x.text+"|"+x.trail),targets:u(targets,x=>Math.round(x.x)+":"+Math.round(x.y)).slice(0,MAX_TARGETS),scrolls:u(scrolls,x=>Math.round(x.x)+":"+Math.round(x.y)).slice(0,MAX_SCROLLS)};
})()`;

function isEnglish(s, hit = {}) { s=String(s||"").trim(); if(!/[A-Za-z]{2}/.test(s))return false; if(/^gpt-\d+(?:\.\d+)?(?:\s+[a-z][a-z0-9.-]*)+$/i.test(s))return false; if(hit.kind==="attribute"&&/^(?:alt|aria-label)$/.test(hit.attribute||"")&&/^[A-Za-z0-9._+ -]+\s+(?:图标|头像|团队标志)$/.test(s))return false; if(/^(?:REST API|API|HTTP|JSON|XML|OAuth|GraphQL|gRPC|WebSocket|Cookie|Postman|RBAC|SSE|TLS|SSL|TCP|UDP|DNS|MCP|MQTT)(?:\s+[A-Za-z][A-Za-z0-9.+/-]*)*\s+[\u3400-\u9fff]/i.test(s))return false; if(/^(API|APIs|URL|HTTP|JSON|XML|OAuth|GraphQL|gRPC|Cookie|Postman|RBAC|SSE|TLS|SSL|TCP|UDP|DNS|MCP|MQTT)$/i.test(s))return false; if(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)$/.test(s))return false; return /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s)||/^[A-Za-z][A-Za-z '-]{3,}$/.test(s); }
function removeIdentityHits(hits) { const identities=new Set();for(const hit of hits){const match=String(hit.text||"").match(/^(.+?)(?: 的头像| 团队标志)$/);if(match)identities.add(match[1]);}return hits.filter(hit=>!identities.has(String(hit.text||""))&&!/(?: 的头像| 团队标志)$/.test(String(hit.text||""))); }
function regexMatches(re, value) {
  re.lastIndex = 0;
  return re.test(String(value || ""));
}
function matchTarget(targets, patterns, filter = () => true) {
  for (const re of patterns) {
    const found = targets.find((target) =>
      [target.text, target.testid, target.role, target.tag].some((value) => regexMatches(re, value)) && filter(target)
    );
    if (found) return found;
  }
  return null;
}

const flowOverflowScript = `(() => {
 const n=s=>String(s||"").replace(/\\s+/g," ").trim(),v=e=>{if(!(e instanceof Element))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>8&&r.height>8&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden"},label=e=>n(e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("data-testid")||Array.from(e.childNodes||[]).filter(x=>x.nodeType===3).map(x=>x.nodeValue).join(" ")).slice(0,220);
 const all=[],walker=document.createTreeWalker(document,NodeFilter.SHOW_ELEMENT);let e,count=0;while((e=walker.nextNode())&&count<${MAX_ELEMENTS}){count++;if(v(e)&&e.matches("button,[role=button]"))all.push(e)}
 const pack=e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,text:label(e),testid:n(e.getAttribute("data-testid")),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}};
 let c=all.find(e=>/more.actions|view.more|overflow|three.dot|查看更多操作|更多操作/i.test(label(e)));if(c)return pack(c);
 const anchors=all.filter(e=>/^(再次运行|重新运行|Rerun|Run again|分享|Share)$/i.test(label(e))).slice(0,20);
 for(const a of anchors){const ar=a.getBoundingClientRect();for(const candidate of all){const r=candidate.getBoundingClientRect();if(r.x>=ar.right-2&&r.x<=ar.right+180&&Math.abs((r.y+r.height/2)-(ar.y+ar.height/2))<25&&r.width<=60)return pack(candidate)}}return null;
})()`;

function buildReport(target, shots, actions, merged) {
  const meta = arguments[4] || {};
  return {
    generatedAt: new Date().toISOString(),
    complete: meta.complete !== false,
    budget: meta.budget || null,
    target: target ? { title: target.title, url: target.url } : null,
    summary: {
      snapshots: shots.length,
      actions: actions.length,
      successfulActions: actions.filter((item) => item.ok).length,
      findings: merged.size,
      errors: (meta.errors || []).length
    },
    actions,
    findings: [...merged.values()].sort((a, b) => b.count - a.count),
    snapshots: shots,
    errors: meta.errors || []
  };
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

async function main(){
  const out = resolveOutPath(arg("--out", null));
  const delay = integerArg("--delay-ms", THOROUGH ? 350 : 500, 0, THOROUGH ? 10000 : 3000);
  const auditBudgetMs = integerArg("--audit-budget-ms", DEFAULT_BUDGET_MS, 5000, THOROUGH ? 600000 : DEFAULT_BUDGET_MS);
  const maxScrollsPerSurface = integerArg("--max-scrolls", THOROUGH ? 20 : 6, 0, THOROUGH ? 80 : 24);
  const budget = { limitMs: auditBudgetMs, startedAt: Date.now(), deadline: Date.now() + auditBudgetMs, exhaustedAt: null };
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) throw new Error("未找到 Postman 的 DevToolsActivePort 文件。请先启动 Postman。");
  const shots = [], actions = [], errors = [];
  let target = null, cdp = null, fatalError = null, scrollsUsed = 0;
  const recordError = (phase, error) => {
    errors.push({ phase: error && error.auditPhase || phase, code: error && error.code || "AUDIT_ERROR", error: String(error && error.message || error) });
    if (error && (error.code === "AUDIT_BUDGET" || /(?:CDP 命令执行超时|CDP WebSocket)/.test(error.message || ""))) budget.exhaustedAt ||= phase;
  };
  try {
    const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(port)) throw new Error("DevToolsActivePort 文件中的端口无效。");
    const pages = await getJson(`http://127.0.0.1:${port}/json/list`, Math.min(5000, auditBudgetMs));
    const pageTargets = pages.filter(p => p.type === "page" && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(p.url || ""));
    target = pageTargets.find(p => /(?:未命名请求|新建请求|我的工作区|Untitled Request|New Request|My Workspace)/i.test(p.title || ""))
      || pageTargets.find(p => !/^(?:导入|Import)$/i.test(String(p.title || "").trim()))
      || pageTargets[0];
    if (!target) throw new Error("未找到 Postman 页面调试目标");
    cdp = await connect(target.webSocketDebuggerUrl, budget.deadline);
    const snap = async (name, scope = "all") => {
      if (!budgetAllows(budget, name, delay + 900)) throw budgetError(name);
      const s = await evalv(cdp, domScript(scope), `快照:${name}`);
      const hits = removeIdentityHits(s.hits);
      if (shots.length < MAX_SNAPSHOTS) shots.push({ name, roots: s.roots, elements: s.elements, truncated: s.truncated, hits, findings: hits.filter(x => isEnglish(x.text, x)), targetCount: s.targets.length, targetPreview: s.targets.slice(0, 80), scrollCount: s.scrolls.length });
      return s;
    };
    const open = async (name, patterns, filter, scope = "all") => {
      const s = await snap(`${name}:scan`, scope);
      const t = matchTarget(s.targets, patterns, filter);
      if (!t) { actions.push({ name, ok: false, reason: "target-not-found" }); return null; }
      await click(cdp, t); await sleep(delay); actions.push({ name, ok: true, target: t }); return t;
    };
    const openNested = async (name, parentPatterns, childPatterns, parentFilter = () => true, childFilter = () => true) => {
      const before = await snap(`${name}:parent-scan`);
      const parent = matchTarget(before.targets, parentPatterns, parentFilter);
      if (!parent) { actions.push({ name, ok: false, reason: "parent-not-found" }); return null; }
      await click(cdp, parent); await sleep(delay);
      const opened = await snap(`${name}:parent-opened`, "overlay");
      const child = matchTarget(opened.targets, childPatterns, childFilter);
      if (!child) {
        actions.push({ name, ok: false, reason: "child-not-found" });
        await esc(cdp); await sleep(Math.min(150, delay));
        return null;
      }
      await click(cdp, child); await sleep(delay);
      actions.push({ name, ok: true, target: child });
      return child;
    };
    const scrollAll = async (name, scope = "all") => {
      let s = await snap(`${name}:before-scroll`, scope);
      const directions = THOROUGH ? [100000, 100000, -100000] : [100000, -100000];
      for (const [i, x] of s.scrolls.slice(0, maxScrollsPerSurface).entries()) {
        for (const dy of directions) {
          if (scrollsUsed >= (THOROUGH ? MAX_SCROLLS : Math.min(MAX_SCROLLS, maxScrollsPerSurface * 4)) || !budgetAllows(budget, `${name}:scroll`, delay + 500)) return;
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: x.x, y: x.y, deltaX: 0, deltaY: dy });
          scrollsUsed += 1; await sleep(Math.max(120, delay / 2)); await snap(`${name}:scroll:${i}:${dy}`, scope);
        }
      }
    };
    await snap("initial");
    const flow = await evalv(cdp, flowOverflowScript, "定位流程溢出菜单");
    if (flow) { await click(cdp, flow); await sleep(delay); actions.push({ name: "flow-overflow-open", ok: true, target: flow }); await snap("flow-overflow-menu", "overlay"); await scrollAll("flow-overflow-menu", "overlay"); await esc(cdp); }
    else actions.push({ name: "flow-overflow-open", ok: false, reason: "target-not-found" });
    const ws = await open(
      "workspace-list-open",
      [/^(工作区|Workspaces)$/i, /^(我的工作区|My Workspace)$/i, /^个人工作区$/i, /workspace-switcher-(?:container|name)/i, /切换工作区|Switch workspace/i],
      t => t.rect.y < 140
    );
    if (ws) { await snap("workspace-list", "overlay"); await scrollAll("workspace-list", "overlay"); await esc(cdp); }
    const apps = await openNested(
      "apps-catalog-open",
      [/^导航菜单$/i, /^Navigation menu$/i, /^header-nav-menu-button$/i],
      [/^(集成|Integrations?|应用|Apps)$/i, /应用清单|App catalog|Apps catalog/i],
      t => t.rect.y < 80,
      t => t.rect.x < 650
    );
    if (apps) { await sleep(delay); await snap("apps-catalog"); await scrollAll("apps-catalog"); }
    const apis = await openNested(
      "api-catalog-open",
      [/^导航菜单$/i, /^Navigation menu$/i, /^header-nav-menu-button$/i],
      [/^(API|APIs|接口)$/i, /API\s*(目录|网络)|公共 API 网络|API Catalog|Public API Network|Explore APIs/i],
      t => t.rect.y < 80,
      t => t.rect.x < 650
    );
    if (apis) { await sleep(delay); await snap("api-catalog"); await scrollAll("api-catalog"); }
    await snap("final");
  } catch (error) {
    fatalError = error; recordError("fatal", error);
  } finally { if (cdp) cdp.close(); }
  const merged = new Map();
  for (const s of shots) for (const h of s.findings || []) {
    const k = `${h.kind}|${h.attribute}|${h.text}`; if (!merged.has(k) && merged.size >= (THOROUGH ? 1600 : 800)) continue;
    const v = merged.get(k) || { ...h, count: 0, surfaces: [] }; v.count += 1; if (!v.surfaces.includes(s.name) && v.surfaces.length < 24) v.surfaces.push(s.name); merged.set(k, v);
  }
  const successfulActions = actions.filter((item) => item.ok).length;
  const coverageMissing = actions.filter((item) => !item.ok).map((item) => item.name);
  const coverageComplete = successfulActions > 0;
  const complete = !fatalError && !budget.exhaustedAt && coverageComplete;
  const budgetInfo = { limitMs: budget.limitMs, elapsedMs: Date.now() - budget.startedAt, exhausted: Boolean(budget.exhaustedAt), exhaustedAt: budget.exhaustedAt };
  const report = buildReport(target, shots, actions, merged, { complete, budget: budgetInfo, errors });
  report.coverage = { successfulActions, missingActions: coverageMissing, delegatedSurfaces: ["import"], minimumMet: coverageComplete };
  writeAuditReport(out, report);
  const summary = { out, complete, budget: budgetInfo, summary: report.summary, diagnostics: errors.slice(0, 8).map(diagnosticOf), actions: actions.slice(0, 60), top: report.findings.slice(0, 40).map(x => x.text) };
  console.log(`易漏界面审计${complete ? "完成" : "已保存部分结果"}：执行 ${report.summary.actions} 次探测，发现 ${report.summary.findings} 条候选，报告已写入 _generated/${path.basename(out)}。`);
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport(summary), null, 2));
  if (!complete) process.exitCode = fatalError && !budget.exhaustedAt ? 1 : 2;
}

function selfTest(){
  const generated = domScript("all");
  const expected = path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告.json");
  const shots = [{ name: "initial" }];
  const report = buildReport({ title: "Postman", url: "https://desktop.postman.com/?userId=1" }, shots, [], new Map());
  const filtered = removeIdentityHits([
    { text: "example-user", kind: "text" },
    { text: "example-user 的头像", kind: "attribute" },
    { text: "editor", kind: "text" }
  ]);
  let syntaxOk = true;
  try {
    new Function(generated);
    new Function(flowOverflowScript);
  } catch (_) { syntaxOk = false; }
  const diagnostic = sanitizeAuditReport({
    diagnostics: [diagnosticOf({
      phase: "快照:initial",
      code: "RUNTIME_EXPRESSION",
      error: "SyntaxError: Unexpected token ')' C:\\Users\\Example\\secret.txt"
    })]
  }).diagnostics[0];
  const checks = [
    [/\be\.value\b/.test(generated), false],
    [/input-value/.test(generated), false],
    [syntaxOk, true],
    [resolveOutPath("自检报告"), expected],
    [report.snapshots === shots, true],
    [isEnglish("HEAD"), false],
    [isEnglish("OPTIONS"), false],
    [isEnglish("Microsoft Teams 图标", { kind: "attribute", attribute: "alt" }), false],
    [isEnglish("REST API 基础", { kind: "text" }), false],
    [isEnglish("添加 a new comment", { kind: "text" }), true],
    [filtered.length, 1],
    [filtered[0].text, "editor"],
    [isEnglish("editor", { kind: "text" }), true],
    [isEnglish("Connect", { kind: "text" }), true],
    [diagnostic.phase, "快照:initial"],
    [diagnostic.code, "RUNTIME_EXPRESSION"],
    [diagnostic.message.includes("Example"), false],
    [matchTarget([{ text: "我的工作区", testid: "", role: "button", tag: "DIV" }], [/^(我的工作区|My Workspace)$/i]).text, "我的工作区"],
    [matchTarget([{ text: "", testid: "header-nav-menu-button", role: "", tag: "BUTTON" }], [/^header-nav-menu-button$/i]).testid, "header-nav-menu-button"],
    [matchTarget([{ text: "我的工作区 button", testid: "", role: "", tag: "DIV" }], [/^我的工作区$/i]), null]
  ];
  const failed = checks.filter(([actual, wanted]) => actual !== wanted);
  if (failed.length) throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  if (flag("--details")) console.log(JSON.stringify(sanitizeAuditReport({ ok: true, checks: checks.length }), null, 2));
  else console.log(`易漏界面审计脚本自检通过，共 ${checks.length} 项。`);
}

Promise.resolve().then(()=>flag("--self-test")?selfTest():main()).catch(e=>{const message=String(e&&e.message||e).replace(/\s+/g," ").trim();if(flag("--details"))console.error(JSON.stringify(sanitizeAuditReport({ok:false,error:message,stack:e&&e.stack||null}),null,2));else console.error("易漏界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");process.exitCode=1});
