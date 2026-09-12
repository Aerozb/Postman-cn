#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { loadPayload, DEFAULT_PAYLOAD } = require("../lib/汉化沙箱.js");

// 只按最终 EXACT 查重：包含 Object.assign 的追加词条，排除术语表及其他字典。
// 新条目仍插在首个 EXACT 头部，维持后面的人工词条优先。
function planMerge(source, documents) {
  const payload = loadPayload({ source });
  const exactKeys = new Set(Object.keys(payload.dictionaries.EXACT));
  const entries = new Map();
  let readTotal = 0;
  let normalizedCount = 0;
  for (const { name = "译文", data } of documents) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(name + " 应为英文原文到中文译文的 JSON 对象。");
    }
    for (const [rawKey, value] of Object.entries(data)) {
      readTotal += 1;
      if (typeof value !== "string") continue;
      const key = payload.normalize(rawKey);
      if (key !== rawKey) normalizedCount += 1;
      if (!key || !value.trim() || key.length > 600 || value.length > 800 || key === value) continue;
      if (!/[一-鿿]/.test(value) || /[一-鿿]/.test(key) || exactKeys.has(key)) continue;
      if (!entries.has(key)) entries.set(key, value);
    }
  }
  const result = { source, entries, readTotal, normalizedCount };
  if (!entries.size) return result;
  const anchor = "  var EXACT = {";
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + anchor.length) >= 0) throw new Error("EXACT 插入锚点缺失或重复。");
  const insertAt = at + anchor.length;
  const lines = Array.from(entries, ([key, value]) => "    " + JSON.stringify(key) + ": " + JSON.stringify(value) + ",").join("\n");
  result.source = source.slice(0, insertAt) + "\n    /* === batch-translated (auto-merged) === */\n" + lines + source.slice(insertAt);
  // 落盘前检查语法和每条实际译文；校验失败保留原文件。
  const checked = loadPayload({ source: result.source });
  for (const [key, value] of entries) {
    if (checked.localizer.translate(key) !== value) throw new Error("新增译文回读不一致：" + key);
  }
  return result;
}

function main() {
  const genDir = path.resolve(__dirname, "..", "..", "..", "_generated");
  if (!fs.existsSync(genDir)) throw new Error("找不到译文产物目录。请先准备 _generated/trans-*.json。");
  const source = fs.readFileSync(DEFAULT_PAYLOAD, "utf8");
  const documents = fs.readdirSync(genDir).filter(name => /^trans-.+\.json$/.test(name)).sort()
    .map(name => ({ name, data: JSON.parse(fs.readFileSync(path.join(genDir, name), "utf8")) }));
  const result = planMerge(source, documents);
  if (result.normalizedCount) console.log("已归一 " + result.normalizedCount + " 条译文键。");
  if (!result.entries.size) {
    console.log("没有找到需要合并的新译文。");
    return;
  }
  if (process.argv.includes("--check")) {
    console.log("检查完成：共读取 " + result.readTotal + " 条译文，发现 " + result.entries.size + " 条可合并的新译文；汉化主体保持原样。");
    return;
  }
  if (fs.readFileSync(DEFAULT_PAYLOAD, "utf8") !== source) throw new Error("汉化主体在检查期间发生变化，请重新合并。");
  fs.writeFileSync(DEFAULT_PAYLOAD, result.source, "utf8");
  console.log("共读取 " + result.readTotal + " 条译文，合并 " + result.entries.size + " 条；语法及译文回读验证通过。");
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error("合并译文失败：" + error.message);
    process.exitCode = 1;
  }
}

module.exports = { planMerge };
