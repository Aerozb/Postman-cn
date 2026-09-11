"use strict";

// 由统一入口 verify / install 调用。payload\zh-oopif-inject-main.js 的隔离回归：
// Electron、fs 全用内存桩，不启动窗口、不读真实 payload、不碰用户数据。
//
// 为什么值得单独测：这份逻辑的正确性全在边界条件上——注错站点会把脚本送进第三方
// 页面，漏判 processId 会白传 2.3 MB 源码，主帧重复注入会和 preload 打架。
// 这些都不是"代码看着对"能保证的。
//
// 真实浏览器行为（preload 进不去 OOPIF、webFrameMain 能进）由
// _generated/oopif-exp 那两轮同版本 Electron 实测确认，不在这里重复。
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");

const MODULE_PATH = path.join(__dirname, "..", "..", "payload", "zh-oopif-inject-main.js");

// 假 frame：只实现被测代码用到的那几个成员
function makeFrame(options = {}) {
  const frame = {
    url: options.url === undefined ? "https://desktop.postman.com/" : options.url,
    processId: options.processId === undefined ? 1 : options.processId,
    frames: options.frames || [],
    executed: [],
  };
  frame.executeJavaScript = (source) => {
    frame.executed.push(source);
    if (options.reject) {
      return Promise.reject(new Error("fixture inject failure"));
    }
    return Promise.resolve(true);
  };
  if (options.urlThrows) {
    Object.defineProperty(frame, "url", {
      get() { throw new Error("fixture frame destroyed"); },
    });
  }
  if (options.processIdThrows) {
    Object.defineProperty(frame, "processId", {
      get() { throw new Error("fixture processId unavailable"); },
    });
  }
  if (options.framesThrows) {
    Object.defineProperty(frame, "frames", {
      get() { throw new Error("fixture frames unavailable"); },
    });
  }
  return frame;
}

class FakeWebContents extends EventEmitter {
  constructor(mainFrame) {
    super();
    this._mainFrame = mainFrame;
  }
  get mainFrame() {
    return this._mainFrame;
  }
}

// 在 VM 里加载被测模块，fs.readFileSync 返回一个短桩而不是真实 2.3 MB payload
function load(options = {}) {
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  const warnings = [];
  const payloadStub = options.payload === undefined ? "/*payload*/" : options.payload;
  const fsStub = {
    readFileSync(file) {
      if (options.payloadReadFails) {
        throw new Error("fixture payload missing");
      }
      assert.equal(path.basename(file), "zh-localize.js");
      return payloadStub;
    },
  };
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === "fs") return fsStub;
      if (name === "path") return path;
      throw new Error("unexpected require: " + name);
    },
    console: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
    setTimeout,
    clearTimeout,
    URL,
    globalThis: {},
    Promise,
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.__dirname = path.dirname(MODULE_PATH);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: MODULE_PATH });
  return { api: sandbox.module.exports, warnings, sandbox };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function runOopifInjectTests() {
  const failures = [];
  let passed = 0;

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
    } catch (e) {
      failures.push({ name, error: e && e.message ? e.message : String(e) });
    }
  }

  // ---- 站点白名单：注错站点等于把脚本送进第三方页面 ----
  await test("只对 Postman 自己的站点注入", () => {
    const { api } = load();
    assert.equal(api.shouldInject("https://desktop.postman.com/"), true);
    assert.equal(api.shouldInject("https://go.postman.co/build"), true);
    assert.equal(api.shouldInject("https://www.getpostman.com/x"), true);
    assert.equal(api.shouldInject("http://desktop.postman.com/"), true);
  });

  // 这批域名是 2026-09-11 从运行中的 Postman 12.27.5 页面 CSP frame-src 实测取到的。
  // 最早的白名单漏了 *.pstmn.io 和 postmancloud.com，会把真实的 Postman 子帧挡在外面。
  await test("CSP 里的 Postman 自有子帧域都要放行", () => {
    const { api } = load();
    assert.equal(api.shouldInject("https://dl-preview-container.pstmn.io/x"), true);
    assert.equal(api.shouldInject("https://client-proxy.pstmn.io/x"), true);
    assert.equal(api.shouldInject("https://skills-assets.pstmn.io/x"), true);
    assert.equal(api.shouldInject("https://flows-assets.pstmn.io/x"), true);
    assert.equal(api.shouldInject("https://runtime-assets.pstmn.io/x"), true);
    assert.equal(api.shouldInject("https://looker.postman.co/dash"), true);
    assert.equal(api.shouldInject("https://flow.cdn.postman.com/x"), true);
    assert.equal(api.shouldInject("https://voyager.postman.com/x"), true);
    assert.equal(api.shouldInject("https://connect.us.integrations.postmancloud.com/x"), true);
  });

  // CSP frame-src 里也列了 Stripe，但那是第三方支付页面：不该翻译，更不该注入脚本。
  await test("CSP 允许但属于第三方的支付域不注入", () => {
    const { api } = load();
    assert.equal(api.shouldInject("https://js.stripe.com/v3"), false);
    assert.equal(api.shouldInject("https://hooks.stripe.com/x"), false);
  });

  await test("第三方站点一律不注入", () => {
    const { api } = load();
    assert.equal(api.shouldInject("https://example.com/"), false);
    assert.equal(api.shouldInject("https://accounts.google.com/signin"), false);
    // 后缀伪装：notpostman.com 不是 postman.com 的子域
    assert.equal(api.shouldInject("https://notpostman.com/"), false);
    // 新增域的后缀伪装也要挡住
    assert.equal(api.shouldInject("https://evilpstmn.io/"), false);
    assert.equal(api.shouldInject("https://notpostmancloud.com/"), false);
    // 域名出现在路径或查询里也不算
    assert.equal(api.shouldInject("https://evil.com/?x=postman.com"), false);
    assert.equal(api.shouldInject("https://evil.com/postman.com"), false);
    // 用户名段伪装
    assert.equal(api.shouldInject("https://postman.com@evil.com/"), false);
  });

  await test("非 http(s) 协议不注入", () => {
    const { api } = load();
    assert.equal(api.shouldInject("about:blank"), false);
    assert.equal(api.shouldInject("file:///C:/x/requester.html"), false);
    assert.equal(api.shouldInject("devtools://devtools/bundled/x.js"), false);
    assert.equal(api.shouldInject("javascript:alert(1)"), false);
    assert.equal(api.shouldInject(""), false);
    assert.equal(api.shouldInject(null), false);
    assert.equal(api.shouldInject(undefined), false);
  });

  // ---- 只注跨进程子帧：主帧和同进程子帧已由 preload 覆盖 ----
  await test("跨进程子帧会被注入", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 1);
    assert.match(child.executed[0], /payload/);
    // 末尾补 ;true，避免把 IIFE 返回值序列化回主进程
    assert.match(child.executed[0], /;true$/);
  });

  await test("主帧不重复注入（preload 已覆盖）", async () => {
    const { api } = load();
    const main = makeFrame({ processId: 1 });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(main.executed.length, 0);
  });

  await test("同进程子帧不注入（preload 已覆盖）", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 1 });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 0);
  });

  await test("跨进程但站点不在白名单的子帧不注入", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2, url: "https://example.com/ad" });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 0);
  });

  await test("深层嵌套的跨进程子帧也会被注入", async () => {
    const { api } = load();
    const deep = makeFrame({ processId: 3, url: "https://go.postman.co/deep" });
    const mid = makeFrame({ processId: 2, frames: [deep] });
    const main = makeFrame({ processId: 1, frames: [mid] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(mid.executed.length, 1);
    assert.equal(deep.executed.length, 1);
  });

  // ---- did-frame-navigate：实测中这是唯一对子帧触发的时机 ----
  await test("子帧导航后立即注入", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    const wc = new FakeWebContents(main);
    const app = new EventEmitter();
    api.install(app);
    app.emit("web-contents-created", {}, wc);
    wc.emit("did-frame-navigate", { frame: child }, child.url, 200, "OK", false);
    await flush();
    assert.equal(child.executed.length, 1);
  });

  await test("主帧导航不触发注入", async () => {
    const { api } = load();
    const main = makeFrame({ processId: 1 });
    const wc = new FakeWebContents(main);
    const app = new EventEmitter();
    api.install(app);
    app.emit("web-contents-created", {}, wc);
    wc.emit("did-frame-navigate", { frame: main }, main.url, 200, "OK", true);
    await flush();
    assert.equal(main.executed.length, 0);
  });

  await test("事件拿不到 frame 时回退遍历整棵树", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    const wc = new FakeWebContents(main);
    const app = new EventEmitter();
    api.install(app);
    app.emit("web-contents-created", {}, wc);
    // 没有 event.frame，应走 injectAll 兜底
    wc.emit("did-frame-navigate", {}, child.url, 200, "OK", false);
    await flush();
    assert.equal(child.executed.length, 1);
  });

  await test("子帧刷新后再注入一次", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    const wc = new FakeWebContents(main);
    const app = new EventEmitter();
    api.install(app);
    app.emit("web-contents-created", {}, wc);
    wc.emit("did-frame-navigate", { frame: child }, child.url, 200, "OK", false);
    await flush();
    wc.emit("did-frame-navigate", { frame: child }, child.url, 200, "OK", false);
    await flush();
    assert.equal(child.executed.length, 2);
  });

  // ---- 幂等与去重 ----
  await test("同一个 webContents 只挂接一次", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    const wc = new FakeWebContents(main);
    const app = new EventEmitter();
    api.install(app);
    app.emit("web-contents-created", {}, wc);
    app.emit("web-contents-created", {}, wc);
    wc.emit("did-frame-navigate", { frame: child }, child.url, 200, "OK", false);
    await flush();
    // 若重复挂接，这里会是 2
    assert.equal(child.executed.length, 1);
  });

  await test("install 重复调用只注册一次监听", () => {
    const { api } = load();
    const app = new EventEmitter();
    api.install(app);
    api.install(app);
    assert.equal(app.listenerCount("web-contents-created"), 1);
  });

  await test("install 传入空值不抛异常", () => {
    const { api } = load();
    api.install(null);
    api.install(undefined);
  });

  // main.js 里的钩子写的是 require("./js/zh-oopif-inject-main.js").install(E)，
  // 传进来的是**整个 electron 模块**，不是 app 对象。
  // 2026-09-11 首轮端到端实测就栽在这里：install(app) 只认 app，拿到模块后
  // app.on 不存在，异常被 try/catch 吞掉，日志里一行都没有，
  // 补丁"装上了"但运行时完全没生效。而当时这份回归 24 项全过——
  // 因为桩一直直接传 app，从没复现真实调用方式。这条用例就是为了钉住它。
  await test("install 接受整个 electron 模块（复现 main.js 钩子的真实传法）", async () => {
    const { api } = load();
    const app = new EventEmitter();
    api.install({ app });          // 关键：模拟 install(E) 而不是 install(E.app)
    assert.equal(app.listenerCount("web-contents-created"), 1);

    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    const wc = new FakeWebContents(main);
    app.emit("web-contents-created", {}, wc);
    wc.emit("did-frame-navigate", { frame: child }, child.url, 200, "OK", false);
    await flush();
    assert.equal(child.executed.length, 1);
  });

  await test("install 传入既非 app 也无 app 字段的对象不抛异常", () => {
    const { api } = load();
    api.install({});
    api.install({ app: null });
    api.install({ app: {} });
    api.install(42);
    api.install("electron");
  });

  // ---- 失败必须只 warn，绝不影响 Postman 启动和主帧汉化 ----
  await test("读取 payload 失败只 warn 不抛", async () => {
    const { api, warnings } = load({ payloadReadFails: true });
    const child = makeFrame({ processId: 2 });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 0);
    assert.ok(warnings.some((w) => /zh-localize\.js/.test(w)));
  });

  await test("注入被拒绝只 warn 不抛未处理拒绝", async () => {
    const { api, warnings } = load();
    const child = makeFrame({ processId: 2, reject: true });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    await flush();
    assert.ok(warnings.some((w) => /注入失败/.test(w)));
  });

  await test("frame 已销毁（读 url 抛异常）时安全跳过", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2, urlThrows: true });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 0);
  });

  await test("拿不到 processId 时保守注入（宁多勿漏）", async () => {
    const { api } = load();
    const child = makeFrame({ processId: 2, processIdThrows: true });
    const main = makeFrame({ processId: 1, frames: [child] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(child.executed.length, 1);
  });

  await test("子帧列表不可读时不影响其余 frame", async () => {
    const { api } = load();
    const bad = makeFrame({ processId: 2, framesThrows: true });
    const good = makeFrame({ processId: 3, url: "https://go.postman.co/x" });
    const main = makeFrame({ processId: 1, frames: [bad, good] });
    api.injectAll(new FakeWebContents(main));
    await flush();
    assert.equal(bad.executed.length, 1);
    assert.equal(good.executed.length, 1);
  });

  await test("mainFrame 不可读时安全返回", () => {
    const { api } = load();
    const wc = {
      get mainFrame() { throw new Error("fixture mainFrame unavailable"); },
    };
    api.injectAll(wc);
  });

  await test("mainFrame 为空时安全返回", () => {
    const { api } = load();
    api.injectAll(new FakeWebContents(null));
  });

  if (failures.length) {
    throw new Error(
      "跨站子帧注入回归失败：" +
        failures.map((f) => f.name + "（" + f.error + "）").join("；")
    );
  }
  return { passed, failures };
}

module.exports = { runOopifInjectTests };

if (require.main === module) {
  runOopifInjectTests()
    .then((r) => {
      console.log("跨站子帧注入回归通过：" + r.passed + " 项");
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
