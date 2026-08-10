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
    throw new Error("APPDATA is not set; cannot locate Postman DevToolsActivePort.");
  }
  return path.join(process.env.APPDATA, "Postman", "DevToolsActivePort");
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
        }, 20000);
      });
    },
    close() {
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
  "postman api apis url uri http https get post put patch delete head options cookie cookies json xml html javascript oauth jwt bearer websocket graphql grpc mcp socket io ctrl alt shift tab enter esc ai postbot vault llm curl ssl tls tcp udp"
    .concat(" f x ms rest mqtt none params raw binary urlencoded www form content type tiny validator getpostman interceptor x-www-form-urlencoded content-type")
    .split(/\s+/)
);

const ALLOWED_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Cookie|Postman|API|HTTP|URL|Ctrl|Alt|Shift|Tab|Enter|Esc|JSON|XML|HTML|JavaScript|GraphQL|gRPC|WebSocket|MCP|Postbot|Vault|AI|LLM|cURL|SSL|TLS)$/i;

function englishHits(text) {
  const lines = norm(text)
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map(norm)
    .filter(Boolean);
  const hits = [];

  for (const line of lines) {
    if (!/[A-Za-z]{2,}/.test(line)) {
      continue;
    }
    if (ALLOWED_LINE.test(line)) {
      continue;
    }
    const words = (line.match(/[A-Za-z][A-Za-z'’-]*/g) || []).map((word) => word.toLowerCase());
    const unknown = words.filter((word) => !ALLOWED_WORDS.has(word));
    if (unknown.length) {
      hits.push(line);
    }
  }

  return Array.from(new Set(hits)).slice(0, 30);
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
    const overlays = Array.from(document.querySelectorAll('[role="tooltip"],[role="menu"],[role="dialog"],.ReactModal__Overlay,[data-testid*="menu"],[data-testid*="modal"]'))
      .map((el) => norm(el.innerText || el.textContent))
      .filter(Boolean)
      .slice(0, 12);
    const attrs = Array.from(document.querySelectorAll('[aria-label],[placeholder],input,textarea,button,a,[role="button"],[role="tab"],[role="menuitem"]'))
      .map((el) => {
        const explicit = norm(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || "");
        if (explicit) {
          return explicit;
        }
        const type = String(el.getAttribute("type") || "").toLowerCase();
        if (el.tagName === "INPUT" && /^(radio|checkbox|hidden|button|submit|reset)$/.test(type)) {
          return "";
        }
        return norm(el.value || "");
      })
      .filter(Boolean)
      .slice(0, 140);
    return {
      title: document.title,
      url: location.href,
      body: norm(document.body && document.body.innerText || ""),
      overlays,
      attrs
    };
  })()`;
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  const value = result.result.value;
  const combined = [value.title, value.body].concat(value.overlays, value.attrs).join("\n");
  return {
    step,
    title: value.title,
    url: value.url,
    hits: englishHits(combined),
    overlays: value.overlays,
    attrs: value.attrs.slice(0, 60),
    bodyPreview: value.body.slice(0, 1400)
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

  throw new Error(`Cannot find a Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
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
  const delayMs = Number(argValue("--delay-ms", "260"));
  const outBase = resolveOutBase(argValue("--out", "postman-targeted-audit"));
  const targetTitle = argValue("--target-title", "未命名请求|新建请求|HTTP Request|Untitled Request|Postman");
  const portFile = resolvePortFile();

  if (!fs.existsSync(portFile)) {
    throw new Error("DevToolsActivePort not found. Start Postman first.");
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

  const hits = Array.from(new Set(log.flatMap((entry) => entry.hits || [])));
  const output = {
    target: { title: target.title, url: target.url },
    hitCount: hits.length,
    hits,
    log
  };
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    out: `${outBase}.json`,
    screenshot: `${outBase}.png`,
    hitCount: hits.length,
    hits
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
