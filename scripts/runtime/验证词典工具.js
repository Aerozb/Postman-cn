"use strict";

const assert = require("assert/strict");
const { loadPayload } = require("../lib/汉化沙箱.js");
const { planMerge } = require("../data/合并译文.js");
const { countDictionaries } = require("../data/统计词条.js");
const { samples, evaluateTranslations } = require("./翻译回归样例.js");

const FIXTURE = String.raw`(function () {
  var EXACT = { "First": "初始", ": Quoted \"label\"": "带引号", "Duplicate": "先写" };
  Object.assign(EXACT, { "Later": "追加", "Duplicate": "后写" });
  var PHRASES = [["part", "片段"]];
  PHRASES = PHRASES.concat([[/can['’]t[,\]]/g, "规则片段"]]);
  var RULES = [[/^can['’]t\s+(.+)$/, "$1"], [/^[a-z]{1,3}[\[\]]$/, "括号"]];
  var I18N_TERMS = { "Group": "术语" };
  var EDITABLE_EXACT = { "Draft": "草稿" };
  var MENU_ITEM_EXACT = { "Only menu": "菜单" };
  function normalize(text) { return String(text).replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim(); }
  function translate(text) { return EXACT[normalize(text)] || text; }
  window.__POSTMAN_ZH_LOCALIZER__ = {
    run: function () {}, translate: translate, walk: function () {}
  };
})();`;

async function runDictionaryTests() {
  let passed = 0;
  const test = (name, fn) => {
    try { fn(); passed += 1; } catch (error) { throw new Error(name + "：" + error.message, { cause: error }); }
  };
  const fixture = loadPayload({ source: FIXTURE });
  test("追加词典、正则和后写优先", () => {
    assert.equal(fixture.dictionaries.EXACT.Later, "追加");
    assert.equal(fixture.localizer.translate("Duplicate"), "后写");
    const counts = countDictionaries(fixture);
    assert.deepEqual(counts.parts.map(item => item.count), [4, 2, 2, 1, 1, 1]);
    assert.equal(counts.bytes, Buffer.byteLength(FIXTURE));
  });
  test("最终 EXACT 查重且其他词典互不屏蔽", () => {
    const result = planMerge(FIXTURE, [{ data: { Later: "覆盖", Group: "群组", Draft: "草稿文案", "Only menu": "界面菜单" } }]);
    assert.deepEqual([...result.entries.keys()], ["Group", "Draft", "Only menu"]);
    assert.equal(loadPayload({ source: result.source }).localizer.translate("Later"), "追加");
  });
  test("归一空白和零宽字符，冒号与引号保持幂等", () => {
    const documents = [{ data: { "  Fresh\u00a0\u200btext\n ": "新文案", ": Quoted \"label\"": "重复", "Don't add {noise}": "完整新词条" } }];
    const result = planMerge(FIXTURE, documents);
    assert.equal(result.normalizedCount, 1);
    assert.deepEqual([...result.entries.keys()], ["Fresh text", "Don't add {noise}"]);
    assert.equal(planMerge(result.source, documents).entries.size, 0);
  });
  test("首批优先及无中文、无效值过滤", () => {
    const result = planMerge(FIXTURE, [{ data: { New: "先到", Identity: "Identity", Empty: "", Number: 4 } }, { data: { New: "后到" } }]);
    assert.deepEqual([...result.entries], [["New", "先到"]]);
    assert.throws(() => planMerge(FIXTURE, [{ data: [] }]), /JSON/);
  });
  test("缺失锚点或错误源码立即失败", () => {
    assert.throws(() => loadPayload({ source: "var x = {};" }), /锚点/);
    assert.throws(() => planMerge(FIXTURE + "\nsyntax !!!", []));
  });
  const payload = loadPayload();
  test("真实词典追加键参与合并查重", () => {
    assert.ok(Object.hasOwn(payload.dictionaries.EXACT, "COLLECTIONS"));
    assert.equal(planMerge(payload.source, [{ data: { COLLECTIONS: "替代译文" } }]).entries.size, 0);
    const counts = countDictionaries(payload);
    assert.ok(counts.parts.find(item => item.name === "RULES").count > 1000);
    assert.ok(counts.parts.find(item => item.name === "PHRASES").count > 500);
  });
  test("检查钩子未扩展生产公开接口", () => {
    assert.deepEqual(Object.keys(payload.localizer).sort(), ["run", "translate", "walk"]);
    assert.equal(payload.source.includes("window.__POSTMAN_ZH_INSPECTION__"), false);
  });
  test("离线与实机共用翻译样例", () => {
    const result = evaluateTranslations(payload.localizer, samples);
    for (const [name, failures] of Object.entries(result)) assert.deepEqual(failures, [], name);
  });
  return { passed, failures: [], probes: samples.translationProbeTargets.length, expectations: samples.translationProbeExpectations.length };
}

module.exports = { runDictionaryTests };
