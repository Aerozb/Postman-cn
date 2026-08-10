#!/usr/bin/env node
"use strict";

// 静态深度扫描：从 Postman 本地磁盘缓存（--disk，推荐）或运行中页面（CDP）抽取
// UI 属性键（label/title/tooltip/text/...）后面的字符串字面量，逐条通过
// zh-localize.js 的 translate() 测试，输出"翻译不出来"的候选清单。
// 用法：node extract-ui-strings.js --disk [--max N] [--out report.json]
// 输出：默认写入同级 _generated/zh-static-candidates.json。裸名称也写入 _generated；带目录的相对路径按调用目录解析。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function outputPath() {
  const index = process.argv.indexOf("--out");
  const generatedDir = path.resolve(__dirname, "..", "..", "..", "_generated");
  let resolved = path.join(generatedDir, "zh-static-candidates.json");
  if (index < 0) return resolved;

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--out requires a JSON report path");
  }
  const hasDirectory = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
  resolved = hasDirectory ? path.resolve(value) : path.join(generatedDir, value);
  const extension = path.extname(resolved);
  if (!extension) return resolved + ".json";
  if (extension.toLowerCase() !== ".json") {
    throw new Error("--out must use a .json extension or no extension");
  }
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    if (message.method && handlers.has(message.method)) {
      handlers.get(message.method)(message.params);
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const cb = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) cb.reject(new Error(message.error.message));
    else cb.resolve(message.result);
  });
  return {
    on(method, cb) { handlers.set(method, cb); },
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); }
        }, 60000);
      });
    },
    close() { try { ws.close(); } catch (_) {} }
  };
}

function loadTranslator() {
  const payload = path.resolve(__dirname, "..", "..", "payload", "zh-localize.js");
  const code = fs.readFileSync(payload, "utf8");
  const noopEl = { setAttribute() {}, nodeType: 0 };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    location: { href: "" },
    navigator: { userAgent: "node" },
    document: {
      readyState: "complete",
      title: "",
      addEventListener() {},
      documentElement: noopEl,
      body: null,
      createTreeWalker() { return { nextNode: () => false, currentNode: null }; },
      querySelectorAll() { return []; }
    }
  };
  sandbox.window = sandbox;
  sandbox.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "zh-localize.js" });
  const localizer = sandbox.window.__POSTMAN_ZH_LOCALIZER__;
  if (!localizer || !localizer.translate) {
    throw new Error("failed to load translate() from payload");
  }
  return localizer.translate;
}

const UI_KEYS = new Set([
  "label", "labels", "text", "title", "subtitle", "tooltip", "tooltiptext", "cta",
  "message", "helpertext", "placeholder", "arialabel", "aria-label", "description",
  "header", "heading", "subheading", "buttontext", "buttonlabel", "children", "alt",
  "hint", "caption", "emptytitle", "emptydescription", "emptystatetitle", "emptystatedescription",
  "primarytext", "secondarytext", "actiontext", "confirmtext", "canceltext", "oktext",
  "successmessage", "errormessage", "warningmessage", "infotext", "content", "body",
  "primaryaction", "secondaryaction", "name"
]);
// name/content/body/children 常是数据字段，只收两词以上短语
const WEAK_KEYS = new Set(["name", "content", "body", "children"]);

const CAMEL_RE = /^[A-Za-z]+([A-Z][a-z]+)+$/;
const ANALYTICS_RE = / - (Clicked|Viewed|Opened|Closed|Loaded|Focused|Selected|Initiated|Succeeded|Failed)/i;
const FILE_EXT_RE = /\.(js|css|svg|png|json|html|ts|map)$/i;
const BAD_CHARS_RE = /[{}<>\\`$@#%^*_=|~]/;

function looksLikeUiString(text, key) {
  if (text.length < 2 || text.length > 600) return false;
  if (!/^[A-Z]/.test(text)) return false;
  if (!/[a-z]/.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, "").length;
  if (letters / text.length < 0.55) return false;
  if (BAD_CHARS_RE.test(text)) return false;
  if (text.indexOf("://") !== -1 || FILE_EXT_RE.test(text)) return false;
  if (CAMEL_RE.test(text)) return false;
  if (ANALYTICS_RE.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length > 90) return false;
  if (WEAK_KEYS.has(key) && words.length < 2) return false;
  return true;
}

function extractStrings(source, counter) {
  // 只抽取 UI 属性键后面的字符串字面量：key:"value"
  const re = /["']?([A-Za-z$_][\w$-]{1,30})["']?\s*:\s*"((?:[^"\\\n]|\\.){2,600})"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const key = match[1].toLowerCase();
    if (!UI_KEYS.has(key)) continue;
    let raw = match[2];
    if (raw.indexOf("\\") !== -1) {
      try { raw = JSON.parse('"' + raw.replace(/"/g, '\\"') + '"'); } catch (e) { continue; }
    }
    const text = raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (!looksLikeUiString(text, key)) continue;
    const entry = counter.get(text);
    if (entry) { entry.count += 1; }
    else counter.set(text, { count: 1, key: key });
  }
}

function extractFromDisk(counter) {
  const zlib = require("zlib");
  const root = path.join(process.env.APPDATA || "", "Postman", "Partitions");
  const files = [];
  (function walkDir(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full, depth + 1);
      else if (/^f_[0-9a-f]+$/i.test(entry.name) || /^data_[0-9]$/i.test(entry.name)) files.push(full);
    }
  })(root, 0);
  console.error("disk mode: " + files.length + " cache files");
  let done = 0;
  let ok = 0;
  for (const file of files) {
    done += 1;
    if (done % 100 === 0) console.error("  " + done + "/" + files.length + " (candidates: " + counter.size + ")");
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { continue; }
    if (buf.length < 200) continue;
    let text = null;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      try { text = zlib.gunzipSync(buf).toString("utf8"); } catch (e) {}
    }
    if (text === null) {
      try { text = zlib.brotliDecompressSync(buf).toString("utf8"); } catch (e) {}
    }
    if (text === null) {
      const head = buf.subarray(0, 64);
      let printable = 0;
      for (const b of head) { if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1; }
      if (printable / head.length > 0.9) text = buf.toString("utf8");
    }
    if (text) {
      ok += 1;
      extractStrings(text, counter);
    }
  }
  return ok;
}

async function extractViaCdp(counter) {
  const portFile = path.join(process.env.APPDATA || "", "Postman", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) {
    throw new Error("DevToolsActivePort not found. 请先通过安装脚本启动 Postman。");
  }
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error("no debuggable pages");

  let resourceCount = 0;
  for (const page of pages) {
    let cdp;
    try {
      cdp = await connectCdp(page.webSocketDebuggerUrl);
      const scripts = [];
      cdp.on("Debugger.scriptParsed", (params) => {
        if (params && params.scriptId) {
          scripts.push({ scriptId: params.scriptId, url: params.url || "", length: params.length || 0 });
        }
      });
      await cdp.send("Debugger.enable", { maxScriptsCacheSize: 1e9 });
      await sleep(4000);
      const picked = scripts.sort((a, b) => (b.length || 0) - (a.length || 0)).slice(0, 120);
      let done = 0;
      for (const script of picked) {
        done += 1;
        if (done % 10 === 0) console.error("  fetching " + done + "/" + picked.length);
        try {
          const src = await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId });
          if (src && src.scriptSource) {
            resourceCount += 1;
            extractStrings(src.scriptSource, counter);
          }
        } catch (e) {}
      }
    } catch (error) {
      console.error("skip page: " + error.message);
    } finally {
      if (cdp) cdp.close();
    }
  }
  return resourceCount;
}

async function main() {
  const maxArg = process.argv.indexOf("--max");
  const maxOut = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : 0;
  const diskMode = process.argv.includes("--disk");
  const outFile = outputPath();

  const counter = new Map();
  const resourceCount = diskMode ? extractFromDisk(counter) : await extractViaCdp(counter);

  console.log("已扫描 " + resourceCount + " 个资源，抽取候选 " + counter.size + " 条，开始过翻译器...");
  const translate = loadTranslator();
  const untranslated = [];
  for (const [text, info] of counter.entries()) {
    let result;
    try { result = translate(text); } catch (e) { result = text; }
    if (result === text) {
      untranslated.push({ text: text, count: info.count, key: info.key });
    }
  }
  untranslated.sort((a, b) => b.count - a.count || a.text.length - b.text.length);
  const limited = maxOut > 0 ? untranslated.slice(0, maxOut) : untranslated;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    exportedAt: new Date().toISOString(),
    scannedResources: resourceCount,
    totalCandidates: counter.size,
    untranslatedCount: untranslated.length,
    untranslated: limited
  }, null, 2), "utf8");
  console.log("未翻译候选 " + untranslated.length + " 条，已保存 " + outFile);
  for (const item of limited.slice(0, 40)) {
    console.log(String(item.count).padStart(4) + "  [" + item.key + "] " + item.text);
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
