"use strict";

// 仅供本地工具和回归：读取最终生效词典，由 JS 处理追加、正则和重复键。
// 检查钩子只加入内存副本，生产 payload 只公开 run、translate、walk。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DEFAULT_PAYLOAD = path.resolve(__dirname, "..", "..", "payload", "zh-localize.js");
const PUBLIC_API_ANCHOR = "  window.__POSTMAN_ZH_LOCALIZER__ = {";
const DICTIONARY_NAMES = ["EXACT", "PHRASES", "RULES", "I18N_TERMS", "EDITABLE_EXACT", "MENU_ITEM_EXACT"];

function loadPayload({ source, payloadPath = DEFAULT_PAYLOAD, timeoutMs = 10000 } = {}) {
  const code = source === undefined ? fs.readFileSync(payloadPath, "utf8") : source;
  if (typeof code !== "string") throw new TypeError("汉化主体源码必须是字符串。");
  const at = code.indexOf(PUBLIC_API_ANCHOR);
  if (at < 0 || code.indexOf(PUBLIC_API_ANCHOR, at + PUBLIC_API_ANCHOR.length) >= 0) {
    throw new Error("汉化主体的公开接口锚点缺失或重复。");
  }
  const inspection = "  window.__POSTMAN_ZH_INSPECTION__ = { dictionaries: { " +
    DICTIONARY_NAMES.join(", ") + " }, normalize: normalize };\n";
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // 不启动 DOM、真实计时器，不暴露 require、文件、进程或网络。
    document: { readyState: "loading", title: "", body: null, documentElement: null, addEventListener() {} },
    location: { href: "" }, navigator: { userAgent: "node" },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    localStorage: { setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(code.slice(0, at) + inspection + code.slice(at), context, {
    filename: payloadPath, timeout: timeoutMs
  });
  const localizer = sandbox.__POSTMAN_ZH_LOCALIZER__;
  const inspected = sandbox.__POSTMAN_ZH_INSPECTION__;
  if (!localizer || typeof localizer.translate !== "function" || !inspected || typeof inspected.normalize !== "function") {
    throw new Error("汉化主体初始化后缺少翻译接口。");
  }
  for (const name of DICTIONARY_NAMES) {
    const value = inspected.dictionaries[name];
    const array = name === "RULES" || name === "PHRASES";
    if (!value || typeof value !== "object" || Array.isArray(value) !== array) {
      throw new Error("汉化词典类型异常：" + name);
    }
  }
  return { source: code, localizer, ...inspected };
}

module.exports = { loadPayload, DEFAULT_PAYLOAD, DICTIONARY_NAMES };
