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
      readyState: 'complete', title: '', addEventListener() {}, documentElement: {}, body: null,
      createTreeWalker() { return { nextNode() { return false; } }; },
      querySelectorAll() { return []; }, querySelector() { return null; }, getElementById() { return null; }
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'zh-localize.js' });
  return sb.__EXACT;
}

const exact = loadExact();
const todo = JSON.parse(fs.readFileSync('tmp-i18n-todo.json', 'utf8'));
const re = /workspace|collaboration|team-|create-new-team|view-all-workspaces|workspaces-table|inactive-workspaces|workspace-rfa|partner-workspace|personal-workspace|files-sidebar|local-filesystem/;
const out = todo.filter((x) => re.test((x.ns || []).join(',')) && !Object.prototype.hasOwnProperty.call(exact, x.text));
console.log(JSON.stringify(out, null, 2));
