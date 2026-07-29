#!/usr/bin/env node
"use strict";

// Phased, state-preserving Postman UI localization audit.
// It recursively scans ordinary DOM, open shadow roots and same-origin frames,
// then probes scroll surfaces, dropdowns, hover tooltips, context menus and dialogs.

const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);

async function connect(url) {
  const ws = new WebSocket(url); let id = 1; const pending = new Map();
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data); if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  return { send(method, params = {}) { const callId = id++; ws.send(JSON.stringify({ id: callId, method, params })); return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`timeout: ${method}`)); }, 60000); pending.set(callId, { resolve, reject, timer }); }); }, close() { try { ws.close(); } catch (_) {} } };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Runtime.evaluate failed");
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
  return [...root.querySelectorAll('[data-tab-id][data-tab-name]')].map((el, index) => {
    const id = el.getAttribute('data-tab-id');
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const r = el.getBoundingClientRect();
    return {
      index,
      tabId: id,
      tabName: norm(el.getAttribute('data-tab-name') || el.innerText || el.textContent),
      active: el.getAttribute('data-tab-is-active') === 'true',
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }
    };
  }).filter(Boolean);
})()`;

const requesterTabActivateScript = (tabId) => `(() => {
  const id = ${JSON.stringify(String(tabId))};
  const root = document.querySelector('[data-testid="requester-tabs"]');
  if (!root) return null;
  const el = [...root.querySelectorAll('[data-tab-id][data-tab-name]')]
    .find(node => node.getAttribute('data-tab-id') === id);
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    tabId: id,
    tabName: String(el.getAttribute('data-tab-name') || el.innerText || el.textContent || '').trim(),
    active: el.getAttribute('data-tab-is-active') === 'true',
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }
  };
})()`;

const requesterTabActiveScript = (tabId) => `(() => {
  const id = ${JSON.stringify(String(tabId))};
  const root = document.querySelector('[data-testid="requester-tabs"]');
  const el = root && [...root.querySelectorAll('[data-tab-id][data-tab-name]')]
    .find(node => node.getAttribute('data-tab-id') === id);
  return !!(el && (el.getAttribute('data-tab-is-active') === 'true' ||
    el.classList.contains('active') || el.classList.contains('is-active')));
})()`;

// Hovering or opening a destructive control can mutate the user's workspace.
// These controls are intentionally excluded from all-tabs probes.  The filter
// is label-based and applies to both translated and original UI text.
function dangerousControl(text) {
  return /(?:关闭|退出|删除|移除|注销|清除|放弃|终止|停止|销毁|close|exit|delete|remove|quit|discard|terminate|shutdown|sign\s*out)/i.test(String(text || ""));
}

const scanScript = (scope = "all") => `(() => {
  const SCOPE=${JSON.stringify(scope)}, ATTRS=["title","aria-label","aria-description","aria-placeholder","placeholder","alt","label","value","data-original-title","data-tippy-content","data-tooltip","data-tooltip-content","data-tooltip-title","data-tooltip-text","data-tooltip-label","data-aether-tooltip","data-tab-name"];
  const norm=s=>String(s||"").replace(/\\u00a0/g," ").replace(/\\s+/g," ").trim();
  const visible=el=>{if(!(el instanceof Element))return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0};
  const roots=[], seen=new Set();
  function visit(root, trail){if(!root||seen.has(root))return;seen.add(root);roots.push({root,trail});for(const el of root.querySelectorAll("*")){if(el.shadowRoot)visit(el.shadowRoot,trail+">shadow("+(el.tagName||"").toLowerCase()+")");if(el.tagName==="IFRAME"){try{if(el.contentDocument)visit(el.contentDocument,trail+">iframe("+(el.src||el.name||"inline")+")")}catch(_){}}}}
  visit(document,"document"); const hits=[], targets=[], scrolls=[];
  const add=(text,kind,trail,el,extra={})=>{text=norm(text);if(!text)return;const r=el&&el.getBoundingClientRect?el.getBoundingClientRect():null;hits.push({text,kind,trail,tag:el&&el.tagName||"",rect:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null,...extra})};
  for(const {root,trail} of roots){
    const overlaySel="[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[role=tooltip],[role=alertdialog],[data-testid*=modal],[data-testid*=popover],[data-testid*=menu],[id^=tippy]";
    const overlayRoots=[...root.querySelectorAll(overlaySel)].filter(visible); const inOverlay=el=>overlayRoots.some(o=>o===el||o.contains(el));
    for(const el of root.querySelectorAll("*")){
      if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName))continue;
      if(SCOPE==="overlay"&&!inOverlay(el))continue;
      if(visible(el)&&el.childNodes)for(const n of el.childNodes)if(n.nodeType===3&&norm(n.nodeValue).length<=1000)add(n.nodeValue,"text",trail,el);
      for(const a of ATTRS)if(el.hasAttribute&&el.hasAttribute(a)){
        if(a==="value"&&/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))continue;
        add(el.getAttribute(a),"attribute",trail,el,{attribute:a});
      }
      if((el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.tagName==="SELECT")&&norm(el.value))add(el.value,"input-value",trail,el);
      if(visible(el)){
        const r=el.getBoundingClientRect(), role=norm(el.getAttribute("role")), style=getComputedStyle(el);
        if(el.matches("button,a,input,textarea,select,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=combobox],[aria-label],[title]")||style.cursor==="pointer")targets.push({x:r.x+r.width/2,y:r.y+r.height/2,text:norm(el.getAttribute("aria-label")||el.getAttribute("title")||el.innerText||el.textContent).slice(0,180),tag:el.tagName,role,trail});
        if(el.scrollHeight>el.clientHeight+24&&r.height>40&&r.width>60)scrolls.push({x:r.x+r.width/2,y:r.y+r.height/2,max:el.scrollHeight-el.clientHeight,text:norm(el.innerText||el.textContent).slice(0,100),trail});
      }
    }
  }
  const uniq=(a,key)=>{const m=new Map();for(const x of a){const k=key(x);if(!m.has(k))m.set(k,x)}return [...m.values()]};
  return {rootCount:roots.length,hits:uniq(hits,x=>x.kind+"|"+x.attribute+"|"+x.text+"|"+x.trail),targets:uniq(targets,x=>Math.round(x.x)+":"+Math.round(x.y)),scrolls:uniq(scrolls,x=>Math.round(x.x)+":"+Math.round(x.y))};
})()`;

function english(text) {
  const s = String(text || "").trim(); if (!s || !/[A-Za-z]{2}/.test(s)) return false;
  const allowed = /^(API|URL|URI|HTTP|HTTPS|JSON|XML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|GET|POST|PUT|PATCH|DELETE|HTML|JavaScript|Postman)$/i;
  return !allowed.test(s) && (/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s) || /^[A-Za-z][A-Za-z '-]{3,}$/.test(s));
}

async function main() {
  const out = path.resolve(arg("--out", path.join(process.cwd(), "_generated", "postman-phased-audit.json")));
  const delay = Number(arg("--delay-ms", "450")), hoverLimit = Number(arg("--max-hovers", "120")), clickLimit = Number(arg("--max-dropdowns", "30")), contextLimit = Number(arg("--max-context", "30"));
  const allTabs = flag("--all-tabs"), maxTabs = Math.max(0, Number(arg("--max-tabs", "50"))), tabDelay = Math.max(0, Number(arg("--tab-delay-ms", String(delay))));
  const phaseOnly = arg("--phase", "all"); const enabled = (p) => phaseOnly === "all" || phaseOnly.split(",").includes(p);
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim(); const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(p => p.type === "page" && /^https:\/\/desktop\.postman\.com/i.test(p.url || "")); if (!target) throw new Error("Postman page target not found");
  const cdp = await connect(target.webSocketDebuggerUrl); const snapshots = [], errors = [], auditedTabs = [];
  const snap = async (phase, scope="all", tab=null) => {
    const state=await evaluate(cdp,scanScript(scope));
    snapshots.push({phase,tabId:tab&&tab.tabId||null,tabName:tab&&tab.tabName||null,rootCount:state.rootCount,hitCount:state.hits.length,findings:state.hits.filter(x=>english(x.text)),targets:state.targets.length,scrolls:state.scrolls.length});
    return state;
  };
  try {
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await esc(cdp); await sleep(delay);
    if (allTabs) {
      const requesterTabs = (await evaluate(cdp, requesterTabsScript)).slice(0, maxTabs);
      for (const tab of requesterTabs) {
        try {
          await esc(cdp);
          const point = await evaluate(cdp, requesterTabActivateScript(tab.tabId));
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("requester tab is no longer available");
          await click(cdp, point);
          const waitUntil = Date.now() + Math.max(1000, tabDelay * 4);
          let active = false;
          do { await sleep(Math.max(80, Math.min(250, tabDelay || 80))); active = await evaluate(cdp, requesterTabActiveScript(tab.tabId)); } while (!active && Date.now() < waitUntil);
          if (!active) throw new Error("requester tab did not become active");
          if (tabDelay > 0) await sleep(tabDelay);

          const tabContext = { tabId: tab.tabId, tabName: point.tabName || tab.tabName };
          auditedTabs.push({ ...tabContext, active: true });
          let state = await snap("tab:baseline", "all", tabContext);

          if (enabled("hover")) {
            const safeTargets = state.targets.filter(t => !dangerousControl(t.text));
            for (const [i,t] of safeTargets.slice(0,hoverLimit).entries()) {
              try { await mouse(cdp,"mouseMoved",t.x,t.y); await sleep(delay); await snap(`tab:hover:${i}:${t.text}`,"overlay",tabContext); }
              catch(e) { errors.push({phase:"tab:hover",tabId:tabContext.tabId,tabName:tabContext.tabName,target:t,error:e.message}); }
            }
          }

          if (enabled("dropdown")) {
            state = await evaluate(cdp,scanScript("all"));
            const dropdowns = state.targets.filter(t => !dangerousControl(t.text) && (/combobox|option/i.test(t.role)||/select|dropdown|options|environment|method/i.test(t.text)));
            for (const [i,t] of dropdowns.slice(0,clickLimit).entries()) {
              try { await click(cdp,t); await sleep(delay); await snap(`tab:dropdown:${i}:${t.text}`,"overlay",tabContext); await esc(cdp); }
              catch(e) { errors.push({phase:"tab:dropdown",tabId:tabContext.tabId,tabName:tabContext.tabName,target:t,error:e.message}); }
            }
          }
          await snap("tab:final", "all", tabContext);
        } catch (e) {
          errors.push({phase:"tab",tabId:tab.tabId,tabName:tab.tabName,error:e.message});
        }
      }
    } else {
      let state = await snap("baseline");
      if(enabled("scroll")){ for(const sc of state.scrolls){ for(const ratio of [0,.25,.5,.75,1]){ await mouse(cdp,"mouseMoved",sc.x,sc.y); await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:sc.x,y:sc.y,deltaX:0,deltaY:ratio===0?-100000:100000}); await sleep(Math.max(120,delay/2)); await snap(`scroll:${sc.text}:${ratio}`); } } }
      state=await evaluate(cdp,scanScript("all"));
      if(enabled("hover")){ for(const [i,t] of state.targets.slice(0,hoverLimit).entries()){ try{await mouse(cdp,"mouseMoved",t.x,t.y);await sleep(delay);await snap(`hover:${i}:${t.text}`,"overlay")}catch(e){errors.push({phase:"hover",target:t,error:e.message})} } }
      const dropdowns=state.targets.filter(t=>/combobox|option/i.test(t.role)||/select|dropdown|options|environment|method/i.test(t.text));
      if(enabled("dropdown")){ for(const [i,t] of dropdowns.slice(0,clickLimit).entries()){ try{await click(cdp,t);await sleep(delay);await snap(`dropdown:${i}:${t.text}`,"overlay");await esc(cdp)}catch(e){errors.push({phase:"dropdown",target:t,error:e.message})} } }
      if(enabled("context")){ for(const [i,t] of state.targets.slice(0,contextLimit).entries()){ try{await click(cdp,t,"right");await sleep(delay);await snap(`context:${i}:${t.text}`,"overlay");await esc(cdp)}catch(e){errors.push({phase:"context",target:t,error:e.message})} } }
      if(enabled("dialogs")){ state=await evaluate(cdp,scanScript("all")); const openers=state.targets.filter(t=>/settings|import|new|more|manage|edit|view|help|info|certificate|proxy|cookie/i.test(t.text)); for(const [i,t] of openers.slice(0,clickLimit).entries()){try{await click(cdp,t);await sleep(delay);await snap(`dialog:${i}:${t.text}`,"overlay");await esc(cdp)}catch(e){errors.push({phase:"dialogs",target:t,error:e.message})}} }
      await snap("final");
    }
  } finally { cdp.close(); }
  const findings=new Map(); for(const s of snapshots)for(const h of s.findings){const k=h.kind+"|"+h.attribute+"|"+h.text;const v=findings.get(k)||{...h,count:0,phases:[],tabs:[]};v.count++;if(v.phases.length<20)v.phases.push(s.phase);if(s.tabId&&!v.tabs.some(t=>t.tabId===s.tabId))v.tabs.push({tabId:s.tabId,tabName:s.tabName});findings.set(k,v)}
  const report={generatedAt:new Date().toISOString(),target:{title:target.title,url:target.url},options:{phaseOnly,delay,hoverLimit,clickLimit,contextLimit,allTabs,maxTabs,tabDelay},tabs:auditedTabs,summary:{snapshots:snapshots.length,tabs:auditedTabs.length,findings:findings.size,errors:errors.length},findings:[...findings.values()].sort((a,b)=>b.count-a.count),snapshots,errors};
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({out,summary:report.summary,top:report.findings.slice(0,30).map(x=>x.text)},null,2));
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
