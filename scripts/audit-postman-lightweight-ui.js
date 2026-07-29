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
  const resolved = hasDirectory ? requested : path.resolve(__dirname, "..", "..", "_generated", requested);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
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
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      callbacks.resolve(message.result);
    }
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
        }, 30000);
      });
    },
    close() {
      try {
        ws.close();
      } catch (_) {}
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function key(cdp, type, keyName, code) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key: keyName,
    code: keyName,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code
  });
}

async function pressEsc(cdp) {
  await key(cdp, "keyDown", "Escape", 27);
  await key(cdp, "keyUp", "Escape", 27);
}

async function mouse(cdp, type, x, y, button = "left") {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
}

async function clickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
  await sleep(60);
  await mouse(cdp, "mousePressed", x, y);
  await mouse(cdp, "mouseReleased", x, y);
}

async function rightClickAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y, "right");
  await sleep(60);
  await mouse(cdp, "mousePressed", x, y, "right");
  await mouse(cdp, "mouseReleased", x, y, "right");
}

async function hoverAt(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function findTargetScript(patterns, options = {}) {
  const patternSource = patterns.map((pattern) => pattern instanceof RegExp ? pattern.source : String(pattern));
  const flags = patterns.map((pattern) => pattern instanceof RegExp ? pattern.flags : "i");
  return `(() => {
    const sources = ${JSON.stringify(patternSource)};
    const flags = ${JSON.stringify(flags)};
    const patterns = sources.map((source, index) => new RegExp(source, flags[index] || "i"));
    const options = ${JSON.stringify(options)};
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid"));
    }
    const selector = [
      "button", "a", "input", "textarea", "[role]", "[aria-label]",
      "[title]", "[placeholder]", "[tabindex]", "[data-testid]", "[data-tab-id]"
    ].join(",");
    const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    const matches = nodes.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: labelOf(el),
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2
      };
    }).filter((item) => {
      if (!item.text) return false;
      if (options.minX != null && item.cx < options.minX) return false;
      if (options.maxX != null && item.cx > options.maxX) return false;
      if (options.minY != null && item.cy < options.minY) return false;
      if (options.maxY != null && item.cy > options.maxY) return false;
      return patterns.some((pattern) => pattern.test(item.text));
    }).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return matches[0] || null;
  })()`;
}

async function clickText(cdp, patterns, delayMs, options = {}) {
  const target = await evaluate(cdp, findTargetScript(patterns, options));
  if (!target) {
    return { ok: false, patterns: patterns.map(String), options };
  }
  await clickAt(cdp, target.cx, target.cy);
  await sleep(delayMs);
  return { ok: true, target };
}

async function clickSearchFilter(cdp, patterns, delayMs) {
  const patternSources = patterns.map((pattern) => pattern instanceof RegExp ? pattern.source : String(pattern));
  const flags = patterns.map((pattern) => pattern instanceof RegExp ? pattern.flags : "i");
  const target = await evaluate(cdp, `(() => {
    const patterns = ${JSON.stringify(patternSources)}.map((source, index) => new RegExp(source, ${JSON.stringify(flags)}[index] || "i"));
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/[\\u200b-\\u200d\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    return Array.from(document.querySelectorAll(".pm-search-filter-menu, .search-result-badge"))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: norm(el.innerText || el.textContent),
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2
        };
      })
      .filter((item) => item.text && !/^公开 API 网络$|^Public API Network$/i.test(item.text))
      .filter((item) => patterns.some((pattern) => pattern.test(item.text)))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] || null;
  })()`);
  if (!target) {
    return { ok: false, patterns: patterns.map(String) };
  }
  await clickAt(cdp, target.cx, target.cy);
  await sleep(delayMs);
  return { ok: true, target };
}

async function clearSearchTypeFilter(cdp, delayMs) {
  const target = await evaluate(cdp, `(() => {
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/[\\u200b-\\u200d\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    return Array.from(document.querySelectorAll(".pm-search-filter-menu, .search-result-badge"))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: norm(el.innerText || el.textContent),
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
          closeX: rect.x + rect.width - 8
        };
      })
      .filter((item) => item.text && !/^公开 API 网络$|^Public API Network$/i.test(item.text))
      .sort((a, b) => b.x - a.x)[0] || null;
  })()`);
  if (!target) {
    return { ok: false };
  }
  await clickAt(cdp, target.closeX, target.cy);
  await sleep(delayMs);
  return { ok: true, target };
}

async function collect(cdp, step) {
  return evaluate(cdp, `(() => {
    const allowedWords = new Set(${JSON.stringify([
      "postman", "api", "url", "uri", "http", "https", "get", "post", "put", "patch", "delete",
      "head", "options", "cookie", "cookies", "json", "csv", "xml", "html", "javascript", "graphql",
      "grpc", "websocket", "socket", "io", "mqtt", "mcp", "ai", "cli", "llm", "jwt", "oauth", "ssl",
      "tls", "tcp", "sse", "curl", "ctrl", "alt", "shift", "tab", "enter", "esc", "git", "github",
      "chrome", "edge", "id", "uuid", "aws", "ntlm", "bearer", "basic", "digest", "hawk",
      "hmac", "sha", "md5", "pem", "base64", "utf", "npm", "node", "js", "web", "vault",
      "rest", "socket.io", "www", "form", "urlencoded", "x-www-form-urlencoded", "win",
      "proxy", "builder", "sdk", "sdks", "hashicorp", "secret", "secrets", "slack",
      "microsoft", "teams", "go", "no",
      "http_proxy", "https_proxy", "no_proxy"
    ])});
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/[\\u200b-\\u200d\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    }
    function addText(list, text, kind) {
      const value = norm(text);
      if (!value || value.length > 280) return;
      list.push({ text: value, kind });
    }
    const items = [];
    addText(items, document.title, "title");
    const body = document.body ? document.body.innerText : "";
    body.split(/\\n+/).forEach((line) => addText(items, line, "body"));
    Array.from(document.querySelectorAll("[aria-label],[title],[placeholder],[alt],[data-tooltip],[data-tooltip-content]")).filter(visible).forEach((el) => {
      ["aria-label", "title", "placeholder", "alt", "data-tooltip", "data-tooltip-content"].forEach((attr) => {
        addText(items, el.getAttribute(attr), "attr:" + attr);
      });
    });
    const hits = [];
    const seen = new Set();
    function allowedLine(value) {
      const lower = value.toLowerCase();
      if (/的头像$|团队标志$|（你）$/.test(value)) return true;
      if (/^团队成员属于 .+ 团队$/.test(value)) return true;
      if (/^@[a-z0-9_.-]+$/i.test(value)) return true;
      if (/^(?:(?:Ctrl|Alt|Shift|Win|Del|Esc|Enter|Tab|[A-Z0-9])|[+]|\\s)+$/i.test(value)) return true;
      if (/^[A-Za-z]:\\\\/.test(value)) return true;
      if (/^(https?:\\/\\/|wss?:\\/\\/|localhost\\b|127\\.0\\.0\\.1|::1|[\\w.-]+@[\\w.-]+\\.\\w+)/i.test(value)) return true;
      const words = lower.match(/[a-z][a-z0-9.+#-]*/g) || [];
      if (!words.length) return true;
      const unknown = words.filter((word) => {
        const normalizedWord = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (normalizedWord.indexOf("+") >= 0 && normalizedWord.split("+").every((part) => allowedWords.has(part))) return false;
        return !allowedWords.has(normalizedWord) && !/^v?\\d/.test(normalizedWord);
      });
      return unknown.length === 0;
    }
    items.forEach((item) => {
      if (!/[A-Za-z]{3,}/.test(item.text)) return;
      if (allowedLine(item.text)) return;
      const key = item.text;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push(item);
    });
    return {
      step: ${jsString(step)},
      title: document.title,
      hitCount: hits.length,
      hits,
      sampleText: items.slice(0, 160).map((item) => item.text)
    };
  })()`);
}

async function waitForPostmanTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    lastTargets = targets;
    const page = targets.filter((item) => item.type === "page" && item.webSocketDebuggerUrl && !String(item.url || "").startsWith("devtools://"))
      .find((item) => /scratchpad|desktop\\.postman/i.test(String(item.url || ""))) ||
      targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (page) {
      return page;
    }
    await sleep(500);
  }
  throw new Error(`Cannot find Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "60000"));
  const delayMs = Number(argValue("--delay-ms", "450"));
  const outBase = resolveOutBase(argValue("--out", "postman-lightweight-ui-audit"));
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) {
    throw new Error("DevToolsActivePort not found. Start Postman with --remote-debugging-port=0 first.");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const log = [];

  async function record(step) {
    log.push(await collect(cdp, step));
  }

  async function runStep(name, fn) {
    try {
      await fn();
      await sleep(delayMs);
      await record(name);
    } catch (error) {
      log.push({ step: name, error: error && error.message || String(error), hits: [] });
    }
  }

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(delayMs);
    await record("initial");

    const actions = [
      ["workspace-menu", () => clickText(cdp, [/^工作区$/i, /^My Workspace$/i], delayMs, { minY: 0, maxY: 80 })],
      ["search-open", () => clickText(cdp, [/搜索 Postman/i, /^Search Postman$/i], delayMs, { minY: 0, maxY: 90 })],
      ["search-filter-workspace", () => clickSearchFilter(cdp, [/^工作区$/i, /^Workspaces?$/i], delayMs)],
      ["search-filter-workspace-clear", () => clearSearchTypeFilter(cdp, delayMs)],
      ["search-filter-collection", () => clickSearchFilter(cdp, [/^集合$/i, /^Collections?$/i], delayMs)],
      ["search-filter-collection-clear", () => clearSearchTypeFilter(cdp, delayMs)],
      ["search-filter-api", () => clickSearchFilter(cdp, [/^API$/i, /^APIs?$/i], delayMs)],
      ["search-filter-api-clear", () => clearSearchTypeFilter(cdp, delayMs)],
      ["search-filter-team", () => clickSearchFilter(cdp, [/^团队$/i, /^Teams?$/i], delayMs)],
      ["search-close", () => pressEsc(cdp)],
      ["import-open", () => clickText(cdp, [/^导入$/i, /^Import$/i], delayMs, { maxX: 620, minY: 80 })],
      ["import-hover", () => hoverAt(cdp, 500, 330)],
      ["import-close", () => pressEsc(cdp)],
      ["new-open", () => clickText(cdp, [/^新建$/i, /^New$/i], delayMs, { maxX: 620, minY: 80 })],
      ["new-http", () => clickText(cdp, [/^HTTP 请求$/i, /^HTTP Request$/i, /^请求$/i, /^Request$/i], delayMs, { minY: 120 })],
      ["new-open-environment", () => clickText(cdp, [/^新建$/i, /^New$/i], delayMs, { maxX: 620, minY: 80 })],
      ["new-environment", () => clickText(cdp, [/^环境$/i, /^Environment$/i], delayMs, { minY: 120 })],
      ["new-open-collection", () => clickText(cdp, [/^新建$/i, /^New$/i], delayMs, { maxX: 620, minY: 80 })],
      ["new-collection", () => clickText(cdp, [/^集合$/i, /^Collection$/i], delayMs, { minY: 120 })],
      ["request-params", () => clickAt(cdp, 410, 243)],
      ["request-auth", () => clickAt(cdp, 458, 243)],
      ["request-headers", () => clickAt(cdp, 520, 243)],
      ["request-body", () => clickAt(cdp, 588, 243)],
      ["request-scripts", () => clickAt(cdp, 668, 243)],
      ["request-settings", () => clickAt(cdp, 768, 243)],
      ["method-menu", () => clickAt(cdp, 440, 199)],
      ["method-menu-close", () => pressEsc(cdp)],
      ["send-dropdown", () => clickAt(cdp, 1222, 199)],
      ["send-dropdown-close", () => pressEsc(cdp)],
      ["tab-right-menu", () => rightClickAt(cdp, 468, 110)],
      ["tab-right-menu-close", () => pressEsc(cdp)],
      ["top-settings-menu", () => clickAt(cdp, 984, 24)],
      ["top-settings-menu-hover", () => hoverAt(cdp, 1010, 65)],
      ["app-settings-open", () => clickAt(cdp, 855, 68)],
      ["app-settings-general", () => clickText(cdp, [/^常规$/i, /^General$/i], delayMs, { minY: 80 })],
      ["app-settings-theme", () => clickText(cdp, [/^主题$/i, /^Themes?$/i], delayMs, { minY: 80 })],
      ["app-settings-shortcuts", () => clickText(cdp, [/^快捷键$/i, /^Shortcuts?$/i, /^Keyboard Shortcuts$/i], delayMs, { minY: 80 })],
      ["app-settings-data", () => clickText(cdp, [/^数据$/i, /^Data$/i], delayMs, { minY: 80 })],
      ["app-settings-certificates", () => clickText(cdp, [/^证书$/i, /^Certificates?$/i], delayMs, { minY: 80 })],
      ["app-settings-proxy", () => clickText(cdp, [/^代理$/i, /^Proxy$/i], delayMs, { minY: 80 })],
      ["app-settings-update", () => clickText(cdp, [/^更新$/i, /^Update$/i], delayMs, { minY: 80 })],
      ["app-settings-close", () => pressEsc(cdp)],
      ["bottom-console-hover", () => hoverAt(cdp, 77, 756)],
      ["bottom-account-hover", () => hoverAt(cdp, 190, 756)],
      ["help-hover", () => hoverAt(cdp, 1280, 756)]
    ];

    for (const [name, fn] of actions) {
      await runStep(name, fn);
    }

    await pressEsc(cdp);
    await sleep(delayMs);
    await record("final");
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(`${outBase}.png`, Buffer.from(screenshot.data, "base64"));
  } finally {
    cdp.close();
  }

  const merged = new Map();
  for (const entry of log) {
    for (const hit of entry.hits || []) {
      if (!merged.has(hit.text)) {
        merged.set(hit.text, { text: hit.text, count: 0, steps: [] });
      }
      const current = merged.get(hit.text);
      current.count += 1;
      if (current.steps.length < 10) {
        current.steps.push({ step: entry.step, kind: hit.kind });
      }
    }
  }
  const hits = Array.from(merged.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const output = { target: { title: target.title, url: target.url }, log, hits };
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    out: `${outBase}.json`,
    screenshot: `${outBase}.png`,
    steps: log.length,
    hitCount: hits.length,
    hits: hits.slice(0, 80).map((item) => item.text)
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
