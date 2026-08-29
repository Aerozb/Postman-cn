const fs = require('fs');
const vm = require('vm');

function loadExact() {
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
      getElementById() { return null; }, createElement() { return {}; }
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'zh-localize.js' });
  return sb.__EXACT;
}

const exact = loadExact();
for (const f of ['tmp-cat-monitor.json', 'tmp-cat-request.json', 'tmp-cat-local.json']) {
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  const missing = a.filter(x => !Object.prototype.hasOwnProperty.call(exact, x.text));
  console.log(`\\n${f}: total=${a.length} missing=${missing.length}`);
  for (const x of missing) console.log(`${x.count}\\t${x.text}`);
}

const re = /monitor|run|runner|response|request|environment|agent|script|local|folder|git|mock|workspace|collection|cloud|sync|deploy|file|repository|branch|simulation|vault|setting|header|body|auth|test/i;
for (const f of ['tmp-cat-monitor.json', 'tmp-cat-request.json', 'tmp-cat-local.json']) {
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`\\nKEYWORD ${f}`);
  for (const x of a.filter(x => !Object.prototype.hasOwnProperty.call(exact, x.text) && re.test(x.text))) {
    console.log(JSON.stringify({ c: x.count, t: x.text, ns: x.ns }));
  }
}
