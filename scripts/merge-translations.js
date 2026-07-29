#!/usr/bin/env node
"use strict";

// 把 _generated/trans-part*.json 的译文合并进 payload/zh-localize.js 的 EXACT 词典。
// 插入位置为 "var EXACT = {" 之后：JS 对象字面量重复键时后者覆盖前者，
// 因此已有的人工词条（在文件靠后位置）自动优先于机器批量词条。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const payloadPath = path.resolve(__dirname, "..", "payload", "zh-localize.js");
const genDir = path.resolve(__dirname, "..", "..", "_generated");

function loadTranslator() {
  const code = fs.readFileSync(payloadPath, "utf8");
  const noopEl = { setAttribute() {}, nodeType: 0 };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    location: { href: "" }, navigator: { userAgent: "node" },
    document: {
      readyState: "complete", title: "", addEventListener() {},
      documentElement: noopEl, body: null,
      createTreeWalker() { return { nextNode: () => false, currentNode: null }; },
      querySelectorAll() { return []; }
    }
  };
  sandbox.window = sandbox;
  sandbox.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "zh-localize.js" });
  return sandbox.window.__POSTMAN_ZH_LOCALIZER__.translate;
}

// 读取当前 EXACT 已有的精确键集合：只有已在 EXACT 里的键才跳过。
// 混合句被 PHRASES 部分翻译（translate!==key），但不在 EXACT，必须能进入 EXACT 覆盖。
const payloadForKeys = fs.readFileSync(payloadPath, "utf8");
const exactKeys = new Set();
{
  const start = payloadForKeys.indexOf("var EXACT = {");
  const tail = start >= 0 ? payloadForKeys.slice(start) : payloadForKeys;
  const keyRe = /"((?:[^"\\]|\\.)+)"\s*:/g;
  let km, kc = 0;
  while ((km = keyRe.exec(tail)) !== null && kc < 500000) {
    kc += 1;
    try { exactKeys.add(JSON.parse('"' + km[1] + '"')); } catch (e) {}
  }
}

const merged = new Map();
let readTotal = 0;
for (const file of fs.readdirSync(genDir)) {
  if (!/^trans-.+\.json$/.test(file)) continue;
  const data = JSON.parse(fs.readFileSync(path.join(genDir, file), "utf8"));
  for (const [key, value] of Object.entries(data)) {
    readTotal += 1;
    if (typeof key !== "string" || typeof value !== "string") continue;
    if (!key.trim() || !value.trim()) continue;
    if (key.length > 600 || value.length > 800) continue;
    if (key === value) continue;
    if (!/[一-鿿]/.test(value)) continue;          // 译文必须含中文
    if (/[一-鿿]/.test(key)) continue;              // 键必须是英文原文
    if (exactKeys.has(key)) continue;               // 已在 EXACT 精确词典，跳过
    if (!merged.has(key)) merged.set(key, value);
  }
}

if (!merged.size) {
  console.log("nothing to merge");
  process.exit(0);
}

const entries = Array.from(merged.entries())
  .map(([k, v]) => "    " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",")
  .join("\n");

let src = fs.readFileSync(payloadPath, "utf8");
const anchor = "var EXACT = {";
const idx = src.indexOf(anchor);
if (idx < 0) throw new Error("EXACT anchor not found");
const insertAt = idx + anchor.length;
src = src.slice(0, insertAt) + "\n    /* === batch-translated (auto-merged) === */\n" + entries + src.slice(insertAt);
fs.writeFileSync(payloadPath, src, "utf8");

// 语法自检
new Function(fs.readFileSync(payloadPath, "utf8"));
console.log("read " + readTotal + " entries, merged " + merged.size + " new entries into EXACT; JS parse OK");
