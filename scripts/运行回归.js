#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");
const ROOT = path.resolve(__dirname, "..");

function filesBelow(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

function checkRepository() {
  let passed = 0;
  const jsFiles = [...filesBelow(__dirname), ...filesBelow(path.join(ROOT, "payload"))].filter(file => file.endsWith(".js"));
  for (const file of jsFiles) { new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }); passed += 1; }
  assert.ok(fs.statSync(path.join(ROOT, "AGENTS.md")).size <= 32768, "AGENTS.md 超过 32 KiB");
  passed += 1;
  const documents = ["AGENTS.md", "CLAUDE.md", "README.md", "scripts/README.md"].map(file => path.join(ROOT, file))
    .concat(...["docs", ".agents", ".claude"].map(dir => filesBelow(path.join(ROOT, dir)).filter(file => file.endsWith(".md"))));
  for (const file of documents) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
      const target = decodeURIComponent(match[1].split("#")[0]);
      if (!target) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), path.relative(ROOT, file) + " 的本地链接缺失：" + match[1]);
      passed += 1;
    }
  }
  const skills = [".agents", ".claude"].map(dir => fs.readFileSync(path.join(ROOT, dir, "skills/postman-zh-deep-audit/SKILL.md"), "utf8"));
  for (const field of ["name", "description"]) {
    const values = skills.map(text => text.match(new RegExp("^" + field + ": (.+)$", "m"))?.[1]);
    assert.ok(values[0], "skill 缺少 " + field);
    assert.equal(values[0], values[1], "skill 的 " + field + " 不一致");
    passed += 1;
  }
  return { passed, javascript: jsFiles.length, documents: documents.length };
}

async function main() {
  const details = process.argv.includes("--details");
  const groups = [
    ["语法与文档链接", checkRepository],
    ["词典读取与翻译样例", () => require("./runtime/验证词典工具.js").runDictionaryTests()],
    ["数据保护与翻译调度", () => require("./runtime/验证翻译调度.js").runLocalizationRuntimeTests()],
    ["CDP 与诊断输出", () => require("./runtime/验证诊断工具.js").runDiagnosticTests()],
    ["实机验证就绪轮询", () => require("./runtime/验证页面就绪.js").runPageReadinessTests()],
    ["汉化版本检查", () => require("./runtime/验证版本检查.js").runVersionCheckTests()],
    ["版本检查界面", () => require("./runtime/验证版本检查界面.js").runVersionCheckUiTests()],
    ["跨站子帧注入", () => require("./runtime/验证跨帧注入.js").runOopifInjectTests()]
  ];
  let failures = 0;
  let passed = 0;
  for (const [name, run] of groups) {
    const started = Date.now();
    try {
      const result = await run();
      assert.equal(result.failures?.length || 0, 0, name + "存在未通过项");
      passed += result.passed;
      console.log("[通过] " + name + "：" + result.passed + " 项" + (details ? "（" + (Date.now() - started) + " ms）" : ""));
    } catch (error) {
      failures += 1;
      console.error("[失败] " + name + "：" + String(error.message).split("\n")[0]);
      if (details) console.error(error.stack);
    }
  }
  console.log("离线回归：通过 " + passed + " 项，失败 " + failures + " 组。");
  if (failures) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error("离线回归出错：" + error.message); process.exitCode = 1; });
module.exports = { checkRepository };
