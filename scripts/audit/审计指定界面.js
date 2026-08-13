#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const SHOW_DETAILS = hasFlag("--details");

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

function resolvePortFile() {
  if (!process.env.APPDATA) {
    throw new Error("未设置 APPDATA 环境变量，无法定位 Postman 的 DevToolsActivePort 文件。");
  }
  return path.join(process.env.APPDATA, "Postman", "DevToolsActivePort");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP 请求失败：状态码 ${response.status}，地址 ${url}`);
  }
  return response.json();
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);

  function rejectPending(error) {
    for (const callbacks of pending.values()) {
      clearTimeout(callbacks.timer);
      callbacks.reject(error);
    }
    pending.clear();
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 CDP WebSocket 超时。")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("连接 CDP WebSocket 失败。"));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(callbacks.timer);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      callbacks.resolve(message.result);
    }
  });

  ws.addEventListener("close", () => {
    rejectPending(new Error("CDP WebSocket 已关闭。"));
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 命令执行超时：${method}`));
          }
        }, 20000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    close() {
      rejectPending(new Error("CDP 连接已关闭。"));
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

function norm(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

const ALLOWED_WORDS = new Set(
  "postman api apis url uri http https get post put patch delete head options cookie cookies json xml html javascript oauth jwt bearer websocket graphql grpc mcp socket io ctrl alt shift tab enter esc ai postbot vault llm curl ssl tls tcp udp git sdk rbac"
    .concat(" f x ms rest mqtt none params raw binary urlencoded www form content type tiny validator getpostman interceptor x-www-form-urlencoded content-type")
    .split(/\s+/)
);

const ALLOWED_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Cookie|Postman|API|HTTP|URL|Ctrl|Alt|Shift|Tab|Enter|Esc|JSON|XML|HTML|JavaScript|GraphQL|gRPC|WebSocket|MCP|Postbot|Vault|AI|LLM|cURL|SSL|TLS)$/i;
const SHORTCUT_CHORD = /(?:Ctrl|Alt|Shift|Cmd|Command|Win)(?:\s*\+\s*(?:Ctrl|Alt|Shift|Cmd|Command|Win|Del|Esc|Enter|Tab|Space|F\d{1,2}|[A-Z0-9`\\]))+/gi;

function englishHits(sources, step) {
  const hits = [];
  const seen = new Set();

  for (const source of sources) {
    const fragments = String(source.text || "")
      .split(/(?<=[。！？.!?])\s+/)
      .map(norm)
      .filter(Boolean);

    for (const line of fragments) {
      if (!/[A-Za-z]{2,}/.test(line) || ALLOWED_LINE.test(line)) {
        continue;
      }
      if (source.kind === "attribute" && source.attribute === "aria-label" && /(?:的头像|团队标志)$/.test(line)) {
        continue;
      }
      const textWithoutShortcuts = line.replace(SHORTCUT_CHORD, " ");
      const words = (textWithoutShortcuts.match(/[A-Za-z][A-Za-z'’-]*/g) || []).map((word) => word.toLowerCase());
      const unknown = words.filter((word) => !ALLOWED_WORDS.has(word));
      if (!unknown.length) {
        continue;
      }
      const key = `${source.kind}|${source.attribute || ""}|${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const hit = { text: line, step, kind: source.kind };
      if (source.attribute) {
        hit.attribute = source.attribute;
      }
      if (source.tag) {
        hit.tag = source.tag;
      }
      if (Number.isInteger(source.index)) {
        hit.index = source.index;
      }
      hits.push(hit);
      if (hits.length >= 30) {
        return hits;
      }
    }
  }

  return hits;
}

async function mouse(cdp, type, x, y, button = "left") {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
}

async function clickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
  await mouse(cdp, "mousePressed", x, y);
  await mouse(cdp, "mouseReleased", x, y);
}

async function rightClickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y, "right");
  await mouse(cdp, "mousePressed", x, y, "right");
  await mouse(cdp, "mouseReleased", x, y, "right");
}

async function hoverAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
}

async function pressEsc(cdp) {
  for (let i = 0; i < 2; i += 1) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await sleep(80);
  }
}

async function collectState(cdp, step) {
  const expression = String.raw`(() => {
    const norm = (text) => String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && el.getClientRects().length > 0;
    };
    const isPrivateText = (el) => {
      if (!el || !el.closest) return true;
      if (el.closest("input,textarea,select,[contenteditable='true'],[role='textbox'],.CodeMirror,.cm-editor,.monaco-editor,.ace_editor,.ProseMirror,.pm-response-body,.response-body,[data-testid*='request-body'],[data-testid*='response-body'],[data-testid*='code-editor']")) {
        return true;
      }
      const keyValue = el.closest(".key-value-form-row,.key-value-cell,.key-value-form-column,.key-value-form-editor-sortable,.auto-suggest-group");
      return !!(keyValue && !el.closest(".header-row,.key-value-form-header-row,.key-value-cell__placeholder,.goto-bulk-editor,.bulk-editor-preset__controls"));
    };
    const sources = [];
    const overlaySelector = '[role="tooltip"],[role="menu"],[role="dialog"],.ReactModal__Overlay,[data-testid*="menu"],[data-testid*="modal"]';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textIndex = 0;
    while (walker.nextNode() && textIndex < 1200) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      const text = norm(node.nodeValue);
      if (!text || !isVisible(parent) || isPrivateText(parent)) continue;
      const overlay = parent.closest(overlaySelector);
      sources.push({ text, kind: overlay ? "overlay" : "body", tag: overlay ? overlay.tagName : parent.tagName, index: textIndex });
      textIndex += 1;
    }
    if (norm(document.title)) {
      sources.unshift({ text: norm(document.title), kind: "title", index: 0 });
    }
    let attributeCount = 0;
    Array.from(document.querySelectorAll('[aria-label],[placeholder],input,textarea,button,a,[role="button"],[role="tab"],[role="menuitem"]'))
      .forEach((el, index) => {
        if (attributeCount >= 240) {
          return;
        }
        const explicit = norm(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || "");
        if (explicit) {
          const attribute = el.getAttribute("aria-label") ? "aria-label" : el.getAttribute("placeholder") ? "placeholder" : "title";
          sources.push({ text: explicit, kind: "attribute", attribute, tag: el.tagName, index });
          attributeCount += 1;
        }
      });
    return {
      title: document.title,
      url: location.href,
      sources,
      textNodeCount: textIndex,
      attributeCount
    };
  })()`;
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  const value = result.result.value;
  return {
    step,
    title: value.title,
    url: value.url,
    hits: englishHits(value.sources || [], step),
    textNodeCount: value.textNodeCount,
    attributeCount: value.attributeCount
  };
}

async function waitForTarget(port, timeoutMs, targetTitle) {
  const deadline = Date.now() + timeoutMs;
  const requested = targetTitle ? new RegExp(targetTitle, "i") : null;
  let lastTargets = [];

  while (Date.now() < deadline) {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    lastTargets = targets;
    const pages = targets.filter((target) => {
      return target.type === "page" &&
        target.webSocketDebuggerUrl &&
        !String(target.url || "").startsWith("devtools://");
    });

    if (requested) {
      const match = pages.find((target) => requested.test(`${target.title}\n${target.url}\n${target.id}`));
      if (match) {
        return match;
      }
    }

    const scratchpad = pages.find((target) => /scratchpad\.html/i.test(String(target.url || "")));
    if (scratchpad) {
      return scratchpad;
    }

    const desktop = pages.find((target) => /desktop\.postman\.com/i.test(String(target.url || "")));
    if (desktop) {
      return desktop;
    }

    await sleep(800);
  }

  throw new Error(`未找到 Postman 页面调试目标。当前目标：${JSON.stringify(lastTargets)}`);
}

const ACTIONS = [
  ["hover-new", "hover", 311, 109],
  ["click-new-menu", "click", 311, 109],
  ["hover-new-menu", "hover", 330, 150],
  ["close-new-menu", "esc", 0, 0],
  ["click-import", "click", 353, 109],
  ["hover-import-modal", "hover", 650, 220],
  ["close-import", "esc", 0, 0],
  ["hover-tab", "hover", 468, 110],
  ["right-tab", "right", 468, 110],
  ["close-tab-menu", "esc", 0, 0],
  ["click-plus-tab", "click", 856, 164],
  ["close-plus", "esc", 0, 0],
  ["click-tab-more", "click", 913, 164],
  ["close-tab-more", "esc", 0, 0],
  ["click-method-menu", "click", 440, 199],
  ["hover-method-menu", "hover", 430, 270],
  ["close-method", "esc", 0, 0],
  ["click-auth-tab", "click", 458, 243],
  ["click-headers-tab", "click", 520, 243],
  ["click-body-tab", "click", 588, 243],
  ["click-scripts-tab", "click", 668, 243],
  ["click-tests-tab", "click", 724, 243],
  ["click-settings-tab", "click", 768, 243],
  ["click-params-tab", "click", 410, 243],
  ["hover-save", "hover", 1201, 150],
  ["right-save", "right", 1201, 150],
  ["close-save-menu", "esc", 0, 0],
  ["hover-send", "hover", 1172, 199],
  ["right-send", "right", 1172, 199],
  ["close-send-menu", "esc", 0, 0],
  ["click-send-dropdown", "click", 1222, 199],
  ["hover-send-dropdown", "hover", 1210, 235],
  ["close-send-dropdown", "esc", 0, 0],
  ["click-cookie", "click", 1206, 243],
  ["close-cookie", "esc", 0, 0],
  ["click-top-settings", "click", 984, 24],
  ["hover-top-settings-menu", "hover", 1010, 65],
  ["close-top-settings", "esc", 0, 0],
  ["hover-bottom-console", "hover", 77, 756],
  ["hover-bottom-account", "hover", 190, 756],
  ["hover-help", "hover", 1280, 756]
];

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "60000"));
  const delayMs = Number(argValue("--delay-ms", "800"));
  const outBase = resolveOutBase(argValue("--out", "postman-targeted-audit"));
  const targetTitle = argValue("--target-title", "未命名请求|新建请求|HTTP Request|Untitled Request|Postman");
  const portFile = resolvePortFile();

  if (!fs.existsSync(portFile)) {
    throw new Error("未找到 DevToolsActivePort 文件。请先启动 Postman。");
  }

  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForTarget(port, timeoutMs, targetTitle);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const log = [];

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    log.push(await collectState(cdp, "initial"));

    for (const [name, type, x, y] of ACTIONS) {
      try {
        if (type === "click") {
          await clickAt(cdp, x, y);
        } else if (type === "right") {
          await rightClickAt(cdp, x, y);
        } else if (type === "hover") {
          await hoverAt(cdp, x, y);
        } else if (type === "esc") {
          await pressEsc(cdp);
        }
        await sleep(type === "click" || type === "right" ? Math.max(delayMs, 420) : delayMs);
        log.push(await collectState(cdp, name));
      } catch (error) {
        log.push({ step: name, error: error.message });
      }
    }

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(`${outBase}.png`, Buffer.from(screenshot.data, "base64"));
  } finally {
    cdp.close();
  }

  const hits = [];
  const seenHits = new Set();
  for (const hit of log.flatMap((entry) => entry.hits || [])) {
    const key = `${hit.step}|${hit.kind}|${hit.attribute || ""}|${hit.text}`;
    if (!seenHits.has(key)) {
      seenHits.add(key);
      hits.push(hit);
    }
  }
  const output = {
    target: { title: target.title, url: target.url },
    hitCount: hits.length,
    hits,
    log
  };
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
  const summary = {
    out: `${outBase}.json`,
    screenshot: `${outBase}.png`,
    hitCount: hits.length,
    hits: hits.slice(0, 80)
  };
  console.log(`指定界面审计完成：发现 ${summary.hitCount} 条待复核文本，报告已保存到 ${summary.out}。`);
  if (SHOW_DETAILS) {
    console.log(JSON.stringify(summary, null, 2));
  }
}

function selfTest() {
  const generatedScan = String(collectState);
  const expectedOut = path.resolve(__dirname, "..", "..", "..", "_generated", "自检报告");
  const checks = [
    [/\bel\.value\b/.test(generatedScan), false],
    [/input-value/.test(generatedScan), false],
    [/document\.body\s*(?:&&|\?)\s*document\.body\.innerText/.test(generatedScan), false],
    [/bodyPreview|bodyLines/.test(generatedScan), false],
    [/contenteditable='true'/.test(generatedScan), true],
    [/key-value-form-row/.test(generatedScan), true],
    [resolveOutBase("自检报告"), expectedOut],
    [englishHits([{ text: "Ctrl+K", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "询问 AICtrl+Alt+P", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "连接 Git", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "SDK 生成", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "基础版基于角色的访问控制（RBAC）", kind: "body" }], "self-test").length, 0],
    [englishHits([{ text: "aerozb 的头像", kind: "attribute", attribute: "aria-label" }], "self-test").length, 0],
    [englishHits([{ text: "Press Ctrl+K to search", kind: "body" }], "self-test").length, 1],
    [englishHits([{ text: "Description", kind: "body" }], "self-test").length, 1],
    [Number(argValue("--delay-ms", "800")) >= 800, true]
  ];
  const failed = checks.filter(([actual, expected]) => actual !== expected);
  if (failed.length) {
    throw new Error(`自检失败，共 ${failed.length} 项不符合预期。`);
  }
  const summary = { ok: true, checks: checks.length };
  if (SHOW_DETAILS) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`指定界面审计脚本自检通过，共 ${checks.length} 项。`);
  }
}

Promise.resolve().then(() => hasFlag("--self-test") ? selfTest() : main()).catch((error) => {
  const message = norm(error && error.message || error);
  if (SHOW_DETAILS) {
    console.error(JSON.stringify({ ok: false, error: message, stack: error && error.stack || null }, null, 2));
  } else {
    console.error("指定界面审计失败，请确认 Postman 已启动；可使用 --details 查看详细信息。");
  }
  process.exitCode = 1;
});
