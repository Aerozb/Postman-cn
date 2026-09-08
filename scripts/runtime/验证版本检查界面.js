"use strict";

// 由 verify / install 运行。使用真实渲染器函数、内存 DOM / IPC 和虚拟计时器，
// 检查启动、页面进入、手动刷新及每小时调度，不等待真实一小时、不写用户偏好。
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HOUR = 60 * 60 * 1000;
const IDS = {
  panel: "postman-zh-version-check", toggle: "postman-zh-version-check-button",
  now: "postman-zh-version-check-now", status: "postman-zh-version-check-status",
  action: "postman-zh-version-check-action", banner: "postman-zh-version-banner"
};

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {};
    this.style = {}; this.events = {}; this.parentNode = null; this.textContent = "";
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node === before) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(at >= 0); this.children.splice(at, 0, node); node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const at = this.children.indexOf(node); assert.ok(at >= 0);
    this.children.splice(at, 1); node.parentNode = null; return node;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, fn) { this.events[name] = fn; }
  click() { if (!this.disabled && this.events.click) this.events.click(); }
}

function fixture(source, options = {}) {
  const body = new Element("body");
  const anchor = new Element("div"); anchor.id = "postman-zh-update-switch"; body.appendChild(anchor);
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
  const document = { body, createElement: tag => new Element(tag), getElementById: id => find(body, id) || null };
  const calls = []; const timers = new Map(); const waiting = [];
  let time = 0; let serial = 0; let enabled = options.enabled !== false;
  let available = options.ipc !== false; let hold = false; let fault = ""; let staleGet = null; let holdGet = false;
  let reply = { status: "latest", localVersion: "12.27.0", latestVersion: "v12.27.0", dismissed: false };
  const ipc = { invoke(channel, value) {
    const method = channel.split(":").pop(); calls.push({ method, value });
    if (method === "get") {
      const snapshot = enabled;
      if (holdGet) { holdGet = false; return new Promise(resolve => { staleGet = () => resolve(snapshot); }); }
      return Promise.resolve(enabled);
    }
    if (method === "set") { enabled = value !== false; return Promise.resolve(enabled); }
    if (method === "check") {
      if (fault === "throw") throw new Error("fixture IPC error");
      if (fault === "reject") return Promise.reject(new Error("fixture IPC rejection"));
      if (!enabled) return Promise.resolve({ status: "disabled", enabled: false });
      const result = { ...reply, enabled: true };
      return hold ? new Promise(resolve => waiting.push(() => resolve(result))) : Promise.resolve(result);
    }
    if (method === "open" || method === "dismiss") return Promise.resolve(true);
    throw new Error("Unexpected IPC channel");
  } };
  const ipcStart = source.indexOf("  var updateToggleIpc;");
  const ipcEnd = source.indexOf("  function renderUpdateToggleState(", ipcStart);
  const start = source.indexOf("  var VERSION_CHECK_BOX_ID =");
  const end = source.indexOf("  function injectStyle() {", start);
  assert.ok(ipcStart >= 0 && ipcEnd > ipcStart && start > ipcEnd && end > start);
  const context = vm.createContext({
    document, Promise,
    require(name) { assert.equal(name, "electron"); return available ? { ipcRenderer: ipc } : {}; },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source.slice(ipcStart, ipcEnd) + source.slice(start, end) +
    "\nglobalThis.fixtureApi = { startVersionCheck, installVersionCheckPanel, refreshVersionCheckToggle, requestVersionCheck };",
  context, { timeout: 5000, filename: "zh-localize-version-check.js" });
  const api = context.fixtureApi;
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  return {
    api, calls, timers, flush,
    el: key => document.getElementById(IDS[key]),
    checks: () => calls.filter(call => call.method === "check"),
    mount() { api.installVersionCheckPanel(document); },
    unmount() { const node = document.getElementById(IDS.panel); if (node) node.parentNode.removeChild(node); },
    setReply(value) { reply = { ...reply, ...value }; },
    setEnabled(value) { enabled = value; },
    setIpc(value) { available = value; },
    setFault(value) { fault = value; },
    hold(value = true) { hold = value; },
    deliver() { assert.ok(waiting.length); waiting.shift()(); },
    holdGet() { holdGet = true; },
    deliverGet() { assert.ok(staleGet); staleGet(); staleGet = null; },
    async advance(ms) {
      const limit = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > limit) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      time = limit; await flush();
    }
  };
}

async function runVersionCheckUiTests() {
  const source = fs.readFileSync(path.join(__dirname, "../../payload/zh-localize.js"), "utf8");
  let passed = 0; const failures = [];
  const test = async (name, fn) => {
    try { await fn(); passed += 1; }
    catch (error) { failures.push({ name, error: error.message }); }
  };
  await test("启动立即检查且重复启动只保留一个小时计时器", async () => {
    const r = fixture(source);
    for (let i = 0; i < 10; i++) r.api.startVersionCheck();
    await r.flush(); assert.equal(r.checks().length, 1); assert.equal(r.checks()[0].value, false);
    assert.equal(r.timers.size, 1); assert.equal([...r.timers.values()][0].at, HOUR);
    await r.advance(HOUR - 1); assert.equal(r.checks().length, 1);
    await r.advance(1); assert.equal(r.checks().length, 2);
    await r.advance(HOUR); assert.equal(r.checks().length, 3); assert.equal(r.timers.size, 1);
  });
  await test("IPC 稍后就绪仍可启动，不把失败发现永久缓存", async () => {
    const r = fixture(source, { ipc: false }); r.api.startVersionCheck(); await r.flush();
    assert.equal(r.checks().length, 0); assert.equal(r.timers.size, 0);
    r.setIpc(true); r.api.startVersionCheck(); await r.flush(); assert.equal(r.checks().length, 1);
  });
  await test("进入更新页刷新，重复挂载不重复检查，返回页面再刷新", async () => {
    const r = fixture(source); r.mount(); await r.flush();
    assert.equal(r.checks().length, 1); assert.equal(r.checks()[0].value, true);
    const button = r.el("now");
    for (let i = 0; i < 10; i++) r.mount();
    await r.flush(); assert.equal(r.checks().length, 1); assert.equal(r.el("now"), button);
    r.unmount(); r.mount(); await r.flush(); assert.equal(r.checks().length, 2);
  });
  await test("启动与页面进入并发合并，手动按钮检查中禁用", async () => {
    const r = fixture(source); r.hold(); r.api.startVersionCheck(); r.mount(); await r.flush();
    assert.equal(r.checks().length, 1); assert.equal(r.el("now").disabled, true);
    assert.match(r.el("status").textContent, /正在检查/); assert.equal(r.el("status").getAttribute("aria-busy"), "true");
    r.el("now").click(); r.el("now").click(); await r.flush(); assert.equal(r.checks().length, 1);
    r.hold(false); r.deliver(); await r.flush();
    assert.equal(r.el("now").disabled, false); assert.equal(r.el("now").textContent, "立即检查");
    assert.equal(r.el("now").getAttribute("data-postman-zh-audit-skip"), "true");
  });
  await test("手动刷新更新面板并重置唯一小时计时器", async () => {
    const r = fixture(source); r.mount(); r.api.startVersionCheck(); await r.flush();
    await r.advance(5 * 60 * 1000);
    r.setReply({ status: "release-incomplete", latestVersion: "v12.28.0" });
    r.el("now").click(); await r.flush();
    assert.equal(r.checks().length, 2); assert.equal(r.checks()[1].value, true);
    assert.match(r.el("status").textContent, /尚未上传完整/); assert.equal(r.el("action").style.display, "");
    assert.equal(r.timers.size, 1); assert.equal([...r.timers.values()][0].at, HOUR + 5 * 60 * 1000);
    await r.advance(HOUR); assert.equal(r.checks().length, 3);
  });
  await test("慢请求完成后一小时仍然按时检查", async () => {
    const r = fixture(source); r.hold(); r.api.startVersionCheck(); await r.flush();
    await r.advance(9000); r.hold(false); r.deliver(); await r.flush();
    assert.equal([...r.timers.values()][0].at, HOUR + 9000);
    await r.advance(HOUR); assert.equal(r.checks().length, 2);
  });
  await test("关闭状态禁用手动按钮，页面巡检只读偏好", async () => {
    const r = fixture(source, { enabled: false }); r.mount(); r.api.startVersionCheck(); await r.flush();
    assert.equal(r.el("now").disabled, true); assert.match(r.el("status").textContent, /检查已关闭/);
    const before = r.checks().length; r.el("now").click();
    for (let i = 0; i < 20; i++) r.api.refreshVersionCheckToggle();
    await r.flush(); assert.equal(r.checks().length, before);
    r.setEnabled(true); r.api.refreshVersionCheckToggle(); await r.flush();
    assert.equal(r.el("now").disabled, false); assert.equal(r.checks().length, before);
  });
  await test("请求中关闭开关响应及时，旧结果不恢复开关也不弹提示", async () => {
    const r = fixture(source); r.mount(); r.api.startVersionCheck(); await r.flush();
    r.hold(); r.setReply({ status: "update-available", latestVersion: "v12.28.0" });
    r.el("now").click(); await r.flush(); r.el("toggle").click(); await r.flush();
    assert.equal(r.el("toggle").disabled, false); assert.equal(r.el("toggle").getAttribute("aria-checked"), "false");
    r.deliver(); await r.flush();
    assert.equal(r.el("toggle").getAttribute("aria-checked"), "false");
    assert.equal(r.el("now").disabled, true); assert.equal(r.el("banner"), null);
    assert.match(r.el("status").textContent, /检查已关闭/);
  });
  await test("旧请求期间重新开启，完成后只补一次新检查", async () => {
    const r = fixture(source); r.mount(); r.api.startVersionCheck(); await r.flush(); r.hold();
    r.el("now").click(); await r.flush(); r.el("toggle").click(); await r.flush();
    r.el("toggle").click(); await r.flush(); assert.equal(r.checks().length, 2);
    r.hold(false); r.deliver(); await r.flush(); assert.equal(r.checks().length, 3);
    assert.equal(r.el("toggle").getAttribute("aria-checked"), "true"); assert.equal(r.timers.size, 1);
  });
  await test("旧偏好轮询响应不覆盖新开关状态", async () => {
    const r = fixture(source); r.mount(); await r.flush();
    r.holdGet(); r.api.refreshVersionCheckToggle(); r.el("toggle").click(); await r.flush();
    r.deliverGet(); await r.flush(); assert.equal(r.el("toggle").getAttribute("aria-checked"), "false");
  });
  for (const fault of ["throw", "reject"]) {
    await test("IPC " + fault + "后按钮恢复且后续检查继续", async () => {
      const r = fixture(source); r.setFault(fault); r.mount(); r.api.startVersionCheck(); await r.flush();
      assert.equal(r.el("now").disabled, false); assert.match(r.el("status").textContent, /暂时查不到/);
      assert.equal(r.timers.size, 1); r.setFault(""); r.el("now").click(); await r.flush();
      assert.match(r.el("status").textContent, /最新已发布/); assert.equal(r.timers.size, 1);
    });
  }
  await test("定时结果同步面板及新版提示，忽略版本保持静默", async () => {
    const r = fixture(source); r.mount(); r.api.startVersionCheck(); await r.flush();
    r.setReply({ status: "update-available", latestVersion: "v12.28.0" }); await r.advance(HOUR);
    assert.match(r.el("status").textContent, /v12.28.0/); assert.equal(r.el("banner").getAttribute("data-version"), "v12.28.0");
    r.setReply({ latestVersion: "v12.29.0" }); await r.advance(HOUR);
    assert.equal(r.el("banner").getAttribute("data-version"), "v12.29.0");
    r.setReply({ dismissed: true }); await r.advance(HOUR); assert.equal(r.el("banner"), null);
  });
  await test("页面卸载后完成请求，再次进入正确显示且只留一个计时器", async () => {
    const r = fixture(source); r.hold(); r.mount(); r.api.startVersionCheck(); await r.flush();
    r.unmount(); r.mount(); await r.flush(); assert.equal(r.checks().length, 1);
    r.hold(false); r.deliver(); await r.flush();
    assert.match(r.el("status").textContent, /最新已发布/); assert.equal(r.el("now").disabled, false);
    assert.equal(r.timers.size, 1);
  });
  if (failures.length) throw new Error("汉化检查界面回归失败：" + failures.map(f => f.name + "（" + f.error + "）").join("；"));
  return { passed, failures };
}

module.exports = { runVersionCheckUiTests };
