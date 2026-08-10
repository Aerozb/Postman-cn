#!/usr/bin/env node
"use strict";

// Read-only audit of entry points that are easy to miss in a normal page sweep.
// It opens menus/dialogs/popovers, records DOM/attributes/accessibility text,
// then dismisses them with Escape.  It never chooses a menu option, submits a
// form, toggles a setting, or activates a destructive control.

const fs = require("fs");
const path = require("path");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = name => argv.includes(name);
const norm = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 CDP 超时。")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("连接 CDP 失败。")); }, { once: true });
  });
  ws.addEventListener("message", event => {
    const msg = JSON.parse(event.data); if (!msg.id || !pending.has(msg.id)) return;
    const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(msg.error.message || JSON.stringify(msg.error))); else item.resolve(msg.result);
  });
  return { send(method, params = {}, sessionId = null) {
    const callId = ++id; ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? {sessionId} : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`CDP 命令执行超时：${method}`)); }, 60000);
      pending.set(callId, { resolve, reject, timer });
    });
  }, close() { try { ws.close(); } catch (_) {} } };
}

async function connectTarget(port, browserPath, target) {
  if (browserPath) {
    const root = await connect(`ws://127.0.0.1:${port}${browserPath}`);
    const attached = await root.send("Target.attachToTarget", { targetId: target.id, flatten: true });
    if (!attached || !attached.sessionId) { root.close(); throw new Error("Target.attachToTarget 未返回会话 ID"); }
    const sessionId = attached.sessionId;
    return {
      send(method, params = {}) { return root.send(method, params, sessionId); },
      close() { root.close(); }
    };
  }
  return connect(target.webSocketDebuggerUrl);
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
  const overlays=[...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],[data-testid*=modal],[data-aether-id*=modal]')].filter(visible);
  for(const overlay of overlays.reverse()){
    const controls=[...overlay.querySelectorAll('button,[role=button]')].filter(visible);
    const close=controls.find(el=>/^(?:close|dismiss|cancel|关闭|关闭弹窗|取消)$/i.test(String(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||'').trim()) || /close|dismiss/i.test(el.getAttribute('data-testid')||''));
    if(close){const r=close.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,text:String(close.getAttribute('aria-label')||close.innerText||'').trim()};}
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

const scanScript = String.raw`(() => {
  const norm = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const attrs = ['title','aria-label','aria-description','aria-placeholder','placeholder','alt','label','value',
    'data-original-title','data-tippy-content','data-tooltip','data-tooltip-content','data-tooltip-title',
    'data-tooltip-text','data-tooltip-label','data-aether-tooltip','data-tab-name','aria-valuetext','aria-roledescription'];
  const roots = []; const visited = new Set();
  function visit(root, trail) {
    if (!root || visited.has(root)) return; visited.add(root); roots.push({root, trail});
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot, trail + '>shadow(' + el.tagName.toLowerCase() + ')');
      if (el.tagName === 'IFRAME') { try { if (el.contentDocument) visit(el.contentDocument, trail + '>iframe'); } catch (_) {} }
    }
  }
  visit(document, 'document');
  const visible = el => { if (!el || el.nodeType !== 1) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0; };
  const rect = el => { const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; };
  const hits = [], targets = [], overlays = [], seenHit = new Set(), seenTarget = new Set();
  const addHit = (text, kind, attr, el, trail) => { text = norm(text); if (!text || text.length > 1800) return; const key = kind+'|'+(attr||'')+'|'+text; if (seenHit.has(key)) return; seenHit.add(key); hits.push({text,kind,attribute:attr||null,trail}); };
  for (const {root,trail} of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const role = el.getAttribute('role') || ''; const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
      const popup = el.getAttribute('aria-haspopup') || ''; const txt = norm(el.innerText || el.textContent || '');
      // Leaf text and labelled controls catch visible menu/dialog copy without giant parent duplicates.
      if (txt && (el.children.length === 0 || role || testid || /^(BUTTON|INPUT|TEXTAREA|OPTION|A|LABEL)$/i.test(el.tagName))) addHit(txt, 'text', null, el, trail);
      for (const attr of attrs) { const value = el.getAttribute(attr); if (value) addHit(value, 'attr', attr, el, trail); }
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) || role === 'combobox') {
        if (el.value) addHit(el.value, 'input-value', 'value', el, trail);
      }
      if (role || testid || popup || /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
        const r = rect(el); const key = [testid, role, txt, Math.round(r.x), Math.round(r.y)].join('|');
        if (!seenTarget.has(key) && r.x > -10 && r.y > -10) { seenTarget.add(key); targets.push({x:r.x,y:r.y,w:r.w,h:r.h,text:txt.slice(0,300),tag:el.tagName,role,testid,hasPopup:popup,disabled:el.disabled || el.getAttribute('aria-disabled') === 'true',title:el.getAttribute('title')||'',aria:el.getAttribute('aria-label')||''}); }
      }
      if (/dialog|menu|listbox|tooltip|alertdialog/i.test(role) || el.getAttribute('aria-modal') === 'true' || /modal|popover|menu|dialog/i.test(testid)) overlays.push({role,testid,text:txt.slice(0,600)});
    }
  }
  return {url:location.href,title:document.title,rootCount:roots.length,hits,targets,overlays};
})()`;

const ALLOWED = /^(?:API|APIs|URL|URI|HTTP|HTTPS|JSON|XML|HTML|OAuth|JWT|AWS|GraphQL|gRPC|WebSocket|Cookie|SDK|AI|Git|CPU|RAM|P95|P99|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Basic|Bearer|HMAC|SHA(?:-256)?|CSV|PDF|HTML|CSS|JavaScript|TypeScript|Node\.js|Electron|Windows|macOS|Linux|TCP|UDP|SSL|TLS|MCP|CLI|ID|IDs|IP|DNS|SQL|NoSQL|REST|OpenAPI|Swagger|OAuth2|OIDC|SAML|SSO|ENTERPRISE|Pro|Team|Free|Postman)$/i;
function candidate(value) {
  const text = norm(value); if (!text || text.length < 2 || text.length > 1800) return false;
  if (/^[\d\W_]+$/.test(text) || /^aether[-_]|^(?:icon|path|circle|polygon|svg|g|use)$/i.test(text)) return false;
  if (ALLOWED.test(text)) return false;
  if (!/[A-Za-z]{3,}/.test(text)) return false;
  if (/^(?:true|false|null|undefined|none|default|normal|small|large|medium)$/i.test(text)) return false;
  return /(?:\s|[.!?,:;()\[\]{}'"/\\_-])/.test(text) || /[\u4e00-\u9fff]/.test(text);
}

function axValue(node,key){const value=node&&node[key];return norm(value&&typeof value==='object'&&'value'in value?value.value:value);}
async function accessibilityFindings(cdp){
  try{
    const tree=await Promise.race([
      cdp.send('Accessibility.getFullAXTree'),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Accessibility.getFullAXTree 软超时')),8000))
    ]); const out=[]; const seen=new Set();
    for(const node of tree.nodes||[]){
      for(const [kind,key] of [['ax-name','name'],['ax-description','description'],['ax-value','value']]){
        const value=axValue(node,key); if(!value||!candidate(value))continue; const id=kind+'|'+value; if(seen.has(id))continue; seen.add(id); out.push({text:value,kind,attribute:null,trail:'accessibility'});
      }
    }
    return out;
  }catch(error){return [{error:error.message}];}
}
function dangerous(target) {
  const text = `${target.text||''} ${target.testid||''} ${target.title||''} ${target.aria||''}`;
  return /delete|remove|logout|sign\s*out|disconnect|revoke|reset|clear|discard|send|submit|save|publish|upgrade|buy|install|uninstall|rename|leave|close\s+account|confirm|选择|删除|移除|退出|撤销|重置|清空|发送|保存|发布|升级|购买|安装|卸载|离开/i.test(text);
}
function pick(state, patterns, opts = {}) {
  const list = (state && state.targets || []).filter(item => {
    if (item.disabled || dangerous(item) && !opts.allowDangerous) return false;
    if (opts.top && item.y > opts.maxY) return false;
    if (opts.minX != null && item.x < opts.minX) return false;
    if (opts.testid && !opts.testid.test(item.testid||'')) return false;
    if (opts.popup && !opts.popup.test(item.hasPopup||'')) return false;
    return patterns.some(re => re.test(item.text||'') || re.test(item.testid||'') || re.test(item.title||'') || re.test(item.aria||''));
  });
  return list.sort((a,b) => (a.w*a.h)-(b.w*b.h))[0] || null;
}

async function main() {
  const out = path.resolve(arg('--out', path.join(__dirname, '..', '..', '..', '_generated', 'postman-entry-modals.json')));
  const delay = Math.max(120, Number(arg('--delay-ms', '420')));
  const maxAx = Math.max(0, Number(arg('--max-ax', '8'))); let axUsed=0;
  const portFile = path.join(process.env.APPDATA || '', 'Postman', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) throw new Error('未找到 Postman 的 DevToolsActivePort 文件');
  const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/); const port = lines[0].trim(); const browserPath = norm(lines[1]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(p => p.type === 'page' && /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(p.url||''));
  if (!target) throw new Error('未找到 Postman 页面调试目标');
  const cdp = await connectTarget(port,browserPath,target); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Accessibility.enable');
  const actions = [], errors = [], snapshots = [], merged = new Map();
  async function scan(label, phase) {
    const state=await evaluate(cdp, scanScript);
      const wantsAx = axUsed < maxAx && (/^(?:initial|global-search|notifications|settings-menu|account-menu|import-dialog|help-menu|theme-entry)$/i.test(label)) && /baseline|opened|inventory/i.test(phase);
      const ax = wantsAx ? await accessibilityFindings(cdp) : [];
      if(wantsAx)axUsed++;
      const findings = [...(state.hits||[]).filter(h => candidate(h.text)),...ax.filter(h=>!h.error)];
      for (const f of findings) { const key = `${f.kind}|${f.attribute||''}|${f.text}`; const old = merged.get(key) || {...f,count:0,surfaces:[],phases:[]}; old.count++; if (!old.surfaces.includes(label)) old.surfaces.push(label); if (!old.phases.includes(phase)) old.phases.push(phase); merged.set(key,old); }
      snapshots.push({label,phase,url:state.url,title:state.title,rootCount:state.rootCount,hitCount:state.hits.length,axFindingCount:ax.filter(h=>!h.error).length,targetCount:state.targets.length,overlayCount:state.overlays.length,findings,overlays:state.overlays.slice(0,50),targets:state.targets.slice(0,240)});
      const axError=ax.find(h=>h.error); if(axError)errors.push({label,phase,type:'accessibility',error:axError.error});
      return state;
  }
  async function open(label, spec, opts = {}) {
    try {
      await dismiss(cdp, delay); const state = await scan(label, 'before'); const item = pick(state, spec.patterns || [], {...opts, testid: spec.testid, popup: spec.popup});
      if (!item) { actions.push({label,type:'open',ok:false,reason:'target-not-found',spec:spec.name}); return; }
      await click(cdp,item); await sleep(delay); const after = await scan(label, 'opened');
      actions.push({label,type:'open',ok:true,spec:spec.name,target:item,overlayCount:after.overlays.length});
      await dismiss(cdp,delay); await scan(label,'closed');
    } catch (error) { errors.push({label,spec:spec.name,error:error.message}); try { await dismiss(cdp,delay); } catch (_) {} }
  }
  async function openNested(label,parentSpec,childPatterns){
    try{
      await dismiss(cdp,delay); let state=await scan(label,'before'); const parent=pick(state,parentSpec.patterns||[],{...parentSpec,testid:parentSpec.testid,popup:parentSpec.popup});
      if(!parent){actions.push({label,type:'nested-open',ok:false,reason:'parent-not-found'});return;}
      await click(cdp,parent); await sleep(delay); state=await scan(label,'parent-opened'); const child=pick(state,childPatterns,{allowDangerous:true});
      if(!child){actions.push({label,type:'nested-open',ok:false,reason:'child-not-found',parent});await dismiss(cdp,delay);return;}
      await click(cdp,child); await sleep(delay); const opened=await scan(label,'opened'); actions.push({label,type:'nested-open',ok:true,parent,target:child,overlayCount:opened.overlays.length}); await dismiss(cdp,delay); await scan(label,'closed');
    }catch(error){errors.push({label,type:'nested-open',error:error.message});try{await dismiss(cdp,delay);}catch(_){}}
  }
  try {
    await dismiss(cdp,delay); await scan('initial','baseline');
    const entries = [
      {name:'top-left-menu',patterns:[/^菜单$/i,/^menu$/i],top:true,maxY:55},
      {name:'header-navigation-menu',patterns:[/^导航菜单$/i,/^navigation menu$/i],testid:/^header-nav-menu-button$/i,popup:/menu/i},
      {name:'workspace-picker',patterns:[/^团队工作区$/i,/^workspace$/i,/^workspaces?$/i],popup:/listbox/i,top:true,maxY:55},
      {name:'global-search',patterns:[/^打开搜索$/i,/^open search$/i,/^搜索 \( Ctrl\+K \)$/i,/^search/i],testid:/^search-container$|^search-bar-content$/i,popup:/dialog/i},
      {name:'invite-members',patterns:[/^邀请$/i,/^invite(?: members?)?$/i],testid:/workspace-invite-button/i,top:true,maxY:60},
      {name:'notifications',patterns:[/^通知$/i,/^notifications?$/i,/notification/i],top:true,maxY:60},
      {name:'settings-menu',patterns:[/^设置$/i,/^settings?$/i],testid:/^settings-button$/i,top:true,maxY:60},
      {name:'account-menu',patterns:[/^管理账号$/i,/^manage account$/i,/^account$/i],testid:/^user-info-button$/i,top:true,maxY:60},
      {name:'requester-create',patterns:[/^新建请求$/i,/^new request$/i],testid:/^requester-tab-create$/i,top:false},
      {name:'environment-picker',patterns:[/^选择环境$/i,/^environment$/i,/^无环境$/i,/^no environment$/i],popup:/listbox/i,top:true,maxY:80},
      {name:'request-method-picker',patterns:[/^打开下拉菜单$/i,/^open dropdown menu$/i],testid:/^base-button$/i},
      {name:'send-options',patterns:[/^发送选项$/i,/^send options$/i],popup:/menu/i}
    ];
    for (const spec of entries) await open(spec.name,spec);
    const topMenu={patterns:[/^菜单$/i,/^menu$/i],top:true,maxY:55};
    await openNested('import-dialog',topMenu,[/^导入$/i,/^import$/i]);
    await openNested('help-menu',topMenu,[/^帮助$/i,/^help(?: and support)?$/i,/^support$/i]);
    const settingsParent={patterns:[/^设置$/i,/^settings?$/i],testid:/^settings-button$/i,top:true,maxY:60};
    await openNested('theme-entry',settingsParent,[/^主题$/i,/^theme$/i,/appearance/i]);
    // Also open every safe visible menu/dialog/listbox trigger; this catches
    // icon-only help, theme and overflow buttons whose labels vary by build.
    await dismiss(cdp,delay); let state = await scan('generic-entry-triggers','inventory');
    const generic = (state.targets||[]).filter(t => /(?:menu|dialog|listbox)/i.test(t.hasPopup||'') && !dangerous(t) && !/^requester-tab-create$/i.test(t.testid||'')).slice(0, Math.max(0,Number(arg('--max-generic','50'))));
    for (let i=0;i<generic.length;i++) {
      const t=generic[i]; try { await dismiss(cdp,delay); await click(cdp,t); await sleep(delay); await scan('generic-entry-triggers',`open:${i}:${t.testid||t.text}`); actions.push({label:'generic-entry-triggers',type:'open',ok:true,target:t}); await dismiss(cdp,delay); } catch(error) { errors.push({label:'generic-entry-triggers',target:t,error:error.message}); }
    }
    await dismiss(cdp,delay); await scan('final','final');
  } finally { cdp.close(); }
  const findings = [...merged.values()].sort((a,b)=>b.count-a.count||a.text.localeCompare(b.text));
  const report = {generatedAt:new Date().toISOString(),target:{id:target.id,title:target.title,url:target.url},options:{delay,maxAx},coverage:{axScans:axUsed},summary:{snapshots:snapshots.length,actions:actions.length,successfulActions:actions.filter(a=>a.ok).length,findings:findings.length,errors:errors.length},findings,actions,snapshots,errors};
  fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,JSON.stringify(report,null,2),'utf8');
  console.log('入口弹窗审计完成，以下为结果摘要：');
  console.log(JSON.stringify({out,summary:report.summary,top:findings.slice(0,100).map(f=>f.text)},null,2));
}

if (flag('--self-test')) {
  new Function(`return (${scanScript});`); // generated browser expression parse check
  const fake={targets:[{text:'设置',testid:'settings-button',hasPopup:'menu',x:10,y:10,w:20,h:20,disabled:false},{text:'删除',testid:'delete-button',hasPopup:'menu',x:10,y:10,w:20,h:20,disabled:false}]};
  if (!pick(fake,[/^设置$/],{top:true,maxY:60})) throw new Error('自检失败：未选中预期目标');
  if (pick(fake,[/^删除$/])) throw new Error('自检失败：危险操作防护未生效');
  console.log('入口弹窗审计脚本自检完成，以下为结果摘要：');
  console.log(JSON.stringify({ok:true,generatedScripts:1,guards:1},null,2));
} else main().catch(error=>{console.error('入口弹窗审计失败，详细信息如下：');console.error(error&&error.stack||error);process.exit(1);});
