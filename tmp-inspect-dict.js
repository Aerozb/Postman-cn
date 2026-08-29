const fs = require('fs');
const vm = require('vm');

function load() {
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

const sb = load();
const exact = sb.__EXACT;
const head = require('child_process').execFileSync(
  'git', ['show', 'HEAD:payload/zh-localize.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
);
const oldCode = head.replace('  var EDITABLE_EXACT = {', '  window.__EXACT = EXACT;\n  var EDITABLE_EXACT = {').replace(/\}\)\(\);\s*$/, 'window.__T = translate; })();');
const old = {};
const oldSb = {
  console: { warn() {}, log() {}, error() {} }, setTimeout() {}, clearTimeout() {},
  setInterval() {}, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} },
  NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, location: { href: '' }, navigator: { userAgent: 'node' },
  document: { readyState: 'complete', title: '', addEventListener() {}, documentElement: {}, body: null,
    createTreeWalker() { return { nextNode() { return false; } }; }, querySelectorAll() { return []; },
    querySelector() { return null; }, getElementById() { return null; } }
};
oldSb.window = oldSb; oldSb.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
vm.createContext(oldSb); vm.runInContext(oldCode, oldSb); Object.assign(old, oldSb.__EXACT);
const added = Object.keys(exact).filter((k) => !Object.prototype.hasOwnProperty.call(old, k));
const sourceLines = fs.readFileSync('payload/zh-localize.js', 'utf8').split(/\r?\n/);
const lineOf = (k) => sourceLines.findIndex((line) => line.includes(JSON.stringify(k) + ':')) + 1;
console.log('exact', Object.keys(exact).length, 'old', Object.keys(old).length, 'added', added.length);
const official = new Set(require('../_generated/i18n-en-unique.json').map((x) => x.text));
const rawOfficial = new Set(require('../_generated/i18n-en-raw.json')
  .map((x) => x && (x.text || x.value))
  .filter((x) => typeof x === 'string'));
const norm = (s) => s.replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, ' ');
const officialNorm = new Set([...official].map(norm));
const rawOfficialNorm = new Set([...rawOfficial].map(norm));
const rawObj = require('../_generated/i18n-en-raw.json');
const absent = added.filter((k) => !official.has(k) && !official.has(norm(k)));
const placeholders = added.filter((k) => /\{[^}]+\}|\{\{/.test(k));
const fragments = added.filter((k) => {
  const t = k.trim();
  return t !== k || t.split(/\s+/).length <= 1;
});
const likelyFragments = added.filter((k) => {
  const t = k.trim();
  return /^[a-z]/.test(t) || /^(and|or|to|of|for|with|from|in|on|by|as|if|when|that|this|the|your|our|a|an)\b/i.test(t) ||
    /\b(and|or|to|of|for|with|from|in|on|by|as|if|when|that|this|the|your|our|a|an)$/i.test(t) ||
    /[,:;—–-]$/.test(t) || /^[,.:;—–-]/.test(t);
});
const technicalWords = new Set(('api url uri http https json xml yaml html css sql sdk cli git oauth jwt aws azure grpc graphql websocket socket io mqtt mcp curl npm postman postbot interceptor javascript typescript python java ruby php rust markdown csv txt ssh tls ssl sha md5 base64 protobuf schema webhook mock mocks flow flows pm vault passport browser desktop agent cloud local windows mac linux github slack jira wiz id ids pr ci cd api key secret token team workspace collection environment request response postman support').split(/\s+/));
const residualStop = /\b(?:the|of|and|or|to|in|on|at|for|with|from|by|as|is|are|was|were|be|been|this|that|these|those|it|its|you|your|we|our|they|their|them|a|an|if|when|while|where|which|who|what|how|why|all|any|some|each|every|more|most|other|then|there|here|use|using|used|make|making|made|get|add|added|set|see|want|need|try|wait|send|please|failed|failure|successful|available|enabled|disabled|allowed|supported|unsupported|details|error|errors|cannot|couldn't|couldn’t|don't|don’t|doesn't|isn't|aren't|wasn't|weren't|would|should|must|will|can|may|later|soon)\b/i;
const mixedValues = added.filter((k) => {
  const v = exact[k];
  const words = String(v).match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  return words.some((w) => w.length >= 3 && !technicalWords.has(w.toLowerCase())) && residualStop.test(v);
});
console.log('absent-from-official', absent.length);
console.log('placeholders', placeholders.length);
console.log('fragments-or-single-word', fragments.length);
console.log('likely-fragments', likelyFragments.length);
console.log('mixed-value-suspects', mixedValues.length);
console.log('\nABSENT');
for (const k of absent) {
  const hits = rawObj.filter((x) => x && norm(x.text || '') === norm(k)).slice(0, 3)
    .map((x) => ({ ns: x.ns, key: x.key }));
  console.log(JSON.stringify([lineOf(k), k, exact[k], officialNorm.has(norm(k)), rawOfficialNorm.has(norm(k)), hits]));
}
console.log('\nPLACEHOLDERS');
for (const k of placeholders) console.log(JSON.stringify([lineOf(k), k, exact[k]]));
console.log('\nFRAGMENTS');
for (const k of fragments) console.log(JSON.stringify([lineOf(k), k, exact[k]]));
console.log('\nLIKELY_FRAGMENTS');
for (const k of likelyFragments) console.log(JSON.stringify([k, exact[k]]));
console.log('\nMIXED_VALUE_SUSPECTS');
for (const k of mixedValues) console.log(JSON.stringify([lineOf(k), k, exact[k]]));
