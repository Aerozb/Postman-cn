// 统计 payload/zh-localize.js 里各字典的词条规模。
// 由 发布中文版.ps1 在生成 Release 说明时调用，避免把条数写成会过时的常量
// （2026-09-01 之前说明里硬编码 13400，实测已是 24190，少报约 45%）。
//
// 用法:
//   node scripts/data/统计词条.js            输出总条数（一个数字，供脚本取用）
//   node scripts/data/统计词条.js --details  输出分项明细
const fs = require("fs");
const path = require("path");

const payloadPath = path.join(__dirname, "..", "..", "payload", "zh-localize.js");
const code = fs.readFileSync(payloadPath, "utf8");
const details = process.argv.includes("--details");

// 按括号深度取一个字面量的区间，扫描时跳过字符串里的括号。
// 不能简单切到文件末尾——后面还有别的字典和函数内的对象字面量。
function region(src, marker, openChar, closeChar) {
  const at = src.indexOf(marker);
  if (at < 0) return "";
  const open = src.indexOf(openChar, at);
  if (open < 0) return "";
  let depth = 0;
  let quote = "";
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

function objectKeys(marker) {
  const body = region(code, marker, "{", "}");
  const re = /"((?:[^"\\]|\\.)+)"\s*:/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(body)) !== null) {
    try { keys.add(JSON.parse('"' + m[1] + '"')); } catch (e) {}
  }
  return keys.size;
}

// 数组型字典按顶层元素数算（元素本身是 ["片段","译文"] 或 [/正则/, 替换]）
function arrayItems(marker) {
  const body = region(code, marker, "[", "]");
  let depth = 0;
  let quote = "";
  let items = 0;
  let sawContent = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; sawContent = true; continue; }
    if (ch === "/" && body[i + 1] === "/") { while (i < body.length && body[i] !== "\n") i += 1; continue; }
    if (ch === "[" || ch === "{" || ch === "(") { depth += 1; if (depth > 1) sawContent = true; continue; }
    if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1;
      if (depth === 0) { if (sawContent) items += 1; break; }
      continue;
    }
    if (ch === "," && depth === 1) { items += 1; sawContent = false; continue; }
    if (!/\s/.test(ch)) sawContent = true;
  }
  return items;
}

const parts = [
  ["EXACT", "完整文案精确匹配", objectKeys("var EXACT = {")],
  ["PHRASES", "可组合子串片段", arrayItems("var PHRASES = [")],
  ["RULES", "含变量的正则规则", arrayItems("var RULES = [")],
  ["I18N_TERMS", "生成规则用术语表", objectKeys("var I18N_TERMS = {")],
  ["EDITABLE_EXACT", "输入框真实 value", objectKeys("var EDITABLE_EXACT = {")],
  ["MENU_ITEM_EXACT", "页面内菜单项", objectKeys("var MENU_ITEM_EXACT = {")],
];
const total = parts.reduce((n, p) => n + p[2], 0);

if (!total) {
  console.error("统计失败：没有从 payload 里读到任何词条，检查字典声明是否改名。");
  process.exit(1);
}

if (details) {
  for (const [name, desc, n] of parts) {
    console.log("  " + name.padEnd(16) + String(n).padStart(6) + "  " + desc);
  }
  console.log("  " + "合计".padEnd(15) + String(total).padStart(6));
  console.log("  payload 体积      " + (code.length / 1048576).toFixed(2) + " MB");
} else {
  console.log(String(total));
}
