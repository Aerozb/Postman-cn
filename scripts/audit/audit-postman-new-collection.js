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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

function resolvePortFile() {
  if (!process.env.APPDATA) {
    throw new Error("APPDATA is not set; cannot locate Postman DevToolsActivePort.");
  }
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
        }, 45000);
      });
    },
    close() {
      try {
        ws.close();
      } catch (_) {}
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
      if (page) {
        return page;
      }
    } catch (_) {}
    await sleep(800);
  }
  throw new Error(`Cannot find a Postman page target. Targets: ${JSON.stringify(lastTargets)}`);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description = details.exception && (details.exception.description || details.exception.value);
    throw new Error(description || details.text || JSON.stringify(details));
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

function findSidebarCreateButtonScript() {
  return `(() => {
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("placeholder")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        norm(el.getAttribute("data-testid")) ||
        "";
    }
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],[aria-label],[title],[tabindex]")).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      const text = labelOf(el);
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const inSidebarToolbar = cx >= 205 && cx <= 285 && cy >= 60 && cy <= 110;
      const labelScore = /^(?:新建|New|Create|Add|\\+)$|(?:新建|创建|create|add|new)/i.test(text) ? 0 : 60;
      const compactPlusScore = !text && rect.width <= 48 && rect.height <= 48 ? 5 : 0;
      return {
        text,
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: cx,
        y: cy,
        w: rect.width,
        h: rect.height,
        score: (inSidebarToolbar ? 0 : 1000) + labelScore + compactPlusScore + Math.abs(cx - 234) + Math.abs(cy - 75)
      };
    }).filter((item) => item.score < 1100);
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] || null;
  })()`;
}

function findOverlayMenuItemScript(pattern, options = {}) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, "i");
    const minY = ${JSON.stringify(options.minY ?? null)};
    const maxY = ${JSON.stringify(options.maxY ?? null)};
    const minX = ${JSON.stringify(options.minX ?? null)};
    const maxX = ${JSON.stringify(options.maxX ?? null)};
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function labelOf(el) {
      return norm(el.getAttribute("aria-label")) ||
        norm(el.getAttribute("title")) ||
        norm(el.innerText) ||
        norm(el.textContent) ||
        "";
    }
    function overlayAncestorScore(el) {
      let node = el;
      for (let depth = 0; depth < 7 && node && node instanceof Element; depth += 1, node = node.parentElement) {
        const role = norm(node.getAttribute("role")).toLowerCase();
        const testid = norm(node.getAttribute("data-testid")).toLowerCase();
        const aether = norm(node.getAttribute("data-aether-id")).toLowerCase();
        if (/^(menu|listbox|dialog)$/.test(role) || /popover|menu|modal|dropdown/.test(testid + " " + aether)) {
          return depth;
        }
      }
      return 30;
    }
    const selector = "[role='menuitem'],[role='option'],button,a,[aria-label],[title],[tabindex]";
    const matches = Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      const text = labelOf(el);
      return {
        text,
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        w: rect.width,
        h: rect.height,
        overlayScore: overlayAncestorScore(el)
      };
    }).filter((item) => {
      if (!item.text || !re.test(item.text)) return false;
      if (minY !== null && item.y < minY) return false;
      if (maxY !== null && item.y > maxY) return false;
      if (minX !== null && item.x < minX) return false;
      if (maxX !== null && item.x > maxX) return false;
      return true;
    });
    matches.sort((a, b) => {
      const exactA = /^\\s*(?:集合|Collection)\\s*$/.test(a.text) ? 0 : 1;
      const exactB = /^\\s*(?:集合|Collection)\\s*$/.test(b.text) ? 0 : 1;
      return (a.overlayScore - b.overlayScore) || (exactA - exactB) || (a.y - b.y) || (a.x - b.x);
    });
    return matches[0] || null;
  })()`;
}

function findTargetScript(pattern, options = {}) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, "i");
    const minY = ${JSON.stringify(options.minY ?? null)};
    const maxY = ${JSON.stringify(options.maxY ?? null)};
    const minX = ${JSON.stringify(options.minX ?? null)};
    const maxX = ${JSON.stringify(options.maxX ?? null)};
    const maxTextLength = ${JSON.stringify(options.maxTextLength ?? 180)};
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    const selector = "[data-tab-id],button,a,input,textarea,[role='tab'],[role='button'],[role='menuitem'],[role='treeitem'],[role='option'],[aria-label],[title],[placeholder],[tabindex]";
    const matches = Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: norm(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent),
        tag: el.tagName,
        role: norm(el.getAttribute("role")),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        w: rect.width,
        h: rect.height
      };
    }).filter((item) => {
      if (!item.text || !re.test(item.text)) return false;
      if (maxTextLength && item.text.length > maxTextLength) return false;
      if (minY !== null && item.y < minY) return false;
      if (maxY !== null && item.y > maxY) return false;
      if (minX !== null && item.x < minX) return false;
      if (maxX !== null && item.x > maxX) return false;
      return true;
    });
    matches.sort((a, b) => {
      const exactA = re.test(a.text) && a.text.length <= 80 ? 0 : 1;
      const exactB = re.test(b.text) && b.text.length <= 80 ? 0 : 1;
      const interactiveA = /^(BUTTON|A|INPUT|TEXTAREA)$/i.test(a.tag) || /^(button|tab|menuitem|treeitem|option|link)$/i.test(a.role) ? 0 : 1;
      const interactiveB = /^(BUTTON|A|INPUT|TEXTAREA)$/i.test(b.tag) || /^(button|tab|menuitem|treeitem|option|link)$/i.test(b.role) ? 0 : 1;
      return exactA - exactB || interactiveA - interactiveB || (a.y - b.y) || (a.x - b.x);
    });
    return matches[0] || null;
  })()`;
}

function scanScript(probes) {
  return `(() => {
    const probes = ${JSON.stringify(probes)};
    const ALLOWED_WORDS = new Set([
      "postman", "getpostman", "api", "apis", "url", "uri", "http", "https", "websocket", "graphql", "grpc", "mqtt", "mqtts", "mcp", "socket", "socket.io", "io",
      "json", "xml", "html", "javascript", "oauth", "bearer", "jwt", "curl", "grpcurl", "wsdl", "openapi", "swagger", "csv", "asyncapi", "protobuf",
      "har", "pem", "ssl", "tls", "rbac", "sdk", "git", "github", "vscode", "vs", "code", "npm", "cookie", "cookies", "recaptcha", "qos", "cli", "ai",
      "ctrl", "alt", "shift", "tab", "enter", "esc", "cmd", "base64", "id", "ids", "uuid", "svg", "png", "jpg", "jpeg", "kb", "mb", "gb", "ms", "px", "llm",
      "aws", "ntlm", "hawk", "akamai", "edgegrid", "atlassian", "claude", "opus", "get", "post", "put", "patch", "delete", "del", "head", "options",
      "trace", "connect", "hashicorp", "vault", "secret", "secrets", "slack", "microsoft", "teams", "go", "x-www-form-urlencoded", "x-api-key", "raw", "none", "inherit", "smtp", "imap", "dns", "tcp", "udp", "icmp",
      "macos", "windows", "markdown", "rest", "rpc", "iot", "header", "headers", "am", "pm", "typescript", "fql", "schema", "fern"
    ]);
    const ALLOWED_PHRASES = new Set([
      "postman api platform",
      "postman code",
      "public api network",
      "app builder"
    ]);
    function norm(text) {
      return String(text || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
    }
    function visible(el) {
      if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100
      };
    }
    function allowedEnglish(text) {
      const normalized = norm(text);
      const loweredText = normalized.toLowerCase();
      if (/的头像$|团队标志$|（你）$/.test(normalized)) return true;
      if (/^HTTP\\/\\d(?:\\.\\d|\\.x)?$/i.test(normalized)) return true;
      if (/^checkbox-[A-Za-z0-9#+.-]+$/i.test(normalized)) return true;
      if (ALLOWED_PHRASES.has(loweredText)) return true;
      const words = normalized.match(/[A-Za-z][A-Za-z0-9.+#/-]*/g) || [];
      const meaningful = words.filter((word) => {
        const lowered = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
        if (!lowered || lowered.length <= 1) return false;
        if (ALLOWED_WORDS.has(lowered)) return false;
        if (lowered.indexOf("/") >= 0 && lowered.split("/").every((part) => ALLOWED_WORDS.has(part))) return false;
        if (/^[a-f0-9]{6,}$/i.test(lowered)) return false;
        if (/^\\d/.test(lowered)) return false;
        return true;
      });
      return meaningful.length === 0;
    }
    function isEnglishLeak(text) {
      const value = norm(text);
      if (!value || value.length < 2) return false;
      if (!/[A-Za-z]{2,}/.test(value)) return false;
      if (/\\b(Ctrl|Alt|Shift|Cmd|Command|Win)\\s*\\+/i.test(value)) return false;
      if (/[\\u4e00-\\u9fff]/.test(value) && /https?:\\/\\//i.test(value)) return false;
      if (/^https?:\\/\\//i.test(value)) return false;
      if (/^[A-Z0-9_./:-]+$/.test(value) && value.length <= 32) return false;
      if (/^\\d+\\s+results?\\s+available\\.Use Up and Down to choose options,/i.test(value)) return false;
      if (/\\b(Salesforce|Docusign|DocuSign|UPS|Zoho|Adyen|Datadog|HubSpot|Mastercard|Notion|OpenAI|PayPal|Pipedrive|Plaid|Razorpay|Tableau|WhatsApp|Box|Cisco|Meraki|PandaDoc|PingOne)\\b/.test(value)) return false;
      if (/\\b(Public Workspace|Developers|API Collection|APIs|REST API|Cloud API|Business Platform|Published Postman Templates|Documentation Checklist|Intro to writing tests|Learn by API|Postman DevRel|Postman Team|API Reference|Platform API|Dashboard API)\\b/i.test(value)) return false;
      if (/^[A-Z][A-Za-z0-9 '&().-]*\\s+API(?:\\s|\\b).*(?:\\(v\\d+\\)|\\(JP\\)|集合|Collection|Endpoints|OAuthAuthCode|Shipping|Reference)$/i.test(value)) return false;
      if (/^[a-z0-9_]{3,16}$/i.test(value)) return false;
      return !allowedEnglish(value);
    }
    function addEnglishHit(hits, text, kind, meta) {
      const value = norm(text);
      if (!isEnglishLeak(value)) return;
      if (!hits.has(value)) {
        hits.set(value, { text: value, count: 0, samples: [] });
      }
      const hit = hits.get(value);
      hit.count += 1;
      if (hit.samples.length < 6) {
        hit.samples.push(Object.assign({ kind }, meta || {}));
      }
    }
    const attrs = [];
    const attrNames = ["aria-label", "aria-placeholder", "title", "placeholder", "alt", "data-tooltip", "data-tooltip-content", "data-original-title"];
    const visibleElements = Array.from(document.querySelectorAll("*")).filter(visible);
    for (const el of visibleElements) {
      for (const attr of attrNames) {
        const value = el.getAttribute(attr);
        if (value) attrs.push(value);
      }
    }
    const text = (document.body ? document.body.innerText : "") + "\\n" + attrs.join("\\n");
    const englishHits = new Map();
    addEnglishHit(englishHits, document.title, "title", { tag: "TITLE" });
    for (const line of String(document.body ? document.body.innerText : "").replace(/\\u00a0/g, " ").split(/\\n| {2,}/)) {
      addEnglishHit(englishHits, line, "body", { tag: "BODY" });
    }
    for (const el of visibleElements) {
      for (const attr of attrNames) {
        if (el.hasAttribute(attr)) {
          addEnglishHit(englishHits, el.getAttribute(attr), "attr", Object.assign({ attr, tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
        }
      }
      const label = norm(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent);
      if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) || /^(button|tab|menuitem|treeitem|option|link|checkbox|radio|switch)$/i.test(String(el.getAttribute("role") || ""))) {
        addEnglishHit(englishHits, label, "control", Object.assign({ tag: el.tagName, role: el.getAttribute("role") || "" }, rectOf(el)));
      }
    }
    const tabs = Array.from(document.querySelectorAll("[role='tab'],[data-tab-id],button")).filter(visible).map((el) => {
      return norm(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent);
    }).filter(Boolean).slice(0, 120);
    return {
      title: document.title,
      url: location.href,
      localized: document.documentElement.getAttribute("data-postman-zh-localized"),
      hits: probes.filter((probe) => text.includes(probe)),
      englishHits: Array.from(englishHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      tabs,
      sample: norm(document.body ? document.body.innerText : "").slice(0, 1600)
    };
  })()`;
}

async function clickLabel(cdp, pattern, delayMs, options = {}) {
  const target = await evaluate(cdp, findTargetScript(pattern, options));
  if (!target) {
    return { ok: false, pattern, options };
  }
  await clickAt(cdp, target.x, target.y);
  await sleep(delayMs);
  return { ok: true, pattern, target };
}

async function clickOverlayMenuLabel(cdp, pattern, delayMs, options = {}) {
  const target = await evaluate(cdp, findOverlayMenuItemScript(pattern, options));
  if (!target) {
    return { ok: false, pattern, options };
  }
  await clickAt(cdp, target.x, target.y);
  await sleep(delayMs);
  return { ok: true, pattern, target };
}

async function openNewCollectionViaCreateMenu(cdp, delayMs) {
  const createButton = await evaluate(cdp, findSidebarCreateButtonScript());
  const createResult = createButton ?
    { ok: true, target: createButton, fallback: false } :
    { ok: true, target: { text: "coordinate-fallback", x: 234, y: 75 }, fallback: true };

  if (createButton) {
    await clickAt(cdp, createButton.x, createButton.y);
  } else {
    await clickAt(cdp, 234, 75);
  }
  await sleep(Math.max(delayMs, 700));

  const collectionResult = await clickOverlayMenuLabel(cdp, "^集合$|^Collection$|^Create Collection$|^新建集合$", Math.max(delayMs, 900), {
    minY: 110,
    maxY: 560,
    minX: 250,
    maxX: 760
  });

  return {
    createButton: createResult,
    collectionItem: collectionResult
  };
}

function mergeEnglishHits(allEnglishHits, step, hits) {
  for (const hit of hits || []) {
    if (!allEnglishHits.has(hit.text)) {
      allEnglishHits.set(hit.text, { text: hit.text, count: 0, samples: [] });
    }
    const current = allEnglishHits.get(hit.text);
    current.count += hit.count || 1;
    for (const sample of hit.samples || []) {
      if (current.samples.length < 10) {
        current.samples.push(Object.assign({ step }, sample));
      }
    }
  }
}

function isCollectionWorkbenchState(state) {
  const text = `${state && state.title || ""}\n${state && state.sample || ""}\n${(state && state.tabs || []).join("\n")}`;
  const coreTabs = [/概览/, /授权/, /脚本/, /变量/, /运行记录/].filter((pattern) => pattern.test(text)).length;
  return coreTabs >= 4 &&
    /(?:发布文档|运行性能测试|此集合|集合为空|新建集合)/.test(text);
}

async function main() {
  const timeoutMs = Number(argValue("--timeout-ms", "30000"));
  const delayMs = Number(argValue("--delay-ms", "900"));
  const outBase = resolveOutBase(argValue("--out", "postman-new-collection-audit"));
  const probes = [
    "Use JavaScript to configure requests dynamically.",
    "This variable is overwritten by a duplicated key",
    "Write description",
    "Share value with teammates and use it with monitors and scheduled runs.",
    "Share value with teammates and use it with monitors and 计划运行.",
    "Search Variables",
    "Select from computer",
    "Files uploaded to this workspace",
    "No files uploaded yet. Upload files to this workspace to share and reuse test data.",
    "Choose how to run your performance test",
    "In the app",
    "Via the CLI",
    "You can take this action when you're back online.",
    "You do not have permission to add items",
    "You cannot create a flow when you’re offline.",
    "You cannot create an environment when you’re offline.",
    "You need to be online to create a webhook.",
    "You cannot create a collection when you’re offline.",
    "You cannot create a monitor when you're offline.",
    "You cannot create an insights project when you're offline.",
    "You cannot generate an SDK when you're offline."
  ];

  const portFile = resolvePortFile();
  if (!fs.existsSync(portFile)) {
    throw new Error("DevToolsActivePort not found. Start Postman with --remote-debugging-port=0 first.");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const target = await waitForPostmanTarget(port, timeoutMs);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const log = [];
  const allHits = new Set();
  const allEnglishHits = new Map();

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await pressEsc(cdp);
    await sleep(250);

    log.push({
      step: "open-collection-sidebar",
      result: await clickLabel(cdp, "^项目$|^集合$|^Collections$|^Projects$", delayMs, { minY: 35, maxY: 75, maxX: 280, maxTextLength: 40 })
    });

    const sidebarClick = await clickLabel(cdp, "新建集合|New Collection", delayMs, { minY: 90, maxX: 420, maxTextLength: 80 });
    log.push({ step: "click-new-collection-sidebar", result: sidebarClick });
    let tabState = sidebarClick.ok ? await evaluate(cdp, scanScript(probes)) : null;
    if (tabState) {
      log.push({ step: "after-click-new-collection-sidebar", state: tabState });
      for (const hit of tabState.hits) allHits.add(hit);
      mergeEnglishHits(allEnglishHits, "after-click-new-collection-sidebar", tabState.englishHits);
    }
    if (!sidebarClick.ok || !isCollectionWorkbenchState(tabState)) {
      const tabClick = await clickLabel(cdp, "新建集合|New Collection", delayMs, { minY: 30, maxY: 90, minX: 300, maxTextLength: 80 });
      log.push({ step: "click-new-collection-tab", result: tabClick });
      tabState = tabClick.ok ? await evaluate(cdp, scanScript(probes)) : null;
      if (tabState) {
        log.push({ step: "after-click-new-collection-tab", state: tabState });
        for (const hit of tabState.hits) allHits.add(hit);
        mergeEnglishHits(allEnglishHits, "after-click-new-collection-tab", tabState.englishHits);
      }
    }

    if (!isCollectionWorkbenchState(tabState)) {
      const createMenuResult = await openNewCollectionViaCreateMenu(cdp, delayMs);
      log.push({ step: "open-new-collection-via-create-menu", result: createMenuResult });
      tabState = await evaluate(cdp, scanScript(probes));
      log.push({ step: "after-open-new-collection-via-create-menu", state: tabState });
      for (const hit of tabState.hits) allHits.add(hit);
      mergeEnglishHits(allEnglishHits, "after-open-new-collection-via-create-menu", tabState.englishHits);
    }

    const initial = await evaluate(cdp, scanScript(probes));
    log.push({ step: "collection-initial", state: initial });
    for (const hit of initial.hits) allHits.add(hit);
    mergeEnglishHits(allEnglishHits, "collection-initial", initial.englishHits);
    let navigationOk = isCollectionWorkbenchState(initial);

    const labels = [
      "概览|Overview",
      "授权|Authorization|Auth",
      "脚本|Scripts?|请求前|Pre-request",
      "变量|Variables",
      "运行|Runs?|运行记录",
      "功能|Functional",
      "定时|计划|Schedule|Scheduled",
      "性能|Performance",
      "发布文档|Publish documentation|Publish docs",
      "分享|Share",
      "复制链接|Copy link|链接|Link",
      "运行性能测试|性能测试|Run performance test|Performance test"
    ];

    for (const label of labels) {
      const clicked = await clickLabel(cdp, label, delayMs, { minY: 70, maxTextLength: 80 });
      const state = await evaluate(cdp, scanScript(probes));
      if (isCollectionWorkbenchState(state)) {
        navigationOk = true;
      }
      for (const hit of state.hits) allHits.add(hit);
      mergeEnglishHits(allEnglishHits, `click-${label}`, state.englishHits);
      log.push({ step: `click-${label}`, clicked, state });
      await pressEsc(cdp);
      await sleep(120);
    }

    const output = {
      target: { title: target.title, url: target.url },
      probes,
      navigationOk,
      navigationFailure: navigationOk ? null : "new-collection-workbench-not-detected",
      hitCount: allHits.size + allEnglishHits.size + (navigationOk ? 0 : 1),
      hits: Array.from(allHits),
      englishHitCount: allEnglishHits.size,
      englishHits: Array.from(allEnglishHits.values()).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      log
    };
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(output, null, 2), "utf8");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(`${outBase}.png`, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({
      out: `${outBase}.json`,
      screenshot: `${outBase}.png`,
      target: output.target,
      navigationOk: output.navigationOk,
      navigationFailure: output.navigationFailure,
      hitCount: output.hitCount,
      hits: output.hits,
      englishHitCount: output.englishHitCount,
      englishHits: output.englishHits.slice(0, 80).map((item) => item.text),
      steps: log.map((item) => ({
        step: item.step,
        clicked: item.result || item.clicked || null,
        hits: item.state && item.state.hits || [],
        englishHits: item.state && item.state.englishHits ? item.state.englishHits.map((hit) => hit.text) : []
      }))
    }, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
