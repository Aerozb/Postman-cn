"use strict";

// 由统一入口 verify / install 调用。整份主进程代码在 VM 内运行，
// 文件、时钟和 HTTPS 均用内存桩，测试不接触用户偏好，也不请求 GitHub。
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");

function release(version = "12.26.5") {
  return {
    tag_name: "v" + version,
    name: "Postman 中文版 " + version,
    draft: false,
    prerelease: false,
    published_at: "2026-09-07T03:00:00Z",
    assets: [
      { name: "app.asar", state: "uploaded", size: 163000000 },
      { name: "Postman-cn-" + version + "-win64.zip", state: "uploaded", size: 184000000 }
    ]
  };
}

function runtime(source, options = {}) {
  const calls = [];
  const writes = [];
  const handlers = new Map();
  let prefs = options.prefs;
  let reply = options.reply || { json: release() };
  let now = Date.parse("2026-09-07T06:00:00Z");
  class Clock extends Date { static now() { return now; } }
  const fileStub = {
    readFileSync(file) {
      if (path.basename(file) === "package.json") {
        return JSON.stringify({ name: "Postman", version: options.local === undefined ? "12.26.5" : options.local });
      }
      if (path.basename(file) === "postman-zh-version-check.json" && prefs !== undefined) {
        return JSON.stringify(prefs);
      }
      throw new Error("fixture file absent");
    },
    readdirSync() { return []; },
    mkdirSync() {},
    writeFileSync(file, value) {
      assert.equal(path.basename(file), "postman-zh-version-check.json");
      assert.notEqual(value.charCodeAt(0), 0xfeff);
      prefs = JSON.parse(value);
      writes.push(prefs);
    }
  };
  const httpStub = {
    get(url, settings, callback) {
      calls.push({ url, settings });
      const current = reply;
      if (current.fault === "throw") throw new Error("fixture network error");
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      queueMicrotask(() => {
        if (current.fault === "timeout") { req.emit("timeout"); return; }
        if (current.fault === "request-error") { req.emit("error", new Error("fixture request error")); return; }
        const res = new EventEmitter();
        res.statusCode = current.code || 200;
        res.headers = current.headers || {};
        res.setEncoding = () => {};
        res.resume = () => {};
        callback(res);
        if (current.fault === "stream-error") { res.emit("error", new Error("fixture stream error")); return; }
        if (current.fault === "aborted") { res.emit("aborted"); return; }
        if (res.statusCode !== 200) return;
        res.emit("data", current.body === undefined ? JSON.stringify(current.json) : current.body);
        if (!req.destroyed) res.emit("end");
      });
      return req;
    }
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    __dirname: path.join("fixture", "app.asar", "js"),
    process: { env: { APPDATA: "fixture-appdata" } },
    Date: Clock,
    require(name) {
      if (name === "path") return path;
      if (name === "fs") return fileStub;
      if (name === "https") return httpStub;
      throw new Error("unexpected fixture import: " + name);
    }
  });
  vm.runInContext(source, context, { filename: "zh-version-check-main.js", timeout: 5000 });
  const api = module.exports;
  api.install({ handle: (name, fn) => handlers.set(name, fn) });
  return {
    api, calls, writes,
    setReply(value) { reply = value; },
    advance(ms) { now += ms; },
    invoke(name, value) { return handlers.get("postman-zh:version-check:" + name)({}, value); }
  };
}

async function runVersionCheckTests() {
  const source = fs.readFileSync(path.join(__dirname, "../../payload/zh-version-check-main.js"), "utf8");
  let passed = 0;
  const failures = [];
  const test = async (name, fn) => {
    try { await fn(); passed += 1; }
    catch (error) { failures.push({ name, error: error.message }); }
  };
  const scenario = async (name, options, status) => test(name, async () => {
    const r = runtime(source, options);
    const result = await r.api.check(true);
    assert.equal(result.status, status);
    assert.equal(r.writes.length, 0);
    if (status === "latest" || status === "update-available") assert.equal(result.assetsReady, true);
    if (status === "local-unpublished" || status === "release-incomplete") assert.equal(result.dismissed, false);
  });

  await scenario("远端较旧不代表本机已发布", { local: "12.26.5", reply: { json: release("12.26.3") } }, "local-unpublished");
  await scenario("版本相同且两份产物齐全才是最新版", {}, "latest");
  await scenario("有完整新版产物才提示更新", { reply: { json: release("12.27.0") } }, "update-available");
  await scenario("本地版本未知不报最新版", { local: "" }, "error");
  await scenario("缺失标签不报最新版", { reply: { json: { ...release(), tag_name: "" } } }, "error");
  await scenario("标签后缀不按数字前缀误判", { reply: { json: { ...release(), tag_name: "v12.26.5-preview" } } }, "error");
  await scenario("超出整数精度的版本号不报最新版", { reply: { json: { ...release(), tag_name: "v99999999999999999999.0.0" } } }, "error");
  await scenario("草稿不报最新版", { reply: { json: { ...release(), draft: true } } }, "error");
  await scenario("预发布不报正式最新版", { reply: { json: { ...release(), prerelease: true } } }, "error");
  await scenario("未公开的 Release 不报最新版", { reply: { json: { ...release(), published_at: null } } }, "error");
  await scenario("缺少附件元数据不报最新版", { reply: { json: { ...release(), assets: undefined } } }, "error");
  await scenario("只有标签没有产物", { reply: { json: { ...release(), assets: [] } } }, "release-incomplete");
  await scenario("只有 app.asar 仍未发布完整", { reply: { json: { ...release(), assets: release().assets.slice(0, 1) } } }, "release-incomplete");
  await scenario("只有绿色版仍未发布完整", { reply: { json: { ...release(), assets: release().assets.slice(1) } } }, "release-incomplete");
  await scenario("标签和绿色版版本必须一致", { reply: { json: { ...release(), assets: release("12.26.3").assets } } }, "release-incomplete");
  for (const [name, changes] of [
    ["上传中", { state: "new" }], ["空附件", { size: 0 }],
    ["负数大小", { size: -1 }], ["无效大小", { size: "163000000" }]
  ]) {
    const data = release(); Object.assign(data.assets[0], changes);
    await scenario(name + "不报最新版", { reply: { json: data } }, "release-incomplete");
  }
  for (const code of [404, 500, 403, 429]) {
    await scenario("HTTP " + code + "不报最新版", { reply: { code } }, "error");
  }
  await scenario("HTTP 错误后的流中断不抛出未处理异常", { reply: { code: 500, fault: "stream-error" } }, "error");
  await scenario("非法 JSON 不报最新版", { reply: { body: "{bad json" } }, "error");
  await scenario("过大响应受限", { reply: { body: " ".repeat(512 * 1024 + 1) } }, "error");
  for (const fault of ["throw", "timeout", "request-error", "stream-error", "aborted"]) {
    await scenario(fault + "静默返回错误状态", { reply: { fault } }, "error");
  }

  await test("数字段比较及严格版本格式", () => {
    const { api } = runtime(source);
    assert.equal(api.compareVersions("v12.10.0", "12.9.0"), 1);
    assert.equal(api.compareVersions("v12.26.5", "12.26.5.0"), 0);
    assert.equal(api.compareVersions("12.26.3", "12.26.5"), -1);
    for (const bad of ["", "release", "12.26.5junk", "12.26.5.1.2"]) {
      assert.equal(api.compareVersions(bad, "12.26.5"), null);
      assert.equal(api.isNewer(bad, "12.26.5"), false);
    }
  });
  await test("关闭时零网络请求且不写文件", async () => {
    const r = runtime(source, { prefs: { enabled: false } });
    assert.equal((await r.api.check(true)).status, "disabled");
    assert.equal(r.calls.length, 0); assert.equal(r.writes.length, 0);
  });
  await test("默认开启且请求不携带本机版本或偏好", async () => {
    const r = runtime(source); await r.api.check(true);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, "https://api.github.com/repos/Aerozb/Postman-cn/releases/latest");
    assert.equal(r.calls[0].settings.timeout, 10000);
    assert.deepEqual(Object.keys(r.calls[0].settings.headers).sort(), ["Accept", "User-Agent"]);
  });
  await test("成功结果缓存六小时，强制检查可刷新", async () => {
    const r = runtime(source); await r.api.check(false); await r.api.check(false);
    assert.equal(r.calls.length, 1);
    await r.api.check(true); assert.equal(r.calls.length, 2);
    r.advance(6 * 60 * 60 * 1000 + 1); await r.api.check(false);
    assert.equal(r.calls.length, 3);
  });
  await test("上传完成后强制刷新进入最新版", async () => {
    const r = runtime(source, { reply: { json: { ...release(), assets: [] } } });
    assert.equal((await r.api.check(false)).status, "release-incomplete");
    r.setReply({ json: release() });
    assert.equal((await r.api.check(true)).status, "latest");
  });
  await test("并发检查共用一个请求", async () => {
    const r = runtime(source);
    const results = await Promise.all([r.api.check(true), r.api.check(true), r.api.check(false)]);
    assert.equal(r.calls.length, 1);
    assert.ok(results.every(result => result.status === "latest"));
  });
  await test("错误退避三十分钟", async () => {
    const r = runtime(source, { reply: { code: 500 } });
    await r.api.check(false); await r.api.check(false); assert.equal(r.calls.length, 1);
    r.advance(30 * 60 * 1000 + 1); await r.api.check(false); assert.equal(r.calls.length, 2);
  });
  await test("限额退避同样阻止强制检查", async () => {
    const reset = Math.floor(Date.parse("2026-09-07T08:00:00Z") / 1000);
    const r = runtime(source, { reply: { code: 429, headers: { "x-ratelimit-reset": String(reset) } } });
    await r.api.check(true); await r.api.check(true); assert.equal(r.calls.length, 1);
    r.advance(2 * 60 * 60 * 1000 + 1); r.setReply({ json: release() });
    assert.equal((await r.api.check(true)).status, "latest"); assert.equal(r.calls.length, 2);
  });
  await test("关闭及恢复开关仅写自身内存偏好", async () => {
    const r = runtime(source); r.invoke("set", false);
    assert.equal((await r.api.check(true)).status, "disabled"); assert.equal(r.calls.length, 0);
    r.invoke("set", true); assert.equal((await r.api.check(true)).status, "latest");
    assert.equal(r.writes.length, 2);
  });
  await test("忽略提示不掩盖已发布的新版状态", async () => {
    const r = runtime(source, { reply: { json: release("12.27.0") }, prefs: { enabled: true, dismissedTag: "v12.27.0" } });
    const result = await r.api.check(true);
    assert.equal(result.status, "update-available"); assert.equal(result.dismissed, true);
  });
  if (failures.length) {
    throw new Error("汉化版本检查回归失败：" + failures.map(f => f.name + "（" + f.error + "）").join("；"));
  }
  return { passed, failures };
}

module.exports = { runVersionCheckTests };
