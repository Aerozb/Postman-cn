const fs = require('fs');
const vm = require('vm');

function loadDict() {
  let code = fs.readFileSync('payload/zh-localize.js', 'utf8');
  code = code.replace('  var EDITABLE_EXACT = {', '  window.__EXACT = EXACT;\n  var EDITABLE_EXACT = {');
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
  return sb;
}

const sb = loadDict();
const dict = sb.__EXACT;
const translate = sb.__T;
const norm = (s) => String(s).replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, ' ').trim();
const keys = new Map(Object.keys(dict).map((k) => [norm(k), k]));
const files = ['tmp-cat-vault.json', 'tmp-cat-settings.json', 'tmp-cat-integration.json'];
for (const file of files) {
  const rows = require('./' + file);
  const out = rows.filter((x) => {
    const t = String(x.text || '').trim();
    return t && !keys.has(norm(t)) && (!translate || translate(t) === t);
  });
  fs.writeFileSync(file.replace('.json', '-absent.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(file, 'total', rows.length, 'absent', out.length);
}
