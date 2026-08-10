#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function resolveOutBase(value) {
  const requested = value || "postman-audit";
  const hasDirectory = path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\");
  let resolved = hasDirectory ? requested : path.resolve(__dirname, "..", "..", "..", "_generated", requested);
  if ([".json", ".png"].includes(path.extname(resolved).toLowerCase())) {
    resolved = resolved.slice(0, -path.extname(resolved).length);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function resolvePortFile() {
  if (!process.env.APPDATA) throw new Error("APPDATA is not set; cannot locate Postman DevToolsActivePort.");
  return path.join(process.env.APPDATA, "Postman", "DevToolsActivePort");
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket.")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to CDP websocket."));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    message.error ? callbacks.reject(new Error(message.error.message || JSON.stringify(message.error))) : callbacks.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP command timed out: ${method}`));
          }
        }, 20000);
      });
    },
    close() {
      try { ws.close(); } catch (_) {}
    }
  };
}

async function waitForPostmanTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets;
      const page = targets.find((item) => item.type === "page" &&
        item.webSocketDebuggerUrl &&
        /(?:^https:\/\/desktop\.postman\.com(?::\d+)?(?:[\/?#]|$)|^file:\/\/\/.*\/(?:requester|scratchpad)\.html(?:[?#]|$))/i.test(String(item.url || "")));
      if (page) return page;
    } catch (_) {}
    await sleep(800);
  }
  throw new Error(`Cannot find a Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.text || (details.exception && details.exception.description) || JSON.stringify(details));
  }
  return result.result.value;
}

async function key(cdp, type, keyName, code) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    key: keyName,
    code: keyName
  });
}

async function pressEsc(cdp) {
  await key(cdp, "keyDown", "Escape", 27);
  await key(cdp, "keyUp", "Escape", 27);
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function hoverAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

function clickTargetScript(pattern, options = {}) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, "i");
    const maxX = ${JSON.stringify(options.maxX ?? null)};
    const minY = ${JSON.stringify(options.minY ?? null)};
    const maxY = ${JSON.stringify(options.maxY ?? null)};
    function norm(text) { return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim(); }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        "";
    }
    const matches = Array.from(document.querySelectorAll("button,a,[role='button'],[role='tab'],[role='menuitem'],[aria-label],[title],[tabindex]")).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        w: rect.width,
        h: rect.height
      };
    }).filter((item) => {
      if (!item.text || !re.test(item.text)) return false;
      if (maxX !== null && item.x > maxX) return false;
      if (minY !== null && item.y < minY) return false;
      if (maxY !== null && item.y > maxY) return false;
      return true;
    });
    matches.sort((a, b) => {
      const importButtonA = /sidebar-import-button|^导入$|^Import$/i.test(a.text) ? 0 : 1;
      const importButtonB = /sidebar-import-button|^导入$|^Import$/i.test(b.text) ? 0 : 1;
      return importButtonA - importButtonB || a.y - b.y || a.x - b.x;
    });
    return matches[0] || null;
  })()`;
}

function applicationMenuInvokeScript(menuId) {
  return `(() => {
    try {
      const remote = require("@electron/remote");
      const menu = remote.Menu && remote.Menu.getApplicationMenu && remote.Menu.getApplicationMenu();
      const item = menu && menu.getMenuItemById && menu.getMenuItemById(${JSON.stringify(menuId)});
      if (!item) {
        return { ok: false, reason: "menu-item-not-found", menuId: ${JSON.stringify(menuId)} };
      }
      const win = remote.getCurrentWindow && remote.getCurrentWindow();
      item.click(item, win, { triggeredByAccelerator: false });
      return { ok: true, menuId: ${JSON.stringify(menuId)}, label: item.label || "", enabled: item.enabled };
    } catch (error) {
      return { ok: false, menuId: ${JSON.stringify(menuId)}, error: String(error && error.stack || error) };
    }
  })()`;
}

function stateScript(mode = "full") {
  return String.raw`(() => {
    const MODE = "__MODE__";
    const ALLOWED_WORDS = new Set([
      "postman", "api", "apis", "url", "uri", "http", "https", "json", "xml", "html", "javascript", "graphql", "grpc", "websocket",
      "mqtt", "mcp", "curl", "openapi", "swagger", "wsdl", "har", "yaml", "yml", "csv", "git", "github", "bitbucket", "gitlab",
      "schema", "oauth", "id", "uuid", "ctrl", "alt", "shift", "enter", "esc", "tab", "ai", "sdk", "post", "get", "put", "patch",
      "delete", "head", "options", "fern", "slack", "microsoft", "teams"
    ]);
    function norm(text) { return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), cx: Math.round(rect.x + rect.width / 2), cy: Math.round(rect.y + rect.height / 2) };
    }
    function allowedEnglish(text) {
      const normalized = norm(text);
      if (/头像$|团队标志$/.test(normalized)) return true;
      if (!/[A-Za-z]{2,}/.test(normalized)) return true;
      if (/^https?:\/\//i.test(normalized)) return true;
      if (/^[A-Z0-9_./:-]+$/.test(normalized) && normalized.length <= 36) return true;
      const words = normalized.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
      return words.filter((word) => {
        const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (!lowered || lowered.length <= 1) return false;
        if (ALLOWED_WORDS.has(lowered)) return false;
        if (/^\d/.test(lowered)) return false;
        return true;
      }).length === 0;
    }
    function addHit(hits, text, kind, meta) {
      const value = norm(text);
      if (!value || allowedEnglish(value)) return;
      if (/^(Browse|Choose File|Choose Files|Select File|Select Files|Open File|Open Folder)$/i.test(value)) return;
      if (!hits.has(value)) hits.set(value, { text: value, count: 0, samples: [] });
      const hit = hits.get(value);
      hit.count += 1;
      if (hit.samples.length < 6) hit.samples.push(Object.assign({ kind }, meta || {}));
    }
    const roots = MODE === "overlay" ? Array.from(document.querySelectorAll([
      "[role='dialog']", "[aria-modal='true']", "[role='menu']", "[role='listbox']", "[role='tooltip']",
      ".ReactModal__Content", ".ReactModal__Overlay", "[data-testid*='modal']", "[data-testid*='popover']",
      "[data-testid='aether-button-tooltip']", "[data-aether-id*='popover']", "[data-aether-id*='modal']"
    ].join(","))).filter(visible) : [document.body || document.documentElement].filter(Boolean);
    const hits = new Map();
    const textParts = [];
    for (const root of roots) {
      textParts.push(norm(root.innerText || root.textContent || ""));
      for (const line of String(root.innerText || "").split(/\n| {2,}/)) addHit(hits, line, MODE, { tag: root.tagName, role: root.getAttribute && root.getAttribute("role") || "" });
    }
    const attrNames = ["aria-label", "title", "placeholder", "alt"];
    const visibleElements = (MODE === "overlay" ? roots : [document.body || document.documentElement]).filter(Boolean).flatMap((root) => {
      if (!root.querySelectorAll) return [];
      return [root].concat(Array.from(root.querySelectorAll("*")));
    }).filter(visible);
    for (const el of visibleElements) {
      for (const attr of attrNames) {
        if (el.hasAttribute(attr)) addHit(hits, el.getAttribute(attr), "attr", Object.assign({ attr, tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
      }
    }
    const targetRoots = MODE === "overlay" ? roots : [document.body || document.documentElement].filter(Boolean);
    const targets = targetRoots.flatMap((root) => {
      if (!root.querySelectorAll) return [];
      return Array.from(root.querySelectorAll("button,a,[role='button'],[role='tab'],[role='menuitem'],[aria-label],[title],[tabindex]"));
    }).filter(visible).map((el) => {
      const text = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || el.getAttribute("data-testid") || "");
      return Object.assign({ text, tag: el.tagName, role: norm(el.getAttribute("role")) }, rectOf(el));
    }).filter((item) => item.text);
    return {
      title: document.title,
      url: location.href,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      text: norm(textParts.join("\n")).slice(0, 1800),
      hits: Array.from(hits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      targets: targets.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 160)
    };
  })()`.replace("__MODE__", mode);
}

async function clickPattern(cdp, pattern, delayMs, options = {}) {
  const target = await evaluate(cdp, clickTargetScript(pattern, options));
  if (!target) return { ok: false, pattern, options };
  await clickAt(cdp, target.x, target.y);
  await sleep(delayMs);
  return { ok: true, pattern, target };
}

function importHandleInvokeScript() {
  return `(() => {
    try {
      let req = window.__POSTMAN_ZH_WEBPACK_REQUIRE__;
      if (!req && window.webpackChunk_postman_app_renderer && window.webpackChunk_postman_app_renderer.push) {
        window.webpackChunk_postman_app_renderer.push([[Math.floor(Math.random() * 1000000000)], {}, function (runtimeRequire) {
          req = runtimeRequire;
          window.__POSTMAN_ZH_WEBPACK_REQUIRE__ = runtimeRequire;
        }]);
      }
      if (!req) {
        return { ok: false, reason: "webpack-require-not-found" };
      }
      const mod = req(106526);
      const fn = mod && (mod.handleImport || (mod.default && mod.default.handleImport));
      if (typeof fn !== "function") {
        return { ok: false, reason: "handleImport-not-found", keys: mod && Object.keys(mod) };
      }
      Promise.resolve(fn({ origin: "global", referrer: "postman-zh-audit" })).catch(function () {});
      return { ok: true, via: "webpack-handleImport" };
    } catch (error) {
      return { ok: false, reason: "handleImport-error", error: String(error && error.stack || error) };
    }
  })()`;
}

function isImportDialogState(state) {
  const text = `${state && state.text || ""}`;
  return /(?:导入|Import)/i.test(text) &&
    /(?:文件|链接|原始文本|Raw|Paste|选择|拖放|OpenAPI|cURL|Postman Collection|集合|工作区|workspace)/i.test(text);
}

function mergeHits(allHits, step, hits) {
  for (const hit of hits || []) {
    if (!allHits.has(hit.text)) allHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
    const current = allHits.get(hit.text);
    current.count += hit.count || 1;
    for (const sample of hit.samples || []) {
      if (current.samples.length < 10) current.samples.push(Object.assign({ step }, sample));
    }
  }
}

async function collect(cdp, step, allHits, log, mode = "overlay") {
  const state = await evaluate(cdp, stateScript(mode));
  mergeHits(allHits, step, state.hits);
  log.push({ step, state });
  return state;
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const delayMs = Number(argValue("--delay-ms", "300"));
  const hoverLimit = Number(argValue("--hover-limit", "10"));
  const outBase = resolveOutBase(argValue("--out", "postman-import-audit"));
  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) throw new Error("DevToolsActivePort not found. Start Postman first.");

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const allHits = new Map();
  const log = [];

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(150);

    const internalOpened = await evaluate(cdp, importHandleInvokeScript());
    await sleep(Math.max(delayMs + 1300, 1800));
    let opened = { ok: !!internalOpened.ok, via: "webpack-handleImport", result: internalOpened };
    log.push({ step: "open-import-internal", opened });

    if (!opened.ok) {
      const menuOpened = await evaluate(cdp, applicationMenuInvokeScript("import"));
      await sleep(Math.max(delayMs + 650, 950));
      opened = { ok: !!menuOpened.ok, via: "application-menu", result: menuOpened };
      log.push({ step: "open-import-menu-fallback", opened });
    }

    let importDialogProbe = await evaluate(cdp, stateScript("overlay"));
    log.push({ step: "open-import-probe", detected: isImportDialogState(importDialogProbe), state: importDialogProbe });

    if (!isImportDialogState(importDialogProbe)) {
      await pressEsc(cdp);
      await sleep(120);
      const projectTab = await clickPattern(cdp, "^项目$|^Collections$|^Projects$", Math.max(delayMs, 300), { maxY: 100 });
      log.push({ step: "open-project-sidebar", projectTab });
      await sleep(150);

      const sideOpened = await clickPattern(cdp, "^导入$|^Import$", Math.max(delayMs + 500, 850), { maxX: 480, minY: 90 });
      opened = { ok: sideOpened.ok, via: "sidebar", result: sideOpened };
      log.push({ step: "open-import-sidebar-fallback", opened });
      importDialogProbe = await evaluate(cdp, stateScript("overlay"));
      log.push({ step: "open-import-sidebar-probe", detected: isImportDialogState(importDialogProbe), state: importDialogProbe });
    }

    const initialState = await collect(cdp, "import-initial", allHits, log, "overlay");
    const importDialogDetected = isImportDialogState(initialState);

    const tabPatterns = [
      "^文件$|^File$|^Files$",
      "^文件夹$|^Folder$|^Folders$",
      "^链接$|^Link$|^URL$",
      "^原始文本$|^Raw text$|^Raw Text$|^Raw$",
      "^代码仓库$|^Repository$|^Code repository$|^Git repository$"
    ];

    for (let i = 0; i < tabPatterns.length; i += 1) {
      const clicked = await clickPattern(cdp, tabPatterns[i], delayMs, { minY: 80 });
      log.push({ step: `import-tab-${i}`, clicked });
      await collect(cdp, `import-after-tab-${i}`, allHits, log, "overlay");
    }

    const hoverState = await evaluate(cdp, stateScript("overlay"));
    const hoverTargets = (hoverState.targets || [])
      .filter((item) => !/选择文件|浏览|上传|Choose File|Browse|Upload/i.test(item.text || ""))
      .slice(0, hoverLimit);
    for (let i = 0; i < hoverTargets.length; i += 1) {
      const item = hoverTargets[i];
      await hoverAt(cdp, item.cx, item.cy);
      await sleep(Math.max(delayMs, 260));
      await collect(cdp, `import-hover-${i}`, allHits, log, "overlay");
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(`${outBase}.png`, Buffer.from(shot.data, "base64"));

    const hits = Array.from(allHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    const output = {
      target: { title: target.title, url: target.url },
      importDialogDetected,
      hitCount: hits.length,
      hits,
      log,
      screenshot: `${outBase}.png`
    };
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    console.log(JSON.stringify({
      out: `${outBase}.json`,
      screenshot: `${outBase}.png`,
      hitCount: hits.length,
      hits: hits.slice(0, 60).map((item) => item.text),
      importDialogDetected,
      opened
    }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
