#!/usr/bin/env node
"use strict";

// 把 _generated/trans-*.json 的译文合并进 payload/zh-localize.js 的 EXACT 词典。
// 插入位置为 "var EXACT = {" 之后：JS 对象字面量重复键时后者覆盖前者，
// 因此已有的人工词条（在文件靠后位置）自动优先于机器批量词条。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

process.on("uncaughtException", (error) => {
  console.error("合并译文失败：");
  console.error(error && error.message || error);
  process.exit(1);
});

const payloadPath = path.resolve(__dirname, "..", "..", "payload", "zh-localize.js");
const genDir = path.resolve(__dirname, "..", "..", "..", "_generated");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(genDir)) {
  throw new Error(`找不到译文产物目录：${genDir}`);
}

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
//
// 切片必须只取 EXACT 这一个对象，不能一路切到文件末尾（2026-09-01 定位）：
// 后面还有 EDITABLE_EXACT、MENU_ITEM_EXACT、I18N_TERMS 以及函数内的对象字面量，
// 那些键会被误当成"已在 EXACT"，让新词条被静默跳过——合并数量照报，词条没进去。
// I18N_TERMS 是给生成规则做术语递归的表，语义和界面词条本就不同
// （"group": "组" 是术语，界面标签该是"群组"），撞名属正常，不该互相屏蔽。
const payloadForKeys = fs.readFileSync(payloadPath, "utf8");
const exactKeys = new Set();
{
  const marker = "var EXACT = {";
  const start = payloadForKeys.indexOf(marker);
  let region = payloadForKeys;
  if (start >= 0) {
    // 从 EXACT 的 { 开始按括号深度扫到配对的 }，扫描时跳过字符串字面量里的括号
    const open = start + marker.length - 1;
    let depth = 0;
    let quote = "";
    let end = -1;
    for (let i = open; i < payloadForKeys.length; i += 1) {
      const ch = payloadForKeys[i];
      if (quote) {
        if (ch === "\\") { i += 1; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    region = payloadForKeys.slice(open, end > 0 ? end : payloadForKeys.length);
  }
  const keyRe = /"((?:[^"\\]|\\.)+)"\s*:/g;
  let km, kc = 0;
  while ((km = keyRe.exec(region)) !== null && kc < 500000) {
    kc += 1;
    try { exactKeys.add(JSON.parse('"' + km[1] + '"')); } catch (e) {}
  }
}

const merged = new Map();
let readTotal = 0;
let normalizedCount = 0;
for (const file of fs.readdirSync(genDir)) {
  if (!/^trans-.+\.json$/.test(file)) continue;
  const data = JSON.parse(fs.readFileSync(path.join(genDir, file), "utf8"));
  for (const [rawKey, value] of Object.entries(data)) {
    readTotal += 1;
    if (typeof rawKey !== "string" || typeof value !== "string") continue;
    // 键一律按 normalize() 形态入库（首尾空白去掉、连续空白压成一个空格）。
    // translate() 先对页面文本 normalize 再查表，键没规范化就是永远匹配不上的死词条
    // （规则 15）。2026-09-01 在 EXACT 里查出 34 条这样的死词条，所以在入口就归一。
    const key = rawKey.replace(/\s+/g, " ").trim();
    if (key !== rawKey) normalizedCount += 1;
    if (!key || !value.trim()) continue;
    if (key.length > 600 || value.length > 800) continue;
    if (key === value) continue;
    if (!/[一-鿿]/.test(value)) continue;          // 译文必须含中文
    if (/[一-鿿]/.test(key)) continue;              // 键必须是英文原文
    if (exactKeys.has(key)) continue;               // 已在 EXACT 精确词典，跳过
    if (!merged.has(key)) merged.set(key, value);
  }
}
if (normalizedCount) {
  console.log("已把 " + normalizedCount + " 条译文的键归一为 normalize() 形态。");
}

if (!merged.size) {
  console.log("没有找到需要合并的新译文。");
  process.exit(0);
}

if (checkOnly) {
  console.log("检查完成：共读取 " + readTotal + " 条译文，发现 " + merged.size + " 条可合并的新译文；--check 模式未修改汉化主体。");
  process.exit(0);
}

const entries = Array.from(merged.entries())
  .map(([k, v]) => "    " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",")
  .join("\n");

let src = fs.readFileSync(payloadPath, "utf8");
const anchor = "var EXACT = {";
const idx = src.indexOf(anchor);
if (idx < 0) throw new Error("找不到 EXACT 词典锚点。");
const insertAt = idx + anchor.length;
src = src.slice(0, insertAt) + "\n    /* === batch-translated (auto-merged) === */\n" + entries + src.slice(insertAt);
fs.writeFileSync(payloadPath, src, "utf8");

// 语法自检
new Function(fs.readFileSync(payloadPath, "utf8"));
console.log("共读取 " + readTotal + " 条译文，向 EXACT 合并 " + merged.size + " 条新译文；JavaScript 语法验证通过。");
