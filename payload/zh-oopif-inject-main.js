"use strict";

// 跨站 iframe（OOPIF）汉化注入（主进程侧）。
//
// 为什么需要这个文件：
//   运行时翻译器一直靠 preload 注入（见 Patch-Preload）。preload 只作用于
//   **同一个渲染进程里的 frame**：Chromium 站点隔离下，跨站 iframe 会被放进
//   独立的渲染进程（out-of-process iframe，简称 OOPIF），preload 到不了那里。
//   payload/zh-localize.js 里的 walkSameOriginIframes 也只能处理**同源** iframe
//   （靠 frame.contentDocument，跨源直接抛异常），所以 OOPIF 里的英文文案
//   两条路都覆盖不到。
//
// 2026-09-11 用同版本 Electron（37.10.3 / Chrome 138.0.7204.251）实测了四条路径，
// 用 127.0.0.1 主页嵌 localhost 子帧构造真实 OOPIF（子帧进程号与主帧不同，已确认）：
//
//   | 路径                                   | 主帧 | OOPIF 子帧 |
//   |----------------------------------------|------|-----------|
//   | webPreferences.preload                 | 生效 | **进不去** |
//   | webFrameMain.executeJavaScript         | 生效 | **能进**   |
//   | webContents.on('frame-created')        | 触发两次但 url 为空，拿不到导航后的 frame |
//   | debugger + Target.setAutoAttach + CDP  | 主 target Page.enable 超时 | 能进 |
//
// 选 webFrameMain.executeJavaScript（第二条），不用 CDP（第四条），两个原因：
//   1. CDP 路径实测不稳：主 target 的 Page.enable 会超时。
//   2. 无需占用 wc.debugger 附加会话，避免给用户 DevTools 和按需诊断增加耦合。
//
// 第二轮实测（真实 payload 2.3 MB 注入跨站子帧）确认端到端可用：
//   文本节点、title、aria-label 属性全部翻译；子帧内部 600ms / 1800ms 后
//   异步插入的文案也被翻译（MutationObserver 在 OOPIF 里正常存活）；
//   子帧刷新后靠 did-frame-navigate 再注入一次即可恢复。
//
// 失败一律只 warn，绝不影响 Postman 启动或主帧汉化——这是纯增量补充。

const fs = require("fs");
const path = require("path");

// 注入目标白名单：只对 Postman 自己的站点注入，不碰任何第三方页面。
// 登录/授权 webview 另有 zh-auth-webview-preload.js 负责，不在这里重复。
//
// 域名清单不是猜的：2026-09-11 从运行中的 Postman 12.27.5 实测取到页面自己的
// CSP frame-src 白名单，里面 Postman 自有域是这几个：
//   *.postman.com  *.postman.co  *.getpostman.com  *.cdn.postman.com  www.postman.com
//   *.pstmn.io（dl-preview-container / client-proxy / skills-assets / flows-assets
//               / runtime-assets 都在这个域下）
//   connect.us.integrations.postmancloud.com
// 最早只写了 postman.com|postman.co|getpostman.com，会把 *.pstmn.io 和
// postmancloud.com 这两类**真实存在的 Postman 子帧**挡在外面——那正是要覆盖的目标。
//
// 刻意不含 js.stripe.com / hooks.stripe.com：那是第三方支付页面，
// 既不该翻译，也不该由我们注入脚本。
const ALLOWED_HOST_RE = /(?:^|\.)(?:postman\.com|postman\.co|getpostman\.com|pstmn\.io|postmancloud\.com)$/i;

let payloadSource = null;
let payloadError = null;
const frameInjections = new WeakMap();
const LOCALIZER_PROBE = "Boolean(window.__POSTMAN_ZH_LOCALIZER__)";

function loadPayload() {
  if (payloadSource !== null || payloadError !== null) {
    return payloadSource;
  }
  try {
    // 与 preload 注入用的是同一个文件，词典只有一份数据源
    payloadSource = fs.readFileSync(path.join(__dirname, "zh-localize.js"), "utf8");
  } catch (e) {
    payloadError = e;
    warn("读取 zh-localize.js 失败，OOPIF 汉化已跳过", e);
  }
  return payloadSource;
}

function warn(message, err) {
  try {
    console.warn("postman-zh oopif: " + message, err || "");
  } catch (e) {}
}

function shouldInject(url) {
  if (typeof url !== "string" || !/^https?:/i.test(url)) {
    return false;
  }
  try {
    return ALLOWED_HOST_RE.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// 只对跨进程的子 frame 注入。主 frame 和同进程子 frame 已由 preload 覆盖，
// 重复注入虽被 payload 自身的 __POSTMAN_ZH_LOCALIZER__ 守卫拦住，
// 但那要先传 2.3 MB 源码过去，白花开销。
function isOutOfProcess(frame, mainFrame) {
  if (!frame || !mainFrame || frame === mainFrame) {
    return false;
  }
  try {
    return frame.processId !== mainFrame.processId;
  } catch (e) {
    // 拿不到 processId 时保守注入：多注一次比漏翻好
    return true;
  }
}

function injectInto(frame, mainFrame, verifyDocument = false) {
  if (!frame) {
    return;
  }
  let url = "";
  try {
    url = frame.url || "";
  } catch (e) {
    return; // frame 已销毁
  }
  if (!shouldInject(url) || !isOutOfProcess(frame, mainFrame)) {
    return;
  }
  const previous = frameInjections.get(frame);
  if (!verifyDocument && previous && previous.url === url) {
    // 同文档已完成或仍在注入；frame-created 的兜底不再重复传送整份词典。
    return;
  }
  const state = { url };
  frameInjections.set(frame, state);
  const current = () => frameInjections.get(frame) === state;
  const failed = (error) => {
    // 导航期间旧文档的迟到 Promise 不干扰新文档状态；失败仍允许后续兜底重试。
    if (current()) frameInjections.delete(frame);
    warn("向 OOPIF 注入失败 " + url, error);
  };
  const executePayload = () => {
    if (!current()) return;
    const source = loadPayload();
    if (!source) {
      frameInjections.delete(frame);
      return;
    }
    try {
      // 末尾补 ;true 避免把 IIFE 的返回值序列化回主进程。
      Promise.resolve(frame.executeJavaScript(source + "\n;true")).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  if (verifyDocument) {
    // 旧版事件若未给出 frame 标识，逐帧做短探测：既识别同址刷新，也免于重传已就绪的兄弟帧。
    try {
      Promise.resolve(frame.executeJavaScript(LOCALIZER_PROBE)).then((localized) => {
        if (!localized) executePayload();
      }).catch(failed);
    } catch (error) {
      failed(error);
    }
  } else {
    executePayload();
  }
}

// 遍历整棵 frame 树补注入。用于两种情形：
//   1. 补上在钩子安装之前就已经导航完成的 frame
//   2. did-frame-navigate 给的 frame 标识拿不到对象时的兜底
function injectAll(webContents, verifyDocument = false) {
  let mainFrame = null;
  try {
    mainFrame = webContents.mainFrame;
  } catch (e) {
    return;
  }
  if (!mainFrame) {
    return;
  }
  const stack = [mainFrame];
  while (stack.length) {
    const frame = stack.pop();
    injectInto(frame, mainFrame, verifyDocument);
    let kids = [];
    try {
      kids = frame.frames || [];
    } catch (e) {
      kids = [];
    }
    for (const kid of kids) {
      stack.push(kid);
    }
  }
}

function navigatedFrame(event, processId, routingId) {
  try {
    if (event && event.frame) return event.frame;
  } catch (e) {}
  if (Number.isInteger(processId) && Number.isInteger(routingId)) {
    try {
      const { webFrameMain } = require("electron");
      if (webFrameMain && typeof webFrameMain.fromId === "function") {
        return webFrameMain.fromId(processId, routingId);
      }
    } catch (e) {}
  }
  return null;
}

function attach(webContents) {
  if (!webContents || webContents.__postmanZhOopifHooked) {
    return;
  }
  webContents.__postmanZhOopifHooked = true;

  // did-frame-navigate 是关键事件：它对**子 frame** 也触发，而 dom-ready 只管主 frame。
  // 实测每次子帧导航（含刷新）都会触发，注入时机足够早——首屏文案就已是中文。
  webContents.on("did-frame-navigate", (event, url, httpResponseCode, httpStatusText, isMainFrame, processId, routingId) => {
    if (isMainFrame) {
      return; // 主 frame 由 preload 负责
    }
    const frame = navigatedFrame(event, processId, routingId);
    if (frame) {
      // 以导航事件而非 URL 标识新文档；同一地址刷新也应重新注入。
      frameInjections.delete(frame);
      let mainFrame = null;
      try {
        mainFrame = webContents.mainFrame;
      } catch (e) {}
      injectInto(frame, mainFrame);
    } else {
      injectAll(webContents, true);
    }
  });

  // frame-created 时 frame 往往还没导航（实测 url 为空），不能直接注入；
  // 真正的注入交给上面的 did-frame-navigate。这里只兜住「创建后不再导航」的情况。
  let sweepTimer = null;
  webContents.on("frame-created", () => {
    if (sweepTimer !== null) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      try {
        injectAll(webContents);
      } catch (e) {}
    }, 400);
  });
  webContents.once("destroyed", () => {
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    sweepTimer = null;
  });
}

// 参数既接受 electron 模块本身，也接受 app 对象。
//
// 2026-09-11 实测踩到的 bug：main.js 里的钩子传的是整个 electron 模块
// （`require("./js/zh-oopif-inject-main.js").install(E)`，E = require("electron")），
// 而这里最早只当它是 app，于是 `app.on("web-contents-created")` 打在 electron
// 模块上——模块没有 .on，异常被 try/catch 静静吞掉，日志里一行都没有，
// 补丁"装好了"但运行时完全没生效。端到端实测（真实 OOPIF 里 hasLocalizer:false）
// 才暴露出来。两种传法都兼容，避免钩子和实现再次对不上。
function resolveApp(candidate) {
  if (!candidate) {
    return null;
  }
  // app 对象自己就有 on / whenReady
  if (typeof candidate.on === "function" && typeof candidate.whenReady === "function") {
    return candidate;
  }
  // 传进来的是 electron 模块
  if (candidate.app && typeof candidate.app.on === "function") {
    return candidate.app;
  }
  if (typeof candidate.on === "function") {
    return candidate;
  }
  return null;
}

function install(candidate) {
  if (globalThis.__postmanZhOopifInject) {
    return false;
  }
  const app = resolveApp(candidate);
  if (!app) {
    warn("拿不到 app 对象，OOPIF 汉化已跳过");
    return false;
  }
  globalThis.__postmanZhOopifInject = true;
  try {
    app.on("web-contents-created", (event, webContents) => {
      try {
        attach(webContents);
      } catch (e) {
        warn("挂接 webContents 失败", e);
      }
    });
  } catch (e) {
    warn("安装 OOPIF 汉化钩子失败", e);
    return false;
  }

  // 钩子可能装在部分 webContents 创建之后（main.js 顶部虽早，但不保证早于全部）。
  // 补一次已存在的 webContents，并对已导航完成的子帧补注入。
  try {
    const { webContents } = require("electron");
    if (webContents && typeof webContents.getAllWebContents === "function") {
      for (const wc of webContents.getAllWebContents()) {
        try {
          attach(wc);
          injectAll(wc);
        } catch (e) {}
      }
    }
  } catch (e) {}
  return true;
}

module.exports = { install, resolveApp, shouldInject, injectAll, ALLOWED_HOST_RE };
