const fs = require('fs');
const vm = require('vm');

function loadTranslator() {
  let code = fs.readFileSync('payload/zh-localize.js', 'utf8');
  code = code.replace(/\}\)\(\);\s*$/, 'window.__T = translate; })();');
  const sb = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    location: { href: '' }, navigator: { userAgent: 'node' },
    document: {
      readyState: 'complete', title: '', addEventListener() {},
      documentElement: {}, body: null,
      createTreeWalker() { return { nextNode() { return false; } }; },
      querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById() { return null; }
    }
  };
  sb.window = sb;
  sb.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'zh-localize.js' });
  return sb.__T;
}

const translate = loadTranslator();
const all = require('../_generated/i18n-en-unique.json');
const raw = require('../_generated/i18n-en-raw.json');
if (process.argv.includes('--find')) {
  for (const q of process.argv.slice(2).filter((x) => x !== '--find')) {
    console.log(q, raw.filter((x) => x.text === q).slice(0, 5));
  }
  process.exit(0);
}
const todo = all.filter((x) => x.text && /[A-Za-z]/.test(x.text) &&
  !/[{}]|\{\{/.test(x.text) && translate(x.text) === x.text);
const bins = { short: [], multi: [], long: [], sent: [] };
for (const x of todo) {
  const t = x.text.trim();
  const words = t.split(/\s+/).length;
  if (words <= 1) bins.short.push(x);
  else if (words <= 4) bins.multi.push(x);
  else if (words <= 12) bins.long.push(x);
  else bins.sent.push(x);
}
console.log(JSON.stringify({
  todo: todo.length,
  bins: Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, v.length]))
}, null, 2));
for (const [k, v] of Object.entries(bins)) {
  console.log(`\n### ${k}`);
  console.log(v.slice(0, 240).map((x) => `${x.count}\t${x.text}`).join('\n'));
}
fs.writeFileSync('tmp-i18n-todo.json', JSON.stringify(todo, null, 2), 'utf8');
for (const [k, v] of Object.entries(bins)) {
  fs.writeFileSync(`tmp-i18n-${k}.txt`, v.map((x) => `${x.count}\t[${(x.ns || []).join(',')}]\t${x.text}`).join('\n'), 'utf8');
}
