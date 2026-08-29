const fs = require('fs');
const path = require('path');

const payload = fs.readFileSync(path.join(__dirname, 'payload', 'zh-localize.js'), 'utf8');
const exact = new Set();
const start = payload.indexOf('var EXACT = {');
const tail = start >= 0 ? payload.slice(start) : payload;
const re = /"((?:[^"\\]|\\.)+)"\s*:/g;
let m;
while ((m = re.exec(tail))) {
  try { exact.add(JSON.parse('"' + m[1] + '"')); } catch (_) {}
}
const all = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_generated', 'i18n-en-unique.json'), 'utf8'));
const groups = {
  workspace: /workspace-sidebar-core|workspace-overview|workspace-create|view-all-workspaces|create-new-team|team-onboarding|home|workspaces-table|workspace-tidy/,
  local: /local-filesystem|files-sidebar|workbench-mock-create-local|file-viewer|files-modal/,
  monitor: /monitors-core|api-mock-core|self-managed-clusters|performance-testing-ui/,
  vault: /vault/,
  settings: /settings|proxy/,
  integration: /integrations|team-profile|team-settings|collaboration-errors|invite-flow|service-accounts/,
  request: /workbench-request|workbench-core|workbench-example|sidebar-collection|sidebar-history|api-client-core|workbench-collection|workbench-folder/,
};
const skip = [
  /https?:\/\//i,
  /[{}]/,
  /<\/?[A-Za-z]/,
  /^\s*[\[\]`]/,
  /\b(?:CRL|HTTP\/2|TLSA|GOAWAY|DANE|SCT|nginx|IE7|WebDAV|PKCS|PEM|JWT|qop|WWW-Authenticate|content-length|CORS|BYOK|requestAggregate|pm\.|JSONPath|XPath)\b/i,
  /^\(?\s*(?:optional|loading|not specified|no query)\s*\)?[.:…]*$/i,
];
for (const [name, nsRe] of Object.entries(groups)) {
  const out = all.filter((x) => {
    const t = String(x.text || '').trim();
    const ns = (x.ns || []).join(',');
    if (exact.has(t) || !nsRe.test(ns) || !t || t.length < 12 || t.length > 320) return false;
    if (skip.some((s) => s.test(t))) return false;
    if (!/[A-Za-z]/.test(t) || !/\s/.test(t)) return false;
    if (/^[a-z][a-z -]*$/.test(t)) return false;
    if (/^[A-Z\d][A-Z\d _+./:-]*$/.test(t) && t.length < 28) return false;
    return true;
  }).sort((a, b) => b.count - a.count || a.text.length - b.text.length);
  console.log(`\n### ${name} (${out.length})`);
  for (const x of out.slice(0, 260)) console.log(`${x.count}\t${x.text}`);
}
