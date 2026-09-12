"use strict";

// 发布器调用：默认输出总数；--details 输出各词典的最终生效规模。
const { loadPayload } = require("../lib/汉化沙箱.js");
const DESCRIPTIONS = {
  EXACT: "完整文案精确匹配", PHRASES: "可组合子串片段", RULES: "含变量的正则规则",
  I18N_TERMS: "生成规则用术语表", EDITABLE_EXACT: "输入框真实 value", MENU_ITEM_EXACT: "页面内菜单项"
};

function countDictionaries(payload = loadPayload()) {
  const parts = Object.entries(DESCRIPTIONS).map(([name, description]) => {
    const table = payload.dictionaries[name];
    const count = Array.isArray(table) ? table.length : Object.keys(table).length;
    if (!count) throw new Error("词典为空，停止生成可能失真的统计：" + name);
    return { name, description, count };
  });
  return { parts, total: parts.reduce((sum, part) => sum + part.count, 0), bytes: Buffer.byteLength(payload.source, "utf8") };
}

function main() {
  const { parts, total, bytes } = countDictionaries();
  if (process.argv.includes("--details")) {
    for (const { name, description, count } of parts) {
      console.log("  " + name.padEnd(16) + String(count).padStart(6) + "  " + description);
    }
    console.log("  合计            " + total);
    console.log("  payload 体积    " + (bytes / 1048576).toFixed(2) + " MiB");
  } else {
    console.log(String(total));
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error("词条统计失败：" + error.message);
    process.exitCode = 1;
  }
}

module.exports = { countDictionaries };
