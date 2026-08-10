#!/usr/bin/env node
"use strict";

// Targeted audit for UI surfaces frequently missed by broad DOM sweeps:
// run/flow overflow menus, Import modal dropdowns, workspace switcher/list,
// Apps catalog and API catalog. It never terminates/restarts Postman and avoids
// destructive menu entries; Escape is used only to dismiss transient overlays.

const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let next = 1;
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); });
  return { send(method, params = {}) { const id = next++; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 命令执行超时：${method}`)); }, 45000); pending.set(id, { resolve, reject, t }); }); }, close() { try { ws.close(); } catch (_) {} } };
}
async function evalv(cdp, expression) { const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Runtime.evaluate 执行失败"); return r.result.value; }
async function mouse(cdp, type, x, y, button = "none", clickCount = 0) { await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount }); }
async function click(cdp, p) { await mouse(cdp, "mouseMoved", p.x, p.y); await mouse(cdp, "mousePressed", p.x, p.y, "left", 1); await mouse(cdp, "mouseReleased", p.x, p.y, "left", 1); }
async function esc(cdp) { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); }

const domScript = (scope = "all") => `(() => {
 const S=${JSON.stringify(scope)}, A=["title","aria-label","aria-description","aria-placeholder","placeholder","alt","label","value","data-original-title","data-tippy-content","data-tooltip","data-tooltip-content","data-tooltip-title","data-tooltip-text","data-tooltip-label","data-aether-tooltip","data-tab-name"];
 const n=s=>String(s||"").replace(/\\u00a0/g," ").replace(/\\s+/g," ").trim();
 const v=e=>{if(!(e instanceof Element))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)!==0};
 const roots=[],seen=new Set();function walk(r,t){if(!r||seen.has(r))return;seen.add(r);roots.push({r,t});for(const e of r.querySelectorAll("*")){if(e.shadowRoot)walk(e.shadowRoot,t+">shadow:"+e.tagName.toLowerCase());if(e.tagName==="IFRAME")try{if(e.contentDocument)walk(e.contentDocument,t+">iframe:"+(e.src||"inline"))}catch(_){}}}walk(document,"document");
 const hits=[],targets=[],scrolls=[],overlaySel="[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[role=tooltip],[role=alertdialog],[data-testid*=modal],[data-testid*=popover],[data-testid*=menu],[id^=tippy]";
 for(const {r,t} of roots){const overlays=[...r.querySelectorAll(overlaySel)].filter(v), inside=e=>overlays.some(o=>o===e||o.contains(e));for(const e of r.querySelectorAll("*")){if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)||S==="overlay"&&!inside(e))continue;
   const q=e.getBoundingClientRect?e.getBoundingClientRect():null, add=(text,kind,attr)=>{text=n(text);if(text&&text.length<=1200)hits.push({text,kind,attribute:attr||null,trail:t,tag:e.tagName,rect:q?{x:q.x,y:q.y,w:q.width,h:q.height}:null})};
   if(v(e))for(const x of e.childNodes||[])if(x.nodeType===3)add(x.nodeValue,"text");for(const a of A)if(e.hasAttribute&&e.hasAttribute(a)){if(a==="value"&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName))continue;add(e.getAttribute(a),"attribute",a)}if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)&&n(e.value))add(e.value,"input-value","value");
   if(v(e)){const role=n(e.getAttribute("role")),text=n(e.getAttribute("aria-label")||e.getAttribute("title")||e.innerText||e.textContent||e.getAttribute("data-testid"));if(e.matches("button,a,input,select,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=combobox],[aria-label],[title]")||getComputedStyle(e).cursor==="pointer")targets.push({x:q.x+q.width/2,y:q.y+q.height/2,text:text.slice(0,220),tag:e.tagName,role,testid:n(e.getAttribute("data-testid")),rect:{x:q.x,y:q.y,w:q.width,h:q.height},trail:t});if(e.scrollHeight>e.clientHeight+20&&q.height>40&&q.width>80)scrolls.push({x:q.x+q.width/2,y:q.y+q.height/2,text:text.slice(0,120),trail:t})}
 }}
 const u=(xs,k)=>[...new Map(xs.map(x=>[k(x),x])).values()];return {roots:roots.length,hits:u(hits,x=>x.kind+"|"+x.attribute+"|"+x.text+"|"+x.trail),targets:u(targets,x=>Math.round(x.x)+":"+Math.round(x.y)),scrolls:u(scrolls,x=>Math.round(x.x)+":"+Math.round(x.y))};
})()`;

function isEnglish(s) { s=String(s||"").trim(); if(!/[A-Za-z]{2}/.test(s))return false; if(/^(API|APIs|URL|HTTP|JSON|XML|OAuth|GraphQL|gRPC|Cookie|Postman|GET|POST|PUT|PATCH|DELETE)$/i.test(s))return false; return /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s)||/^[A-Za-z][A-Za-z '-]{3,}$/.test(s); }
function matchTarget(targets, patterns, filter = () => true) { for(const re of patterns) { const found=targets.find(t=>re.test(`${t.text} ${t.testid} ${t.role}`)&&filter(t)); if(found)return found; } return null; }

const flowOverflowScript = `(() => {
 const n=s=>String(s||"").replace(/\\s+/g," ").trim(),v=e=>{if(!(e instanceof Element))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>8&&r.height>8&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=="none"&&s.visibility!=="hidden"};
 const roots=[document],seen=new Set();for(let i=0;i<roots.length;i++)for(const e of roots[i].querySelectorAll("*")){if(e.shadowRoot&&!seen.has(e.shadowRoot)){seen.add(e.shadowRoot);roots.push(e.shadowRoot)}}
 const all=roots.flatMap(r=>[...r.querySelectorAll("button,[role=button]")]).filter(v), pack=e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,text:n(e.getAttribute("aria-label")||e.getAttribute("title")||e.innerText||e.textContent),testid:n(e.getAttribute("data-testid")),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}};
 let c=all.find(e=>/more.actions|view.more|overflow|three.dot/i.test(n(e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("data-testid"))));if(c)return pack(c);
 const anchors=all.filter(e=>/^(再次运行|重新运行|Rerun|Run again|分享|Share)$/i.test(n(e.innerText||e.textContent||e.getAttribute("aria-label"))));
 for(const a of anchors){const ar=a.getBoundingClientRect(),near=all.map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.x>=ar.right-2&&x.r.x<=ar.right+180&&Math.abs((x.r.y+x.r.height/2)-(ar.y+ar.height/2))<25&&x.r.width<=60).sort((x,y)=>x.r.x-y.r.x);if(near.length)return pack(near[near.length-1].e)}return null;
})()`;

async function main(){
 const out=path.resolve(arg("--out",path.join(__dirname,"..","..","..","_generated","postman-targeted-surfaces.json"))), delay=Number(arg("--delay-ms","500"));
 const portFile=path.join(process.env.APPDATA||"","Postman","DevToolsActivePort");if(!fs.existsSync(portFile))throw new Error("未找到 Postman 的 DevToolsActivePort 文件。请先启动 Postman。");const port=fs.readFileSync(portFile,"utf8").split(/\r?\n/)[0].trim(),pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=pages.find(p=>p.type==="page"&&/(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(p.url||""));if(!target)throw new Error("未找到 Postman 页面调试目标");const cdp=await connect(target.webSocketDebuggerUrl),shots=[],actions=[];
 const snap=async(name,scope="all")=>{const s=await evalv(cdp,domScript(scope));shots.push({name,roots:s.roots,hits:s.hits,findings:s.hits.filter(x=>isEnglish(x.text)),targetCount:s.targets.length,targetPreview:s.targets.slice(0,250),scrollCount:s.scrolls.length});return s};
 const open=async(name,patterns,filter)=>{const s=await evalv(cdp,domScript("all")),t=matchTarget(s.targets,patterns,filter);if(!t){actions.push({name,ok:false,reason:"target-not-found"});return null}await click(cdp,t);await sleep(delay);actions.push({name,ok:true,target:t});return t};
 const scrollAll=async(name,scope="all")=>{let s=await evalv(cdp,domScript(scope));for(const [i,x]of s.scrolls.entries()){for(const dy of [100000,100000,-100000]){await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:x.x,y:x.y,deltaX:0,deltaY:dy});await sleep(Math.max(150,delay/2));await snap(`${name}:scroll:${i}:${dy}`,scope)}}};
 try{await cdp.send("Runtime.enable");await cdp.send("Page.enable");await snap("initial");
   // Run/Flow overflow: only open the menu and inspect it. No menu item is selected.
   let flow=await evalv(cdp,flowOverflowScript);if(flow){await click(cdp,flow);await sleep(delay);actions.push({name:"flow-overflow-open",ok:true,target:flow})}else{actions.push({name:"flow-overflow-open",ok:false,reason:"target-not-found"})}
   if(flow){await snap("flow-overflow-menu","overlay");await scrollAll("flow-overflow-menu","overlay");await esc(cdp);await sleep(150)}
   // Import modal: inspect the modal, then open each combobox/dropdown without selecting an option.
   const imp=await open("import-open",[/^(导入|Import)$/i,/sidebar-import-button/i],t=>t.rect.x<650);
   if(imp){let s=await snap("import-modal","overlay");const combos=s.targets.filter(t=>/combobox/i.test(t.role)||/dropdown|select|选择|下拉/i.test(t.text));for(const [i,c]of combos.slice(0,12).entries()){await click(cdp,c);await sleep(delay);await snap(`import-dropdown:${i}:${c.text}`,"overlay");await scrollAll(`import-dropdown:${i}`,"overlay");await esc(cdp);await sleep(120)}await esc(cdp);await sleep(150)}
   // Workspace switcher/list. Open and exhaust its virtualized/scrolling list.
   const ws=await open("workspace-list-open",[/^(工作区|Workspaces)$/i,/^(我的工作区|My Workspace)$/i,/切换工作区|Switch workspace/i],t=>t.rect.y<140);
   if(ws){await snap("workspace-list","overlay");await scrollAll("workspace-list","overlay");await esc(cdp);await sleep(150)}
   // Apps and API catalog are navigation-only probes; never activate cards/actions.
   const apps=await open("apps-catalog-open",[/^(应用|Apps)$/i,/应用清单|App catalog|Apps catalog/i],t=>t.rect.x<520);
   if(apps){await sleep(delay);await snap("apps-catalog");await scrollAll("apps-catalog")}
   const apis=await open("api-catalog-open",[/^(API|APIs|接口)$/i,/API\s*(目录|网络)|公共 API 网络|API Catalog|Public API Network|Explore APIs/i],t=>t.rect.x<520);
   if(apis){await sleep(delay);await snap("api-catalog");await scrollAll("api-catalog")}
   await snap("final");
 }finally{cdp.close()}
 const merged=new Map();for(const s of shots)for(const h of s.findings){const k=h.kind+"|"+h.attribute+"|"+h.text,v=merged.get(k)||{...h,count:0,surfaces:[]};v.count++;if(!v.surfaces.includes(s.name))v.surfaces.push(s.name);merged.set(k,v)}
 const report={generatedAt:new Date().toISOString(),target:{title:target.title,url:target.url},summary:{snapshots:shots.length,actions:actions.length,successfulActions:actions.filter(x=>x.ok).length,findings:merged.size},actions,findings:[...merged.values()].sort((a,b)=>b.count-a.count),snapshots:shots};fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log("易漏界面审计完成，以下为结果摘要：");console.log(JSON.stringify({out,summary:report.summary,actions,top:report.findings.slice(0,40).map(x=>x.text)},null,2));
}
main().catch(e=>{console.error("易漏界面审计失败，详细信息如下：");console.error(e.stack||e);process.exit(1)});
