const fs = require('fs');
const vm = require('vm');
let c = fs.readFileSync('payload/zh-localize.js', 'utf8');
c = c.replace('  var EDITABLE_EXACT = {', '  window.__EXACT = EXACT;\n  var EDITABLE_EXACT = {');
c = c.replace(/\}\)\(\);\s*$/, 'window.__T = translate; })();');
const s = {
  console: { warn() {}, log() {}, error() {} }, setTimeout() {}, clearTimeout() {},
  setInterval() {}, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} },
  NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, location: { href: '' }, navigator: { userAgent: 'node' },
  document: { readyState: 'complete', title: '', addEventListener() {}, documentElement: {}, body: null,
    createTreeWalker() { return { nextNode() { return false; } }; }, querySelectorAll() { return []; },
    querySelector() { return null; }, getElementById() { return null; } }
};
s.window = s; s.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
vm.createContext(s); vm.runInContext(c, s);
const d = require('./tmp-trans-official-vault-settings-next.json');
const e = s.__EXACT;
const n = (x) => String(x).replace(/[‘’]/g, "'").replace(/\u00a0/g, ' ').trim();
const existing = Object.keys(d).filter((k) => Object.keys(e).some((x) => n(x) === n(k)));
const bad = Object.entries(d).filter(([k, v]) => k === v || !/[\u4e00-\u9fff]/.test(v));
console.log('entries', Object.keys(d).length, 'existing', existing.length, existing.slice(0, 30));
console.log('bad', bad.length, bad.slice(0, 10));
